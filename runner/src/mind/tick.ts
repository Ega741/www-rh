/**
 * One tick of one mind (`docs/SPEC.md` §4.1 `mind/tick.ts`).
 *
 * `client.beta.messages.toolRunner({ …, stream: true, max_iterations })`; per iteration: forward
 * text / thinking deltas as WS `thought` messages, `await stream.finalMessage()`, charge it at the
 * served model, emit `action` messages for its `tool_use` blocks, then apply the stop rules —
 * `refusal` ends the tick (not a failure), `max_tokens` with a `tool_use` aborts it (failure),
 * reaching `MAX_TICK_COST_USD` stops iterating. An unparsable tool-input JSON rebuilds the runner
 * from `runner.params` once (a second one fails the tick); rate limits / 5xx / connection errors are
 * retried up to 3 times (1 s, 2 s, 4 s or `retry-after`) the same way; `TICK_TIMEOUT_MS` aborts the
 * in-flight request and recreates the mind's browser context.
 *
 * Hung work can never hold the tick (and with it the scheduler's single-flight lock): every
 * `next()` of the tool runner and of each stream, and `finalMessage()`, is raced against the tick's
 * AbortSignal, and each tool `run` against that signal plus `TOOL_TIMEOUT_MS` (a timed-out tool
 * returns an `error:` result and resets the browser context). The running usage is persisted after
 * every iteration, so a crash still charges the completed iterations.
 *
 * @module mind/tick
 */
import Anthropic from '@anthropic-ai/sdk';
import type { BetaToolRunnerParams } from '@anthropic-ai/sdk/lib/tools/BetaToolRunner';
import { redactActionInput, type ModelSpec, type Thought, type TokenUsage } from '@www-rh/shared';
import type { EgressFilter } from '../browser/egress.js';
import type { MindBrowserApi } from '../browser/mindBrowser.js';
import type { Repos, ThoughtRow } from '../db/repos.js';
import { shouldStopTick } from '../economics/governor.js';
import { TickUsage, type TickTotals } from '../economics/usage.js';
import { errorMessage, type Logger } from '../log.js';
import type { MemoryService } from '../memory/memory.js';
import type { StreamBus } from '../stream/bus.js';
import { buildSystem, type PersonaIdentity } from './persona.js';
import { buildTickParams, type TickParams } from './request.js';
import { createMindTools, DEFAULT_TOOL_TIMEOUT_MS } from './tools.js';

/** A streamed iteration as yielded by the tool runner. */
export interface StreamLike extends AsyncIterable<Anthropic.Beta.BetaRawMessageStreamEvent> {
  finalMessage(): Promise<Anthropic.Beta.BetaMessage>;
}

/** The part of `BetaToolRunner<true>` a tick uses. */
export interface ToolRunnerLike extends AsyncIterable<StreamLike> {
  readonly params: Readonly<BetaToolRunnerParams>;
}

/** Creates a streaming tool runner (the SDK in production, a fake in tests). */
export type RunnerFactory = (params: TickParams, options: { signal: AbortSignal }) => ToolRunnerLike;

/** Production {@link RunnerFactory} over the Anthropic SDK. */
export function sdkRunnerFactory(client: Anthropic): RunnerFactory {
  return (params, options) => client.beta.messages.toolRunner(params, { signal: options.signal });
}

/** Browser session of a tick, with frame hooks. */
export interface TickBrowser extends MindBrowserApi {
  startFrames(fps: number, onFrame: (frame: { jpegBase64: string; url: string; at: string }) => void): void;
  stopFrames(): void;
  captureFrame(): Promise<{ jpegBase64: string; url: string; at: string } | null>;
}

