/**
 * HTTP API DTOs (SPEC §5) and WebSocket messages (SPEC §6) as zod schemas + inferred TS types,
 * as amended by directives R1, R2, R7, R10 and R11.
 *
 * Conventions (R11): addresses are lowercase hex; every wei amount is a decimal string whose field
 * name ends in `Wei`; token amounts (18 decimals) are decimal strings; `costUsd`-style fields are
 * JS numbers rounded to 6 decimals; timestamps are ISO-8601; optional values are `null` (never
 * omitted) in responses.
 *
 * @module types
 */
import { z } from 'zod';
import type { ModelId } from './models.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Lowercase `0x`-prefixed 20-byte address. */
export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/, 'expected lowercase 0x-prefixed 20-byte address');
/** `0x`-prefixed 32-byte hex (tx hashes, keccak / sha256 hashes). Case-insensitive. */
export const hash32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'expected 0x-prefixed 32-byte hex');
/** Non-negative integer encoded as a decimal string (bigint over the wire). */
export const bigintStringSchema = z.string().regex(/^(0|[1-9][0-9]*)$/, 'expected decimal integer string');
/** Alias of {@link bigintStringSchema} for wei amounts (fields named `…Wei`). */
export const weiStringSchema = bigintStringSchema;
/** ISO-8601 timestamp. */
export const isoTimestampSchema = z.iso.datetime({ offset: true });
/** USD amount as a JS number with at most 6 decimals. */
export const usdSchema = z.number().min(0);

export type Address = z.infer<typeof addressSchema>;
export type Hash32 = z.infer<typeof hash32Schema>;
export type BigintString = z.infer<typeof bigintStringSchema>;

/** Serialises a non-negative bigint for the API. */
export function toBigintString(value: bigint): BigintString {
  if (value < 0n) throw new RangeError('API bigints must be non-negative');
  return value.toString(10);
}

/** Parses an API bigint string. */
export function fromBigintString(value: BigintString): bigint {
  return BigInt(value);
}

/** Rounds a USD value to the API's 6-decimal precision (R11). */
export function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Enumerations (string form used by the API)
// ---------------------------------------------------------------------------

/** `MindStatus` names (R11). `paused` = paused by the creator (D4). */
export const mindStatusNameSchema = z.enum(['alive', 'dormant', 'paused']);
export type MindStatusName = z.infer<typeof mindStatusNameSchema>;

export const curvePhaseNameSchema = z.enum(['bonding', 'complete', 'graduated']);
export type CurvePhaseName = z.infer<typeof curvePhaseNameSchema>;

/** Maps the on-chain `MindStatus` enum value to its API name. */
export function mindStatusName(value: number): MindStatusName {
  switch (value) {
    case 0:
      return 'alive';
    case 1:
      return 'dormant';
    case 2:
      return 'paused';
    default:
      throw new RangeError(`unknown MindStatus ${value}`);
  }
}

/** Maps the on-chain `CurvePhase` enum value to its API name. */
export function curvePhaseName(value: number): CurvePhaseName {
  switch (value) {
    case 0:
      return 'bonding';
    case 1:
      return 'complete';
    case 2:
      return 'graduated';
    default:
      throw new RangeError(`unknown CurvePhase ${value}`);
  }
}

/** Maps an API status name back to the on-chain enum value. */
export function mindStatusValue(name: MindStatusName): 0 | 1 | 2 {
  return name === 'alive' ? 0 : name === 'dormant' ? 1 : 2;
}

/** Maps an API phase name back to the on-chain enum value. */
export function curvePhaseValue(name: CurvePhaseName): 0 | 1 | 2 {
  return name === 'bonding' ? 0 : name === 'complete' ? 1 : 2;
}

/** Catalog model id schema (kept in sync with `MODEL_IDS`; asserted by a unit test). */
export const modelIdSchema = z.enum([
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-4-5',
  'claude-fable-5-1',
] as const satisfies readonly ModelId[]);

// ---------------------------------------------------------------------------
// Metadata (R1)
// ---------------------------------------------------------------------------

/** Maximum size of a `POST /api/metadata` body (R1). */
export const METADATA_MAX_BYTES = 32 * 1024;

const utf8 = new TextEncoder();
/** UTF-8 byte length of a string (the contract bounds name/symbol in bytes, D10). */
export function utf8ByteLength(value: string): number {
  return utf8.encode(value).length;
}

