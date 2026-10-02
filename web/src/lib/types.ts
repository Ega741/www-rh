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

/** Mind status names (R11 / D4). `paused` is set by the creator only. */
export type MindStatusName = 'alive' | 'dormant' | 'paused';
/** Curve phase names (R11). */
export type CurvePhaseName = 'bonding' | 'complete' | 'graduated';
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
}

/** `MindDetail` = summary + resolved metadata and graduation info. */
export interface MindDetail extends MindSummary {
  personaHash: Hex;
  pool: Address | null;
  positionId: bigint | null;
  description: string | null;
  persona: string | null;
  links: MindLinks | null;
  lastFrameAt: number | null;
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
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  settledTx: Hex | null;
  createdAt: number | null;
}

/** One tick inside a draw receipt (R2). */
export interface ReceiptTick {
  tickId: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsdMicro: number;
}

/**
 * The canonical draw receipt object hashed into `receiptHash` (R2):
 * `{ token, fromTickId, toTickId, ticks, ethUsdPriceMicro, amountWei }`.
 * Kept as plain JSON values so it can be re-hashed byte-for-byte.
 */
export interface DrawReceiptObject {
  token: string;
  fromTickId: number;
  toTickId: number;
  ticks: ReceiptTick[];
  ethUsdPriceMicro: number | string;
  amountWei: string;
}

/** A compute draw receipt as shown in the UI (W6). */
export interface ComputeReceipt {
  receiptHash: Hex;
  txHash: Hex | null;
  amountWei: bigint;
  fromTickId: number | null;
  toTickId: number | null;
  tickCount: number | null;
  costUsd: number | null;
  createdAt: number | null;
  /** The canonical object when the API served all of its fields (enables local re-hash). */
  object: DrawReceiptObject | null;
}

/** `GET /api/minds/:token/compute`. */
export interface ComputeInfo {
  balanceWei: bigint;
  balanceUsd: number;
  burnUsdPerHour: number;
  /** `null` = no burn (infinite runway). */
  runwayHours: number | null;
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

/** Metadata JSON uploaded with `POST /api/metadata` (R1). */
export interface MindMetadata {
  name: string;
  symbol: string;
  description?: string;
  image?: string;
  persona: string;
  model: string;
  links?: MindLinks;
}

/** `POST /api/metadata` response (R1). */
export interface MetadataUploadResult {
  uri: string;
  hash: string;
  personaHash: Hex;
}
