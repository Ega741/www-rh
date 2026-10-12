import { TOKEN_PROGRAM_ID } from '@beagle/shared/addresses';
import { tokensForUsdMicro } from '@beagle/shared/credit';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { McpError, type CallToolResult, type Progress } from '@modelcontextprotocol/sdk/types.js';
import { decodeInstruction, isApproveCheckedInstruction, isBurnCheckedInstruction, isRevokeInstruction, TokenInstruction } from '@solana/spl-token';
import { Transaction } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';
import { BeagleApiError, type BeagleApi } from '../src/api.js';
import { BEAGLE_TOOL_NAMES, createBeagleMcpServer, explorerLink, numberToDecimalString, priceAge, tokenInputToRaw, type BeagleMcpServerOptions } from '../src/server.js';
import { createLazyWalletExecutor, WalletError, type WalletExecutor } from '../src/wallet.js';
import { AGENT_ATA, createFakeApi, DECIMALS, NOW_MS, NOW_S, PRICE_E18, RPC_URL, sampleBudget, sampleReceipt, signatureOf, WORKSPACE, type FakeApi } from './fake-api.js';
import { AGENT, BLOCKHASH, createFakeConnection, LAST_VALID_BLOCK_HEIGHT, MINT, OPERATOR, OTHER_WORKSPACE, PAYER, type FakeConnection } from './fake-connection.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';

const SIG = signatureOf(0xab);
const ONE = 10n ** BigInt(DECIMALS);
const PAYER_ATA = getAssociatedTokenAddressSync(new PublicKey(MINT), new PublicKey(PAYER), true, new PublicKey(TOKEN_PROGRAM_ID)).toBase58();
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

/** A node where the agent and the payer each hold 1000 BEAGLE in their ATA. */
function node(): FakeConnection {
  return createFakeConnection({
    tokenAccounts: [
      { address: AGENT_ATA, mint: MINT, owner: AGENT, amount: 1_000n * ONE },
      { address: PAYER_ATA, mint: MINT, owner: PAYER, amount: 1_000n * ONE, delegate: OPERATOR, delegatedAmount: 20n * ONE },
    ],
  });
}

async function connect(api: BeagleApi, opts: BeagleMcpServerOptions = {}) {
  const server = createBeagleMcpServer(api, { now: () => NOW_MS, connection: node(), ...opts });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'beagle-mcp-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}, options?: RequestOptions): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args }, undefined, options)) as CallToolResult;
}

function structured(result: CallToolResult): Record<string, unknown> {
  expect(result.isError ?? false, JSON.stringify(result.structuredContent)).toBe(false);
  expect(result.structuredContent).toBeDefined();
  const text = result.content.find((c) => c.type === 'text');
  expect(text?.type).toBe('text');
  expect(JSON.parse((text as { text: string }).text)).toEqual(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
}

function errorOf(result: CallToolResult): { code: string; message: string; status?: number; signature?: string } {
  expect(result.isError).toBe(true);
  const sc = result.structuredContent as { error: { code: string; message: string; status?: number; signature?: string } };
  expect(sc.error).toBeDefined();
  const text = result.content[0];
  expect(text?.type).toBe('text');
  expect(JSON.parse((text as { text: string }).text)).toEqual(sc);
  return sc.error;
}

function unsignedTx(data: Record<string, unknown>): Transaction {
  const transactions = data['transactions'] as Array<{ base64: string; description: string }>;
  expect(transactions.length).toBe(1);
  expect(transactions[0]!.description).toBeTruthy();
  return Transaction.from(Buffer.from(transactions[0]!.base64, 'base64'));
}

function fakeWallet(overrides: Partial<WalletExecutor> = {}): WalletExecutor & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    address: AGENT,
    async buyCompute(params) {
      calls.push({ buyCompute: params });
      return { signature: SIG, slot: 42, tokenAccount: AGENT_ATA, memo: params.workspace === AGENT ? null : `beagle:v1 ws=${params.workspace}` };
    },
    async openBudget(params) {
      calls.push({ openBudget: params });
      return { signature: SIG, slot: 42, tokenAccount: AGENT_ATA, balance: 1_000n * ONE };
    },
    async closeBudget(params) {
      calls.push({ closeBudget: params });
      return { signature: SIG, slot: 43, tokenAccount: params.tokenAccount ?? AGENT_ATA };
    },
    ...overrides,
  };
}