const linkUrlSchema = z.string().min(1).max(512);

/** Optional social links of a mind. */
export const mindLinksSchema = z
  .object({
    x: linkUrlSchema.optional(),
    website: linkUrlSchema.optional(),
    telegram: linkUrlSchema.optional(),
  })
  .strict();
export type MindLinks = z.infer<typeof mindLinksSchema>;

/**
 * Metadata JSON referenced by `MindInfo.metadataURI` (R1). Validated strictly on upload; the
 * runner stores the canonical JSON of the parsed object and hashes it with sha256.
 */
export const mindMetadataSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .refine((s) => utf8ByteLength(s) <= 64, 'name must be at most 64 bytes'),
    symbol: z
      .string()
      .min(1)
      .refine((s) => utf8ByteLength(s) <= 16, 'symbol must be at most 16 bytes'),
    description: z.string().max(4_000).optional(),
    image: z.string().min(1).max(2_048).optional(),
    persona: z.string().min(1).max(20_000),
    model: modelIdSchema,
    links: mindLinksSchema.optional(),
  })
  .strict();
export type MindMetadata = z.infer<typeof mindMetadataSchema>;

/**
 * Lenient view of third-party metadata (resolved from `data:`, `ipfs://` or `http(s)` URIs):
 * every field optional, unknown keys ignored, wrong types dropped by the consumer.
 */
export const mindMetadataLooseSchema = z.object({
  name: z.string().optional(),
  symbol: z.string().optional(),
  description: z.string().optional(),
  image: z.string().optional(),
  persona: z.string().optional(),
  model: z.string().optional(),
  links: z.record(z.string(), z.string()).optional(),
});
export type MindMetadataLoose = z.infer<typeof mindMetadataLooseSchema>;

/** `POST /api/metadata` response (R1). */
export const metadataUploadResponseSchema = z.object({
  /** `runner://metadata/<hash>` */
  uri: z.string(),
  /** `sha256(canonicalJSON(metadata))`, 0x-prefixed lowercase hex. */
  hash: hash32Schema,
  /** `keccak256(utf8Bytes(persona))` — pass as `personaHash` to `createMind`. */
  personaHash: hash32Schema,
});
export type MetadataUploadResponse = z.infer<typeof metadataUploadResponseSchema>;

/** URI scheme prefix of metadata stored by the runner. */
export const RUNNER_METADATA_URI_PREFIX = 'runner://metadata/';
/** URI scheme prefix of anchored memory batches. */
export const RUNNER_MEMORIES_URI_PREFIX = 'runner://memories/';

/** `runner://metadata/<hash>` */
export function metadataUri(hash: string): string {
  return `${RUNNER_METADATA_URI_PREFIX}${hash.toLowerCase()}`;
}

/** `runner://memories/<token>/<fromSeq>-<toSeq>` (R2). */
export function memoryBatchUri(token: string, fromSeq: number, toSeq: number): string {
  return `${RUNNER_MEMORIES_URI_PREFIX}${token.toLowerCase()}/${fromSeq}-${toSeq}`;
}

// ---------------------------------------------------------------------------
// §5 DTOs
// ---------------------------------------------------------------------------

/** Card-level view of a mind (`GET /api/minds`). */
export const mindSummarySchema = z.object({
  token: addressSchema,
  name: z.string(),
  symbol: z.string(),
  creator: addressSchema,
  metadataURI: z.string(),
  /** Image URL resolved from metadata, or `null`. */
  image: z.string().nullable(),
  /** `bytes32` model id hash. */
  modelId: hash32Schema,
  /** Catalog model id, or `null` if the hash is not in the catalog. */
  model: modelIdSchema.nullable(),
  status: mindStatusNameSchema,
  phase: curvePhaseNameSchema,
  /** Curve price, wei per 1e18 tokens. */
  priceWei: weiStringSchema,
  marketCapWei: weiStringSchema,
  progressBps: z.number().int().min(0).max(10_000),
  realEthReserveWei: weiStringSchema,
  /** Tokens sold on the curve (18 decimals). */
  tokensSold: bigintStringSchema,
  mindBalanceWei: weiStringSchema,
  lastTickAt: isoTimestampSchema.nullable(),
  currentUrl: z.string().nullable(),
  createdAt: isoTimestampSchema,
  trades24h: z.number().int().min(0),
  volume24hWei: weiStringSchema,
  /** Locally paused for 1 h by the runner after 3 consecutive failed ticks (R4); no on-chain effect. */
  cooling: z.boolean(),
});
export type MindSummary = z.infer<typeof mindSummarySchema>;

