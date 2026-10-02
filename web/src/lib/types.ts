/**
 * View models used by the UI. The runner API serialises bigints as decimal strings (R8/R11);
 * `api.ts` normalises responses into these shapes (bigints as `bigint`, timestamps as epoch ms,
 * absent optional fields as `null`).
 *
 * LOCAL FALLBACK: the wire DTOs live in `@www-rh/shared/types`, which is being updated to the
 * directives (R1, R2, R7, R11) concurrently; these view models mirror the directives.
 *
 * @module lib/types
 */
import type { Address, Hex } from 'viem';
import type { JsonObject } from './json';

export type { MindMetadata } from '@www-rh/shared';

/** Mind status names (R11 / D4). `paused` is set by the creator only. */
export type MindStatusName = 'alive' | 'dormant' | 'paused';
/** Curve phase names (R11). */
export type CurvePhaseName = 'bonding' | 'complete' | 'graduated';
/** Venue a mind trades on (SPEC §9.3). */
export type VenueName = 'pons' | 'curve';
/** Sort keys accepted by `GET /api/minds`. */
export type MindsSort = 'created' | 'mcap' | 'activity';

/** Social links stored in the metadata JSON (R1). */
export interface MindLinks {
  x?: string;
  website?: string;
  telegram?: string;
}

/** `MindSummary` (SPEC §5 as amended by R11). */
export interface MindSummary {
  token: Address;
  name: string;
  symbol: string;
  creator: Address;
  metadataURI: string;
  image: string | null;
  /** bytes32 model id hash (R12). */
  modelId: Hex;
  /** Catalog id (e.g. `claude-opus-5-5`) or `null` when the hash is not in the catalog. */
  model: string | null;
  status: MindStatusName;
  phase: CurvePhaseName;
  /** Wei per 1e18 tokens. */
  priceWei: bigint;
  marketCapWei: bigint;
  progressBps: number;
  realEthReserveWei: bigint;
  /** Token amount (18 decimals). */
  tokensSold: bigint;
  mindBalanceWei: bigint;
  lastTickAt: number | null;
  currentUrl: string | null;
  createdAt: number;
  trades24h: number;
  volume24hWei: bigint;
  /** Venue reported by the runner (SPEC §9.3); `null` from pre-Pons runners. */
  venue: VenueName | null;
}

/** `MindDetail.pons` (SPEC §9.3): the Pons side of a mind, `null` for curve minds. */
export interface PonsInfo {
  curve: Address;
  /** The mind's `MindAccount` (the Pons `creatorFeeRecipient` while it receives fees). */
  account: Address;
  /** Pons launch `deployer` (the registry for minds launched here). */
  deployer: Address | null;
  launchConfigId: bigint | null;
  feeBps: number | null;
  creatorTaxBps: number | null;
  /** Creator fees credited to the account in the Pons FeeEscrow, not yet harvested. */
  claimableWei: bigint;
  launchedHere: boolean;
  adopted: boolean;
  /**
   * The creator left (SPEC §9.7 `hasLeft`): creator fees go elsewhere, the mind stays dormant until
   * someone takes it over with `activateAdoption`. `false` from pre-§9.7 runners.
   */
  left: boolean;
  /** Uniswap v4 pool id after graduation (recorded by the operator), when known. */
  poolId: Hex | null;
}

/** Live Pons curve / launch state read from the chain for the mind page (Pons mode). */
export interface PonsLive {
  curve: Address;
  /** Mind account (`registry.ponsMind(token).account`). */
  account: Address | null;
  /** `getReserves()`: quote reserve incl. the phantom reserve, excl. pending fees. */
  quoteReserve: bigint | null;
  tokenReserve: bigint | null;
  /** `sellableTokens()`. */
  sellable: bigint | null;
  realQuoteReserve: bigint | null;
  graduationThreshold: bigint | null;
  feeBps: number | null;
  creatorTaxBps: number | null;
  graduated: boolean | null;
  readyToGraduate: boolean | null;
  /** `factory.getLaunchedToken(token).phase` (`GraduationPhase`). */
  factoryPhase: number | null;
  creatorFeeRecipient: Address | null;
  deployer: Address | null;
  /** Launch time in unix seconds (curve `launchedAt()`; else the mind's `createdAt` for minds launched here). */
  launchedAt: number | null;
  totalSupply: bigint | null;
  claimableWei: bigint | null;
  /** `registry.hasLeft(token)` (SPEC §9.7); `null` when the read failed (pre-§9.7 registry). */
  left: boolean | null;
}

