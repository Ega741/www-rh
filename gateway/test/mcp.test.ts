import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GatewayError } from '../src/api/errors.js';
import { toApiError } from '../src/api/mcp.js';
import { ATA2, FakeRpc, jsonRequest, makeHarness, makeTokenAccount, MINT, OPERATOR, WS1, type Harness } from './helpers.js';

describe('MCP error mapping', () => {
  it('masks internal errors like the /v1 envelopes and keeps gateway codes', () => {
    const internal = toApiError(new Error('SQLITE_CONSTRAINT: usage.id /var/lib/beagle/gateway.sqlite'));
    expect(internal).toMatchObject({ name: 'BeagleApiError', status: 500, code: 'internal_error', message: 'Internal error.' });
    expect(internal.message).not.toContain('SQLITE');
    expect(toApiError(new TypeError("Cannot read properties of undefined (reading 'x')")).message).toBe('Internal error.');
    expect(toApiError(new GatewayError('model_not_found', 'Unknown model "x".'))).toMatchObject({ status: 404, code: 'model_not_found', message: 'Unknown model "x".' });
  });
});

describe('MCP over HTTP (stateless Streamable HTTP, JSON responses)', () => {
  let h: Harness;
  let rpc: FakeRpc;
  let key: string;
  const headers = (k: string): Record<string, string> => ({ authorization: `Bearer ${k}`, accept: 'application/json, text/event-stream' });
  let id = 0;
  const rpcCall = (method: string, params: unknown = {}) => ({ jsonrpc: '2.0', id: ++id, method, params });
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ isError?: boolean; structuredContent: Record<string, unknown> }> => {
    const res = await h.app.request(jsonRequest('POST', '/mcp', rpcCall('tools/call', { name, arguments: args }), headers(key)));
    expect(res.status).toBe(200);
    return ((await res.json()) as { result: { isError?: boolean; structuredContent: Record<string, unknown> } }).result;
  };

  beforeAll(async () => {
    rpc = new FakeRpc();
    h = await makeHarness({}, {}, true, { rpc });
    key = h.key(WS1);
    h.credit(WS1, 5_000_000n);
  });
  afterAll(async () => h.close());

  it('rejects missing keys and non-POST methods', async () => {
    const anon = await h.app.request(jsonRequest('POST', '/mcp', rpcCall('tools/list'), { accept: 'application/json, text/event-stream' }));
    expect(anon.status).toBe(401);
    const get = await h.app.request('/mcp', { headers: headers(key) });
    expect(get.status).toBe(405);
  });

  it('initialize → tools/list → tools/call beagle_balance', async () => {
    const init = await h.app.request(jsonRequest('POST', '/mcp', rpcCall('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } }), headers(key)));
    expect(init.status).toBe(200);
    const initBody = (await init.json()) as { result: { serverInfo: { name: string }; protocolVersion: string } };
    expect(initBody.result.serverInfo.name).toBe('beagle');
    expect(init.headers.get('mcp-session-id')).toBeNull();

    const list = await h.app.request(jsonRequest('POST', '/mcp', rpcCall('tools/list'), headers(key)));
    expect(list.status).toBe(200);
    const tools = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    for (const name of ['beagle_balance', 'beagle_complete', 'beagle_buy_compute', 'beagle_open_budget', 'beagle_close_budget', 'beagle_budgets', 'beagle_status']) expect(tools).toContain(name);

    const result = await call('beagle_balance');
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent['balanceMicro']).toBe('5000000');
    expect(result.structuredContent['availableMicro']).toBe('5000000');
    expect(result.structuredContent['price']).toMatchObject({ pricePointId: 1, stale: false });
  });

  it('beagle_complete runs through the router and reports cost and balance', async () => {
    const result = await call('beagle_complete', { prompt: 'hello mcp', model: 'beagle/auto', max_tokens: 16 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ text: 'echo: hello mcp', model: 'house/gpt-oss-20b', provider: 'house', paidBy: 'credit' });
    expect(BigInt(result.structuredContent['costMicro'] as string)).toBeGreaterThan(0n);
    expect(result.structuredContent['balanceMicro']).toBe(h.services.ledger.balance(WS1).toString());
  });

  it('quote, status and budgets use the in-process api; errors carry gateway codes; resources read', async () => {
    const quote = await call('beagle_quote', { usd: 1 });
    expect(quote.isError).toBeUndefined();
    expect(quote.structuredContent).toMatchObject({ tokens: '100000000', usdMicro: '1000000', pricePointId: 1 });
    const status = await call('beagle_status');
    expect(status.structuredContent).toMatchObject({ cluster: 'localnet', mint: MINT, operator: { address: OPERATOR } });
    expect(await call('beagle_budgets')).toMatchObject({ structuredContent: expect.anything() });
    // registerBudget through the in-process api (the key's workspace is the owner here)
    rpc.accounts.set(ATA2, makeTokenAccount({ owner: WS1, amount: 10n ** 9n, delegate: OPERATOR, delegatedAmount: 10n ** 9n }));
    const budgets = h.services.repos.budgets;
    expect(budgets.get(ATA2)).toBeUndefined();
    const { createInProcessBeagleApi } = await import('../src/api/mcp.js');
    const api = createInProcessBeagleApi(h.services, WS1, null, 'free');
    const registered = await api.registerBudget({ tokenAccount: ATA2 });
    expect(registered).toMatchObject({ tokenAccount: ATA2, owner: WS1, workspace: WS1, cap: 10n ** 9n, headroomMicro: 10_000_000n });
    expect((await api.budgets()).map((b) => b.tokenAccount)).toEqual([ATA2]);
    await expect(api.registerBudget({ tokenAccount: ATA2, workspace: 'x' })).rejects.toMatchObject({ name: 'BeagleApiError' });
    expect((await api.price()).pricePointId).toBe(1);
    expect((await api.priceHistory({ limit: 3 })).length).toBe(1);
    expect((await api.receipts({ limit: 5 })).rows).toEqual([]);
    const upgrade = await call('beagle_upgrade', { kind: 'pro', quantity: 1 });
    expect(upgrade.isError).toBe(true);
    expect(upgrade.structuredContent['error']).toMatchObject({ code: 'insufficient_credit', status: 402 });
    const models = await h.app.request(jsonRequest('POST', '/mcp', rpcCall('resources/read', { uri: 'beagle://models' }), headers(key)));
    const m = ((await models.json()) as { result: { contents: { text: string }[] } }).result;
    expect(m.contents[0]?.text).toContain('house/gpt-oss-20b');
  });
});