/** Full view of a mind (`GET /api/minds/:token`). */
export const mindDetailSchema = mindSummarySchema.extend({
  personaHash: hash32Schema,
  /** `true` when the resolved persona hashes to `personaHash`; `null` when no persona was resolved. */
  personaVerified: z.boolean().nullable(),
  pool: addressSchema.nullable(),
  positionId: bigintStringSchema.nullable(),
  /** Graduator recorded at graduation (`graduatorOf(token)`), or `null`. */
  graduator: addressSchema.nullable(),
  description: z.string().nullable(),
  /** Persona prompt text from the metadata JSON, if resolvable. */
  persona: z.string().nullable(),
  links: z.record(z.string(), z.string()).nullable(),
  lastFrameAt: isoTimestampSchema.nullable(),
  /** Metadata resolution state. */
  metadataStatus: z.enum(['pending', 'ok', 'error']),
});
export type MindDetail = z.infer<typeof mindDetailSchema>;

/** A curve trade (`GET /api/minds/:token/trades`). */
export const tradeSchema = z.object({
  txHash: hash32Schema,
  logIndex: z.number().int().min(0),
  blockNumber: z.number().int().min(0),
  timestamp: isoTimestampSchema,
  trader: addressSchema,
  isBuy: z.boolean(),
  /** `ethUsed` for buys, `ethOut` for sells (D6). */
  ethAmountWei: weiStringSchema,
  tokenAmount: bigintStringSchema,
  feeWei: weiStringSchema,
  /** Curve price after the trade, wei per 1e18 tokens. */
  priceWei: weiStringSchema,
  realEthReserveWei: weiStringSchema,
  tokensSold: bigintStringSchema,
});
export type Trade = z.infer<typeof tradeSchema>;

/** `Memory.kind` (R7). */
export const memoryKindSchema = z.enum(['note', 'finding']);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

/** A memory (`GET /api/minds/:token/memories`). */
export const memorySchema = z.object({
  seq: z.number().int().min(1),
  kind: memoryKindSchema,
  content: z.string(),
  url: z.string().nullable(),
  createdAt: isoTimestampSchema,
  /** `keccak256(canonicalJSON({ seq, kind, content, url, createdAt }))`. */
  contentHash: hash32Schema,
  /** `anchorMemory` transaction covering this memory, or `null`. */
  anchorTx: hash32Schema.nullable(),
  /** `runner://memories/<token>/<fromSeq>-<toSeq>` of the batch covering this memory, or `null`. */
  anchorUri: z.string().nullable(),
});
export type Memory = z.infer<typeof memorySchema>;

/** A persisted thought (`GET /api/minds/:token/thoughts`, R7). */
export const thoughtSchema = z.object({
  id: z.number().int().min(1),
  tickId: z.number().int().min(1),
  /** `aloud` from the `think_aloud` tool, `summary` from the tick's final assistant text. */
  kind: z.enum(['aloud', 'summary']),
  text: z.string(),
  createdAt: isoTimestampSchema,
});
export type Thought = z.infer<typeof thoughtSchema>;

