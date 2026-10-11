import { CREDIT_DESK_ABI, ERC20_ABI } from '@beagle/shared/abi';
import { tokensForUsdMicro } from '@beagle/shared/credit';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { decodeFunctionData, getAddress, type Hex } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import { BeagleApiError } from '../src/api.js';
import { BEAGLE_TOOL_NAMES, createBeagleMcpServer, type BeagleMcpServerOptions } from '../src/server.js';
import { WalletError, type WalletExecutor } from '../src/wallet.js';
import { createFakeApi, DESK, NOW_MS, PRICE_E18, TOKEN, WORKSPACE, type FakeApi } from './fake-api.js';

const TX = `0x${'ab'.repeat(32)}` as Hex;
const APPROVE_TX = `0x${'cd'.repeat(32)}` as Hex;
const AGENT = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

async function connect(api: FakeApi, opts: BeagleMcpServerOptions = {}) {
  const server = createBeagleMcpServer(api, { now: () => NOW_MS, ...opts });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'beagle-mcp-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

function structured(result: CallToolResult): Record<string, unknown> {
  expect(result.isError ?? false).toBe(false);
  expect(result.structuredContent).toBeDefined();
  const text = result.content.find((c) => c.type === 'text');
  expect(text?.type).toBe('text');
  expect(JSON.parse((text as { text: string }).text)).toEqual(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function errorOf(result: CallToolResult): { code: string; message: string; status?: number } {
  expect(result.isError).toBe(true);
  const sc = result.structuredContent as { error: { code: string; message: string; status?: number } };
  expect(sc.error).toBeDefined();
  const text = result.content[0];
  expect(text?.type).toBe('text');
  expect(JSON.parse((text as { text: string }).text)).toEqual(sc);
  return sc.error;
}

function fakeWallet(overrides: Partial<WalletExecutor> = {}): WalletExecutor & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    address: AGENT,
    async buyCompute(params) {
      calls.push({ buyCompute: params });
      return { txHash: TX, receiptId: 42n, approveTxHash: APPROVE_TX };
    },
    async openBudget(params) {
      calls.push({ openBudget: params });
      return { txHash: TX, budgetId: 7n };
    },
    ...overrides,
  };
}

describe('tools/list', () => {
  it('exposes exactly the ten tools of SPEC §6.3 with descriptions and object input schemas', async () => {
    const client = await connect(createFakeApi());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...BEAGLE_TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }
    const budget = tools.find((t) => t.name === 'beagle_open_budget')!;
    const hours = (budget.inputSchema.properties as Record<string, { maximum?: number }>)['hours'];
    expect(hours?.maximum).toBe(720);
    expect(tools.find((t) => t.name === 'beagle_balance')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'beagle_buy_compute')?.annotations?.readOnlyHint).toBe(false);
  });

  it('reports server info and instructions', async () => {
    const client = await connect(createFakeApi());
    expect(client.getServerVersion()?.name).toBe('beagle');
    expect(client.getInstructions()).toMatch(/beagle_balance/);
  });
});

