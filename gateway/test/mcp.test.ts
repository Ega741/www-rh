import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { jsonRequest, makeHarness, WS1, type Harness } from './helpers.js';

describe('MCP over HTTP (stateless Streamable HTTP, JSON responses)', () => {
  let h: Harness;
  let key: string;
  const headers = (k: string): Record<string, string> => ({ authorization: `Bearer ${k}`, accept: 'application/json, text/event-stream' });
  let id = 0;
  const rpc = (method: string, params: unknown = {}) => ({ jsonrpc: '2.0', id: ++id, method, params });

  beforeAll(async () => {
    h = await makeHarness();
    key = h.key(WS1);
    h.credit(WS1, 5_000_000n);
  });
  afterAll(async () => h.close());

  it('rejects missing keys and non-POST methods', async () => {
    const anon = await h.app.request(jsonRequest('POST', '/mcp', rpc('tools/list'), { accept: 'application/json, text/event-stream' }));
    expect(anon.status).toBe(401);
    const get = await h.app.request('/mcp', { headers: headers(key) });
    expect(get.status).toBe(405);
  });

  it('initialize → tools/list → tools/call beagle_balance', async () => {
    const init = await h.app.request(jsonRequest('POST', '/mcp', rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }), headers(key)));
    expect(init.status).toBe(200);
    const initBody = (await init.json()) as { result: { serverInfo: { name: string }; protocolVersion: string } };
    expect(initBody.result.serverInfo.name).toBe('beagle');
    expect(init.headers.get('mcp-session-id')).toBeNull();

    const list = await h.app.request(jsonRequest('POST', '/mcp', rpc('tools/list'), headers(key)));
    expect(list.status).toBe(200);
    const tools = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(tools).toContain('beagle_balance');
    expect(tools).toContain('beagle_complete');
    expect(tools).toContain('beagle_open_budget');
    expect(tools).toHaveLength(10);

    const call = await h.app.request(jsonRequest('POST', '/mcp', rpc('tools/call', { name: 'beagle_balance', arguments: {} }), headers(key)));
    expect(call.status).toBe(200);
    const result = ((await call.json()) as { result: { isError?: boolean; structuredContent: Record<string, unknown> } }).result;
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent['balanceMicro']).toBe('5000000');
    expect(result.structuredContent['availableMicro']).toBe('5000000');
  });

  it('beagle_complete runs through the router and reports cost and balance', async () => {
    const call = await h.app.request(jsonRequest('POST', '/mcp', rpc('tools/call', { name: 'beagle_complete', arguments: { prompt: 'hello mcp', model: 'beagle/auto', max_tokens: 16 } }), headers(key)));
    expect(call.status).toBe(200);
    const result = ((await call.json()) as { result: { isError?: boolean; structuredContent: Record<string, unknown> } }).result;
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ text: 'echo: hello mcp', model: 'house/gpt-oss-20b', provider: 'house', paidBy: 'credit' });
    expect(BigInt(result.structuredContent['costMicro'] as string)).toBeGreaterThan(0n);
    expect(result.structuredContent['balanceMicro']).toBe(h.services.ledger.balance(WS1).toString());
  });

  it('wallet tools return unsigned steps with the key workspace, and errors carry gateway codes', async () => {
    const quote = await h.app.request(jsonRequest('POST', '/mcp', rpc('tools/call', { name: 'beagle_quote', arguments: { usd: 1 } }), headers(key)));
    const q = ((await quote.json()) as { result: { isError?: boolean; structuredContent: { error?: { code: string; status?: number } } } }).result;
    expect(q.isError).toBe(true);
    expect(q.structuredContent.error).toMatchObject({ code: 'price_unavailable', status: 503 });
    const buy = await h.app.request(jsonRequest('POST', '/mcp', rpc('tools/call', { name: 'beagle_buy_compute', arguments: { usd: 1 } }), headers(key)));
    const b = ((await buy.json()) as { result: { isError?: boolean; structuredContent: { error?: { code: string } } } }).result;
    expect(b.isError).toBe(true);
    expect(b.structuredContent.error?.code).toBe('not_configured');
    const status = await h.app.request(jsonRequest('POST', '/mcp', rpc('tools/call', { name: 'beagle_status', arguments: {} }), headers(key)));
    const s = ((await status.json()) as { result: { structuredContent: { chainId: number } } }).result;
    expect(s.structuredContent.chainId).toBe(31337);
    const models = await h.app.request(jsonRequest('POST', '/mcp', rpc('resources/read', { uri: 'beagle://models' }), headers(key)));
    const m = ((await models.json()) as { result: { contents: { text: string }[] } }).result;
    expect(m.contents[0]?.text).toContain('house/gpt-oss-20b');
  });
});
