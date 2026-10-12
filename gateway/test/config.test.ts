import { readFileSync } from 'node:fs';
import { encodeBase58 } from '@beagle/shared/solana';
import { describe, expect, it } from 'vitest';
import { ChainConfigError, publicRpcUrlOf, resolveChainInfo } from '../src/chain/rpc.js';
import { ConfigError, DEV_SESSION_SECRET, loadConfig, parsePriceUsdE18, parseSecretKey, testConfig } from '../src/config.js';
import { MINT, OPERATOR } from './helpers.js';

const OPERATOR_KEY_JSON = readFileSync(new URL('../../solana/keys/operator.json', import.meta.url), 'utf8');

describe('config', () => {
  it('applies defaults and converts USD values to µUSD / priceE18', () => {
    const c = loadConfig({});
    expect(c.cluster).toEqual({
      name: 'localnet',
      rpcUrl: undefined,
      wsUrl: undefined,
      mint: undefined,
      tokenProgram: undefined,
      commitment: 'confirmed',
      indexFromSignature: undefined,
      indexPageLimit: 1000,
      pollIntervalMs: 2000,
      txFetchConcurrency: 4,
    });
    expect(c.operator).toEqual({ secretKey: undefined, secretKeyIsSeed: false, dryRun: true, priorityFeeMicrolamports: 0 });
    expect(c.price).toEqual({
      source: 'manual',
      initialPriceE18: undefined,
      feedUrl: undefined,
      jupiterUrl: 'https://lite-api.jup.ag/price/v3',
      refreshMs: 60_000,
      minChangeBps: 50,
      maxStepBps: 2500,
      maxAgeS: 3600,
      creditWhenStale: true,
      minCreditMicro: 1000n,
    });
    expect(c.budgets).toEqual({ scanIntervalMs: 30_000, headroomRefreshMs: 15_000, drawThresholdMicro: 1_000_000n, drawIntervalMs: 30_000, drawConfirmTimeoutMs: 90_000 });
    expect(c.server.port).toBe(8787);
    expect(c.economics.markupBps).toBe(1000);
    expect(c.economics.lowCreditMicro).toBe(1_000_000n);
    expect(c.economics.minReserveMicro).toBe(10_000n);
    expect(c.economics.proPriceMicro).toBe(20_000_000n);
    expect(c.secrets.sessionSecret).toBe(DEV_SESSION_SECRET);
    expect(c.secrets.sessionSecretIsDefault).toBe(true);
    expect(c.providers.houseBaseUrl).toBeUndefined();
    expect(c.server.publicHost).toBe('localhost:8787');
  });

  it('treats empty strings as unset and accepts cluster aliases', () => {
    const c = loadConfig({ ANTHROPIC_API_KEY: '', OPERATOR_SECRET_KEY: '', MINT_ADDRESS: '', RPC_URL: '', INDEX_FROM_SIGNATURE: '', CLUSTER: 'mainnet' });
    expect(c.providers.anthropicApiKey).toBeUndefined();
    expect(c.operator.secretKey).toBeUndefined();
    expect(c.cluster.mint).toBeUndefined();
    expect(c.cluster.rpcUrl).toBeUndefined();
    expect(c.cluster.name).toBe('mainnet-beta');
    expect(loadConfig({ CLUSTER: 'devnet' }).cluster.name).toBe('devnet');
  });

  it('parses the e2e environment (JSON operator key, overrides, feed)', () => {
    const c = loadConfig({
      CLUSTER: 'localnet',
      RPC_URL: 'http://127.0.0.1:8899/',
      MINT_ADDRESS: MINT,
      COMMITMENT: 'confirmed',
      OPERATOR_SECRET_KEY: OPERATOR_KEY_JSON,
      DRY_RUN: 'false',
      PRIORITY_FEE_MICROLAMPORTS: '5',
      PRICE_SOURCE: 'manual',
      INITIAL_PRICE_USD: '0.01',
      MIN_CREDIT_USD: '0.000001',
      DRAW_THRESHOLD_USD: '0.000001',
      BUDGET_SCAN_INTERVAL_MS: '2000',
      PUBLIC_WEB_ORIGIN: 'http://localhost:5173, http://web:80/',
      KEYRING_MASTER_KEY: '11'.repeat(32),
      HOUSE_BASE_URL: 'http://127.0.0.1:9999/v1/',
    });
    expect(c.cluster.rpcUrl).toBe('http://127.0.0.1:8899');
    expect(c.cluster.mint).toBe(MINT);
    expect(c.operator.dryRun).toBe(false);
    expect(c.operator.secretKey).toHaveLength(64);
    expect(encodeBase58(c.operator.secretKey!.subarray(32))).toBe(OPERATOR);
    expect(c.operator.priorityFeeMicrolamports).toBe(5);
    expect(c.price.initialPriceE18).toBe(10n ** 16n);
    expect(c.price.minCreditMicro).toBe(1n);
    expect(c.budgets.drawThresholdMicro).toBe(1n);
    expect(c.budgets.scanIntervalMs).toBe(2000);
    expect(c.server.webOrigins).toEqual(['http://localhost:5173', 'http://web:80']);
    expect(c.secrets.keyringMasterKey?.length).toBe(32);
    expect(c.providers.houseBaseUrl).toBe('http://127.0.0.1:9999/v1');
    const feed = loadConfig({ PRICE_SOURCE: 'feed', PRICE_FEED_URL: 'https://feed.example/price' });
    expect(feed.price).toMatchObject({ source: 'feed', feedUrl: 'https://feed.example/price' });
  });

  it('accepts the operator key as base58 (64-byte key or 32-byte seed) and validates it', () => {
    const bytes = Uint8Array.from(JSON.parse(OPERATOR_KEY_JSON) as number[]);
    const full = parseSecretKey(encodeBase58(bytes));
    expect(encodeBase58(full.subarray(32))).toBe(OPERATOR);
    const seed = parseSecretKey(encodeBase58(bytes.subarray(0, 32)));
    expect(encodeBase58(seed.subarray(32))).toBe(OPERATOR);
    expect(loadConfig({ OPERATOR_SECRET_KEY: encodeBase58(bytes) }).operator.secretKey).toEqual(full);
    const corrupted = Uint8Array.from(bytes);
    corrupted[40] = (corrupted[40]! + 1) % 256;
    expect(() => parseSecretKey(JSON.stringify([...corrupted]))).toThrow(/does not match/);
    expect(() => parseSecretKey('[1,2,3]')).toThrow(/64 bytes/);
    expect(() => parseSecretKey('[1,"x"]')).toThrow(/array of bytes/);
    expect(() => parseSecretKey('[1,2')).toThrow(/JSON/);
    expect(() => parseSecretKey('0OIl')).toThrow(/base58/);
    expect(() => loadConfig({ OPERATOR_SECRET_KEY: '[1,2,3]' })).toThrow(ConfigError);
    // A 32-byte value is flagged as a seed; the operator's *public* key pasted by mistake derives another key → refused at chain resolution.
    expect(loadConfig({ OPERATOR_SECRET_KEY: encodeBase58(bytes.subarray(0, 32)) }).operator.secretKeyIsSeed).toBe(true);
    expect(loadConfig({ OPERATOR_SECRET_KEY: encodeBase58(bytes) }).operator.secretKeyIsSeed).toBe(false);
    expect(resolveChainInfo(testConfig({ OPERATOR_SECRET_KEY: encodeBase58(bytes.subarray(0, 32)) })).operator).toBe(OPERATOR);
    expect(() => resolveChainInfo(testConfig({ OPERATOR_SECRET_KEY: OPERATOR }))).toThrow(ChainConfigError);
  });

  it('keeps RPC_URL private and publishes PUBLIC_RPC_URL or the cluster endpoint', () => {
    const c = testConfig({ CLUSTER: 'mainnet-beta', RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=SECRET' });
    expect(c.cluster.publicRpcUrl).toBeUndefined();
    expect(publicRpcUrlOf(c, c.cluster.rpcUrl!)).toBe('https://api.mainnet-beta.solana.com');
    const explicit = testConfig({ CLUSTER: 'mainnet-beta', RPC_URL: 'https://mainnet.helius-rpc.com/?api-key=SECRET', PUBLIC_RPC_URL: 'https://rpc.public.example/' });
    expect(publicRpcUrlOf(explicit, explicit.cluster.rpcUrl!)).toBe('https://rpc.public.example');
    const local = testConfig({ RPC_URL: 'http://127.0.0.1:18899' });
    expect(publicRpcUrlOf(local, local.cluster.rpcUrl!)).toBe('http://127.0.0.1:18899');
    expect(resolveChainInfo(local)).toMatchObject({ rpcUrl: 'http://127.0.0.1:18899', publicRpcUrl: 'http://127.0.0.1:18899' });
    expect(() => testConfig({ PUBLIC_RPC_URL: 'ftp://x' })).toThrow(ConfigError);
    expect(testConfig({ AUTH_RATE_LIMIT_RPM: '7' }).economics.authRateLimitRpm).toBe(7);
  });

  it('parses USD prices into priceE18', () => {
    expect(parsePriceUsdE18('0.01')).toBe(10n ** 16n);
    expect(parsePriceUsdE18('$0.0025')).toBe(2_500_000_000_000_000n);
    expect(parsePriceUsdE18('1')).toBe(10n ** 18n);
    expect(parsePriceUsdE18('0.000000000000000001')).toBe(1n);
    expect(() => parsePriceUsdE18('0')).toThrow(RangeError);
    expect(() => parsePriceUsdE18('0.0000000000000000001')).toThrow(RangeError);
    expect(() => parsePriceUsdE18('abc')).toThrow(SyntaxError);
  });

  it('rejects bad values', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ LOW_CREDIT_USD: 'lots' })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ MIN_RESERVE_USD: '10', MAX_RESERVE_USD: '1' })).toThrow(/MIN_RESERVE_USD/);
    expect(() => loadConfig({ PRICE_SOURCE: 'feed' })).toThrow(/PRICE_FEED_URL/);
    expect(() => loadConfig({ PRICE_SOURCE: 'oracle' })).toThrow(ConfigError);
    expect(() => loadConfig({ CLUSTER: 'testnet' })).toThrow(/unknown cluster/);
    expect(() => loadConfig({ COMMITMENT: 'processed' })).toThrow(ConfigError);
    expect(() => loadConfig({ MINT_ADDRESS: '0x1234' })).toThrow(/base58/);
    expect(() => loadConfig({ INDEX_FROM_SIGNATURE: 'abc' })).toThrow(/signature/);
    expect(() => loadConfig({ INITIAL_PRICE_USD: '-1' })).toThrow(ConfigError);
    expect(() => loadConfig({ RPC_URL: 'ftp://x' })).toThrow(/RPC_URL/);
    expect(() => loadConfig({ KEYRING_MASTER_KEY: 'short' })).toThrow(ConfigError);
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });

  it('testConfig is production-free and in-memory', () => {
    const c = testConfig();
    expect(c.server.dbPath).toBe(':memory:');
    expect(c.isProduction).toBe(false);
    expect(c.secrets.adminToken).toBe('test-admin');
    expect(c.cluster.name).toBe('localnet');
  });
});
