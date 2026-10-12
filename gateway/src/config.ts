/**
 * Environment configuration (SPEC §5.1), validated with zod. Empty strings count as unset; USD
 * values become `bigint` µUSD; `INITIAL_PRICE_USD` becomes `priceE18`; the operator secret key is
 * accepted as base58 (64-byte secret key or 32-byte seed) or as the JSON byte array written by
 * `solana-keygen`.
 *
 * @module config
 */
import { parseCluster, type Cluster } from '@beagle/shared/clusters';
import { parseUsdToMicro } from '@beagle/shared/credit';
import { decodeBase58, isBase58Pubkey, isBase58Signature } from '@beagle/shared/solana';
import nacl from 'tweetnacl';
import { z } from 'zod';
import { isLogLevel, type LogLevel } from './log.js';

const blankToUndefined = (v: unknown): unknown => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optStr = () => z.preprocess(blankToUndefined, z.string().optional());
const str = (def: string) => z.preprocess(blankToUndefined, z.string().default(def));
const int = (def: number, min = 0) => z.preprocess(blankToUndefined, z.coerce.number().int().min(min).default(def));
const bool = (def: boolean) =>
  z.preprocess((v) => {
    if (typeof v !== 'string') return v;
    const t = v.trim().toLowerCase();
    if (t === '') return undefined;
    if (['1', 'true', 'yes', 'on'].includes(t)) return true;
    if (['0', 'false', 'no', 'off'].includes(t)) return false;
    return v;
  }, z.boolean().default(def));
const usd = (def: string) =>
  z.preprocess(blankToUndefined, z.string().default(def)).transform((s, ctx) => {
    try {
      const micro = parseUsdToMicro(s);
      if (micro < 0n) throw new RangeError('must be ≥ 0');
      return micro;
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: `invalid USD amount ${JSON.stringify(s)}: ${e instanceof Error ? e.message : String(e)}` });
      return 0n;
    }
  });
const pubkey = z.preprocess(blankToUndefined, z.string().trim().refine(isBase58Pubkey, 'expected a base58 public key').optional());
const signature = z.preprocess(blankToUndefined, z.string().trim().refine(isBase58Signature, 'expected a base58 transaction signature').optional());
const cluster = z.preprocess(blankToUndefined, z.string().optional()).transform((s, ctx): Cluster => {
  try {
    return parseCluster(s);
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: e instanceof Error ? e.message : String(e) });
    return 'localnet';
  }
});

/**
 * Parses a USD price per whole token (`"0.01"`, `"$0.0025"`) into `priceE18` (18-decimal fixed
 * point). Up to 18 fraction digits; the price must be positive.
 */
export function parsePriceUsdE18(input: string): bigint {
  const m = /^\s*\$?\s*(\d*)(?:\.(\d*))?\s*$/.exec(input);
  if (!m || ((m[1] ?? '') === '' && (m[2] ?? '') === '')) throw new SyntaxError(`invalid USD price: ${JSON.stringify(input)}`);
  const whole = m[1] === undefined || m[1] === '' ? '0' : m[1];
  const frac = m[2] ?? '';
  if (frac.length > 18) throw new RangeError(`USD price has more than 18 fraction digits: ${JSON.stringify(input)}`);
  const value = BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, '0') || '0');
  if (value <= 0n) throw new RangeError('USD price must be positive');
  return value;
}

/**
 * Parses `OPERATOR_SECRET_KEY`: a JSON byte array (`[12, 34, …]`, 64 bytes) or base58 text that
 * decodes to a 64-byte secret key or a 32-byte seed. Returns the 64-byte Ed25519 secret key.
 */
export function parseSecretKey(input: string): Uint8Array {
  return parseSecretKeyDetailed(input).secretKey;
}

/** {@link parseSecretKey} plus whether the input was a 32-byte seed (indistinguishable from a public key). */
export function parseSecretKeyDetailed(input: string): { secretKey: Uint8Array; fromSeed: boolean } {
  const text = input.trim();
  let bytes: Uint8Array | undefined;
  if (text.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SyntaxError('OPERATOR_SECRET_KEY: invalid JSON byte array');
    }
    if (!Array.isArray(parsed) || !parsed.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
      throw new TypeError('OPERATOR_SECRET_KEY: expected a JSON array of bytes');
    }
    bytes = Uint8Array.from(parsed as number[]);
  } else {
    bytes = decodeBase58(text);
    if (bytes === undefined) throw new TypeError('OPERATOR_SECRET_KEY: expected base58 or a JSON byte array');
  }
  if (bytes.length === 32) return { secretKey: nacl.sign.keyPair.fromSeed(bytes).secretKey, fromSeed: true };
  if (bytes.length !== 64) throw new RangeError(`OPERATOR_SECRET_KEY: expected 64 bytes (or a 32-byte seed), got ${bytes.length}`);
  // Validate: the public half must match the seed half.
  const derived = nacl.sign.keyPair.fromSeed(bytes.subarray(0, 32)).secretKey;
  for (let i = 32; i < 64; i++) if (derived[i] !== bytes[i]) throw new RangeError('OPERATOR_SECRET_KEY: public key does not match the seed');
  return { secretKey: bytes, fromSeed: false };
}

