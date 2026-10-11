/**
 * Environment configuration (SPEC §5.1), validated with zod. Empty strings count as unset; USD
 * values become `bigint` µUSD; the zero address counts as "no override".
 *
 * @module config
 */
import { parseUsdToMicro } from '@beagle/shared/credit';
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
const hexKey = z.preprocess(blankToUndefined, z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'expected 0x + 64 hex chars').optional());
const address = z.preprocess(blankToUndefined, z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected an address').optional());

/** Zod schema of the environment (keys of SPEC §5.1). */
export const EnvSchema = z.object({
  NODE_ENV: str('development'),
  // chain
  CHAIN_ID: int(31337, 1),
  RPC_URL: optStr(),
  CREDIT_DESK_ADDRESS: address,
  START_BLOCK: z.preprocess(blankToUndefined, z.coerce.number().int().min(0).optional()),
  CONFIRMATIONS: int(0),
  POLL_INTERVAL_MS: int(2000, 100),
  LOG_CHUNK_BLOCKS: int(2000, 1),
  // operator
  OPERATOR_PRIVATE_KEY: z.preprocess((v) => (typeof v === 'string' && /^(0x)?$/i.test(v.trim()) ? undefined : v), hexKey),
  DRY_RUN: bool(true),
  // price poster
  PRICE_POSTER_ENABLED: bool(false),
  PRICE_SOURCE_ADDRESS: address,
  PRICE_FEED_URL: optStr(),
  PRICE_POST_INTERVAL_MS: int(300_000, 1000),
  // budgets
  DRAW_THRESHOLD_USD: usd('1'),
  DRAW_INTERVAL_MS: int(30_000, 100),
  BUDGET_HEADROOM_REFRESH_MS: int(15_000, 100),
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
  WARM_DRIVER: z.preprocess(blankToUndefined, z.enum(['log', 'ollama', 'http']).default('log')),
  WARM_WEBHOOK_URL: optStr(),
  WARM_PING_INTERVAL_MS: int(240_000, 1000),
});

/** Raw parsed env. */
export type Env = z.output<typeof EnvSchema>;

/** The validated gateway configuration. */
export interface Config {
  nodeEnv: string;
  isProduction: boolean;
  chain: {
    chainId: number;
    rpcUrl: string | undefined;
    creditDeskAddress: string | undefined;
    startBlock: number | undefined;
    confirmations: number;
    pollIntervalMs: number;
    logChunkBlocks: number;
  };
  operator: { privateKey: `0x${string}` | undefined; dryRun: boolean };
  poster: { enabled: boolean; priceSourceAddress: string | undefined; feedUrl: string | undefined; intervalMs: number };
  budgets: { drawThresholdMicro: bigint; drawIntervalMs: number; headroomRefreshMs: number };
  server: {
    port: number;
    host: string;
    publicUrl: string;
    /** Host (authority) of `PUBLIC_URL`, the SIWE domain. */
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
 * values; `SESSION_SECRET` is required in production, `KEYRING_MASTER_KEY` only when BYOK is used.
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
  if (e.PRICE_POSTER_ENABLED && e.PRICE_FEED_URL === undefined) throw new ConfigError('PRICE_FEED_URL is required when PRICE_POSTER_ENABLED=true');
  if (e.WARM_DRIVER === 'http' && e.WARM_WEBHOOK_URL === undefined) throw new ConfigError('WARM_WEBHOOK_URL is required when WARM_DRIVER=http');
  const sessionSecret = e.SESSION_SECRET ?? DEV_SESSION_SECRET;
  const masterHex = e.KEYRING_MASTER_KEY === undefined ? undefined : e.KEYRING_MASTER_KEY.replace(/^0x/, '');
  return {
    nodeEnv: e.NODE_ENV,
    isProduction,
    chain: {
      chainId: e.CHAIN_ID,
      rpcUrl: e.RPC_URL,
      creditDeskAddress: e.CREDIT_DESK_ADDRESS,
      startBlock: e.START_BLOCK,
      confirmations: e.CONFIRMATIONS,
      pollIntervalMs: e.POLL_INTERVAL_MS,
      logChunkBlocks: e.LOG_CHUNK_BLOCKS,
    },
    operator: { privateKey: e.OPERATOR_PRIVATE_KEY as `0x${string}` | undefined, dryRun: e.DRY_RUN },
    poster: {
      enabled: e.PRICE_POSTER_ENABLED,
      priceSourceAddress: e.PRICE_SOURCE_ADDRESS,
      feedUrl: e.PRICE_FEED_URL,
      intervalMs: e.PRICE_POST_INTERVAL_MS,
    },
    budgets: {
      drawThresholdMicro: e.DRAW_THRESHOLD_USD,
      drawIntervalMs: e.DRAW_INTERVAL_MS,
      headroomRefreshMs: e.BUDGET_HEADROOM_REFRESH_MS,
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
      warmDriver: e.WARM_DRIVER,
      warmWebhookUrl: e.WARM_WEBHOOK_URL,
      warmPingIntervalMs: e.WARM_PING_INTERVAL_MS,
    },
  };
}

/** A complete test configuration: in-memory DB, no chain, no providers unless overridden. */
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