describe('read-only tools', () => {
  it('beagle_balance returns the DTO with bigints as strings plus a human summary', async () => {
    const client = await connect(createFakeApi());
    const data = structured(await call(client, 'beagle_balance'));
    expect(data['availableMicro']).toBe('12340000');
    expect(data['balanceMicro']).toBe('12340000');
    expect(data['plan']).toBe('free');
    expect((data['price'] as Record<string, unknown>)['priceE18']).toBe(PRICE_E18.toString());
    expect(data['summary']).toBe('$12.34 available; plan free; 1 BEAGLE = $0.0100');
  });

  it('beagle_models lists the catalog with aliases and filters by tier', async () => {
    const client = await connect(createFakeApi());
    const all = structured(await call(client, 'beagle_models'));
    const models = all['models'] as Array<Record<string, unknown>>;
    expect(models.length).toBe(12);
    expect((all['aliases'] as Array<{ id: string }>).map((a) => a.id)).toContain('beagle/auto');
    const first = models[0]!;
    expect(first['priceHuman']).toEqual({ input: '$4.00/1M', output: '$20.00/1M', cacheRead: '$0.20/1M', cacheWrite: '$5.00/1M' });
    expect(first['available']).toBe(true);

    const budget = structured(await call(client, 'beagle_models', { tier: 'budget' }));
    const ids = (budget['models'] as Array<{ id: string; tier: string }>).map((m) => m.id);
    expect(ids).toEqual(['anthropic/claude-haiku-5-5', 'openai/gpt-5.4-nano', 'google/gemini-3.1-flash-lite']);
    expect(budget['count']).toBe(3);
  });

  it('beagle_models rejects an unknown tier through the zod schema', async () => {
    const client = await connect(createFakeApi());
    const result = await call(client, 'beagle_models', { tier: 'ultra' });
    expect(result.isError).toBe(true);
  });

  it('beagle_quote prices USD in tokens and tokens in USD', async () => {
    const api = createFakeApi();
    const client = await connect(api);
    const byUsd = structured(await call(client, 'beagle_quote', { usd: 5 }));
    expect(byUsd['tokens']).toBe((500n * 10n ** 18n).toString());
    expect(byUsd['usdMicro']).toBe('5000000');
    expect(byUsd['tokensFormatted']).toBe('500 BEAGLE');
    expect(byUsd['usd']).toBe('$5.00');
    expect(byUsd['usdPerToken']).toBe('$0.0100');

    const byTokens = structured(await call(client, 'beagle_quote', { tokens: '1000.5' }));
    expect(byTokens['tokens']).toBe((10005n * 10n ** 17n).toString());
    expect(byTokens['usdMicro']).toBe('10005000');

    const byUsdString = structured(await call(client, 'beagle_quote', { usd: '$0.25' }));
    expect(byUsdString['usdMicro']).toBe('250000');
  });

  it('beagle_quote needs exactly one of usd / tokens', async () => {
    const client = await connect(createFakeApi());
    expect(errorOf(await call(client, 'beagle_quote', {})).code).toBe('invalid_request');
    expect(errorOf(await call(client, 'beagle_quote', { usd: 1, tokens: 1 })).code).toBe('invalid_request');
    expect(errorOf(await call(client, 'beagle_quote', { usd: -3 })).code).toBe('invalid_request');
    expect(errorOf(await call(client, 'beagle_quote', { tokens: 'abc' })).code).toBe('invalid_request');
  });

  it('beagle_usage returns rows and the summary for the requested window', async () => {
    const api = createFakeApi();
    const client = await connect(api);
    const data = structured(await call(client, 'beagle_usage', { limit: 1, window: '7d' }));
    expect((data['rows'] as unknown[]).length).toBe(1);
    const summary = data['summary'] as Record<string, unknown>;
    expect(summary['window']).toBe('7d');
    expect(summary['chargedMicro']).toBe('12');
    expect(data['text']).toMatch(/^2 requests in 7d/);
    expect(api.state.calls.find((c) => c.method === 'usage')?.args[0]).toEqual({ limit: 1, window: '7d' });
  });

  it('beagle_budgets lists budgets with formatted amounts and total headroom', async () => {
    const client = await connect(createFakeApi());
    const data = structured(await call(client, 'beagle_budgets'));
    const budgets = data['budgets'] as Array<Record<string, unknown>>;
    expect(budgets.length).toBe(1);
    expect(budgets[0]!['budgetId']).toBe(3);
    expect(budgets[0]!['cap']).toBe((500n * 10n ** 18n).toString());
    expect(budgets[0]!['capFormatted']).toBe('500 BEAGLE');
    expect(budgets[0]!['headroomFormatted']).toBe('400 BEAGLE ($4.00)');
    expect((budgets[0]!['draws'] as unknown[]).length).toBe(1);
    expect(data['headroomMicro']).toBe('4000000');
    expect(data['headroom']).toBe('$4.00');
  });

  it('beagle_status returns the status DTO', async () => {
    const client = await connect(createFakeApi());
    const data = structured(await call(client, 'beagle_status'));
    expect(data['chainId']).toBe(31337);
    expect(data['creditDesk']).toBe(DESK);
    expect((data['providers'] as Record<string, { state: string }>)['google']?.state).toBe('down');
  });
});