describe('tools/list', () => {
  it('exposes exactly the eleven tools of SPEC §6.3 with descriptions and object input schemas', async () => {
    const client = await connect(createFakeApi());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...BEAGLE_TOOL_NAMES].sort());
    expect(tools.length).toBe(11);
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }
    const budget = tools.find((t) => t.name === 'beagle_open_budget')!;
    const props = Object.keys(budget.inputSchema.properties ?? {}).sort();
    expect(props).toEqual(['fundOtherWorkspace', 'payer', 'tokenAccount', 'tokens', 'usd', 'workspace']); // cap only: no hours / deadline
    expect(budget.description).toMatch(/REPLACES the previous cap/);
    expect(budget.description).toMatch(/not_owner/);
    expect(budget.description).not.toMatch(/scanner will pick it up/);
    const buy = tools.find((t) => t.name === 'beagle_buy_compute')!;
    expect(Object.keys(buy.inputSchema.properties ?? {})).not.toContain('tolerance_bps');
    expect(buy.description).toMatch(/published price point when the gateway observes the burn/);
    expect(buy.description).toMatch(/stale/);
    expect(buy.description).not.toMatch(/CreditDesk|approve \+|slippage/i);
    expect(tools.find((t) => t.name === 'beagle_close_budget')?.description).toMatch(/Revoke/);
    expect(tools.find((t) => t.name === 'beagle_balance')?.annotations?.readOnlyHint).toBe(true);
    expect(buy.annotations?.readOnlyHint).toBe(false);
    expect(buy.annotations?.destructiveHint).toBe(true);
  });

  it('reports server info and instructions', async () => {
    const client = await connect(createFakeApi());
    expect(client.getServerVersion()?.name).toBe('beagle');
    expect(client.getInstructions()).toMatch(/beagle_balance/);
    expect(client.getInstructions()).toMatch(/Solana/);
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
    expect((data['price'] as Record<string, unknown>)['pricePointId']).toBe(7);
    expect(data['summary']).toBe('$12.34 available; plan free; 1 BEAGLE = $0.0100');
    expect(data['warning']).toBeUndefined();
  });

  it('beagle_balance flags a stale price in the summary and a warning', async () => {
    const client = await connect(createFakeApi({ priceStale: true }));
    const data = structured(await call(client, 'beagle_balance'));
    expect(data['summary']).toBe('$12.34 available; plan free; 1 BEAGLE = $0.0100 (stale)');
    expect(data['warning']).toMatch(/STALE/);
    expect(data['warning']).toMatch(/observed 2 h ago/);
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

  it('beagle_quote prices USD in tokens and tokens in USD at 6 decimals', async () => {
    const api = createFakeApi();
    const client = await connect(api);
    const byUsd = structured(await call(client, 'beagle_quote', { usd: 5 }));
    expect(byUsd['tokens']).toBe((500n * ONE).toString());
    expect(byUsd['usdMicro']).toBe('5000000');
    expect(byUsd['tokensFormatted']).toBe('500 BEAGLE');
    expect(byUsd['usd']).toBe('$5.00');
    expect(byUsd['usdPerToken']).toBe('$0.0100');
    expect(byUsd['pricePointId']).toBe(7);
    expect(byUsd['stale']).toBe(false);

    const byTokens = structured(await call(client, 'beagle_quote', { tokens: '1000.5' }));
    expect(byTokens['tokens']).toBe((10_005n * ONE / 10n).toString());
    expect(byTokens['usdMicro']).toBe('10005000');

    const byUsdString = structured(await call(client, 'beagle_quote', { usd: '$0.25' }));
    expect(byUsdString['usdMicro']).toBe('250000');
  });

  it('takes numeric token amounts at their shortest decimal form, without float noise', () => {
    expect(tokenInputToRaw(0.1, 6)).toBe(100_000n);
    expect(tokenInputToRaw(0.3, 6)).toBe(300_000n);
    expect(tokenInputToRaw(1.005, 6)).toBe(1_005_000n);
    expect(tokenInputToRaw(123.456, 6)).toBe(123_456_000n);
    expect(tokenInputToRaw(1e9, 6)).toBe(10n ** 15n);
    expect(tokenInputToRaw(1.5e-5, 6)).toBe(15n);
    expect(tokenInputToRaw('1000.5', 6)).toBe(1_000_500_000n);
    expect(() => tokenInputToRaw(Number.NaN, 6)).toThrow(/tokens/);
    expect(() => tokenInputToRaw(1e-7, 6)).toThrow(/fraction digits/);
    expect(numberToDecimalString(2.5e22)).toBe('25000000000000000000000');
    expect(numberToDecimalString(-1.25e-3)).toBe('-0.00125');
    expect(numberToDecimalString(42)).toBe('42');
  });

  it('beagle_quote flags a stale point and needs exactly one of usd / tokens', async () => {
    const stale = await connect(createFakeApi({ priceStale: true }));
    const data = structured(await call(stale, 'beagle_quote', { tokens: 0.3 }));
    expect(data['tokens']).toBe('300000');
    expect(data['tokensFormatted']).toBe('0.3 BEAGLE');
    expect(data['usdMicro']).toBe('3000');
    expect(data['stale']).toBe(true);
    expect(data['warning']).toMatch(/stale/);

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

  it('beagle_budgets lists delegation budgets keyed by token account with formatted amounts and total headroom', async () => {
    const client = await connect(createFakeApi());
    const data = structured(await call(client, 'beagle_budgets'));
    const budgets = data['budgets'] as Array<Record<string, unknown>>;
    expect(budgets.length).toBe(1);
    expect(budgets[0]!['tokenAccount']).toBe(AGENT_ATA);
    expect(budgets[0]!['delegate']).toBe(OPERATOR);
    expect(budgets[0]!['cap']).toBe((400n * ONE).toString());
    expect(budgets[0]!['capFormatted']).toBe('400 BEAGLE');
    expect(budgets[0]!['balanceFormatted']).toBe('1000 BEAGLE');
    expect(budgets[0]!['headroomFormatted']).toBe('400 BEAGLE ($4.00)');
    expect(budgets[0]!['lifetime']).toBe('until revoked');
    expect((budgets[0]!['draws'] as unknown[]).length).toBe(1);
    expect(budgets[0]!['drawCount']).toBe(1);
    expect(data['headroomMicro']).toBe('4000000');
    expect(data['headroom']).toBe('$4.00');
    expect(budgets[0]!['active']).toBe(true);
    expect(budgets[0]!['countsAsHeadroom']).toBe(true);
  });

  it('beagle_budgets excludes closed and stalled budgets from the total, like /api/balance does', async () => {
    const api = createFakeApi();
    api.state.budgets = [
      sampleBudget(),
      sampleBudget({ tokenAccount: PAYER_ATA, closed: true, delegate: null, stalledReason: 'revoked', headroomMicro: 4_000_000n }),
      sampleBudget({ tokenAccount: OTHER_WORKSPACE, stalledReason: 'price', headroomMicro: 0n, headroomTokens: 0n }),
    ];
    const client = await connect(api);
    const data = structured(await call(client, 'beagle_budgets'));
    const rows = data['budgets'] as Array<Record<string, unknown>>;
    expect(rows.length).toBe(3);
    expect(rows[1]!['active']).toBe(false);
    expect(rows[1]!['lifetime']).toBe('closed');
    expect(rows[1]!['countsAsHeadroom']).toBe(false);
    expect(rows[2]!['active']).toBe(true);
    expect(rows[2]!['countsAsHeadroom']).toBe(false);
    expect(data['headroomMicro']).toBe('4000000');
  });

  it('beagle_status returns the status DTO plus the price age and upgrade prices', async () => {
    const client = await connect(createFakeApi());
    const data = structured(await call(client, 'beagle_status'));
    expect(data['cluster']).toBe('localnet');
    expect(data['mint']).toBe(MINT);
    expect((data['operator'] as Record<string, unknown>)['address']).toBe(OPERATOR);
    expect((data['providers'] as Record<string, { state: string }>)['google']?.state).toBe('down');
    expect(data['priceAge']).toBe('30 s ago');
    expect(data['upgradePrices']).toEqual({
      pro: { priceMicro: '20000000', price: '$20.00', days: 30 },
      warm: { hourPriceMicro: '2000000', hourPrice: '$2.00' },
    });
    expect(priceAge({ observedAt: NOW_S - 90 }, NOW_MS)).toBe('1 min ago');
    expect(priceAge({ observedAt: NOW_S - 2 * 86_400 }, NOW_MS)).toBe('2 d ago');
  });

  it('beagle_status still answers when config() fails', async () => {
    const client = await connect(createFakeApi({ failures: { config: new BeagleApiError(500, 'internal_error', 'nope') } }));
    const data = structured(await call(client, 'beagle_status'));
    expect(data['cluster']).toBe('localnet');
    expect(data['upgradePrices']).toBeNull();
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
  it('returns one unsigned BurnChecked + memo transaction with feePayer = workspace and a decodable burn', async () => {
    const api = createFakeApi();
    const rpc = node();
    const client = await connect(api, { connection: rpc });
    const data = structured(await call(client, 'beagle_buy_compute', { usd: 5, workspace: PAYER }));
    expect(data['unsigned']).toBe(true);
    expect(data['cluster']).toBe('localnet');
    expect(data['feePayer']).toBe(PAYER);
    expect(data['blockhash']).toBe(BLOCKHASH);
    expect(data['lastValidBlockHeight']).toBe(LAST_VALID_BLOCK_HEIGHT);
    const expectedTokens = tokensForUsdMicro(5_000_000n, PRICE_E18, DECIMALS);
    expect(data['tokens']).toBe(expectedTokens.toString());
    expect(data['tokensFormatted']).toBe('500 BEAGLE');
    expect(data['usdMicro']).toBe('5000000');
    expect(data['pricePointId']).toBe(7);
    expect(data['priceStale']).toBe(false);
    expect(data['warnings']).toEqual([]);
    expect(data['workspace']).toBe(PAYER);
    expect(data['workspaceSource']).toBe('input');
    expect(data['tokenAccount']).toBe(PAYER_ATA);
    expect(data['tokenAccountBalance']).toBe((1_000n * ONE).toString());
    expect(data['memo']).toBeNull();
    expect(data['mint']).toBe(MINT);
    expect(data['note']).not.toMatch(/Warning/);
    expect(data['note']).toMatch(/No memo: the token account owner is the credited workspace/);
    expect(data['note']).toMatch(/\$5\.00/);

    const tx = unsignedTx(data);
    expect(tx.feePayer?.toBase58()).toBe(PAYER);
    expect(tx.recentBlockhash).toBe(BLOCKHASH);
    expect(tx.signatures[0]!.signature).toBeNull();
    expect(tx.instructions.length).toBe(1);
    const burn = decodeInstruction(tx.instructions[0]!);
    if (!isBurnCheckedInstruction(burn)) throw new Error('expected BurnChecked');
    expect(burn.data).toEqual({ instruction: TokenInstruction.BurnChecked, amount: expectedTokens, decimals: DECIMALS });
    expect(burn.keys.account.pubkey.toBase58()).toBe(PAYER_ATA);
    expect(burn.keys.owner.pubkey.toBase58()).toBe(PAYER);
    expect(api.state.calls.find((c) => c.method === 'quote')?.args[0]).toEqual({ usdMicro: 5_000_000n });
    expect(api.callsTo('price')).toBe(1);
    expect(rpc.calls.map((c) => c.method)).toEqual(['getAccountInfo', 'getLatestBlockhash']);
  });

  it('adds the memo when a payer burns for another workspace', async () => {
    const client = await connect(createFakeApi());
    const data = structured(await call(client, 'beagle_buy_compute', { tokens: 250, workspace: OTHER_WORKSPACE, payer: PAYER }));
    expect(data['feePayer']).toBe(PAYER);
    expect(data['workspace']).toBe(OTHER_WORKSPACE);
    expect(data['memo']).toBe(`beagle:v1 ws=${OTHER_WORKSPACE}`);
    expect(data['note']).toMatch(new RegExp(`The memo "beagle:v1 ws=${OTHER_WORKSPACE}" credits workspace ${OTHER_WORKSPACE}`));
    const tx = unsignedTx(data);
    expect(tx.instructions.length).toBe(2);
    expect(Buffer.from(tx.instructions[1]!.data).toString('utf8')).toBe(`beagle:v1 ws=${OTHER_WORKSPACE}`);
  });

  it('warns when the published price is stale and still builds the transaction', async () => {
    const client = await connect(createFakeApi({ priceStale: true }));
    const data = structured(await call(client, 'beagle_buy_compute', { usd: 5, workspace: PAYER }));
    expect(data['priceStale']).toBe(true);
    const warnings = data['warnings'] as string[];
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/STALE/);
    expect(warnings[0]).toMatch(/flagged priceStale/);
    unsignedTx(data);
  });

  it('refuses burns that would quote below the gateway minimum credit', async () => {
    const api = createFakeApi();
    api.state.config = { ...api.state.config, minCreditMicro: 1_000_000n };
    const client = await connect(api);
    const error = errorOf(await call(client, 'beagle_buy_compute', { usd: 0.5, workspace: PAYER }));
    expect(error.code).toBe('invalid_request');
    expect(error.message).toMatch(/below the gateway minimum credit of \$1\.00/);
    structured(await call(client, 'beagle_buy_compute', { usd: 1, workspace: PAYER }));
  });

  it('accepts a token amount and uses the configured default workspace as fee payer', async () => {
    const api = createFakeApi();
    const client = await connect(api, { workspace: PAYER });
    const data = structured(await call(client, 'beagle_buy_compute', { tokens: 250 }));
    expect(data['tokens']).toBe((250n * ONE).toString());
    expect(data['usdMicro']).toBe('2500000');
    expect(data['workspace']).toBe(PAYER);
    expect(data['feePayer']).toBe(PAYER);
    expect(data['workspaceSource']).toBe('configured');
    expect(data['note']).not.toMatch(/Warning/);
  });

  it('needs a workspace when none can be inferred', async () => {
    const client = await connect(createFakeApi());
    const error = errorOf(await call(client, 'beagle_buy_compute', { usd: 1 }));
    expect(error.code).toBe('invalid_request');
    expect(error.message).toMatch(/workspace is required/);
  });

  it('reports insufficient_tokens from the node and rpc_error when the RPC is down', async () => {
    const client = await connect(createFakeApi(), { connection: node() });
    const short = errorOf(await call(client, 'beagle_buy_compute', { tokens: 5_000, workspace: PAYER }));
    expect(short.code).toBe('insufficient_tokens');
    expect(short.message).toMatch(/holds 1000 BEAGLE/);
    const none = errorOf(await call(client, 'beagle_buy_compute', { tokens: 1, workspace: OTHER_WORKSPACE }));
    expect(none.code).toBe('insufficient_tokens');
    expect(none.message).toMatch(/no token account/);

    const down = await connect(createFakeApi(), { connection: createFakeConnection({ fail: { getAccountInfo: new Error('ECONNREFUSED 127.0.0.1:8899') } }) });
    const error = errorOf(await call(down, 'beagle_buy_compute', { usd: 1, workspace: PAYER }));
    expect(error.code).toBe('rpc_error');
    expect(error.message).toMatch(/ECONNREFUSED/);
  });

  it('rejects malformed workspace / payer / tokenAccount through the schema', async () => {
    const client = await connect(createFakeApi());
    for (const args of [{ workspace: 'not-an-address' }, { workspace: PAYER, payer: '0x12' }, { workspace: PAYER, tokenAccount: 'x' }]) {
      const result = await call(client, 'beagle_buy_compute', { usd: 1, ...args });
      expect(result.isError, JSON.stringify(args)).toBe(true);
    }
  });

  it('rejects a token account the signer does not own (the owner must sign the burn)', async () => {
    const client = await connect(createFakeApi());
    const error = errorOf(await call(client, 'beagle_buy_compute', { usd: 1, workspace: PAYER, tokenAccount: AGENT_ATA }));
    expect(error.code).toBe('invalid_request');
    expect(error.message).toMatch(new RegExp(`${AGENT_ATA} is owned by ${AGENT}, not by ${PAYER}, so ${PAYER} cannot sign its BurnChecked`));
    // naming the owner as payer makes it a burn by the agent crediting PAYER via memo
    const data = structured(await call(client, 'beagle_buy_compute', { usd: 1, workspace: PAYER, payer: AGENT, tokenAccount: AGENT_ATA }));
    expect(data['feePayer']).toBe(AGENT);
    expect(data['memo']).toBe(`beagle:v1 ws=${PAYER}`);
  });

  it('uses the gateway rpcUrl for the default connection when none is injected (and surfaces the failure as rpc_error)', async () => {
    const api = createFakeApi();
    api.state.config = { ...api.state.config, rpcUrl: 'http://127.0.0.1:1' }; // nothing listens there
    const server = createBeagleMcpServer(api, { now: () => NOW_MS });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'beagle-mcp-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    closers.push(async () => {
      await client.close();
      await server.close();
    });
    const error = errorOf(await call(client, 'beagle_buy_compute', { usd: 1, workspace: PAYER }));
    expect(error.code).toBe('rpc_error');
  }, 20_000);
});

describe('beagle_buy_compute with a wallet', () => {
  it('executes the burn and polls the receipts until the credit event appears, reporting its price point', async () => {
    const api = createFakeApi();
    api.scheduleReceipt(sampleReceipt({ signature: SIG, usdMicro: 5_000_000n, pricePointId: 7 }), 3); // visible on the third receipts() call
    const wallet = fakeWallet();
    const client = await connect(api, { wallet, pollIntervalMs: 1, creditWaitMs: 5_000, now: () => Date.now() });
    const data = structured(await call(client, 'beagle_buy_compute', { usd: 5 }));
    expect(data['executed']).toBe(true);
    expect(data['signature']).toBe(SIG);
    expect(data['slot']).toBe(42);
    expect(data['tokenAccount']).toBe(AGENT_ATA);
    expect(data['memo']).toBeNull();
    expect(data['credited']).toBe(true);
    expect(data['creditedMicro']).toBe('5000000');
    expect(data['pricePointId']).toBe(7);
    expect(data['priceStale']).toBe(false);
    expect(data['priceE18']).toBe(PRICE_E18.toString());
    expect((data['receipt'] as Record<string, unknown>)['signature']).toBe(SIG);
    expect(data['balanceMicro']).toBe((12_340_000n + 5_000_000n).toString());
    expect(data['workspace']).toBe(AGENT); // defaults to the agent wallet
    expect(data['workspaceSource']).toBe('agent_wallet');
    expect(data['explorerUrl']).toBe(`https://explorer.solana.com/tx/${SIG}?cluster=custom&customUrl=${encodeURIComponent(RPC_URL)}`);
    expect(wallet.calls).toEqual([{ buyCompute: { workspace: AGENT, tokens: 500n * ONE } }]);
    expect(api.callsTo('receipts')).toBe(3);
    expect(data['note']).toMatch(/^Credited \$5\.00 at price point 7\./);
    expect(data['note']).toMatch(/Warning: workspace defaulted to the agent wallet/);
    expect(typeof data['elapsedMs']).toBe('number');
  });

  it("falls back to the balance delta when the receipt is not listed yet but the key's workspace balance moved", async () => {
    const api = createFakeApi();
    api.scheduleCredit(4_000_000n, 3);
    const client = await connect(api, { wallet: fakeWallet(), pollIntervalMs: 1, creditWaitMs: 5_000, now: () => Date.now() });
    const data = structured(await call(client, 'beagle_buy_compute', { usd: 4, workspace: OTHER_WORKSPACE }));
    expect(data['credited']).toBe(true);
    expect(data['creditedMicro']).toBe('4000000');
    expect(data['receipt']).toBeUndefined();
    expect(data['memo']).toBe(`beagle:v1 ws=${OTHER_WORKSPACE}`);
    expect(data['pricePointId']).toBe(7); // from the quote
  });

  it('warns about a stale price on the executed path too', async () => {
    const client = await connect(createFakeApi({ priceStale: true }), { wallet: fakeWallet(), waitForCredit: false });
    const data = structured(await call(client, 'beagle_buy_compute', { usd: 1 }));
    expect(data['executed']).toBe(true);
    expect(data['priceStale']).toBe(true);
    expect((data['warnings'] as string[])[0]).toMatch(/STALE/);
  });

  it('maps an insufficient_tokens wallet failure to isError with that code, nothing burned', async () => {
    const wallet = fakeWallet({
      async buyCompute() {
        throw new WalletError('insufficient_tokens', `${AGENT} holds 10 BEAGLE in its largest BEAGLE account, less than the 500 BEAGLE needed`);
      },
    });
    const api = createFakeApi();
    const client = await connect(api, { wallet });
    const error = errorOf(await call(client, 'beagle_buy_compute', { usd: 5, workspace: WORKSPACE }));
    expect(error.code).toBe('insufficient_tokens');
    expect(error.signature).toBeUndefined();
    expect(api.callsTo('balance')).toBe(1);
    expect(api.callsTo('receipts')).toBe(0);
  });

  it('reports a pending credit when the indexer has not caught up in time', async () => {
    const api = createFakeApi();
    const client = await connect(api, { wallet: fakeWallet(), pollIntervalMs: 1, creditWaitMs: 15, now: () => Date.now() });
    const data = structured(await call(client, 'beagle_buy_compute', { tokens: 10, workspace: WORKSPACE }));
    expect(data['executed']).toBe(true);
    expect(data['credited']).toBe(false);
    expect(data['creditedMicro']).toBeNull();
    expect(data['note']).toMatch(/not visible/);
    expect(data['note']).toMatch(/about \$0\.10/);
    expect(data['note']).toMatch(/Do not burn again/);
    expect(api.callsTo('balance')).toBeGreaterThan(1);
  });

  it('sees the credit even when a concurrent debit lands while polling', async () => {
    const api = createFakeApi();
    api.scheduleDebit(6_000_000n, 2); // a completion settles −$6.00 on the second poll…
    api.scheduleCredit(5_000_000n, 3); // …and the +$5.00 credit is indexed on the third: balance never exceeds `before`
    const client = await connect(api, { wallet: fakeWallet(), pollIntervalMs: 1, creditWaitMs: 5_000, now: () => Date.now() });
    const data = structured(await call(client, 'beagle_buy_compute', { usd: 5, workspace: WORKSPACE }));
    expect(data['credited']).toBe(true);
    expect(data['creditedMicro']).toBe('5000000');
    expect(data['balanceMicro']).toBe((12_340_000n - 6_000_000n + 5_000_000n).toString());
    expect(api.callsTo('balance')).toBe(3);
  });

  it('keeps polling when receipts() fails transiently', async () => {
    const api = createFakeApi({ failures: { receipts: new BeagleApiError(500, 'internal_error', 'db locked') } });
    api.scheduleCredit(1_000_000n, 2);
    const client = await connect(api, { wallet: fakeWallet(), pollIntervalMs: 1, creditWaitMs: 5_000, now: () => Date.now() });
    const data = structured(await call(client, 'beagle_buy_compute', { usd: 1, workspace: WORKSPACE }));
    expect(data['credited']).toBe(true);
    expect(data['creditedMicro']).toBe('1000000');
  });

  it('skips polling when waitForCredit is false', async () => {
    const api = createFakeApi();
    const client = await connect(api, { wallet: fakeWallet(), waitForCredit: false });
    const data = structured(await call(client, 'beagle_buy_compute', { usd: 1 }));
    expect(data['executed']).toBe(true);
    expect(data['credited']).toBe(false);
    expect(data['creditedMicro']).toBeNull();
    expect(data['note']).toMatch(/Do not burn again/);
    expect(api.callsTo('balance')).toBe(1);
    expect(api.callsTo('receipts')).toBe(0);
  });

  it('returns within the call budget even when the credit never shows and the gateway is slow', async () => {
    const api = createFakeApi();
    let reads = 0;
    const slowApi: BeagleApi = {
      ...api,
      async balance() {
        reads += 1;
        if (reads > 1) await sleep(400); // every poll is longer than the whole budget: it must not extend the call
        return api.balance();
      },
    };
    let burnedAt = 0;
    const wallet = fakeWallet({
      async buyCompute() {
        await sleep(30); // confirmation wait
        burnedAt = Date.now();
        return { signature: SIG, tokenAccount: AGENT_ATA, memo: null };
      },
    });
    const client = await connect(slowApi, { wallet, pollIntervalMs: 5, creditWaitMs: 60_000, callBudgetMs: 120, now: () => Date.now() });
    const started = Date.now();
    const data = structured(await call(client, 'beagle_buy_compute', { usd: 1, workspace: WORKSPACE }));
    const elapsed = Date.now() - started;
    expect(data['executed']).toBe(true);
    expect(data['signature']).toBe(SIG);
    expect(data['slot']).toBeUndefined();
    expect(data['credited']).toBe(false);
    expect(burnedAt).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(350);
    expect(data['elapsedMs'] as number).toBeLessThan(350);
  });

  it('sends progress notifications while waiting so clients that reset their timeout on progress survive a long purchase', async () => {
    const api = createFakeApi();
    api.scheduleCredit(5_000_000n, 15); // visible on the 15th balance() call: ~14 polls of 10 ms
    const client = await connect(api, { wallet: fakeWallet(), pollIntervalMs: 10, creditWaitMs: 5_000, callBudgetMs: 5_000, now: () => Date.now() });
    const progress: Progress[] = [];
    const data = structured(
      await call(client, 'beagle_buy_compute', { usd: 5, workspace: WORKSPACE }, { timeout: 60, resetTimeoutOnProgress: true, onprogress: (p) => progress.push(p) }),
    );
    expect(data['credited']).toBe(true);
    expect(progress.length).toBeGreaterThanOrEqual(10);
    expect(progress[0]!.message).toMatch(/burning 500 BEAGLE/);
    expect(progress[0]!.message).toMatch(/BurnChecked, waiting for confirmation/);
    expect(progress[1]!.message).toMatch(new RegExp(`burn confirmed \\(${SIG}\\)`));
    expect(progress.map((p) => p.progress)).toEqual(progress.map((_, i) => i + 1));
  });

  it('is dropped by a default client (no reset on progress) when its timeout is shorter than the wait; the burn still happened', async () => {
    const api = createFakeApi();
    const wallet = fakeWallet();
    const client = await connect(api, { wallet, pollIntervalMs: 10, creditWaitMs: 5_000, callBudgetMs: 5_000, now: () => Date.now() });
    const error = await call(client, 'beagle_buy_compute', { usd: 5, workspace: WORKSPACE }, { timeout: 60 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).message).toMatch(/timed out/i);
    expect(wallet.calls.length).toBe(1);
  });

  it('sends no progress notifications when the client did not ask for them', async () => {
    const api = createFakeApi();
    api.scheduleCredit(5_000_000n, 2);
    const client = await connect(api, { wallet: fakeWallet(), pollIntervalMs: 1, creditWaitMs: 5_000, now: () => Date.now() });
    let notifications = 0;
    client.fallbackNotificationHandler = async () => {
      notifications += 1;
    };
    structured(await call(client, 'beagle_buy_compute', { usd: 5, workspace: WORKSPACE }));
    expect(notifications).toBe(0);
  });

  it('reports wallet_unavailable from a lazy wallet whose setup fails, then executes once it recovers', async () => {
    let gatewayUp = false;
    const inner = fakeWallet();
    const wallet = createLazyWalletExecutor({
      address: AGENT,
      build: async () => {
        if (!gatewayUp) throw new Error('request to GET /api/config failed: fetch failed');
        return inner;
      },
    });
    const api = createFakeApi();
    api.scheduleCredit(5_000_000n, 3); // before-read of attempt 1, before-read of attempt 2, first poll
    const client = await connect(api, { wallet, pollIntervalMs: 1, creditWaitMs: 5_000, now: () => Date.now() });
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'beagle_buy_compute')?.description).toMatch(/signs and sends with the agent wallet/);

    const error = errorOf(await call(client, 'beagle_buy_compute', { usd: 5 }));
    expect(error.code).toBe('wallet_unavailable');
    expect(error.message).toMatch(/fetch failed/);
    expect(inner.calls.length).toBe(0);

    gatewayUp = true;
    const data = structured(await call(client, 'beagle_buy_compute', { usd: 5 }));
    expect(data['executed']).toBe(true);
    expect(data['workspace']).toBe(AGENT); // the lazy wallet knows its address before any network call
    expect(inner.calls.length).toBe(1);
  });

  it('builds explorer links per cluster and explorer site', async () => {
    expect(explorerLink({ cluster: 'devnet', rpcUrl: 'https://api.devnet.solana.com', explorer: 'https://explorer.solana.com' }, SIG)).toBe(`https://explorer.solana.com/tx/${SIG}?cluster=devnet`);
    expect(explorerLink({ cluster: 'mainnet-beta', rpcUrl: 'https://api.mainnet-beta.solana.com', explorer: 'https://solscan.io' }, SIG)).toBe(`https://solscan.io/tx/${SIG}`);
    const api = createFakeApi();
    api.state.config = { ...api.state.config, cluster: 'devnet', rpcUrl: 'https://api.devnet.solana.com' };
    const client = await connect(api, { wallet: fakeWallet(), waitForCredit: false });
    const data = structured(await call(client, 'beagle_buy_compute', { usd: 1 }));
    expect(data['explorerUrl']).toBe(`https://explorer.solana.com/tx/${SIG}?cluster=devnet`);
  });

  it('maps wallet failures to isError with the wallet code and signature', async () => {
    const wallet = fakeWallet({
      async buyCompute() {
        throw new WalletError('blockhash_expired', `burn: transaction ${SIG} was not confirmed before its blockhash expired`, { signature: SIG });
      },
    });
    const client = await connect(createFakeApi(), { wallet });
    const error = errorOf(await call(client, 'beagle_buy_compute', { usd: 1 }));
    expect(error.code).toBe('blockhash_expired');
    expect(error.signature).toBe(SIG);
  });
});

