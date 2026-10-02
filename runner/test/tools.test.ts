import { describe, expect, it } from 'vitest';
import { MODELS, modelSpec, type Memory } from '@www-rh/shared';
import type { EgressFilter } from '../src/browser/egress.js';
import type { MindBrowserApi } from '../src/browser/mindBrowser.js';
import { buildSystem, stablePrefix, TICK_PROMPT, type PersonaIdentity } from '../src/mind/persona.js';
import { buildTickParams, FALLBACK_BETA } from '../src/mind/request.js';
import { createMindTools, serializeToolDefinitions, TOOL_NAMES, type ToolContext } from '../src/mind/tools.js';

const page = { url: 'https://example.com/', title: 'Example', text: 'Example Domain', links: [{ i: 0, text: 'More', href: 'https://iana.org/' }] };

function fakeBrowser(calls: string[]): MindBrowserApi {
  return {
    currentUrl: () => 'https://example.com/',
    navigate: async (url) => (calls.push(`navigate ${url}`), page),
    read: async () => (calls.push('read'), page),
    click: async (t) => (calls.push(`click ${JSON.stringify(t)}`), page),
    type: async (s, t, submit) => (calls.push(`type ${s} ${t} ${submit}`), page),
    scroll: async (d) => (calls.push(`scroll ${d}`), page),
    back: async () => (calls.push('back'), page),
    screenshot: async () => (calls.push('screenshot'), '/9j/AAAA'),
  };
}

const allowAll: EgressFilter = {
  checkUrl: async (url) => ({ ok: true, url: new URL(url), addresses: ['93.184.216.34'] }),
  checkHost: async () => ({ ok: true, addresses: ['93.184.216.34'] }),
};
const blockAll: EgressFilter = {
  checkUrl: async () => ({ ok: false, reason: 'blocked address 10.0.0.1 (private)' }),
  checkHost: async () => ({ ok: false, reason: 'private' }),
};

function ctx(egress: EgressFilter, calls: string[], aloud: string[] = []): ToolContext {
  let seq = 0;
  const mem = (content: string): Memory => ({ seq: ++seq, kind: 'note', content, url: null, createdAt: new Date(0).toISOString(), contentHash: `0x${'00'.repeat(32)}`, anchorTx: null });
  return {
    browser: async () => fakeBrowser(calls),
    egress,
    remember: (_kind, content) => mem(content),
    recall: () => [mem('old finding')],
    thinkAloud: (text) => aloud.push(text),
    afterAction: () => calls.push('frame'),
  };
}

type Runnable = { parse(input: unknown): unknown; run(input: unknown): Promise<string | unknown[]> };

const byName = (tools: ReturnType<typeof createMindTools>, name: string): Runnable => {
  const tool = tools.find((t) => 'name' in t && t.name === name);
  if (tool === undefined) throw new Error(`no tool ${name}`);
  return tool as unknown as Runnable;
};