describe('beagle_complete', () => {
  it('runs a prompt through beagle/auto and reports cost and balance from the metadata', async () => {
    const api = createFakeApi();
    const client = await connect(api);
    const data = structured(await call(client, 'beagle_complete', { prompt: 'hi there', max_tokens: 64, difficulty: 0.9 }));
    expect(data['text']).toBe('echo: hi there');
    expect(data['model']).toBe('house/gpt-oss-20b');
    expect(data['provider']).toBe('house');
    expect(data['paidBy']).toBe('credit');
    expect(data['costMicro']).toBe('1500');
    expect(data['cost']).toBe('$0.0015');
    expect(data['balanceMicro']).toBe((12_340_000n - 1_500n).toString());
    expect(data['finishReason']).toBe('stop');
    expect(data['requestId']).toBe('req_1');
    expect(data['route']).toEqual(['alias beagle/auto → tier budget', 'fallback house']);
    const completeCall = api.state.calls.find((c) => c.method === 'complete')!;
    const req = completeCall.args[0] as { model: string; messages: unknown[]; max_tokens?: number };
    expect(req.model).toBe('beagle/auto');
    expect(req.messages).toEqual([{ role: 'user', content: 'hi there' }]);
    expect(req.max_tokens).toBe(64);
    expect(completeCall.args[1]).toEqual({ difficulty: 0.9 });
    // balance() was not needed: the metadata carried the balance
    expect(api.callsTo('balance')).toBe(0);
  });

  it('accepts system + messages and an explicit model', async () => {
    const api = createFakeApi();
    const client = await connect(api);
    const data = structured(
      await call(client, 'beagle_complete', {
        system: 'be terse',
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
          { role: 'user', content: 'c' },
        ],
        model: 'anthropic/claude-haiku-5-5',
      }),
    );
    expect(data['text']).toBe('echo: c');
    const req = api.state.calls.find((c) => c.method === 'complete')!.args[0] as { model: string; messages: Array<{ role: string }> };
    expect(req.model).toBe('anthropic/claude-haiku-5-5');
    expect(req.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
  });

  it('falls back to balance() when the implementation attaches no metadata', async () => {
    const api = createFakeApi({ completionMeta: false });
    const client = await connect(api);
    const data = structured(await call(client, 'beagle_complete', { prompt: 'x' }));
    expect(data['costMicro']).toBeNull();
    expect(data['paidBy']).toBeNull();
    expect(data['provider']).toBe('house');
    expect(data['balanceMicro']).toBe((12_340_000n - 1_500n).toString());
    expect(api.callsTo('balance')).toBe(1);
  });

  it('requires prompt or messages', async () => {
    const client = await connect(createFakeApi());
    const error = errorOf(await call(client, 'beagle_complete', { system: 'only system' }));
    expect(error.code).toBe('invalid_request');
    expect(error.message).toMatch(/prompt or messages/);
  });

  it('surfaces gateway errors with their code and status', async () => {
    const api = createFakeApi({
      failures: { complete: new BeagleApiError(402, 'insufficient_credit', 'Insufficient credit: burn BEAGLE on the Credits page or open a budget.') },
    });
    const client = await connect(api);
    const error = errorOf(await call(client, 'beagle_complete', { prompt: 'x' }));
    expect(error).toEqual({ code: 'insufficient_credit', status: 402, message: 'Insufficient credit: burn BEAGLE on the Credits page or open a budget.' });
  });
});