const secretKey = z.preprocess(blankToUndefined, z.string().optional()).transform((s, ctx) => {
  if (s === undefined) return undefined;
  try {
    return parseSecretKeyDetailed(s);
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: e instanceof Error ? e.message : String(e) });
    return undefined;
  }
});
const priceUsd = z.preprocess(blankToUndefined, z.string().optional()).transform((s, ctx) => {
  if (s === undefined) return undefined;
  try {
    return parsePriceUsdE18(s);
  } catch (e) {
    ctx.addIssue({ code: 'custom', message: e instanceof Error ? e.message : String(e) });
    return undefined;
  }
});

/** Zod schema of the environment (keys of SPEC §5.1). */
export const EnvSchema = z.object({
  NODE_ENV: str('development'),
  // cluster
  CLUSTER: cluster,
  RPC_URL: optStr(),
  RPC_WS_URL: optStr(),
  PUBLIC_RPC_URL: optStr(),
  MINT_ADDRESS: pubkey,
  TOKEN_PROGRAM: pubkey,
  COMMITMENT: z.preprocess(blankToUndefined, z.enum(['confirmed', 'finalized']).default('confirmed')),
  INDEX_FROM_SIGNATURE: signature,
  INDEX_PAGE_LIMIT: int(1000, 1),
  POLL_INTERVAL_MS: int(2000, 100),
  TX_FETCH_CONCURRENCY: int(4, 1),
  // operator
  OPERATOR_SECRET_KEY: secretKey,
  DRY_RUN: bool(true),
  PRIORITY_FEE_MICROLAMPORTS: int(0),
  // price
  PRICE_SOURCE: z.preprocess(blankToUndefined, z.enum(['manual', 'feed', 'jupiter']).default('manual')),
  INITIAL_PRICE_USD: priceUsd,
  PRICE_FEED_URL: optStr(),
  JUPITER_PRICE_URL: str('https://lite-api.jup.ag/price/v3'),
  PRICE_REFRESH_MS: int(60_000, 1000),
  PRICE_MIN_CHANGE_BPS: int(50),
  PRICE_MAX_STEP_BPS: int(2500, 1),
  PRICE_MAX_AGE_S: int(3600, 1),
  CREDIT_WHEN_STALE: bool(true),
  MIN_CREDIT_USD: usd('0.001'),
  // budgets
  BUDGET_SCAN_INTERVAL_MS: int(30_000, 100),
  BUDGET_HEADROOM_REFRESH_MS: int(15_000, 100),
  DRAW_THRESHOLD_USD: usd('1'),
  DRAW_INTERVAL_MS: int(30_000, 100),
  DRAW_CONFIRM_TIMEOUT_MS: int(90_000, 1000),
  // server
  PORT: int(8787, 0),
  HOST: str('0.0.0.0'),
  PUBLIC_URL: str('http://localhost:8787'),
  PUBLIC_WEB_ORIGIN: str('http://localhost:5173'),
  DB_PATH: str('./data/gateway.sqlite'),
  MAX_BODY_BYTES: int(2_000_000, 1024),
  TRUST_PROXY: bool(false),
  LOG_LEVEL: str('info'),
  LOG_PROMPTS: bool(false),
  // secrets
  SESSION_SECRET: optStr(),
  KEYRING_MASTER_KEY: z.preprocess(blankToUndefined, z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/, 'expected 64 hex chars').optional()),
  ADMIN_TOKEN: optStr(),
  // providers
  ANTHROPIC_API_KEY: optStr(),
  OPENAI_API_KEY: optStr(),
  OPENAI_BASE_URL: str('https://api.openai.com/v1'),
  GOOGLE_API_KEY: optStr(),
  GOOGLE_BASE_URL: str('https://generativelanguage.googleapis.com/v1beta/openai'),
  HOUSE_BASE_URL: optStr(),
  HOUSE_API_KEY: optStr(),
  HOUSE_MODEL_SMALL: str('openai/gpt-oss-20b'),
  HOUSE_MODEL_LARGE: str('openai/gpt-oss-120b'),
  PROVIDER_TIMEOUT_MS: int(120_000, 1000),
  MODEL_CATALOG_FILE: optStr(),
  // economics
  MARKUP_BPS: int(1000),
  BYOK_FEE_BPS: int(0),
  LOW_CREDIT_USD: usd('1'),
  VERY_LOW_CREDIT_USD: usd('0.1'),
  MIN_RESERVE_USD: usd('0.01'),
  MAX_RESERVE_USD: usd('5'),
  RESERVATION_TTL_MS: int(600_000, 1000),
  PRO_PRICE_USD: usd('20'),
  PRO_DAYS: int(30, 1),
  WARM_HOUR_PRICE_USD: usd('2'),
  RATE_LIMIT_RPM: int(60, 1),
  RATE_LIMIT_RPM_PRO: int(300, 1),
  AUTH_RATE_LIMIT_RPM: int(60, 1),
  WARM_DRIVER: z.preprocess(blankToUndefined, z.enum(['log', 'ollama', 'http']).default('log')),
  WARM_WEBHOOK_URL: optStr(),
  WARM_PING_INTERVAL_MS: int(240_000, 1000),
});