describe('beagle_open_budget', () => {
  it('returns one unsigned ApproveChecked transaction (cap only, no deadline) plus the register body', async () => {
    const client = await connect(createFakeApi());
    const data = structured(await call(client, 'beagle_open_budget', { usd: '10', workspace: PAYER }));
    expect(data['unsigned']).toBe(true);
    const cap = 1_000n * ONE;
    expect(data['cap']).toBe(cap.toString());
    expect(data['capFormatted']).toBe('1000 BEAGLE');
    expect(data['usdMicro']).toBe('10000000');
    expect(data['operator']).toBe(OPERATOR);
    expect(data['feePayer']).toBe(PAYER);
    expect(data['tokenAccount']).toBe(PAYER_ATA);
    expect(data['register']).toEqual({ tokenAccount: PAYER_ATA });
    expect(data['workspaceSource']).toBe('input');
    expect(data['deadline']).toBeUndefined();
    expect(data['note']).toMatch(/POST \/api\/budgets\/register/);
    expect(data['note']).toMatch(new RegExp(`or wait for the gateway scanner \\(it registers the delegation for its owner ${PAYER}\\)`));
    expect(data['note']).not.toMatch(/not_owner/);
    expect(data['note']).toMatch(/replaces the existing delegation of 20 BEAGLE/);
    const tx = unsignedTx(data);
    expect(tx.feePayer?.toBase58()).toBe(PAYER);
    expect(tx.instructions.length).toBe(1);
    const approve = decodeInstruction(tx.instructions[0]!);
    if (!isApproveCheckedInstruction(approve)) throw new Error('expected ApproveChecked');
    expect(approve.data).toEqual({ instruction: TokenInstruction.ApproveChecked, amount: cap, decimals: DECIMALS });
    expect(approve.keys.delegate.pubkey.toBase58()).toBe(OPERATOR);
    expect(approve.keys.owner.pubkey.toBase58()).toBe(PAYER);
    expect(approve.keys.account.pubkey.toBase58()).toBe(PAYER_ATA);
  });

  it('refuses an unsigned cross-workspace budget until fundOtherWorkspace confirms the owner will register it, then names the workspace in the register body', async () => {
    const rpc = node();
    const client = await connect(createFakeApi(), { workspace: OTHER_WORKSPACE, connection: rpc });
    const refused = errorOf(await call(client, 'beagle_open_budget', { tokens: 1, payer: PAYER }));
    expect(refused.code).toBe('invalid_request');
    expect(refused.message).toMatch(new RegExp(`signed by ${PAYER} \\(the token account owner\\) but fund workspace ${OTHER_WORKSPACE} \\(the configured workspace\\)`));
    expect(refused.message).toMatch(/403 not_owner/);
    expect(refused.message).toMatch(new RegExp(`run this server with an API key of ${PAYER} and pass workspace: ${OTHER_WORKSPACE}`));
    expect(refused.message).toMatch(new RegExp(`must then be sent with a key of ${PAYER}`));
    expect(refused.message).toMatch(/fundOtherWorkspace: true/);
    expect(rpc.calls.length).toBe(0); // refused before touching the chain

    const data = structured(await call(client, 'beagle_open_budget', { tokens: 1, payer: PAYER, fundOtherWorkspace: true }));
    expect(data['workspace']).toBe(OTHER_WORKSPACE);
    expect(data['workspaceSource']).toBe('configured');
    expect(data['feePayer']).toBe(PAYER);
    expect(data['register']).toEqual({ tokenAccount: PAYER_ATA, workspace: OTHER_WORKSPACE });
    expect(data['note']).toMatch(new RegExp(`using a key or session of the owner ${PAYER}: any other key is refused \\(403 not_owner\\)`));
    expect(data['note']).toMatch(new RegExp(`registers the delegation for ${PAYER}'s workspace, so ${OTHER_WORKSPACE} gets no headroom`));
    expect(data['note']).not.toMatch(/or wait for the gateway scanner/);
    unsignedTx(data);
  });

  it('rejects an unsigned approval for a token account the signer does not own', async () => {
    const client = await connect(createFakeApi());
    const error = errorOf(await call(client, 'beagle_open_budget', { tokens: 1, workspace: PAYER, tokenAccount: AGENT_ATA }));
    expect(error.code).toBe('invalid_request');
    expect(error.message).toMatch(new RegExp(`${AGENT_ATA} is owned by ${AGENT}, not by ${PAYER}`));
    expect(error.message).toMatch(/cannot sign its ApproveChecked/);
    expect(error.message).toMatch(new RegExp(`pass payer: ${AGENT}`));
  });

  it('fails cleanly when the gateway has no operator', async () => {
    const api = createFakeApi();
    api.state.config = { ...api.state.config, operator: null };
    const client = await connect(api);
    const error = errorOf(await call(client, 'beagle_open_budget', { usd: 1, workspace: PAYER }));
    expect(error.code).toBe('not_configured');
    expect(error.status).toBe(503);
  });

  it('executes with a wallet, registers the token account and reports the budget', async () => {
    const wallet = fakeWallet();
    const api = createFakeApi();
    const client = await connect(api, { wallet });
    const data = structured(await call(client, 'beagle_open_budget', { usd: 2 }));
    expect(data['executed']).toBe(true);
    expect(data['signature']).toBe(SIG);
    expect(data['tokenAccount']).toBe(AGENT_ATA);
    expect(data['tokenAccountBalance']).toBe((1_000n * ONE).toString());
    expect(data['cap']).toBe((200n * ONE).toString());
    expect(data['registered']).toBe(true);
    expect((data['budget'] as Record<string, unknown>)['tokenAccount']).toBe(AGENT_ATA);
    expect(data['registerError']).toBeNull();
    expect(data['registerErrorCode']).toBeNull();
    expect(data['fundsWorkspace']).toBe(AGENT);
    expect(data['workspace']).toBe(AGENT);
    expect(data['workspaceSource']).toBe('agent_wallet');
    expect(data['explorerUrl']).toMatch(/explorer\.solana\.com\/tx\//);
    expect(data['note']).toMatch(/^Delegated up to 200 BEAGLE of token account/);
    expect(data['note']).toMatch(new RegExp(`registered the budget for workspace ${AGENT}`));
    expect(data['note']).not.toMatch(/balance is below the cap/);
    expect(data['note']).not.toMatch(/replaces the existing delegation/);
    expect(data['note']).toMatch(/Warning: workspace defaulted to the agent wallet/);
    expect(wallet.calls).toEqual([{ openBudget: { cap: 200n * ONE } }]);
    // the agent is the workspace: no workspace in the register body
    expect(api.state.calls.find((c) => c.method === 'registerBudget')?.args[0]).toEqual({ tokenAccount: AGENT_ATA });
  });

  it('reports the delegation an executed approval replaced', async () => {
    const wallet = fakeWallet({ openBudget: async () => ({ signature: SIG, tokenAccount: AGENT_ATA, balance: 1_000n * ONE, previousDelegate: OPERATOR, previousDelegatedAmount: 30n * ONE }) });
    const client = await connect(createFakeApi(), { wallet });
    const data = structured(await call(client, 'beagle_open_budget', { tokens: 100 }));
    expect(data['note']).toMatch(new RegExp(`This replaces the existing delegation of 30 BEAGLE to ${OPERATOR}`));
  });

  it('refuses to execute a cross-workspace budget without fundOtherWorkspace: nothing approved, nothing registered', async () => {
    const wallet = fakeWallet();
    const api = createFakeApi();
    const client = await connect(api, { wallet, workspace: OTHER_WORKSPACE });
    const error = errorOf(await call(client, 'beagle_open_budget', { tokens: 100 }));
    expect(error.code).toBe('invalid_request');
    expect(error.message).toMatch(new RegExp(`signed by ${AGENT} \\(the token account owner\\) but fund workspace ${OTHER_WORKSPACE} \\(the configured workspace\\)`));
    expect(error.message).toMatch(/registers a delegation for its OWNER's workspace/);
    expect(error.message).toMatch(/403 not_owner/);
    expect(error.message).toMatch(new RegExp(`open the budget from ${OTHER_WORKSPACE}'s own wallet, or run this server with an API key of ${AGENT} and pass workspace: ${OTHER_WORKSPACE}`));
    expect(error.message).toMatch(/fundOtherWorkspace: true/);
    expect(wallet.calls).toEqual([]);
    expect(api.callsTo('registerBudget')).toBe(0);

    // explicit workspace input is gated the same way
    const byInput = errorOf(await call(client, 'beagle_open_budget', { tokens: 100, workspace: PAYER }));
    expect(byInput.message).toMatch(new RegExp(`fund workspace ${PAYER}\\. `));
    expect(wallet.calls).toEqual([]);
  });

  it('with fundOtherWorkspace registers the funded workspace (a key of the owner) and reports it', async () => {
    const wallet = fakeWallet();
    const api = createFakeApi();
    const client = await connect(api, { wallet, workspace: OTHER_WORKSPACE });
    const data = structured(await call(client, 'beagle_open_budget', { tokens: 100, fundOtherWorkspace: true }));
    expect(data['executed']).toBe(true);
    expect(data['registered']).toBe(true);
    expect(data['fundsWorkspace']).toBe(OTHER_WORKSPACE);
    expect((data['budget'] as Record<string, unknown>)['workspace']).toBe(OTHER_WORKSPACE);
    expect(data['note']).toMatch(new RegExp(`registered the budget for workspace ${OTHER_WORKSPACE}`));
    expect(wallet.calls).toEqual([{ openBudget: { cap: 100n * ONE } }]);
    expect(api.state.calls.find((c) => c.method === 'registerBudget')?.args[0]).toEqual({ tokenAccount: AGENT_ATA, workspace: OTHER_WORKSPACE });
  });

  it("explains a 403 not_owner after an executed approval: the delegation funds the owner's workspace, never 'the scanner will fix it'", async () => {
    const api = createFakeApi({ failures: { registerBudget: new BeagleApiError(403, 'not_owner', 'only the token account owner may choose which workspace a budget funds') } });
    const client = await connect(api, { wallet: fakeWallet(), workspace: OTHER_WORKSPACE });
    const data = structured(await call(client, 'beagle_open_budget', { tokens: 100, fundOtherWorkspace: true }));
    expect(data['executed']).toBe(true);
    expect(data['registered']).toBe(false);
    expect(data['budget']).toBeNull();
    expect(data['registerError']).toMatch(/only the token account owner/);
    expect(data['registerErrorCode']).toBe('not_owner');
    expect(data['fundsWorkspace']).toBe(AGENT);
    expect(data['note']).toMatch(new RegExp(`refused to register it for workspace ${OTHER_WORKSPACE} \\(403 not_owner: this server's API key does not belong to ${AGENT}\\)`));
    expect(data['note']).toMatch(new RegExp(`funds the owner's workspace ${AGENT} instead`));
    expect(data['note']).toMatch(new RegExp(`${OTHER_WORKSPACE} gets no headroom from it: revoke it with beagle_close_budget, or register it with a key of ${AGENT}`));
    expect(data['note']).toMatch(new RegExp(`POST /api/budgets/register \\{ tokenAccount: ${AGENT_ATA}, workspace: ${OTHER_WORKSPACE} \\}`));
    expect(data['note']).not.toMatch(/scanner will pick it up/);
  });

  it('tolerates another registration failure, saying who the delegation funds meanwhile', async () => {
    const api = createFakeApi({ failures: { registerBudget: new BeagleApiError(400, 'not_delegated', 'token account is not delegated to the operator') } });
    const client = await connect(api, { wallet: fakeWallet({ openBudget: async () => ({ signature: SIG, tokenAccount: AGENT_ATA, balance: 50n * ONE }) }), workspace: OTHER_WORKSPACE });
    const data = structured(await call(client, 'beagle_open_budget', { tokens: 100, fundOtherWorkspace: true }));
    expect(data['executed']).toBe(true);
    expect(data['registered']).toBe(false);
    expect(data['budget']).toBeNull();
    expect(data['registerError']).toMatch(/not delegated/);
    expect(data['registerErrorCode']).toBe('not_delegated');
    expect(data['fundsWorkspace']).toBe(AGENT);
    expect(data['note']).toMatch(/registration failed: token account is not delegated/);
    expect(data['note']).toMatch(new RegExp(`Until a key of ${AGENT} registers it naming workspace ${OTHER_WORKSPACE}, the delegation funds ${AGENT}`));
    expect(data['note']).not.toMatch(/scanner will pick it up/);
    expect(data['note']).toMatch(/balance is below the cap/);
    expect(data['workspaceSource']).toBe('configured');
    expect(api.state.calls.find((c) => c.method === 'registerBudget')?.args[0]).toEqual({ tokenAccount: AGENT_ATA, workspace: OTHER_WORKSPACE });

    // same-workspace failure: the scanner's registration under the owner is the right outcome
    const own = await connect(createFakeApi({ failures: { registerBudget: new BeagleApiError(500, 'internal_error', 'db locked') } }), { wallet: fakeWallet() });
    const ownData = structured(await call(own, 'beagle_open_budget', { tokens: 100 }));
    expect(ownData['fundsWorkspace']).toBe(AGENT);
    expect(ownData['note']).toMatch(new RegExp(`registration failed: db locked; the gateway scanner registers the delegation for its owner ${AGENT} on its own`));
  });
});

describe('beagle_close_budget', () => {
  it('returns one unsigned Revoke transaction for the configured workspace (default: its delegated account)', async () => {
    const client = await connect(createFakeApi(), { workspace: PAYER });
    const data = structured(await call(client, 'beagle_close_budget'));
    expect(data['unsigned']).toBe(true);
    expect(data['feePayer']).toBe(PAYER);
    expect(data['tokenAccount']).toBe(PAYER_ATA);
    expect(data['delegate']).toBe(OPERATOR);
    expect(data['delegatedAmount']).toBe((20n * ONE).toString());
    expect(data['note']).toMatch(/Revokes the delegation of 20 BEAGLE/);
    const tx = unsignedTx(data);
    const revoke = decodeInstruction(tx.instructions[0]!);
    if (!isRevokeInstruction(revoke)) throw new Error('expected Revoke');
    expect(revoke.keys.account.pubkey.toBase58()).toBe(PAYER_ATA);
    expect(revoke.keys.owner.pubkey.toBase58()).toBe(PAYER);

    const explicit = structured(await call(client, 'beagle_close_budget', { tokenAccount: AGENT_ATA, payer: AGENT }));
    expect(explicit['tokenAccount']).toBe(AGENT_ATA);
    expect(explicit['note']).toMatch(/no delegate/);
    const bad = errorOf(await call(client, 'beagle_close_budget', { tokenAccount: OTHER_WORKSPACE }));
    expect(bad.code).toBe('invalid_address');
  });

  it('works with only an API key configured: payer + tokenAccount give an unsigned Revoke with feePayer = payer', async () => {
    const rpc = node();
    const client = await connect(createFakeApi(), { connection: rpc }); // no workspace, no wallet: the documented stdio config
    const data = structured(await call(client, 'beagle_close_budget', { payer: PAYER, tokenAccount: PAYER_ATA }));
    expect(data['unsigned']).toBe(true);
    expect(data['feePayer']).toBe(PAYER);
    expect(data['tokenAccount']).toBe(PAYER_ATA);
    expect(data['delegate']).toBe(OPERATOR);
    expect(data['note']).toMatch(new RegExp(`^Sign with ${PAYER} `));
    const tx = unsignedTx(data);
    expect(tx.feePayer?.toBase58()).toBe(PAYER);
    const revoke = decodeInstruction(tx.instructions[0]!);
    if (!isRevokeInstruction(revoke)) throw new Error('expected Revoke');
    expect(revoke.keys.account.pubkey.toBase58()).toBe(PAYER_ATA);
    expect(revoke.keys.owner.pubkey.toBase58()).toBe(PAYER);
    expect(rpc.calls.map((c) => c.method)).toEqual(['getAccountInfo', 'getLatestBlockhash']);
  });

  it('with only tokenAccount, reads the owner from the chain as the signer (the only valid one)', async () => {
    const rpc = node();
    const client = await connect(createFakeApi(), { connection: rpc });
    const data = structured(await call(client, 'beagle_close_budget', { tokenAccount: PAYER_ATA }));
    expect(data['feePayer']).toBe(PAYER);
    expect(data['tokenAccount']).toBe(PAYER_ATA);
    expect(data['delegatedAmount']).toBe((20n * ONE).toString());
    expect(unsignedTx(data).feePayer?.toBase58()).toBe(PAYER);
    expect(rpc.callsTo('getAccountInfo')).toBe(2); // owner lookup, then the account read of the builder

    // an explicit payer that does not own the account cannot sign its Revoke
    const mismatch = errorOf(await call(client, 'beagle_close_budget', { tokenAccount: PAYER_ATA, payer: AGENT }));
    expect(mismatch.code).toBe('invalid_request');
    expect(mismatch.message).toMatch(new RegExp(`${PAYER_ATA} is owned by ${PAYER}, not by ${AGENT}, so ${AGENT} cannot sign its Revoke`));
  });

  it('asks for payer or tokenAccount (not a workspace) when nothing identifies the signer', async () => {
    const client = await connect(createFakeApi());
    const error = errorOf(await call(client, 'beagle_close_budget'));
    expect(error.code).toBe('invalid_request');
    expect(error.message).toMatch(/signer of the Revoke is unknown: pass tokenAccount .* or payer/);
    expect(error.message).not.toMatch(/workspace is required/);
  });

  it('executes with a wallet', async () => {
    const wallet = fakeWallet();
    const client = await connect(createFakeApi(), { wallet });
    const data = structured(await call(client, 'beagle_close_budget', { tokenAccount: AGENT_ATA }));
    expect(data['executed']).toBe(true);
    expect(data['signature']).toBe(SIG);
    expect(data['slot']).toBe(43);
    expect(data['tokenAccount']).toBe(AGENT_ATA);
    expect(data['delegate']).toBeUndefined(); // the fake executor does not read the delegation
    expect(data['note']).toMatch(/^Revoked the delegation of token account/);
    expect(data['note']).toMatch(/closed \(revoked\)/);
    expect(wallet.calls).toEqual([{ closeBudget: { tokenAccount: AGENT_ATA } }]);
    structured(await call(client, 'beagle_close_budget'));
    expect(wallet.calls[1]).toEqual({ closeBudget: {} });
  });

  it('reports the delegation an executed Revoke cleared, or that there was none', async () => {
    const wallet = fakeWallet({
      closeBudget: async (params) => ({ signature: SIG, tokenAccount: params.tokenAccount ?? AGENT_ATA, delegate: params.tokenAccount === undefined ? null : OPERATOR, delegatedAmount: params.tokenAccount === undefined ? 0n : 20n * ONE }),
    });
    const client = await connect(createFakeApi(), { wallet });
    const cleared = structured(await call(client, 'beagle_close_budget', { tokenAccount: PAYER_ATA }));
    expect(cleared['delegate']).toBe(OPERATOR);
    expect(cleared['delegatedAmount']).toBe((20n * ONE).toString());
    expect(cleared['note']).toMatch(new RegExp(`^Revoked the delegation of 20 BEAGLE to ${OPERATOR} of token account ${PAYER_ATA}`));

    const none = structured(await call(client, 'beagle_close_budget'));
    expect(none['executed']).toBe(true);
    expect(none['delegate']).toBeNull();
    expect(none['delegatedAmount']).toBe('0');
    expect(none['note']).toMatch(/had no delegate: nothing changed and no budget was open on it/);
    expect(none['note']).toMatch(/Pass tokenAccount/);
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
    expect(qsText).toMatch(/SPL `BurnChecked`/);
    expect(qsText).toMatch(/published price point in force when it observes the burn/);
    expect(qsText).toMatch(/`ApproveChecked`/);
    expect(qsText).toMatch(/beagle_close_budget/);
    expect(qsText).not.toMatch(/CreditDesk|Robinhood|tolerance/);
  });
});

/** Keeps the fake api type in scope for editors (the helpers above are typed against it). */
export type _FakeApiRef = FakeApi;