describe('errors', () => {
  it('maps BeagleApiError to isError results carrying the gateway code', async () => {
    const api = createFakeApi({ failures: { balance: new BeagleApiError(401, 'invalid_api_key', 'revoked') } });
    const client = await connect(api);
    expect(errorOf(await call(client, 'beagle_balance'))).toEqual({ code: 'invalid_api_key', status: 401, message: 'revoked' });
  });

  it('maps unknown errors to internal_error', async () => {
    const api = createFakeApi({ failures: { status: new Error('boom') } });
    const client = await connect(api);
    expect(errorOf(await call(client, 'beagle_status'))).toEqual({ code: 'internal_error', message: 'boom' });
  });
});

describe('beagle_upgrade', () => {
  it('buys pro and returns the upgrade row', async () => {
    const api = createFakeApi({ balanceMicro: 25_000_000n });
    const client = await connect(api);
    const data = structured(await call(client, 'beagle_upgrade', { kind: 'pro' }));
    expect(data['kind']).toBe('pro');
    expect(data['quantity']).toBe(1);
    expect(data['amountMicro']).toBe('20000000');
    expect(data['amount']).toBe('$20.00');
    expect(api.state.balanceMicro).toBe(5_000_000n);
    expect(api.state.plan).toBe('pro');
  });

  it('passes the quantity for warm hours and reports 402 when short', async () => {
    const api = createFakeApi({ balanceMicro: 5_000_000n });
    const client = await connect(api);
    const ok = structured(await call(client, 'beagle_upgrade', { kind: 'warm', quantity: 2 }));
    expect(ok['amountMicro']).toBe('4000000');
    const error = errorOf(await call(client, 'beagle_upgrade', { kind: 'warm', quantity: 5 }));
    expect(error.code).toBe('insufficient_credit');
    expect(error.status).toBe(402);
  });
});

describe('beagle_buy_compute without a wallet', () => {
  it('returns unsigned approve + burnForCredit steps with decodable calldata', async () => {
    const api = createFakeApi();
    const client = await connect(api);
    const data = structured(await call(client, 'beagle_buy_compute', { usd: 5, workspace: WORKSPACE }));
    expect(data['unsigned']).toBe(true);
    expect(data['chainId']).toBe(31337);
    const expectedTokens = tokensForUsdMicro(5_000_000n, PRICE_E18);
    expect(data['tokens']).toBe(expectedTokens.toString());
    expect(data['usdMicro']).toBe('5000000');
    expect(data['workspace']).toBe(getAddress(WORKSPACE));
    const steps = data['steps'] as Array<{ to: string; data: Hex; value: string; description: string }>;
    expect(steps.length).toBe(2);
    expect(steps.every((s) => s.value === '0')).toBe(true);

    expect(steps[0]!.to).toBe(TOKEN);
    const approve = decodeFunctionData({ abi: ERC20_ABI, data: steps[0]!.data });
    expect(approve.functionName).toBe('approve');
    expect(approve.args).toEqual([DESK, expectedTokens]);
    expect(steps[0]!.description).toMatch(/approve 500 BEAGLE/);

    expect(steps[1]!.to).toBe(DESK);
    const burn = decodeFunctionData({ abi: CREDIT_DESK_ABI, data: steps[1]!.data });
    expect(burn.functionName).toBe('burnForCredit');
    expect(burn.args).toEqual([getAddress(WORKSPACE), expectedTokens]);
    expect(data['note']).toMatch(/\$5\.00/);
    // the quote came from the api
    expect(api.state.calls.find((c) => c.method === 'quote')?.args[0]).toEqual({ usdMicro: 5_000_000n });
  });

  it('accepts a token amount and uses the configured default workspace', async () => {
    const api = createFakeApi();
    const client = await connect(api, { workspace: WORKSPACE });
    const data = structured(await call(client, 'beagle_buy_compute', { tokens: 250 }));
    expect(data['tokens']).toBe((250n * 10n ** 18n).toString());
    expect(data['usdMicro']).toBe('2500000');
    expect(data['workspace']).toBe(getAddress(WORKSPACE));
  });

  it('needs a workspace when none can be inferred', async () => {
    const client = await connect(createFakeApi());
    const error = errorOf(await call(client, 'beagle_buy_compute', { usd: 1 }));
    expect(error.code).toBe('invalid_request');
    expect(error.message).toMatch(/workspace is required/);
  });

  it('fails cleanly when the gateway has no deployment configured', async () => {
    const api = createFakeApi();
    api.state.config = { ...api.state.config, creditDesk: null, token: null };
    const client = await connect(api);
    const error = errorOf(await call(client, 'beagle_buy_compute', { usd: 1, workspace: WORKSPACE }));
    expect(error.code).toBe('not_configured');
    expect(error.status).toBe(503);
  });

  it('rejects a malformed workspace address through the schema', async () => {
    const client = await connect(createFakeApi());
    const result = await call(client, 'beagle_buy_compute', { usd: 1, workspace: 'not-an-address' });
    expect(result.isError).toBe(true);
  });
});

