import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { costOfUsageMicroUsd, modelSpec, type WsServerMessage } from '@www-rh/shared';
import type { EgressFilter } from '../src/browser/egress.js';
import type { TxQueue } from '../src/chain/txQueue.js';
import { MemoryService } from '../src/memory/memory.js';
import type { TickParams } from '../src/mind/request.js';
import { runTick, type RunnerFactory, type StreamLike, type TickBrowser, type TickDeps, type ToolRunnerLike } from '../src/mind/tick.js';
import { StreamBus } from '../src/stream/bus.js';
import { FakeQueue, memoryRepos, silentLogger, TOKEN } from './helpers.js';

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number };
type Block = { type: 'text'; text: string } | { type: 'thinking'; thinking: string } | { type: 'tool_use'; name: string; input: unknown };

interface Iteration {
  model?: string;
  blocks: Block[];
  stop: string;
  usage?: Usage;
  /** finalMessage() rejects with this after the events. */
  error?: Error;
  /** never completes until aborted */
  hang?: boolean;
}

const U: Usage = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 };

function message(it: Iteration): Anthropic.Beta.BetaMessage {
  const content = it.blocks.map((b, i) =>
    b.type === 'text' ? { type: 'text', text: b.text, citations: null } : b.type === 'thinking' ? { type: 'thinking', thinking: b.thinking, signature: 'sig' } : { type: 'tool_use', id: `toolu_${i}`, name: b.name, input: b.input },
  );
  return { id: 'msg', type: 'message', role: 'assistant', model: it.model ?? 'claude-opus-5-5', content, stop_reason: it.stop, stop_sequence: null, usage: { ...(it.usage ?? U) } } as unknown as Anthropic.Beta.BetaMessage;
}

class FakeStream implements StreamLike {
  constructor(private readonly it: Iteration, private readonly signal: AbortSignal) {}

  async *[Symbol.asyncIterator](): AsyncIterator<Anthropic.Beta.BetaRawMessageStreamEvent> {
    const m = message(this.it);
    yield { type: 'message_start', message: { ...m, content: [], usage: { ...(this.it.usage ?? U), output_tokens: 1 } } } as unknown as Anthropic.Beta.BetaRawMessageStreamEvent;
    if (this.it.hang === true) {
      await new Promise((_, reject) => this.signal.addEventListener('abort', () => reject(new Anthropic.APIUserAbortError()), { once: true }));
    }
    for (const [index, b] of this.it.blocks.entries()) {
      if (b.type === 'tool_use') continue;
      yield { type: 'content_block_start', index, content_block: b.type === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' } } as unknown as Anthropic.Beta.BetaRawMessageStreamEvent;
      const text = b.type === 'text' ? b.text : b.thinking;
      for (const part of [text.slice(0, 3), text.slice(3)]) {
        if (part === '') continue;
        yield { type: 'content_block_delta', index, delta: b.type === 'text' ? { type: 'text_delta', text: part } : { type: 'thinking_delta', thinking: part } } as unknown as Anthropic.Beta.BetaRawMessageStreamEvent;
      }
      yield { type: 'content_block_stop', index } as unknown as Anthropic.Beta.BetaRawMessageStreamEvent;
    }
    yield { type: 'message_delta', delta: { stop_reason: this.it.stop }, usage: { ...(this.it.usage ?? U) } } as unknown as Anthropic.Beta.BetaRawMessageStreamEvent;
  }

  async finalMessage(): Promise<Anthropic.Beta.BetaMessage> {
    if (this.it.error !== undefined) throw this.it.error;
    return message(this.it);
  }
}

/** Mimics BetaToolRunner: yields one stream per iteration and runs the tools of `tool_use` turns. */
class FakeRunner implements ToolRunnerLike {
  constructor(readonly params: TickParams, private readonly script: Iteration[], private readonly signal: AbortSignal) {}

