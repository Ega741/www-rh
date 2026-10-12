import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BudgetDtoWire, ConfigDtoWire, CreditEventDtoWire, PriceDtoWire, StatusDtoWire, UsageReceiptWire } from '@beagle/shared/api';
import { receiptHash } from '@beagle/shared/canonical';
import { ApiError, api, queryString, sessionToken } from './api.js';

type FetchCall = { url: string; init: RequestInit };

const WS = 'BEJQY85xuHoT2NyAT5eXF9ftMv6RnSM7LQSujxm8BAbZ';
const MINT = 'HBJrfAHGsn7WQYk4FaBXv3wA7fVRL4ctSriSdj3UiDND';
const ATA = 'So11111111111111111111111111111111111111112';
const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';

const PRICE: PriceDtoWire = { pricePointId: 7, priceE18: '2500000000000000', observedAt: 1760000000, stale: false, source: 'manual', maxAgeS: 3600, usdPerToken: '0.0025', tokensPerUsd: '400' };

function stubFetch(status: number, body: unknown, calls: FetchCall[]): void {
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('queryString', () => {
  it('serialises defined scalars only', () => {
    expect(queryString({ limit: 50, before: undefined, model: 'beagle/auto', tokens: 10n ** 18n, stream: true })).toBe('?limit=50&model=beagle%2Fauto&tokens=1000000000000000000&stream=true');
    expect(queryString({})).toBe('');
  });
});

describe('api client', () => {
  it('parses wire DTOs into bigint and sends credentials', async () => {
    const calls: FetchCall[] = [];
    stubFetch(200, { balanceMicro: '2500000', reservedMicro: '0', budgetHeadroomMicro: '100', availableMicro: '2500100', plan: 'free', planUntil: null, price: PRICE }, calls);
    const b = await api.balance();
    expect(b.balanceMicro).toBe(2_500_000n);
    expect(b.price.priceE18).toBe(2_500_000_000_000_000n);
    expect(b.price.pricePointId).toBe(7);
    expect(calls[0]?.url).toBe('/api/balance');
    expect(calls[0]?.init.credentials).toBe('include');
    expect(calls[0]?.init.method).toBe('GET');
    const headers = calls[0]?.init.headers as Headers;
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('authorization')).toBeNull();
  });

  it('posts the SIWS verify body { message, signature, publicKey }', async () => {
    const calls: FetchCall[] = [];
    stubFetch(200, { token: 'abc', workspace: WS }, calls);
    const v = await api.verify('msg', SIG, WS);
    expect(v.token).toBe('abc');
    expect(v.workspace).toBe(WS);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe(JSON.stringify({ message: 'msg', signature: SIG, publicKey: WS }));
    expect((calls[0]?.init.headers as Headers).get('content-type')).toBe('application/json');
  });

  it('parses /api/price and /api/price/history', async () => {
    const calls: FetchCall[] = [];
    stubFetch(200, PRICE, calls);
    const p = await api.price();
    expect(p).toMatchObject({ pricePointId: 7, observedAt: 1760000000, stale: false, source: 'manual', maxAgeS: 3600 });
    stubFetch(200, [PRICE, { ...PRICE, pricePointId: 6, priceE18: '2400000000000000' }], calls);
    const history = await api.priceHistory(2);
    expect(history.map((x) => x.pricePointId)).toEqual([7, 6]);
    expect(calls[1]?.url).toBe('/api/price/history?limit=2');
  });

  it('parses /api/config and /api/status (Solana shapes)', async () => {
    const config: ConfigDtoWire = {
      cluster: 'localnet',
      rpcUrl: 'http://127.0.0.1:8899',
      mint: MINT,
      decimals: 6,
      symbol: 'BEAGLE',
      tokenProgram: TOKEN_PROGRAM,
      memoProgram: MEMO_PROGRAM,
      operator: null,
      explorer: 'https://explorer.solana.com',
      aliases: ['beagle/auto'],
      markupBps: 2000,
      byokFeeBps: 0,
      minCreditMicro: '1000',
      pro: { priceMicro: '20000000', days: 30 },
      warmHourPriceMicro: '500000',
    };
    const calls: FetchCall[] = [];
    stubFetch(200, config, calls);
    const c = await api.config();
    expect(c.minCreditMicro).toBe(1000n);
    expect(c.operator).toBeNull();
    expect(c.pro.priceMicro).toBe(20_000_000n);
    const status: StatusDtoWire = {
      cluster: 'localnet',
      mint: MINT,
      token: { mint: MINT, symbol: 'BEAGLE', decimals: 6, tokenProgram: TOKEN_PROGRAM },
      indexer: { lastSignature: null, lastSlot: null, headSlot: 120, lagSlots: 0, lastEventAt: null },
      price: PRICE,
      providers: { anthropic: { state: 'ok', configured: true }, openai: { state: 'down', configured: false }, google: { state: 'degraded', configured: true }, house: { state: 'ok', configured: true } },
      house: { enabled: false, warmUntil: null, largeModel: 'gpt-oss-120b' },
      operator: { address: WS, enabled: true, dryRun: true, solBalance: '1000000000' },
      version: '0.1.0',
    };
    stubFetch(200, status, calls);
    const s = await api.status();
    expect(s.indexer.lastSlot).toBeNull();
    expect(s.operator.solBalance).toBe(1_000_000_000n);
    expect(s.providers.anthropic?.state).toBe('ok');
  });

  it('parses credit events keyed by signature:ixIndex', async () => {
    const row: CreditEventDtoWire = {
      signature: SIG,
      ixIndex: 0,
      slot: 55,
      blockTime: 1760000100,
      kind: 'purchase',
      workspace: WS,
      payer: WS,
      tokenAccount: ATA,
      tokenAmount: '1000000000',
      usdMicro: '10000000',
      priceE18: '10000000000000000',
      pricePointId: 7,
      priceStale: false,
      memo: null,
      receiptHash: null,
      explorerUrl: `https://explorer.solana.com/tx/${SIG}`,
    };
    const calls: FetchCall[] = [];
    stubFetch(200, { rows: [row], nextBefore: null }, calls);
    const list = await api.receipts.list({ limit: 10 });
    expect(calls[0]?.url).toBe('/api/receipts?limit=10');
    expect(list.rows[0]).toMatchObject({ signature: SIG, ixIndex: 0, tokenAmount: 1_000_000_000n, usdMicro: 10_000_000n, priceE18: 10n ** 16n, pricePointId: 7 });
    expect(list.nextBefore).toBeNull();
  });

  it('budgets are keyed by token account: get, draws and register', async () => {
    const budget: BudgetDtoWire = {
      tokenAccount: ATA,
      owner: WS,
      workspace: WS,
      delegate: WS,
      cap: '5000000',
      balance: '9000000',
      headroomTokens: '5000000',
      headroomMicro: '50000',
      closed: false,
      stalledReason: null,
      registeredAt: 1_760_000_000_000,
      lastSeenSlot: 60,
      draws: [{ id: 1, tokenAccount: ATA, workspace: WS, tokenAmount: '100', usdMicro: '1', receiptHash: `0x${'ab'.repeat(32)}`, usageIds: ['req_1'], signature: null, status: 'pending', error: null, createdAt: 1, updatedAt: 2 }],
    };
    const calls: FetchCall[] = [];
    stubFetch(200, [budget], calls);
    const list = await api.budgets.list();
    expect(list[0]?.cap).toBe(5_000_000n);
    expect(list[0]?.draws[0]?.signature).toBeNull();
    stubFetch(200, budget, calls);
    await api.budgets.get(ATA);
    expect(calls[1]?.url).toBe(`/api/budgets/${ATA}`);
    stubFetch(200, budget.draws, calls);
    expect(await api.budgets.draws(ATA)).toHaveLength(1);
    expect(calls[2]?.url).toBe(`/api/budgets/${ATA}/draws`);
    stubFetch(201, budget, calls);
    const registered = await api.budgets.register({ tokenAccount: ATA });
    expect(registered.headroomMicro).toBe(50_000n);
    expect(calls[3]?.url).toBe('/api/budgets/register');
    expect(calls[3]?.init.body).toBe(JSON.stringify({ tokenAccount: ATA }));
    stubFetch(201, budget, calls);
    await api.budgets.register({ tokenAccount: ATA, workspace: WS });
    expect(calls[4]?.init.body).toBe(JSON.stringify({ tokenAccount: ATA, workspace: WS }));
    stubFetch(400, { error: { code: 'not_delegated', message: 'The account is not delegated to the operator' } }, calls);
    await expect(api.budgets.register({ tokenAccount: ATA })).rejects.toMatchObject({ status: 400, code: 'not_delegated' });
  });

  it('accepts bare arrays or envelopes for list routes', async () => {
    const key = { id: 'k1', prefix: 'bgl_abcdefgh', name: 'default', createdAt: 1, lastUsedAt: null };
    const calls: FetchCall[] = [];
    stubFetch(200, [key], calls);
    expect(await api.keys.list()).toHaveLength(1);
    stubFetch(200, { keys: [key, { ...key, id: 'k2' }] }, calls);
    expect((await api.keys.list()).map((k) => k.id)).toEqual(['k1', 'k2']);
    stubFetch(200, { nope: 1 }, calls);
    await expect(api.keys.list()).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('maps the gateway error envelope to ApiError', async () => {
    const calls: FetchCall[] = [];
    stubFetch(402, { error: { code: 'insufficient_credit', message: 'Insufficient credit' } }, calls);
    const err = await api.upgrades.buy('pro', 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 402, code: 'insufficient_credit', message: 'Insufficient credit' });
    stubFetch(401, undefined, calls);
    const unauth = await api.me().catch((e: unknown) => e);
    expect(unauth).toMatchObject({ status: 401, code: 'http_401' });
    expect((unauth as ApiError).unauthorized).toBe(true);
  });

  it('reports network failures as ApiError(0)', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    await expect(api.status()).rejects.toMatchObject({ status: 0, code: 'network_error' });
  });

  it('parses GET /api/receipts/:id into the nested { receipt, hash } and the hash recomputes over receipt alone', async () => {
    const receipt: UsageReceiptWire = {
      v: 1,
      requestId: 'req_1',
      workspace: WS,
      createdAt: 1_760_000_000_000,
      endpoint: '/v1/chat/completions',
      requestedModel: 'beagle/auto',
      servedModel: 'house/gpt-oss-20b',
      provider: 'house',
      paidBy: 'credit',
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      price: { inputPerM: 100_000, outputPerM: 400_000 },
      upstreamCostMicro: '3',
      markupBps: 2000,
      chargedMicro: '4',
      routeReasons: ['alias:auto'],
    };
    const hash = receiptHash(receipt);
    const calls: FetchCall[] = [];
    stubFetch(200, { receipt, hash, ...receipt }, calls);
    const dto = await api.receipts.get('req_1');
    expect(calls[0]?.url).toBe('/api/receipts/req_1');
    expect(Object.keys(dto).sort()).toEqual(['hash', 'receipt']);
    expect(dto.hash).toBe(hash);
    expect(dto.receipt.chargedMicro).toBe(4n);
    expect(receiptHash(dto.receipt)).toBe(hash);
  });

  it('rejects malformed DTOs', async () => {
    stubFetch(200, { priceE18: 'not-a-number' }, []);
    await expect(api.price()).rejects.toMatchObject({ code: 'bad_response' });
    stubFetch(200, { token: 'abc', workspace: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' }, []);
    await expect(api.verify('m', SIG, WS)).rejects.toMatchObject({ code: 'bad_response' });
  });
});

describe('sessionToken', () => {
  it('keeps the bearer token in localStorage (shared by every tab) and sends it as a header', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
    });
    expect(sessionToken.get()).toBeUndefined();
    sessionToken.set('tok_1');
    expect(store.get('beagle.session.token')).toBe('tok_1');
    expect(sessionToken.get()).toBe('tok_1');
    const calls: FetchCall[] = [];
    stubFetch(200, PRICE, calls);
    await api.price();
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe('Bearer tok_1');
    sessionToken.clear();
    expect(sessionToken.get()).toBeUndefined();
    expect(store.size).toBe(0);
  });
  it('is a no-op without storage (cookie-only session)', () => {
    vi.stubGlobal('window', {});
    expect(sessionToken.get()).toBeUndefined();
    expect(() => sessionToken.set('x')).not.toThrow();
    expect(() => sessionToken.clear()).not.toThrow();
  });
});
