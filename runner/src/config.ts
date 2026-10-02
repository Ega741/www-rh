/**
 * Runner configuration, parsed from environment variables with zod (SPEC §4 + R4/R5/R9 knobs).
 * Every variable has a safe default so `DRY_RUN=true node dist/main.js` starts with nothing set.
 *
 * @module config
 */
import { z } from 'zod';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { launchpadAddress, deploymentFor } from '@www-rh/shared';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return fallback;
      const s = v.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(s)) return true;
      if (['0', 'false', 'no', 'off'].includes(s)) return false;
      ctx.addIssue({ code: 'custom', message: `expected a boolean, got "${v}"` });
      return z.NEVER;
    });

const num = (fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().min(min).max(max).default(fallback);
const int = (fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const optionalAddress = z
  .string()
  .optional()
  .transform((v, ctx): Address | undefined => {
    if (v === undefined) return undefined;
    if (!isAddress(v, { strict: false })) {
      ctx.addIssue({ code: 'custom', message: `expected an address, got "${v}"` });
      return z.NEVER;
    }
    return v.toLowerCase() === ZERO_ADDRESS ? undefined : getAddress(v);
  });

const optionalPrivateKey = z
  .string()
  .optional()
  .transform((v, ctx): Hex | undefined => {
    if (v === undefined || v === '0x') return undefined;
    const key = v.startsWith('0x') ? v : `0x${v}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
      ctx.addIssue({ code: 'custom', message: 'OPERATOR_PRIVATE_KEY must be a 32-byte hex string' });
      return z.NEVER;
    }
    return key as Hex;
  });

/** Decimal ETH/USD price string → integer micro-USD (exact, no float rounding). */
export function parseUsdMicro(value: string): number {
  const m = /^\s*(\d+)(?:\.(\d{0,6})\d*)?\s*$/.exec(value);
  if (m === null) throw new RangeError(`invalid USD amount "${value}"`);
  const whole = BigInt(m[1] as string);
  const frac = BigInt(((m[2] ?? '') + '000000').slice(0, 6));
  const micro = whole * 1_000_000n + frac;
  if (micro > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`USD amount "${value}" too large`);
  return Number(micro);
}

const envSchema = z.object({
  CHAIN_ID: int(46630, 1),
  RPC_URL: z.string().url().optional(),
  LAUNCHPAD_ADDRESS: optionalAddress,
  START_BLOCK: z.coerce.number().int().min(0).optional(),
  CONFIRMATIONS: int(0, 0, 1000),
  INDEXER_POLL_MS: int(2_000, 100),
  INDEXER_BATCH_BLOCKS: int(2_000, 1, 2_000),
  OPERATOR_PRIVATE_KEY: optionalPrivateKey,
  DRY_RUN: bool(true),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ETH_USD_PRICE: z.string().default('3000'),
  ETH_USD_FEED: optionalAddress,
  ETH_USD_FEED_MAX_AGE_S: int(86_400, 60),
  MIN_TICK_BUDGET_USD: num(0.05),
  DRAW_THRESHOLD_USD: num(2),
  MAX_TICK_COST_USD: num(0.25, 0.000001),
  TARGET_RUNWAY_DAYS: num(14, 0.01),
  MIN_DAILY_SPEND_USD: num(0.5, 0.000001),
  DB_PATH: z.string().min(1).default('./data/runner.sqlite'),
  HOST: z.string().min(1).default('0.0.0.0'),
  PORT: int(8787, 0, 65_535),
  PUBLIC_WEB_ORIGIN: z.string().default('http://localhost:5173'),
  MAX_CONCURRENT_MINDS: int(3, 1, 64),
  TICK_INTERVAL_MS: int(20_000, 1_000),
  TICK_MAX_ITERATIONS: int(8, 1, 100),
  TICK_TIMEOUT_MS: int(180_000, 5_000),
  SCHEDULER_POLL_MS: int(2_000, 100),
  ANCHOR_EVERY_N_MEMORIES: int(5, 1, 500),
  HARVEST_INTERVAL_MS: int(21_600_000, 60_000),
  BROWSER_HEADLESS: bool(true),
  FRAME_FPS: num(1, 0, 10),
  IPFS_GATEWAY: z.string().url().default('https://ipfs.io/ipfs/'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

/** Validated runner configuration. */
export interface RunnerConfig {
  chainId: number;
  /** RPC endpoint; defaults to the first HTTP RPC of the known chain. */
  rpcUrl: string;
  /** Launchpad address (env override → generated deployments), or `null` when unknown. */
  launchpad: Address | null;
  startBlock: bigint;
  confirmations: number;
  indexerPollMs: number;
  indexerBatchBlocks: number;
  operatorPrivateKey: Hex | null;
  /** When true no transaction is ever sent (also forced when no operator key is configured). */
  dryRun: boolean;
  anthropicApiKey: string | null;
  ethUsdPriceMicro: number;
  ethUsdFeed: Address | null;
  ethUsdFeedMaxAgeS: number;
  minTickBudgetUsd: number;
  drawThresholdUsd: number;
  maxTickCostUsd: number;
  targetRunwayDays: number;
  minDailySpendUsd: number;
  dbPath: string;
  host: string;
  port: number;
  publicWebOrigins: string[];
  maxConcurrentMinds: number;
  tickIntervalMs: number;
  tickMaxIterations: number;
  tickTimeoutMs: number;
  schedulerPollMs: number;
  anchorEveryNMemories: number;
  harvestIntervalMs: number;
  browserHeadless: boolean;
  frameFps: number;
  ipfsGateway: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

const KNOWN_RPC: Record<number, string> = {
  4663: 'https://rpc.mainnet.chain.robinhood.com',
  46630: 'https://rpc.testnet.chain.robinhood.com/rpc',
  31337: 'http://127.0.0.1:8545',
};

/** Error thrown for an invalid environment; `issues` lists every problem. */
export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid runner configuration:\n  ${issues.join('\n  ')}`);
    this.name = 'ConfigError';
  }
}

/**
 * Parses and validates `env` (defaults to `process.env`). Empty strings count as unset.
 *
 * @throws ConfigError when a variable is malformed.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): RunnerConfig {
  const cleaned: Record<string, string> = {};
  for (const key of Object.keys(envSchema.shape)) {
    const value = env[key];
    if (value !== undefined && value.trim() !== '') cleaned[key] = value.trim();
  }
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`));
  }
  const e = parsed.data;
  let ethUsdPriceMicro: number;
  try {
    ethUsdPriceMicro = parseUsdMicro(e.ETH_USD_PRICE);
  } catch (err) {
    throw new ConfigError([`ETH_USD_PRICE: ${(err as Error).message}`]);
  }
  if (ethUsdPriceMicro <= 0) throw new ConfigError(['ETH_USD_PRICE: must be positive']);

  const launchpad = launchpadAddress(e.CHAIN_ID, { override: e.LAUNCHPAD_ADDRESS }) ?? null;
  const deployment = deploymentFor(e.CHAIN_ID);
  const startBlock = BigInt(e.START_BLOCK ?? deployment?.blockNumber ?? 0);
  const rpcUrl = e.RPC_URL ?? KNOWN_RPC[e.CHAIN_ID] ?? 'http://127.0.0.1:8545';
  const operatorPrivateKey = e.OPERATOR_PRIVATE_KEY ?? null;

  return {
    chainId: e.CHAIN_ID,
    rpcUrl,
    launchpad,
    startBlock,
    confirmations: e.CONFIRMATIONS,
    indexerPollMs: e.INDEXER_POLL_MS,
    indexerBatchBlocks: e.INDEXER_BATCH_BLOCKS,
    operatorPrivateKey,
    dryRun: e.DRY_RUN || operatorPrivateKey === null,
    anthropicApiKey: e.ANTHROPIC_API_KEY ?? null,
    ethUsdPriceMicro,
    ethUsdFeed: e.ETH_USD_FEED ?? null,
    ethUsdFeedMaxAgeS: e.ETH_USD_FEED_MAX_AGE_S,
    minTickBudgetUsd: e.MIN_TICK_BUDGET_USD,
    drawThresholdUsd: e.DRAW_THRESHOLD_USD,
    maxTickCostUsd: e.MAX_TICK_COST_USD,
    targetRunwayDays: e.TARGET_RUNWAY_DAYS,
    minDailySpendUsd: e.MIN_DAILY_SPEND_USD,
    dbPath: e.DB_PATH,
    host: e.HOST,
    port: e.PORT,
    publicWebOrigins: e.PUBLIC_WEB_ORIGIN.split(',').map((s) => s.trim()).filter((s) => s.length > 0),
    maxConcurrentMinds: e.MAX_CONCURRENT_MINDS,
    tickIntervalMs: e.TICK_INTERVAL_MS,
    tickMaxIterations: e.TICK_MAX_ITERATIONS,
    tickTimeoutMs: e.TICK_TIMEOUT_MS,
    schedulerPollMs: e.SCHEDULER_POLL_MS,
    anchorEveryNMemories: e.ANCHOR_EVERY_N_MEMORIES,
    harvestIntervalMs: e.HARVEST_INTERVAL_MS,
    browserHeadless: e.BROWSER_HEADLESS,
    frameFps: e.FRAME_FPS,
    ipfsGateway: e.IPFS_GATEWAY.endsWith('/') ? e.IPFS_GATEWAY : `${e.IPFS_GATEWAY}/`,
    logLevel: e.LOG_LEVEL,
  };
}

/** Names of all environment variables the runner reads (for `--help`). */
export const ENV_VARS: readonly string[] = Object.keys(envSchema.shape);