/** One compute ledger row: usage of one tick at one served model. */
export const ledgerEntrySchema = z.object({
  tickId: z.number().int().min(1),
  /** Model that served the requests (`message.model`) — the price applied. */
  model: z.string(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cacheReadTokens: z.number().int().min(0),
  cacheWriteTokens: z.number().int().min(0),
  costUsd: usdSchema,
  createdAt: isoTimestampSchema,
  /** Receipt this row was settled in, or `null` while unsettled. */
  receiptHash: hash32Schema.nullable(),
  settledTx: hash32Schema.nullable(),
});
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

/** One line of a draw receipt (R2). */
export const drawReceiptTickSchema = z.object({
  tickId: z.number().int().min(1),
  model: z.string(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cacheReadTokens: z.number().int().min(0),
  cacheWriteTokens: z.number().int().min(0),
  /** `costOfUsageMicroUsd(pricing(model), tokens)` — integer micro-USD. */
  costUsdMicro: z.number().int().min(0),
});
export type DrawReceiptTick = z.infer<typeof drawReceiptTickSchema>;

/**
 * Draw receipt object (R2). `receiptHash = keccak256(utf8(canonicalJSON(receipt)))` is passed to
 * `drawCompute(token, amountWei, receiptHash)`; `amountWei = Σ costUsdMicro · 1e18 / ethUsdPriceMicro`
 * (floored).
 */
export const drawReceiptSchema = z.object({
  token: addressSchema,
  fromTickId: z.number().int().min(1),
  toTickId: z.number().int().min(1),
  ticks: z.array(drawReceiptTickSchema).min(1),
  /** ETH/USD price × 1e6 used for the conversion. */
  ethUsdPriceMicro: z.number().int().min(1),
  amountWei: weiStringSchema,
});
export type DrawReceipt = z.infer<typeof drawReceiptSchema>;

/** Lifecycle of a runner-originated transaction record (draw receipt, memory anchor). */
export const txRecordStatusSchema = z.enum(['pending', 'submitted', 'confirmed', 'failed', 'dry_run']);
export type TxRecordStatus = z.infer<typeof txRecordStatusSchema>;

/** A draw receipt with its settlement state (`GET /api/minds/:token/compute` → `receipts`). */
export const computeReceiptSchema = z.object({
  receiptHash: hash32Schema,
  receipt: drawReceiptSchema,
  status: txRecordStatusSchema,
  txHash: hash32Schema.nullable(),
  createdAt: isoTimestampSchema,
  error: z.string().nullable(),
});
export type ComputeReceipt = z.infer<typeof computeReceiptSchema>;

/** An on-chain `ComputeDrawn` event. */
export const drawSchema = z.object({
  txHash: hash32Schema,
  logIndex: z.number().int().min(0),
  blockNumber: z.number().int().min(0),
  amountWei: weiStringSchema,
  receiptHash: hash32Schema,
  timestamp: isoTimestampSchema,
});
export type Draw = z.infer<typeof drawSchema>;

/** `GET /api/minds/:token/compute` */
export const computeResponseSchema = z.object({
  balanceWei: weiStringSchema,
  balanceUsd: usdSchema,
  /** Spend not yet settled on-chain. */
  unsettledUsd: usdSchema,
  /** `balanceUsd - unsettledUsd` (floored at 0). */
  availableUsd: usdSchema,
  ethUsd: usdSchema,
  burnUsdPerHour: usdSchema,
  /** `null` when the burn rate is zero (infinite runway). */
  runwayHours: z.number().min(0).nullable(),
  /** Burn-governor daily budget (R5). */
  dailyBudgetUsd: usdSchema,
  /** Burn-governor tick interval (R5). */
  tickIntervalMs: z.number().int().min(0),
  ledger: z.array(ledgerEntrySchema),
  receipts: z.array(computeReceiptSchema),
  draws: z.array(drawSchema),
});
export type ComputeResponse = z.infer<typeof computeResponseSchema>;

/** One memory inside an anchor batch (R2). */
export const memoryBatchItemSchema = z.object({
  seq: z.number().int().min(1),
  kind: memoryKindSchema,
  content: z.string(),
  url: z.string().nullable(),
  createdAt: isoTimestampSchema,
});
export type MemoryBatchItem = z.infer<typeof memoryBatchItemSchema>;

/**
 * Anchor batch object (R2), served verbatim at
 * `GET /api/minds/:token/memories/batch/:fromSeq-:toSeq`;
 * `contentHash = keccak256(utf8(canonicalJSON(batch)))`.
 */
export const memoryBatchSchema = z.object({
  token: addressSchema,
  fromSeq: z.number().int().min(1),
  toSeq: z.number().int().min(1),
  memories: z.array(memoryBatchItemSchema).min(1),
});
export type MemoryBatch = z.infer<typeof memoryBatchSchema>;

/** A memory anchor record (`GET /api/minds/:token/anchors`). */
export const anchorSchema = z.object({
  fromSeq: z.number().int().min(1),
  toSeq: z.number().int().min(1),
  contentHash: hash32Schema,
  uri: z.string(),
  status: txRecordStatusSchema,
  txHash: hash32Schema.nullable(),
  createdAt: isoTimestampSchema,
});
export type Anchor = z.infer<typeof anchorSchema>;

/** Indexer state reported by `GET /api/health`. */
export const indexerStatusSchema = z.enum(['disabled', 'starting', 'syncing', 'live', 'error']);
export type IndexerStatus = z.infer<typeof indexerStatusSchema>;

/** `GET /api/health` */
export const healthResponseSchema = z.object({
  ok: z.boolean(),
  chainId: z.number().int(),
  /** Configured launchpad, or `null` when none is configured. */
  launchpad: addressSchema.nullable(),
  lastIndexedBlock: z.number().int().min(0).nullable(),
  headBlock: z.number().int().min(0).nullable(),
  activeMinds: z.number().int().min(0),
  dryRun: z.boolean(),
  indexer: z.object({ status: indexerStatusSchema, lastError: z.string().nullable() }),
  /** Whether an Anthropic API key is configured (minds only think when true). */
  anthropic: z.boolean(),
  operator: addressSchema.nullable(),
  version: z.string(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** `GET /api/minds` query. */
export const mindsSortSchema = z.enum(['created', 'mcap', 'activity']);
export type MindsSort = z.infer<typeof mindsSortSchema>;

export const mindsQuerySchema = z.object({
  sort: mindsSortSchema.default('created'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(64).optional(),
});
export type MindsQuery = z.infer<typeof mindsQuerySchema>;

/** `GET /api/minds` response. */
export const mindsResponseSchema = z.object({
  items: z.array(mindSummarySchema),
  nextCursor: z.string().nullable(),
});
export type MindsResponse = z.infer<typeof mindsResponseSchema>;

/** `GET /api/models` item (public fields only). */
export const publicModelSchema = z.object({
  id: modelIdSchema,
  label: z.string(),
  description: z.string(),
  modelIdHash: hash32Schema,
  inputUsdPerMTok: z.number().min(0),
  outputUsdPerMTok: z.number().min(0),
  cacheReadUsdPerMTok: z.number().min(0),
  cacheWriteUsdPerMTok: z.number().min(0),
  isDefault: z.boolean(),
});
export type PublicModel = z.infer<typeof publicModelSchema>;

/** `GET /api/stats` */
export const statsResponseSchema = z.object({
  minds: z.number().int().min(0),
  alive: z.number().int().min(0),
  dormant: z.number().int().min(0),
  paused: z.number().int().min(0),
  graduated: z.number().int().min(0),
  trades: z.number().int().min(0),
  volumeTotalWei: weiStringSchema,
  feesToMindsWei: weiStringSchema,
});
export type StatsResponse = z.infer<typeof statsResponseSchema>;

/** Error body of every non-2xx JSON response. */
export const apiErrorSchema = z.object({ error: z.string(), details: z.unknown().optional() });
export type ApiError = z.infer<typeof apiErrorSchema>;

// ---------------------------------------------------------------------------
// §6 WebSocket protocol (R7, R10)
// ---------------------------------------------------------------------------

export const wsHelloSchema = z.object({
  type: z.literal('hello'),
  token: addressSchema,
  status: mindStatusNameSchema,
  phase: curvePhaseNameSchema,
  cooling: z.boolean(),
  currentUrl: z.string().nullable(),
  /** Last captured frame (JPEG, base64) or `null`. */
  lastFrame: z.string().nullable(),
  at: isoTimestampSchema,
});
export const wsFrameSchema = z.object({
  type: z.literal('frame'),
  jpegBase64: z.string(),
  url: z.string(),
  at: isoTimestampSchema,
});
/**
 * Streamed model output (R7): `delta: true` fragments followed by one `delta: false` message with
 * the full block text. `kind` is `text` for assistant text and `thinking` for summarized thinking.
 */
export const wsThoughtSchema = z.object({
  type: z.literal('thought'),
  tickId: z.number().int().min(1),
  kind: z.enum(['text', 'thinking']),
  text: z.string(),
  delta: z.boolean(),
  at: isoTimestampSchema,
});
export const wsActionSchema = z.object({
  type: z.literal('action'),
  tickId: z.number().int().min(1),
  tool: z.string(),
  /** Redacted tool input, at most 300 characters. */
  input: z.string().max(300),
  at: isoTimestampSchema,
});
/** A thought was persisted (same object as the REST `Thought`). */
export const wsThoughtSavedSchema = z.object({
  type: z.literal('thought_saved'),
  thought: thoughtSchema,
});
export const wsMemorySchema = z.object({
  type: z.literal('memory'),
  memory: memorySchema,
});
export const wsAnchorSchema = z.object({
  type: z.literal('anchor'),
  anchor: anchorSchema,
});
export const wsTickSchema = z.object({
  type: z.literal('tick'),
  tickId: z.number().int().min(1),
  state: z.enum(['started', 'finished']),
  model: z.string().nullable(),
  costUsd: usdSchema.nullable(),
  stopReason: z.string().nullable(),
  at: isoTimestampSchema,
});
export const wsStatusSchema = z.object({
  type: z.literal('status'),
  status: mindStatusNameSchema,
  phase: curvePhaseNameSchema,
  cooling: z.boolean(),
  at: isoTimestampSchema,
});
export const wsBudgetSchema = z.object({
  type: z.literal('budget'),
  balanceWei: weiStringSchema,
  balanceUsd: usdSchema,
  availableUsd: usdSchema,
  burnUsdPerHour: usdSchema,
  tickIntervalMs: z.number().int().min(0),
  at: isoTimestampSchema,
});
export const wsTradeSchema = z.object({
  type: z.literal('trade'),
  trade: tradeSchema,
});
export const wsPongSchema = z.object({
  type: z.literal('pong'),
  at: isoTimestampSchema,
});
export const wsErrorSchema = z.object({
  type: z.literal('error'),
  message: z.string(),
});

/** Server → client messages. */
export const wsServerMessageSchema = z.discriminatedUnion('type', [
  wsHelloSchema,
  wsFrameSchema,
  wsThoughtSchema,
  wsActionSchema,
  wsThoughtSavedSchema,
  wsMemorySchema,
  wsAnchorSchema,
  wsTickSchema,
  wsStatusSchema,
  wsBudgetSchema,
  wsTradeSchema,
  wsPongSchema,
  wsErrorSchema,
]);
export type WsServerMessage = z.infer<typeof wsServerMessageSchema>;
export type WsHello = z.infer<typeof wsHelloSchema>;
export type WsFrame = z.infer<typeof wsFrameSchema>;
export type WsThought = z.infer<typeof wsThoughtSchema>;
export type WsAction = z.infer<typeof wsActionSchema>;
export type WsThoughtSaved = z.infer<typeof wsThoughtSavedSchema>;
export type WsMemory = z.infer<typeof wsMemorySchema>;
export type WsAnchor = z.infer<typeof wsAnchorSchema>;
export type WsTick = z.infer<typeof wsTickSchema>;
export type WsStatus = z.infer<typeof wsStatusSchema>;
export type WsBudget = z.infer<typeof wsBudgetSchema>;
export type WsTrade = z.infer<typeof wsTradeSchema>;
export type WsPong = z.infer<typeof wsPongSchema>;
export type WsError = z.infer<typeof wsErrorSchema>;

/** Client → server messages. */
export const wsClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), token: addressSchema }),
  z.object({ type: z.literal('ping') }),
]);
export type WsClientMessage = z.infer<typeof wsClientMessageSchema>;

/** Server ping interval (SPEC §6: "Server pings every 25 s"). */
export const WS_PING_INTERVAL_MS = 25_000;
/** Maximum length of the redacted `action.input` field. */
export const WS_ACTION_INPUT_MAX_CHARS = 300;
/** Frames are dropped for a connection whose `bufferedAmount` exceeds this many bytes (R10). */
export const WS_MAX_BUFFERED_BYTES = 1_000_000;
/** Maximum WebSocket connections per mind (R10). */
export const WS_MAX_CONNECTIONS_PER_MIND = 100;
/** Close code used when the per-mind connection limit is reached ("Try Again Later", R10). */
export const WS_CLOSE_TRY_AGAIN_LATER = 1013;

/**
 * Truncates a tool input for the `action` message (`≤ 300 chars`), JSON-encoding objects.
 */
export function redactActionInput(input: unknown, max: number = WS_ACTION_INPUT_MAX_CHARS): string {
  const text = typeof input === 'string' ? input : (JSON.stringify(input) ?? '');
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}
