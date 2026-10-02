/**
 * Runner configuration (`docs/SPEC.md` §4 env table), parsed from the environment with zod.
 * Empty strings count as unset; booleans accept `true|false|1|0`.
 *
 * @module config
 */
import { z } from 'zod';
import { getAddress, isAddress, type Address, type Hex } from 'viem';
import { defaultVenue, launchpadAddress, ponsAddressesFor, registryAddress, type Venue } from '@www-rh/shared';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

const bool = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined) return fallback;
      if (v === 'true' || v === '1') return true;
      if (v === 'false' || v === '0') return false;
      ctx.addIssue({ code: 'custom', message: `expected true|false|1|0, got "${v}"` });
      return z.NEVER;
    });

const num = (fallback: number, min = 0) => z.coerce.number().finite().min(min).default(fallback);
const int = (fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) => z.coerce.number().int().min(min).max(max).default(fallback);

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
      ctx.addIssue({ code: 'custom', message: 'must be a 32-byte hex private key' });
      return z.NEVER;
    }
    return key as Hex;
  });

/** Wei amount as a non-negative decimal integer string. */
const weiString = (fallback: bigint) =>
  z
    .string()
    .optional()
    .transform((v, ctx): bigint => {
      if (v === undefined) return fallback;
      if (!/^\d{1,78}$/.test(v)) {
        ctx.addIssue({ code: 'custom', message: `expected a wei amount (decimal integer), got "${v}"` });
        return z.NEVER;
      }
      return BigInt(v);
    });

/** Default `HARVEST_MIN_WEI` (0.002 ether, `docs/SPEC.md` §9.4). */
export const DEFAULT_HARVEST_MIN_WEI = 2_000_000_000_000_000n;

const envSchema = z.object({
  CHAIN_ID: int(46630, 1),
  RPC_URL: z.url({ protocol: /^https?$/, error: 'RPC_URL is required (http(s) JSON-RPC endpoint)' }),
  VENUE: z.enum(['pons', 'curve']).optional(),
  LAUNCHPAD_ADDRESS: optionalAddress,
  REGISTRY_ADDRESS: optionalAddress,
  HARVEST_MIN_WEI: weiString(DEFAULT_HARVEST_MIN_WEI),
  PONS_FACTORY: optionalAddress,
  PONS_FEE_ESCROW: optionalAddress,
  PONS_MEME_HOOK: optionalAddress,
  START_BLOCK: int(0, 0),
  CONFIRMATIONS: int(0, 0, 10_000),
  OPERATOR_PRIVATE_KEY: optionalPrivateKey,
  DRY_RUN: bool(true),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ETH_USD_PRICE: z.coerce.number().finite().positive().default(3000),
  ETH_USD_FEED: optionalAddress,
  ETH_USD_MIN: z.coerce.number().finite().positive().default(100),
  ETH_USD_MAX: z.coerce.number().finite().positive().default(100_000),
  MIN_TICK_BUDGET_USD: num(0.05),
  MAX_TICK_COST_USD: num(0.25, 0.000001),
  DRAW_THRESHOLD_USD: num(2),
  TARGET_RUNWAY_DAYS: num(14, 0.000001),
  MIN_DAILY_SPEND_USD: num(0.5, 0.000001),
  DB_PATH: z.string().min(1).default('./data/runner.sqlite'),
  PORT: int(8787, 0, 65_535),
  PUBLIC_WEB_ORIGIN: z.string().default('http://localhost:5173'),
  MAX_CONCURRENT_MINDS: int(3, 1, 64),
  TICK_INTERVAL_MS: int(20_000, 1),
  TICK_MAX_ITERATIONS: int(8, 1, 100),
  TICK_TIMEOUT_MS: int(180_000, 1_000),
  TOOL_TIMEOUT_MS: int(30_000, 1_000),
  ANCHOR_EVERY_N_MEMORIES: int(5, 1, 1_000),
  HARVEST_INTERVAL_MS: int(21_600_000, 1_000),
  BROWSER_HEADLESS: bool(true),
  FRAME_FPS: num(1, 0),
  IPFS_GATEWAY: z.url({ protocol: /^https?$/ }).default('https://ipfs.io/ipfs/'),
});

/** Pons V2 contracts the runner reads (`PONS_*` overrides → `@www-rh/shared` `PONS` on 4663 → `null`: read from the registry). */
export interface PonsContracts {
  factory: Address | null;
  feeEscrow: Address | null;
  memeHook: Address | null;
}