/** `MindDetail` = summary + resolved metadata and graduation info. */
export interface MindDetail extends MindSummary {
  personaHash: Hex;
  /** Runner's verdict: the resolved persona hashes to `personaHash` (`null` = not resolved). */
  personaVerified: boolean | null;
  pool: Address | null;
  positionId: bigint | null;
  description: string | null;
  persona: string | null;
  links: MindLinks | null;
  lastFrameAt: number | null;
  /** Pons details (SPEC §9.3); `null` for curve minds and pre-Pons runners. */
  pons: PonsInfo | null;
}

/**
 * One pending adoption preparation (SPEC §9.7, `GET /api/minds/:token/adoptions`): the preparer's
 * own account and the config `activateAdoption(token, preparer)` would register.
 */
export interface PendingAdoption {
  preparer: Address;
  account: Address;
  modelId: Hex | null;
  personaHash: Hex | null;
  metadataURI: string | null;
}

/** One curve trade (`Trade` event). */
export interface Trade {
  txHash: Hex;
  logIndex: number;
  blockNumber: number;
  timestamp: number;
  trader: Address;
  isBuy: boolean;
  ethAmountWei: bigint;
  tokenAmount: bigint;
  feeWei: bigint;
  priceWei: bigint;
}

/** Memory kinds (R7). */
export type MemoryKind = 'note' | 'finding';

/** A memory recorded by the mind, optionally anchored on-chain in a batch (R2). */
export interface Memory {
  seq: number;
  kind: MemoryKind;
  content: string;
  url: string | null;
  createdAt: number;
  contentHash: Hex | null;
  anchorTx: Hex | null;
  /** `runner://memories/<token>/<fromSeq>-<toSeq>` of the anchored batch, when known. */
  anchorUri: string | null;
}

/** Persisted thought (R7): `aloud` from `think_aloud`, `summary` from the tick's final text. */
export interface Thought {
  id: number;
  tickId: number;
  kind: 'aloud' | 'summary';
  text: string;
  createdAt: number;
}

/** Per-tick compute ledger row. */
export interface LedgerEntry {
  tickId: number;
  /** Served model (the price applied). */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  iterations: number | null;
  stopReason: string | null;
  error: string | null;
  /** Receipt this tick was settled in (`null` while unsettled). */
  receiptHash: Hex | null;
  settled: boolean;
  startedAt: number | null;
}

/** A compute draw receipt as shown in the UI (W6). */
export interface ComputeReceipt {
  receiptHash: Hex;
  /** `pending` | `submitted` | `confirmed` | `failed` | `dry_run` (or `null` when not reported). */
  status: string | null;
  txHash: Hex | null;
  amountWei: bigint;
  fromTickId: number | null;
  toTickId: number | null;
  tickCount: number | null;
  costUsd: number | null;
  createdAt: number | null;
  /**
   * The canonical receipt object `{ token, fromTickId, toTickId, ticks, ethUsdPriceMicro, amountWei }`
   * exactly as served (R2), when all fields are present; enables re-hashing in the browser.
   */
  object: JsonObject | null;
}

/** `GET /api/minds/:token/compute`. */
export interface ComputeInfo {
  balanceWei: bigint;
  balanceUsd: number;
  burnUsdPerHour: number;
  /** `null` = no burn (infinite runway). */
  runwayHours: number | null;
  /** Spend not yet drawn from the vault. */
  unsettledUsd: number | null;
  /** `balanceUsd − unsettledUsd`. */
  availableUsd: number | null;
  /** Burn-governor tick interval (R5), `null` when the mind is not runnable. */
  tickIntervalMs: number | null;
  ledger: LedgerEntry[];
  receipts: ComputeReceipt[];
}

/** `GET /api/stats`. */
export interface Stats {
  minds: number;
  alive: number;
  graduated: number;
  volumeWei: bigint;
  feesToMindsWei: bigint;
}

/** `GET /api/health`. */
export interface Health {
  ok: boolean;
  chainId: number | null;
  launchpad: Address | null;
  lastIndexedBlock: number | null;
  headBlock: number | null;
  activeMinds: number | null;
  dryRun: boolean | null;
  /** Venue the runner indexes (SPEC §9.4), `null` from pre-Pons runners. */
  venue: VenueName | null;
  /** `PonsMindRegistry` the runner indexes (Pons mode). */
  registry: Address | null;
}

/** `GET /api/models` item (public fields). */
export interface ModelInfo {
  id: string;
  label: string;
  description: string;
  modelIdHash: Hex;
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  cacheReadUsdPerMTok: number;
  cacheWriteUsdPerMTok: number;
  isDefault: boolean;
}

/** `GET /api/minds` page. */
export interface MindsPage {
  items: MindSummary[];
  nextCursor: string | null;
}

/** `POST /api/metadata` response (R1). */
export interface MetadataUploadResult {
  uri: string;
  hash: string;
  personaHash: Hex;
}