/** Raw parsed env. */
export type Env = z.output<typeof EnvSchema>;

/** Where price points come from (SPEC §3.3). */
export type PriceSourceKind = 'manual' | 'feed' | 'jupiter';
/** RPC commitment used for reads and confirmations. */
export type CommitmentLevel = 'confirmed' | 'finalized';

/** The validated gateway configuration. */
export interface Config {
  nodeEnv: string;
  isProduction: boolean;
  cluster: {
    name: Cluster;
    /** `RPC_URL` override (the cluster default applies when unset). May carry a provider key: never published. */
    rpcUrl: string | undefined;
    wsUrl: string | undefined;
    /** `PUBLIC_RPC_URL`: the endpoint published to clients; unset → the cluster's public endpoint (localnet: `RPC_URL`). */
    publicRpcUrl: string | undefined;
    /** `MINT_ADDRESS` override of the deployment mint. */
    mint: string | undefined;
    tokenProgram: string | undefined;
    commitment: CommitmentLevel;
    indexFromSignature: string | undefined;
    indexPageLimit: number;
    pollIntervalMs: number;
    txFetchConcurrency: number;
  };
  operator: {
    /** 64-byte Ed25519 secret key; `undefined` → draws disabled. */
    secretKey: Uint8Array | undefined;
    /** `true` when `OPERATOR_SECRET_KEY` was a 32-byte seed (which a pasted public key also is). */
    secretKeyIsSeed: boolean;
    dryRun: boolean;
    priorityFeeMicrolamports: number;
  };
  price: {
    source: PriceSourceKind;
    /** `INITIAL_PRICE_USD` as `priceE18` (manual bootstrap). */
    initialPriceE18: bigint | undefined;
    feedUrl: string | undefined;
    jupiterUrl: string;
    refreshMs: number;
    minChangeBps: number;
    maxStepBps: number;
    maxAgeS: number;
    creditWhenStale: boolean;
    minCreditMicro: bigint;
  };
  budgets: {
    scanIntervalMs: number;
    headroomRefreshMs: number;
    drawThresholdMicro: bigint;
    drawIntervalMs: number;
    drawConfirmTimeoutMs: number;
  };
  server: {
    port: number;
    host: string;
    publicUrl: string;
    /** Host (authority) of `PUBLIC_URL`, the SIWS domain. */
    publicHost: string;
    webOrigins: string[];
    dbPath: string;
    maxBodyBytes: number;
    trustProxy: boolean;
    logLevel: LogLevel;
    logPrompts: boolean;
  };
  secrets: {
    sessionSecret: string;
    /** `true` when `SESSION_SECRET` was absent and a development default is in use. */
    sessionSecretIsDefault: boolean;
    keyringMasterKey: Buffer | undefined;
    adminToken: string | undefined;
  };
  providers: {
    anthropicApiKey: string | undefined;
    openaiApiKey: string | undefined;
    openaiBaseUrl: string;
    googleApiKey: string | undefined;
    googleBaseUrl: string;
    houseBaseUrl: string | undefined;
    houseApiKey: string | undefined;
    houseModelSmall: string;
    houseModelLarge: string;
    timeoutMs: number;
    catalogFile: string | undefined;
  };
  economics: {
    markupBps: number;
    byokFeeBps: number;
    lowCreditMicro: bigint;
    veryLowCreditMicro: bigint;
    minReserveMicro: bigint;
    maxReserveMicro: bigint;
    reservationTtlMs: number;
    proPriceMicro: bigint;
    proDays: number;
    warmHourPriceMicro: bigint;
    rateLimitRpm: number;
    rateLimitRpmPro: number;
    /** Per-IP limit of `GET /api/auth/nonce` / `POST /api/auth/verify` per minute (`AUTH_RATE_LIMIT_RPM`). */
    authRateLimitRpm: number;
    warmDriver: 'log' | 'ollama' | 'http';
    warmWebhookUrl: string | undefined;
    warmPingIntervalMs: number;
  };
}