describe('beagle_buy_compute with a wallet', () => {
  it('executes the purchase and polls the balance until the credit appears', async () => {
    const api = createFakeApi();
    api.scheduleCredit(5_000_000n, 3); // visible on the third balance() call after the burn
    const wallet = fakeWallet();
    const client = await connect(api, { wallet, pollIntervalMs: 1, creditWaitMs: 5_000, now: () => Date.now() });
    const data = structured(await call(client, 'beagle_buy_compute', { usd: 5 }));
    expect(data['executed']).toBe(true);
    expect(data['txHash']).toBe(TX);
    expect(data['approveTxHash']).toBe(APPROVE_TX);
    expect(data['receiptId']).toBe('42');
    expect(data['credited']).toBe(true);
    expect(data['creditedMicro']).toBe('5000000');
    expect(data['balanceMicro']).toBe((12_340_000n + 5_000_000n).toString());
    expect(data['workspace']).toBe(AGENT); // defaults to the agent wallet
    expect(data['explorerTxUrl']).toBeNull();
    expect(wallet.calls).toEqual([{ buyCompute: { workspace: AGENT, tokens: 500n * 10n ** 18n } }]);
    // one balance read before the burn, then polling until credited (visible on the third call overall)
    expect(api.callsTo('balance')).toBe(3);
    expect(data['note']).toBe('Credited $5.00.');
  });

  it('reports a pending credit when the indexer has not caught up in time', async () => {
    const api = createFakeApi();
    const client = await connect(api, { wallet: fakeWallet(), pollIntervalMs: 1, creditWaitMs: 15, now: () => Date.now() });
    const data = structured(await call(client, 'beagle_buy_compute', { tokens: 10, workspace: WORKSPACE }));
    expect(data['executed']).toBe(true);
    expect(data['credited']).toBe(false);
    expect(data['creditedMicro']).toBeNull();
    expect(data['note']).toMatch(/not visible/);
    expect(api.callsTo('balance')).toBeGreaterThan(1);
  });

  it('skips polling when waitForCredit is false', async () => {
    const api = createFakeApi();
    const client = await connect(api, { wallet: fakeWallet(), waitForCredit: false });
    const data = structured(await call(client, 'beagle_buy_compute', { usd: 1 }));
    expect(data['executed']).toBe(true);
    expect(data['credited']).toBe(false);
    expect(api.callsTo('balance')).toBe(1);
  });

  it('builds an explorer link from the gateway config', async () => {
    const api = createFakeApi();
    api.state.config = { ...api.state.config, explorer: 'https://explorer.example/' };
    const client = await connect(api, { wallet: fakeWallet(), waitForCredit: false });
    const data = structured(await call(client, 'beagle_buy_compute', { usd: 1 }));
    expect(data['explorerTxUrl']).toBe(`https://explorer.example/tx/${TX}`);
  });

  it('maps wallet failures to isError with the wallet code', async () => {
    const wallet = fakeWallet({
      async buyCompute() {
        throw new WalletError('tx_reverted', 'burnForCredit reverted (tx 0x01)', { txHash: TX });
      },
    });
    const client = await connect(createFakeApi(), { wallet });
    const error = errorOf(await call(client, 'beagle_buy_compute', { usd: 1 }));
    expect(error.code).toBe('tx_reverted');
    expect((error as { txHash?: string }).txHash).toBe(TX);
  });
});