/** Dependencies of {@link runTick}. */
export interface TickDeps {
  createRunner: RunnerFactory;
  repos: Repos;
  bus: StreamBus;
  memory: MemoryService;
  egress: EgressFilter;
  /** The mind's browser session (lazy). */
  browser(token: string): Promise<TickBrowser>;
  /** Closes and recreates the mind's browser context (after a timeout). */
  resetBrowser(token: string): Promise<void>;
  config: { maxIterations: number; maxTickCostUsd: number; timeoutMs: number; frameFps: number; toolTimeoutMs?: number };
  log: Logger;
  now?: () => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** What the scheduler passes for one tick. */
export interface TickInput {
  identity: PersonaIdentity;
  spec: ModelSpec;
  vaultUsd: number;
  runwayHours: number | null;
  currentUrl: string | null;
  /** Aborts the tick (graceful shutdown). */
  signal?: AbortSignal;
}

/** Final state of a tick. */
export type TickStatus = 'ok' | 'refused' | 'failed' | 'timeout';

/** Result of {@link runTick}. */
export interface TickResult {
  tickId: number;
  status: TickStatus;
  /** Counts towards the consecutive-failure counter (exception after retries, timeout, JSON failure). */
  failed: boolean;
  stopReason: string | null;
  error: string | null;
  totals: TickTotals;
}

/** Error used as the abort reason at `TICK_TIMEOUT_MS`. */
export class TickTimeoutError extends Error {
  constructor(ms: number) {
    super(`tick timed out after ${ms} ms`);
    this.name = 'TickTimeoutError';
  }
}

const MAX_API_RETRIES = 3;

/** Whether `err` is a transient API failure worth retrying (429, ≥ 500, connection). */
export function isRetryable(err: unknown): boolean {
  if (err instanceof Anthropic.APIUserAbortError) return false;
  if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.APIConnectionError) return true;
  return err instanceof Anthropic.APIError && typeof err.status === 'number' && err.status >= 500;
}

/** Whether `err` is the SDK's tool-input JSON parse error (an `AnthropicError` that is not an `APIError`). */
export function isToolJsonError(err: unknown): boolean {
  return err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError);
}

/** Delay before retry `attempt` (0-based): `retry-after` when present, else 1 s, 2 s, 4 s. */
export function retryDelayMs(err: unknown, attempt: number): number {
  if (err instanceof Anthropic.APIError) {
    const header = (err.headers as Headers | undefined)?.get?.('retry-after');
    const seconds = header === null || header === undefined ? Number.NaN : Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1000);
  }
  return 1000 * 2 ** attempt;
}

const abortReason = (signal: AbortSignal): Error => (signal.reason instanceof Error ? signal.reason : new Error('aborted'));

/** Settles like `p`, or rejects with the signal's reason as soon as it aborts (`p` keeps running unobserved). */
export function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    p.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

/**
 * Iterates `iterable`, but every `next()` is raced against `signal`: a hung iterator (a tool that
 * never returns inside the SDK tool runner, a stalled stream) cannot hold the caller. On early exit
 * the source iterator's `return()` is called without being awaited.
 */
export async function* abortable<T>(iterable: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T, void, undefined> {
  const it = iterable[Symbol.asyncIterator]();
  let done = false;
  try {
    for (;;) {
      const r = await raceAbort(it.next(), signal);
      if (r.done === true) {
        done = true;
        return;
      }
      yield r.value;
    }
  } finally {
    if (!done) void Promise.resolve().then(() => it.return?.()).catch(() => undefined);
  }
}

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
    }, { once: true });
  });

function thoughtDto(row: ThoughtRow): Thought {
  return { id: row.id, tickId: row.tick_id, kind: row.kind, text: row.text, createdAt: new Date(row.created_at).toISOString() };
}