/** The development session secret used when `SESSION_SECRET` is unset outside production. */
export const DEV_SESSION_SECRET = 'beagle-dev-session-secret-change-me';

/** Thrown by {@link loadConfig} on invalid input. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    throw new ConfigError(`PUBLIC_URL is not a valid URL: ${JSON.stringify(url)}`);
  }
}

/**
 * Parses `env` (default `process.env`) into a {@link Config}. Throws {@link ConfigError} on invalid
 * values; `SESSION_SECRET` is required in production, `KEYRING_MASTER_KEY` only when BYOK is used,
 * `PRICE_FEED_URL` when `PRICE_SOURCE=feed`.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new ConfigError(`invalid configuration: ${details}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';
  if (!isLogLevel(e.LOG_LEVEL)) throw new ConfigError(`LOG_LEVEL must be one of debug|info|warn|error (got ${e.LOG_LEVEL})`);
  if (isProduction && e.SESSION_SECRET === undefined) throw new ConfigError('SESSION_SECRET is required in production');
  if (e.MIN_RESERVE_USD > e.MAX_RESERVE_USD) throw new ConfigError('MIN_RESERVE_USD must be ≤ MAX_RESERVE_USD');
  if (e.PRICE_SOURCE === 'feed' && e.PRICE_FEED_URL === undefined) throw new ConfigError('PRICE_FEED_URL is required when PRICE_SOURCE=feed');
  if (e.WARM_DRIVER === 'http' && e.WARM_WEBHOOK_URL === undefined) throw new ConfigError('WARM_WEBHOOK_URL is required when WARM_DRIVER=http');
  for (const [key, value] of [
    ['RPC_URL', e.RPC_URL],
    ['PUBLIC_RPC_URL', e.PUBLIC_RPC_URL],
    ['PRICE_FEED_URL', e.PRICE_FEED_URL],
    ['JUPITER_PRICE_URL', e.JUPITER_PRICE_URL],
  ] as const) {
    if (value === undefined) continue;
    try {
      const u = new URL(value);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('not http(s)');
    } catch {
      throw new ConfigError(`${key} must be an http(s) URL (got ${JSON.stringify(value)})`);
    }
  }
  const sessionSecret = e.SESSION_SECRET ?? DEV_SESSION_SECRET;
  const masterHex = e.KEYRING_MASTER_KEY === undefined ? undefined : e.KEYRING_MASTER_KEY.replace(/^0x/, '');
  return {
    nodeEnv: e.NODE_ENV,
    isProduction,
    cluster: {
      name: e.CLUSTER,
      rpcUrl: e.RPC_URL?.replace(/\/+$/, ''),
      wsUrl: e.RPC_WS_URL,
      publicRpcUrl: e.PUBLIC_RPC_URL?.replace(/\/+$/, ''),
      mint: e.MINT_ADDRESS,
      tokenProgram: e.TOKEN_PROGRAM,
      commitment: e.COMMITMENT,
      indexFromSignature: e.INDEX_FROM_SIGNATURE,
      indexPageLimit: Math.min(e.INDEX_PAGE_LIMIT, 1000),
      pollIntervalMs: e.POLL_INTERVAL_MS,
      txFetchConcurrency: e.TX_FETCH_CONCURRENCY,
    },
    operator: { secretKey: e.OPERATOR_SECRET_KEY?.secretKey, secretKeyIsSeed: e.OPERATOR_SECRET_KEY?.fromSeed ?? false, dryRun: e.DRY_RUN, priorityFeeMicrolamports: e.PRIORITY_FEE_MICROLAMPORTS },
    price: {
      source: e.PRICE_SOURCE,
      initialPriceE18: e.INITIAL_PRICE_USD,
      feedUrl: e.PRICE_FEED_URL,
      jupiterUrl: e.JUPITER_PRICE_URL.replace(/\/+$/, ''),
      refreshMs: e.PRICE_REFRESH_MS,
      minChangeBps: e.PRICE_MIN_CHANGE_BPS,
      maxStepBps: e.PRICE_MAX_STEP_BPS,
      maxAgeS: e.PRICE_MAX_AGE_S,
      creditWhenStale: e.CREDIT_WHEN_STALE,
      minCreditMicro: e.MIN_CREDIT_USD,
    },
    budgets: {
      scanIntervalMs: e.BUDGET_SCAN_INTERVAL_MS,
      headroomRefreshMs: e.BUDGET_HEADROOM_REFRESH_MS,
      drawThresholdMicro: e.DRAW_THRESHOLD_USD,
      drawIntervalMs: e.DRAW_INTERVAL_MS,
      drawConfirmTimeoutMs: e.DRAW_CONFIRM_TIMEOUT_MS,
    },
    server: {
      port: e.PORT,
      host: e.HOST,
      publicUrl: e.PUBLIC_URL.replace(/\/+$/, ''),
      publicHost: hostOf(e.PUBLIC_URL),
      webOrigins: e.PUBLIC_WEB_ORIGIN.split(',')
        .map((s) => s.trim().replace(/\/+$/, ''))
        .filter((s) => s !== ''),
      dbPath: e.DB_PATH,
      maxBodyBytes: e.MAX_BODY_BYTES,
      trustProxy: e.TRUST_PROXY,
      logLevel: e.LOG_LEVEL,
      logPrompts: e.LOG_PROMPTS,
    },
    secrets: {
      sessionSecret,
      sessionSecretIsDefault: e.SESSION_SECRET === undefined,
      keyringMasterKey: masterHex === undefined ? undefined : Buffer.from(masterHex, 'hex'),
      adminToken: e.ADMIN_TOKEN,
    },
    providers: {
      anthropicApiKey: e.ANTHROPIC_API_KEY,
      openaiApiKey: e.OPENAI_API_KEY,
      openaiBaseUrl: e.OPENAI_BASE_URL.replace(/\/+$/, ''),
      googleApiKey: e.GOOGLE_API_KEY,
      googleBaseUrl: e.GOOGLE_BASE_URL.replace(/\/+$/, ''),
      houseBaseUrl: e.HOUSE_BASE_URL?.replace(/\/+$/, ''),
      houseApiKey: e.HOUSE_API_KEY,
      houseModelSmall: e.HOUSE_MODEL_SMALL,
      houseModelLarge: e.HOUSE_MODEL_LARGE,
      timeoutMs: e.PROVIDER_TIMEOUT_MS,
      catalogFile: e.MODEL_CATALOG_FILE,
    },
    economics: {
      markupBps: e.MARKUP_BPS,
      byokFeeBps: e.BYOK_FEE_BPS,
      lowCreditMicro: e.LOW_CREDIT_USD,
      veryLowCreditMicro: e.VERY_LOW_CREDIT_USD,
      minReserveMicro: e.MIN_RESERVE_USD,
      maxReserveMicro: e.MAX_RESERVE_USD,
      reservationTtlMs: e.RESERVATION_TTL_MS,
      proPriceMicro: e.PRO_PRICE_USD,
      proDays: e.PRO_DAYS,
      warmHourPriceMicro: e.WARM_HOUR_PRICE_USD,
      rateLimitRpm: e.RATE_LIMIT_RPM,
      rateLimitRpmPro: e.RATE_LIMIT_RPM_PRO,
      authRateLimitRpm: e.AUTH_RATE_LIMIT_RPM,
      warmDriver: e.WARM_DRIVER,
      warmWebhookUrl: e.WARM_WEBHOOK_URL,
      warmPingIntervalMs: e.WARM_PING_INTERVAL_MS,
    },
  };
}

/** A complete test configuration: in-memory DB, localnet, manual price, no providers unless overridden. */
export function testConfig(overrides: Record<string, string | undefined> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    DB_PATH: ':memory:',
    SESSION_SECRET: 'test-session-secret-test-session-secret',
    KEYRING_MASTER_KEY: '11'.repeat(32),
    ADMIN_TOKEN: 'test-admin',
    LOG_LEVEL: 'error',
    ...overrides,
  });
}
