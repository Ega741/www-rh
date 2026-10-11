import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api, queryString } from './api.js';

type FetchCall = { url: string; init: RequestInit };

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
    stubFetch(200, {
      balanceMicro: '2500000',
      reservedMicro: '0',
      budgetHeadroomMicro: '100',
      availableMicro: '2500100',
      plan: 'free',
      planUntil: null,
      price: { priceE18: '2500000000000000', updatedAt: 1760000000, stale: false, usdPerToken: '0.0025', tokensPerUsd: '400', source: 'manual', maxPriceAge: 3600 },
    }, calls);
    const b = await api.balance();
    expect(b.balanceMicro).toBe(2_500_000n);
    expect(b.price.priceE18).toBe(2_500_000_000_000_000n);
    expect(calls[0]?.url).toBe('/api/balance');
    expect(calls[0]?.init.credentials).toBe('include');
    expect(calls[0]?.init.method).toBe('GET');
    const headers = calls[0]?.init.headers as Headers;
    expect(headers.get('accept')).toBe('application/json');
    expect(headers.get('authorization')).toBeNull();
  });

  it('posts JSON bodies', async () => {
    const calls: FetchCall[] = [];
    stubFetch(200, { token: 'abc', workspace: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266' }, calls);
    const v = await api.verify('msg', '0x1234');
    expect(v.token).toBe('abc');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe(JSON.stringify({ message: 'msg', signature: '0x1234' }));
    expect((calls[0]?.init.headers as Headers).get('content-type')).toBe('application/json');
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

  it('rejects malformed DTOs', async () => {
    stubFetch(200, { priceE18: 'not-a-number' }, []);
    await expect(api.price()).rejects.toMatchObject({ code: 'bad_response' });
  });
});