describe('beagle_open_budget', () => {
  it('returns unsigned approve + openBudget steps with the deadline derived from hours', async () => {
    const client = await connect(createFakeApi());
    const data = structured(await call(client, 'beagle_open_budget', { usd: '10', hours: 24, workspace: WORKSPACE }));
    expect(data['unsigned']).toBe(true);
    const cap = 1000n * 10n ** 18n;
    expect(data['cap']).toBe(cap.toString());
    expect(data['capFormatted']).toBe('1000 BEAGLE');
    const deadline = BigInt(Math.floor(NOW_MS / 1000) + 24 * 3600);
    expect(data['deadline']).toBe(deadline.toString());
    const steps = data['steps'] as Array<{ to: string; data: Hex }>;
    expect(steps.length).toBe(2);
    const approve = decodeFunctionData({ abi: ERC20_ABI, data: steps[0]!.data });
    expect(approve.args).toEqual([DESK, cap]);
    const open = decodeFunctionData({ abi: CREDIT_DESK_ABI, data: steps[1]!.data });
    expect(open.functionName).toBe('openBudget');
    expect(open.args).toEqual([getAddress(WORKSPACE), cap, deadline]);
  });

  it('keeps a safety margin at the 720 h maximum and rejects longer budgets', async () => {
    const client = await connect(createFakeApi());
    const max = structured(await call(client, 'beagle_open_budget', { tokens: 1, hours: 720, workspace: WORKSPACE }));
    expect(max['deadline']).toBe(String(Math.floor(NOW_MS / 1000) + 720 * 3600 - 300));
    const tooLong = await call(client, 'beagle_open_budget', { tokens: 1, hours: 721, workspace: WORKSPACE });
    expect(tooLong.isError).toBe(true);
  });

  it('executes with a wallet and returns the budget id', async () => {
    const wallet = fakeWallet();
    const client = await connect(createFakeApi(), { wallet });
    const data = structured(await call(client, 'beagle_open_budget', { usd: 2, hours: 1 }));
    expect(data['executed']).toBe(true);
    expect(data['txHash']).toBe(TX);
    expect(data['budgetId']).toBe('7');
    expect(data['workspace']).toBe(AGENT);
    expect(wallet.calls).toEqual([
      { openBudget: { workspace: AGENT, cap: 200n * 10n ** 18n, deadline: BigInt(Math.floor(NOW_MS / 1000) + 3600) } },
    ]);
  });
});

describe('resources', () => {
  it('lists and reads beagle://models and beagle://quickstart', async () => {
    const client = await connect(createFakeApi(), { apiUrl: 'https://api.beagle.example' });
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(['beagle://models', 'beagle://quickstart']);

    const models = await client.readResource({ uri: 'beagle://models' });
    const modelsText = (models.contents[0] as { text: string; mimeType?: string }).text;
    expect(models.contents[0]?.mimeType).toBe('text/markdown');
    expect(modelsText).toMatch(/\| `anthropic\/claude-opus-5-5` \| frontier \| anthropic \| 1,000,000 \| 128,000 \| \$4\.00 \| \$20\.00 \|/);
    expect(modelsText).toMatch(/no \(down\)/);
    expect(modelsText).toMatch(/`beagle\/auto`/);

    const quickstart = await client.readResource({ uri: 'beagle://quickstart' });
    const qsText = (quickstart.contents[0] as { text: string }).text;
    expect(qsText).toMatch(/https:\/\/api\.beagle\.example\/v1\/chat\/completions/);
    expect(qsText).toMatch(/402 insufficient_credit/);
  });
});