  async *[Symbol.asyncIterator](): AsyncIterator<StreamLike> {
    for (const it of this.script.slice(0, this.params.max_iterations)) {
      const stream = new FakeStream(it, this.signal);
      yield stream;
      const msg = await stream.finalMessage();
      for (const b of msg.content) {
        if (b.type !== 'tool_use') continue;
        const tool = this.params.tools.find((t) => 'name' in t && t.name === b.name) as { parse(i: unknown): unknown; run(i: unknown): Promise<unknown> } | undefined;
        if (tool !== undefined) await tool.run(tool.parse(b.input));
      }
      if (msg.stop_reason !== 'tool_use') return;
    }
  }
}

function harness(scripts: (Iteration[] | Error)[], config: Partial<TickDeps['config']> = {}) {
  const repos = memoryRepos();
  const bus = new StreamBus();
  const messages: WsServerMessage[] = [];
  bus.subscribe(TOKEN, (m) => messages.push(m));
  const memory = new MemoryService(repos, bus, new FakeQueue(true) as unknown as TxQueue, { anchorEvery: 5 }, silentLogger);
  const created: TickParams[] = [];
  const sleeps: number[] = [];
  const resets: string[] = [];
  const createRunner: RunnerFactory = (params, { signal }) => {
    created.push(params);
    const script = scripts.shift() ?? [];
    if (script instanceof Error) {
      return { params, [Symbol.asyncIterator]: async function* () { throw script; } } as unknown as ToolRunnerLike;
    }
    return new FakeRunner(params, script, signal);
  };
  const browser: TickBrowser = {
    currentUrl: () => 'https://example.com/',
    navigate: async () => ({ url: 'https://example.com/', title: '', text: '', links: [] }),
    read: async () => ({ url: 'https://example.com/', title: '', text: '', links: [] }),
    click: async () => ({ url: '', title: '', text: '', links: [] }),
    type: async () => ({ url: '', title: '', text: '', links: [] }),
    scroll: async () => ({ url: '', title: '', text: '', links: [] }),
    back: async () => ({ url: '', title: '', text: '', links: [] }),
    screenshot: async () => 'AAAA',
    startFrames: () => undefined,
    stopFrames: () => undefined,
    captureFrame: async () => ({ jpegBase64: 'AAAA', url: 'https://example.com/', at: new Date().toISOString() }),
  };
  const allowAll: EgressFilter = { checkUrl: async (url) => ({ ok: true, url: new URL(url), addresses: ['1.1.1.1'] }), checkHost: async () => ({ ok: true, addresses: ['1.1.1.1'] }) };
  const deps: TickDeps = {
    createRunner,
    repos,
    bus,
    memory,
    egress: allowAll,
    browser: async () => browser,
    resetBrowser: async (t) => void resets.push(t),
    config: { maxIterations: 8, maxTickCostUsd: 0.25, timeoutMs: 5_000, frameFps: 0, ...config },
    log: silentLogger,
    sleep: async (ms) => void sleeps.push(ms),
  };
  const input = {
    identity: { token: TOKEN, name: 'Mind', symbol: 'MIND', modelId: `0x${'aa'.repeat(32)}`, personaHash: `0x${'bb'.repeat(32)}`, verifiedPersona: null },
    spec: modelSpec('claude-opus-5-5')!,
    vaultUsd: 10,
    runwayHours: null,
    currentUrl: null,
  };
  return { repos, messages, created, sleeps, resets, run: () => runTick(deps, input) };
}

describe('runTick', () => {
  it('streams thoughts, emits actions, runs tools, saves aloud + summary thoughts and charges each iteration at its served model', async () => {
    const h = harness([
      [
        { blocks: [{ type: 'thinking', thinking: 'Let me look around.' }, { type: 'text', text: 'Thinking out loud.' }, { type: 'tool_use', name: 'think_aloud', input: { text: 'Off to read about trains.' } }], stop: 'tool_use' },
        { model: 'claude-opus-4-8', blocks: [{ type: 'text', text: 'Summary: I read about trains.' }], stop: 'end_turn' },
      ],
    ]);
    const r = await h.run();
    expect(r).toMatchObject({ status: 'ok', failed: false, stopReason: 'end_turn', error: null });
    expect(r.totals.iterations).toBe(2);
    expect(r.totals.costUsdMicro).toBe(costOfUsageMicroUsd('claude-opus-5-5', U) + costOfUsageMicroUsd('claude-opus-4-8', U));
    expect(r.totals.servedModel).toBe('claude-opus-4-8');
    const thoughts = h.messages.filter((m) => m.type === 'thought');
    expect(thoughts.filter((m) => m.type === 'thought' && m.delta).map((m) => (m.type === 'thought' ? m.text : ''))).toEqual(['Let', ' me look around.', 'Thi', 'nking out loud.', 'Sum', 'mary: I read about trains.']);
    expect(thoughts.filter((m) => m.type === 'thought' && !m.delta).map((m) => (m.type === 'thought' ? `${m.kind}:${m.text}` : ''))).toEqual([
      'thinking:Let me look around.',
      'text:Thinking out loud.',
      'text:Summary: I read about trains.',
    ]);
    const action = h.messages.find((m) => m.type === 'action');
    expect(action).toMatchObject({ type: 'action', tickId: r.tickId, tool: 'think_aloud', input: '{"text":"Off to read about trains."}' });
    const saved = h.messages.filter((m) => m.type === 'thoughtSaved').map((m) => (m.type === 'thoughtSaved' ? `${m.thought.kind}:${m.thought.text}` : ''));
    expect(saved).toEqual(['aloud:Off to read about trains.', 'summary:Summary: I read about trains.']);
    const row = h.repos.ticks.get(r.tickId)!;
    expect([row.status, row.served_model, row.iterations, row.cost_usd_micro, row.input_tokens]).toEqual(['ok', 'claude-opus-4-8', 2, r.totals.costUsdMicro, 2000]);
  });

  it('refusal ends the tick without counting as a failure', async () => {
    const h = harness([[{ blocks: [{ type: 'text', text: 'I cannot' }], stop: 'refusal' }]]);
    const r = await h.run();
    expect(r).toMatchObject({ status: 'refused', failed: false, stopReason: 'refusal' });
    expect(h.messages.some((m) => m.type === 'thoughtSaved')).toBe(false);
  });

  it('max_tokens with a tool_use aborts the tick before the tool runs (failure)', async () => {
    const h = harness([[{ blocks: [{ type: 'tool_use', name: 'think_aloud', input: { text: 'truncat' } }], stop: 'max_tokens' }]]);
    const r = await h.run();
    expect(r).toMatchObject({ status: 'failed', failed: true, error: 'max_tokens_with_tool_use' });
    expect(h.repos.ticks.thoughts(TOKEN, 10)).toHaveLength(0);
  });

  it('stops iterating once the running cost reaches MAX_TICK_COST_USD', async () => {
    const big: Usage = { input_tokens: 100_000, output_tokens: 10_000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }; // $0.60 on opus-5-5
    const h = harness([[{ blocks: [{ type: 'tool_use', name: 'think_aloud', input: { text: 'one' } }], stop: 'tool_use', usage: big }, { blocks: [{ type: 'text', text: 'never' }], stop: 'end_turn' }]]);
    const r = await h.run();
    expect(r).toMatchObject({ status: 'ok', failed: false });
    expect(r.totals.iterations).toBe(1);
  });

  it('rebuilds the runner once from runner.params on unparsable tool JSON; a second one fails the tick', async () => {
    const jsonError = new Anthropic.AnthropicError('Unable to parse tool parameter JSON from model.');
    const ok = harness([[{ blocks: [], stop: 'tool_use', error: jsonError }], [{ blocks: [{ type: 'text', text: 'Recovered.' }], stop: 'end_turn' }]]);
    const r = await ok.run();
    expect(r.status).toBe('ok');
    expect(ok.created).toHaveLength(2);
    expect(ok.created[1]?.max_iterations).toBe(7);
    expect(ok.created[1]?.messages).toEqual(ok.created[0]?.messages);

    const bad = harness([[{ blocks: [], stop: 'tool_use', error: jsonError }], [{ blocks: [], stop: 'tool_use', error: jsonError }]]);
    const r2 = await bad.run();
    expect(r2).toMatchObject({ status: 'failed', failed: true });
    expect(r2.error).toMatch(/^tool_input_json/);
  });

  it('retries rate limits and 5xx with backoff (retry-after honoured) by rebuilding the runner', async () => {
    const rate = new Anthropic.RateLimitError(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 'slow down', new Headers({ 'retry-after': '2' }));
    const server = new Anthropic.InternalServerError(529, { type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }, 'overloaded', new Headers());
    const h = harness([rate, server, [{ blocks: [{ type: 'text', text: 'done' }], stop: 'end_turn' }]]);
    const r = await h.run();
    expect(r.status).toBe('ok');
    expect(h.sleeps).toEqual([2000, 2000]);
    const auth = harness([new Anthropic.AuthenticationError(401, undefined, 'bad key', new Headers())]);
    expect(await auth.run()).toMatchObject({ status: 'failed', failed: true });
    expect(auth.sleeps).toEqual([]);
  });

  it('times out: aborts the request, fails the tick, recreates the browser context', async () => {
    const h = harness([[{ blocks: [{ type: 'text', text: 'slow' }], stop: 'end_turn', hang: true }]], { timeoutMs: 50 });
    const r = await h.run();
    expect(r).toMatchObject({ status: 'timeout', failed: true });
    expect(r.error).toMatch(/timed out/);
    expect(h.resets).toEqual([TOKEN.toLowerCase()]);
    expect(r.totals.iterations).toBe(1); // usage seen on message_start is still charged
  });

  it('charges the last streamed usage of an iteration whose stream broke', async () => {
    const h = harness([[{ blocks: [{ type: 'text', text: 'partial' }], stop: 'end_turn', error: new Error('socket hang up') }]]);
    const r = await h.run();
    expect(r).toMatchObject({ status: 'failed', failed: true, error: 'socket hang up' });
    expect(r.totals.costUsdMicro).toBe(costOfUsageMicroUsd('claude-opus-5-5', U));
  });
});