describe('mind tools (SPEC §4.1 tools.ts)', () => {
  it('fixed order, eager input streaming, object schemas, byte-identical definitions for every mind', () => {
    const a = createMindTools(ctx(allowAll, []));
    const b = createMindTools(ctx(blockAll, []));
    expect(a.map((t) => ('name' in t ? t.name : ''))).toEqual(TOOL_NAMES);
    expect(TOOL_NAMES).toEqual(['browse_navigate', 'browse_read', 'browse_click', 'browse_type', 'browse_scroll', 'browse_back', 'browse_screenshot', 'remember', 'recall', 'think_aloud']);
    for (const t of a) {
      expect(t.eager_input_streaming).toBe(true);
      expect('input_schema' in t && (t.input_schema as { type: string }).type).toBe('object');
    }
    expect(serializeToolDefinitions(a)).toBe(serializeToolDefinitions(b));
    expect(serializeToolDefinitions(a)).not.toContain('run');
  });

  it.each([
    ['browse_navigate', { url: 'https://example.com/a' }, true],
    ['browse_navigate', { url: 'ftp://example.com/a' }, false],
    ['browse_navigate', { url: 'javascript:alert(1)' }, false],
    ['browse_navigate', { url: `https://example.com/${'a'.repeat(2050)}` }, false],
    ['browse_navigate', {}, false],
    ['browse_click', { link: 3 }, true],
    ['browse_click', { selector: 'a.next' }, true],
    ['browse_click', { link: 1, selector: 'a' }, false],
    ['browse_click', {}, false],
    ['browse_click', { link: -1 }, false],
    ['browse_type', { selector: 'input[name=q]', text: 'robinhood chain', submit: true }, true],
    ['browse_type', { selector: 'input', text: 'x'.repeat(501) }, false],
    ['browse_scroll', { direction: 'down' }, true],
    ['browse_scroll', { direction: 'left' }, false],
    ['remember', { kind: 'finding', content: 'L2 blocks are 100 ms', url: 'https://docs.robinhood.com/chain' }, true],
    ['remember', { kind: 'thought', content: 'x' }, false],
    ['remember', { kind: 'note', content: '' }, false],
    ['remember', { kind: 'note', content: 'x'.repeat(2001) }, false],
    ['remember', { kind: 'note', content: 'x', url: 'file:///etc/passwd' }, false],
    ['recall', { query: 'trains' }, true],
    ['recall', { query: 'trains', limit: 21 }, false],
    ['recall', { query: '' }, false],
    ['think_aloud', { text: 'Reading about Arbitrum Orbit.' }, true],
    ['think_aloud', { text: 'x'.repeat(281) }, false],
  ])('%s %j → valid=%s', (name, input, valid) => {
    const tool = byName(createMindTools(ctx(allowAll, [])), name);
    const parse = (): unknown => tool.parse(input);
    if (valid) expect(parse).not.toThrow();
    else expect(parse).toThrow();
  });

  it('run: blocked URLs return an error result without touching the browser; actions capture a frame', async () => {
    const calls: string[] = [];
    const blocked = await byName(createMindTools(ctx(blockAll, calls)), 'browse_navigate').run({ url: 'http://internal.example/' });
    expect(blocked).toMatch(/^error: blocked URL/);
    expect(calls).toEqual([]);
    const ok = await byName(createMindTools(ctx(allowAll, calls)), 'browse_navigate').run({ url: 'https://example.com/' });
    expect(JSON.parse(ok as string)).toEqual(page);
    expect(calls).toEqual(['navigate https://example.com/', 'frame']);
  });

  it('run: screenshot is an image block; memory and think_aloud results', async () => {
    const calls: string[] = [];
    const aloud: string[] = [];
    const tools = createMindTools(ctx(allowAll, calls, aloud));
    expect(await byName(tools, 'browse_screenshot').run({})).toEqual([{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/AAAA' } }]);
    expect(await byName(tools, 'remember').run({ kind: 'note', content: 'hello' })).toBe('{"seq":1}');
    expect(JSON.parse((await byName(tools, 'recall').run({ query: 'old' })) as string)[0].content).toBe('old finding');
    expect(await byName(tools, 'think_aloud').run({ text: 'hi' })).toBe('ok');
    expect(aloud).toEqual(['hi']);
  });

  it('run never throws: browser failures become error results', async () => {
    const tools = createMindTools({ ...ctx(allowAll, []), browser: async () => ({ ...fakeBrowser([]), read: async () => { throw new Error('Timeout 15000ms exceeded'); } }) });
    expect(await byName(tools, 'browse_read').run({})).toBe('error: Timeout 15000ms exceeded');
  });
});

describe('request-shape builder per model', () => {
  const identity: PersonaIdentity = { token: '0x1111111111111111111111111111111111111111', name: 'Mind', symbol: 'MIND', modelId: `0x${'aa'.repeat(32)}`, personaHash: `0x${'bb'.repeat(32)}`, verifiedPersona: 'You love maps.' };
  const system = buildSystem(identity, { now: Date.UTC(2026, 9, 2, 10, 0), vaultUsd: 12.5, runwayHours: 40, maxTickCostUsd: 0.25, memories: [{ seq: 1, kind: 'note', content: 'hello' }], currentUrl: null });
  const tools = createMindTools(ctx(allowAll, []));

  it.each(MODELS.filter((m) => m.id !== 'claude-haiku-4-5').map((m) => m.id))('%s: adaptive thinking, medium effort, server-side fallbacks', (id) => {
    const p = buildTickParams(modelSpec(id)!, tools, system, 8);
    expect(p.model).toBe(id);
    expect(p.max_tokens).toBe(16000);
    expect(p.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(p.output_config).toEqual({ effort: 'medium' });
    expect(p.betas).toEqual([FALLBACK_BETA]);
    expect(p.fallbacks).toBe('default');
    expect(p.stream).toBe(true);
    expect(p.max_iterations).toBe(8);
    expect(p.cache_control).toEqual({ type: 'ephemeral' });
    expect(p.messages).toEqual([{ role: 'user', content: TICK_PROMPT }]);
    expect('tool_choice' in p).toBe(false);
    expect(Object.keys(p).indexOf('tools')).toBeLessThan(Object.keys(p).indexOf('system'));
  });

  it('claude-haiku-4-5: budget thinking, 8192 max tokens, no effort, no fallbacks', () => {
    const p = buildTickParams(modelSpec('claude-haiku-4-5')!, tools, system, 4);
    expect(p.max_tokens).toBe(8192);
    expect(p.thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
    expect('output_config' in p).toBe(false);
    expect('betas' in p).toBe(false);
    expect('fallbacks' in p).toBe(false);
    expect('tool_choice' in p).toBe(false);
  });

  it('system = cached stable prefix (deterministic, no volatile data) + dynamic trailer', () => {
    expect(system).toHaveLength(2);
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(system[1]?.cache_control).toBeUndefined();
    expect(system[0]?.text).toBe(stablePrefix(identity));
    expect(system[0]?.text).toContain('You are the mind of $MIND (Mind)');
    expect(system[0]?.text).toContain('You love maps.');
    expect(system[0]?.text).not.toMatch(/2026|\$12\.50|runway/);
    expect(system[1]?.text).toContain('2026-10-02 10:00 UTC');
    expect(system[1]?.text).toContain('$12.50');
    expect(stablePrefix({ ...identity, verifiedPersona: null })).toContain('No persona was provided.');
  });
});