/** Validated runner configuration. */
export interface RunnerConfig {
  chainId: number;
  rpcUrl: string;
  /** `VENUE`; default `pons` on 4663, `curve` elsewhere (`docs/SPEC.md` §9.4). */
  venue: Venue;
  /** `LAUNCHPAD_ADDRESS` (zero = unset) → `launchpadAddress(CHAIN_ID)`; `null` when neither yields one. Curve mode. */
  launchpad: Address | null;
  /** `REGISTRY_ADDRESS` (zero = unset) → `registryAddress(CHAIN_ID)`; `null` when neither yields one. Pons mode. */
  registry: Address | null;
  /** Pons mode: harvest when `claimable(token) >= harvestMinWei` (`HARVEST_MIN_WEI`). */
  harvestMinWei: bigint;
  /** Pons V2 addresses (`PONS_FACTORY`, `PONS_FEE_ESCROW`, `PONS_MEME_HOOK`). */
  pons: PonsContracts;
  startBlock: bigint;
  confirmations: number;
  operatorPrivateKey: Hex | null;
  /** True when `DRY_RUN` or no operator key: no transaction is ever sent. */
  dryRun: boolean;
  anthropicApiKey: string | null;
  /** `Math.round(ETH_USD_PRICE · 1e6)` */
  ethUsdPriceMicro: number;
  ethUsdFeed: Address | null;
  /** Plausible ETH/USD range (× 1e6) the fallback price is clamped to (`ETH_USD_MIN` / `ETH_USD_MAX`). */
  ethUsdBoundsMicro: { min: number; max: number };
  minTickBudgetUsd: number;
  maxTickCostUsd: number;
  drawThresholdUsd: number;
  targetRunwayDays: number;
  minDailySpendUsd: number;
  dbPath: string;
  port: number;
  publicWebOrigins: string[];
  maxConcurrentMinds: number;
  tickIntervalMs: number;
  tickMaxIterations: number;
  tickTimeoutMs: number;
  /** Per-tool deadline inside a tick (`TOOL_TIMEOUT_MS`). */
  toolTimeoutMs: number;
  anchorEveryNMemories: number;
  harvestIntervalMs: number;
  browserHeadless: boolean;
  frameFps: number;
  /** Always ends with `/`. */
  ipfsGateway: string;
}

/** The contract the runner indexes and sends operator transactions to: the registry (Pons) or the launchpad (curve). */
export function mindContract(config: Pick<RunnerConfig, 'venue' | 'launchpad' | 'registry'>): Address | null {
  return config.venue === 'pons' ? config.registry : config.launchpad;
}

/** Invalid environment; `issues` lists every problem in `VAR: message` form. */
export class ConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`invalid runner configuration:\n  ${issues.join('\n  ')}`);
    this.name = 'ConfigError';
  }
}

/** Names of the environment variables the runner reads (SPEC §4). */
export const ENV_VARS: readonly string[] = Object.keys(envSchema.shape);

/**
 * Parses `env` (default `process.env`).
 *
 * @throws ConfigError on malformed or missing required values.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): RunnerConfig {
  const cleaned: Record<string, string> = {};
  for (const key of ENV_VARS) {
    const value = env[key]?.trim();
    if (value !== undefined && value !== '') cleaned[key] = value;
  }
  const parsed = envSchema.safeParse(cleaned);
  if (!parsed.success) throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.') || '(env)'}: ${i.message}`));
  const e = parsed.data;
  if (e.ETH_USD_MIN >= e.ETH_USD_MAX) throw new ConfigError([`ETH_USD_MIN: must be below ETH_USD_MAX (${e.ETH_USD_MIN} >= ${e.ETH_USD_MAX})`]);
  const operatorPrivateKey = e.OPERATOR_PRIVATE_KEY ?? null;
  const known = ponsAddressesFor(e.CHAIN_ID);
  return {
    chainId: e.CHAIN_ID,
    rpcUrl: e.RPC_URL,
    venue: e.VENUE ?? defaultVenue(e.CHAIN_ID),
    launchpad: e.LAUNCHPAD_ADDRESS ?? launchpadAddress(e.CHAIN_ID) ?? null,
    registry: e.REGISTRY_ADDRESS ?? registryAddress(e.CHAIN_ID) ?? null,
    harvestMinWei: e.HARVEST_MIN_WEI,
    pons: {
      factory: e.PONS_FACTORY ?? known?.factory ?? null,
      feeEscrow: e.PONS_FEE_ESCROW ?? known?.feeEscrow ?? null,
      memeHook: e.PONS_MEME_HOOK ?? known?.memeHook ?? null,
    },
    startBlock: BigInt(e.START_BLOCK),
    confirmations: e.CONFIRMATIONS,
    operatorPrivateKey,
    dryRun: e.DRY_RUN || operatorPrivateKey === null,
    anthropicApiKey: e.ANTHROPIC_API_KEY ?? null,
    ethUsdPriceMicro: Math.round(e.ETH_USD_PRICE * 1e6),
    ethUsdFeed: e.ETH_USD_FEED ?? null,
    ethUsdBoundsMicro: { min: Math.round(e.ETH_USD_MIN * 1e6), max: Math.round(e.ETH_USD_MAX * 1e6) },
    minTickBudgetUsd: e.MIN_TICK_BUDGET_USD,
    maxTickCostUsd: e.MAX_TICK_COST_USD,
    drawThresholdUsd: e.DRAW_THRESHOLD_USD,
    targetRunwayDays: e.TARGET_RUNWAY_DAYS,
    minDailySpendUsd: e.MIN_DAILY_SPEND_USD,
    dbPath: e.DB_PATH,
    port: e.PORT,
    publicWebOrigins: e.PUBLIC_WEB_ORIGIN.split(',').map((s) => s.trim()).filter((s) => s.length > 0),
    maxConcurrentMinds: e.MAX_CONCURRENT_MINDS,
    tickIntervalMs: e.TICK_INTERVAL_MS,
    tickMaxIterations: e.TICK_MAX_ITERATIONS,
    tickTimeoutMs: e.TICK_TIMEOUT_MS,
    toolTimeoutMs: e.TOOL_TIMEOUT_MS,
    anchorEveryNMemories: e.ANCHOR_EVERY_N_MEMORIES,
    harvestIntervalMs: e.HARVEST_INTERVAL_MS,
    browserHeadless: e.BROWSER_HEADLESS,
    frameFps: e.FRAME_FPS,
    ipfsGateway: e.IPFS_GATEWAY.endsWith('/') ? e.IPFS_GATEWAY : `${e.IPFS_GATEWAY}/`,
  };
}