/** Runs one tick for `input.identity.token`. Never throws for model/tool failures. */
export async function runTick(deps: TickDeps, input: TickInput): Promise<TickResult> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const token = input.identity.token.toLowerCase();
  const startedAt = now();
  const tickId = deps.repos.ticks.start(token, input.spec.id, startedAt);
  deps.repos.minds.tickStarted(token, startedAt);
  const log = deps.log.child(`tick#${tickId}`);
  const usage = new TickUsage();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new TickTimeoutError(deps.config.timeoutMs)), deps.config.timeoutMs);
  timer.unref();
  const onShutdown = (): void => controller.abort(new Error('tick aborted (shutdown)'));
  if (input.signal?.aborted === true) onShutdown();
  input.signal?.addEventListener('abort', onShutdown, { once: true });
  const at = (): string => new Date(now()).toISOString();

  let session: TickBrowser | null = null;
  const publishFrame = (frame: { jpegBase64: string; url: string; at: string }): void => {
    try {
      deps.bus.publishFrame(token, frame);
      deps.repos.minds.setLastFrameAt(token, Date.parse(frame.at));
    } catch (err) {
      // a late frame (after shutdown closed the DB) must not become an unhandled rejection
      log.debug('frame not stored', { error: errorMessage(err) });
    }
  };
  const saveThought = (kind: 'aloud' | 'summary', text: string): void => {
    const row = deps.repos.ticks.insertThought(token, tickId, kind, text, now());
    deps.bus.publish(token, { type: 'thoughtSaved', thought: thoughtDto(row) });
  };

  const tools = createMindTools({
    browser: async () => {
      if (session === null) {
        session = await deps.browser(token);
        session.startFrames(deps.config.frameFps, publishFrame);
      }
      return session;
    },
    egress: deps.egress,
    remember: (kind, content, url) => deps.memory.remember(token, kind, content, url, tickId),
    recall: (query, limit) => deps.memory.recall(token, query, limit),
    thinkAloud: (text) => saveThought('aloud', text),
    afterAction: () => {
      const s = session;
      if (s === null) return;
      try {
        const url = s.currentUrl();
        deps.repos.minds.setCurrentUrl(token, url === 'about:blank' ? null : url);
      } catch (err) {
        log.debug('current URL not stored', { error: errorMessage(err) });
      }
      void s
        .captureFrame()
        .then((f) => {
          if (f !== null) publishFrame(f);
        })
        .catch(() => undefined);
    },
    signal: controller.signal,
    toolTimeoutMs: deps.config.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    onToolTimeout: async (tool) => {
      // the page is wedged: drop this session, the next browse tool starts a fresh context
      const s = session;
      session = null;
      s?.stopFrames();
      log.warn('tool timed out; resetting the browser context', { tool });
      await deps.resetBrowser(token);
    },
  });
  const persistUsage = (): void => {
    const t = usage.totals;
    deps.repos.ticks.updateUsage(tickId, {
      servedModel: t.servedModel,
      iterations: t.iterations,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens,
      costUsdMicro: t.costUsdMicro,
    });
  };

  const memories = deps.memory.recent(token, 10).map((m) => ({ seq: m.seq, kind: m.kind, content: m.content }));
  const system = buildSystem(input.identity, {
    now: startedAt,
    vaultUsd: input.vaultUsd,
    runwayHours: input.runwayHours,
    maxTickCostUsd: deps.config.maxTickCostUsd,
    memories,
    currentUrl: input.currentUrl,
  });

  let status: TickStatus = 'ok';
  let failed = false;
  let stopReason: string | null = null;
  let error: string | null = null;
  let finalText = '';
  let started = 0;
  let jsonFailures = 0;
  let apiRetries = 0;
  let runner = deps.createRunner(buildTickParams(input.spec, tools, system, deps.config.maxIterations), { signal: controller.signal });

  outer: for (;;) {
    try {
      for await (const stream of abortable(runner, controller.signal)) {
        started++;
        const blocks = new Map<number, { kind: 'text' | 'thinking'; text: string }>();
        let partial: { model: string; usage: TokenUsage } | null = null;
        let message: Anthropic.Beta.BetaMessage;
        try {
          for await (const event of abortable(stream, controller.signal)) {
            switch (event.type) {
              case 'message_start':
                partial = { model: event.message.model, usage: { ...event.message.usage } };
                break;
              case 'message_delta':
                if (partial !== null) {
                  partial.usage = {
                    input_tokens: event.usage.input_tokens ?? partial.usage.input_tokens,
                    output_tokens: event.usage.output_tokens,
                    cache_read_input_tokens: event.usage.cache_read_input_tokens ?? partial.usage.cache_read_input_tokens ?? null,
                    cache_creation_input_tokens: event.usage.cache_creation_input_tokens ?? partial.usage.cache_creation_input_tokens ?? null,
                  };
                }
                break;
              case 'content_block_start':
                if (event.content_block.type === 'text' || event.content_block.type === 'thinking') blocks.set(event.index, { kind: event.content_block.type, text: '' });
                break;
              case 'content_block_delta': {
                const block = blocks.get(event.index);
                const fragment = event.delta.type === 'text_delta' ? event.delta.text : event.delta.type === 'thinking_delta' ? event.delta.thinking : null;
                if (block !== undefined && fragment !== null && fragment !== '') {
                  block.text += fragment;
                  deps.bus.publish(token, { type: 'thought', tickId, kind: block.kind, text: fragment, delta: true, at: at() });
                }
                break;
              }
              case 'content_block_stop': {
                const block = blocks.get(event.index);
                if (block !== undefined) {
                  deps.bus.publish(token, { type: 'thought', tickId, kind: block.kind, text: block.text, delta: false, at: at() });
                  blocks.delete(event.index);
                }
                break;
              }
              default:
                break;
            }
          }
          message = await raceAbort(stream.finalMessage(), controller.signal);
        } catch (err) {
          if (partial !== null) {
            usage.charge(partial.model, partial.usage);
            persistUsage();
          }
          throw err;
        }
        usage.charge(message.model, message.usage);
        persistUsage();
        stopReason = message.stop_reason;
        const toolUses = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
        for (const t of toolUses) deps.bus.publish(token, { type: 'action', tickId, tool: t.name, input: redactActionInput(t.input), at: at() });
        const text = message.content
          .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();
        if (text !== '') finalText = text;
        if (message.stop_reason === 'refusal') {
          status = 'refused';
          break outer;
        }
        if (message.stop_reason === 'max_tokens' && toolUses.length > 0) {
          status = 'failed';
          failed = true;
          error = 'max_tokens_with_tool_use';
          break outer;
        }
        if (shouldStopTick(usage.totals.costUsdMicro, deps.config)) {
          log.info('tick spend cap reached; stopping', { costUsdMicro: usage.totals.costUsdMicro });
          break outer;
        }
      }
      break;
    } catch (err) {
      if (controller.signal.aborted) {
        const timedOut = controller.signal.reason instanceof TickTimeoutError;
        status = timedOut ? 'timeout' : 'failed';
        failed = timedOut;
        error = errorMessage(controller.signal.reason);
        break;
      }
      const remaining = deps.config.maxIterations - started;
      if (isRetryable(err) && apiRetries < MAX_API_RETRIES && remaining > 0) {
        const delay = retryDelayMs(err, apiRetries++);
        log.warn('transient API error; retrying', { error: errorMessage(err), delayMs: delay, attempt: apiRetries });
        try {
          await sleep(delay, controller.signal);
        } catch {
          status = 'timeout';
          failed = true;
          error = errorMessage(controller.signal.reason);
          break;
        }
        runner = deps.createRunner({ ...(runner.params as TickParams), max_iterations: remaining }, { signal: controller.signal });
        continue;
      }
      if (isToolJsonError(err) && jsonFailures === 0 && remaining > 0) {
        jsonFailures++;
        log.warn('unparsable tool input JSON; re-issuing the turn', { error: errorMessage(err) });
        runner = deps.createRunner({ ...(runner.params as TickParams), max_iterations: remaining }, { signal: controller.signal });
        continue;
      }
      status = 'failed';
      failed = true;
      error = isToolJsonError(err) ? `tool_input_json: ${errorMessage(err)}` : errorMessage(err);
      break;
    }
  }

  clearTimeout(timer);
  input.signal?.removeEventListener('abort', onShutdown);
  // tools still running in the background see the abort and return at once
  if (!controller.signal.aborted) controller.abort(new Error('tick finished'));
  (session as TickBrowser | null)?.stopFrames();
  if (status === 'timeout') await raceAbort(deps.resetBrowser(token), AbortSignal.timeout(15_000)).catch(() => undefined);
  if (status === 'ok' && finalText !== '') saveThought('summary', finalText.slice(0, 4000));
  if (usage.unknownModels.size > 0) log.warn('charged unknown served model(s) at claude-fable-5-1 prices', { models: [...usage.unknownModels] });
  const totals = usage.totals;
  deps.repos.ticks.finish(tickId, {
    endedAt: now(),
    servedModel: totals.servedModel,
    iterations: totals.iterations,
    inputTokens: totals.inputTokens,
    outputTokens: totals.outputTokens,
    cacheReadTokens: totals.cacheReadTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    costUsdMicro: totals.costUsdMicro,
    stopReason,
    status,
    error,
  });
  log.info('tick finished', { status, stopReason, iterations: totals.iterations, costUsdMicro: totals.costUsdMicro, error });
  return { tickId, status, failed, stopReason, error, totals };
}
