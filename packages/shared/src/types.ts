/**
 * HTTP API DTOs (`docs/SPEC.md` §5), WebSocket messages (§6) and the hashed objects of §3.2 as zod
 * schemas + inferred TypeScript types. Schema name = type name in lowerCamelCase + `Schema`.
 *
 * Conventions (§0.1): addresses and bytes32 values are lowercase hex (the schemas lowercase their
 * input); wei and token amounts are decimal strings (wei fields end in `Wei`); USD values are
 * numbers in dollars with 6 decimals; timestamps are ISO-8601 UTC; every DTO field is always
 * present and unknown values are `null` (the `MindMetadata` document is the only exception).
 *
 * @module types
 */
import { z } from 'zod';
import type { ModelId } from './models.js';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** `0x`-prefixed 20-byte address (any case on input, lowercased on output). */
export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x-prefixed 20-byte address')
  .transform((s) => s.toLowerCase() as `0x${string}`);
/** `0x`-prefixed 32-byte hex (tx hashes, keccak hashes), lowercased on output. */
export const hash32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'expected 0x-prefixed 32-byte hex')
  .transform((s) => s.toLowerCase() as `0x${string}`);
/** Non-negative integer as a decimal string (no leading zeros, no sign). */
export const bigintStringSchema = z.string().regex(/^(0|[1-9][0-9]*)$/, 'expected a decimal integer string');
/** ISO-8601 UTC timestamp (`Date.prototype.toISOString()`). */
export const isoTimestampSchema = z.iso.datetime();

/** Lowercase `0x` address. */
export type Address = z.infer<typeof addressSchema>;
/** Lowercase `0x` bytes32. */
export type Hash32 = z.infer<typeof hash32Schema>;
/** Decimal integer string. */
export type BigintString = z.infer<typeof bigintStringSchema>;

/** Serialises a non-negative bigint for the wire. */
export function toBigintString(value: bigint): BigintString {
  if (value < 0n) throw new RangeError('wire bigints must be non-negative');
  return value.toString(10);
}

/** Parses a wire bigint string. */
export function fromBigintString(value: BigintString): bigint {
  return BigInt(value);
}

const usd = z.number().finite().min(0);
const count = z.number().int().min(0);
const id = z.number().int().min(1);

// ---------------------------------------------------------------------------
// Enumerations (string form used on the wire)
// ---------------------------------------------------------------------------

/** `MindStatus` names; `paused` = paused by the creator. */
export const mindStatusNameSchema = z.enum(['alive', 'dormant', 'paused']);
export type MindStatusName = z.infer<typeof mindStatusNameSchema>;

/** `CurvePhase` names. */
export const curvePhaseNameSchema = z.enum(['bonding', 'complete', 'graduated']);
export type CurvePhaseName = z.infer<typeof curvePhaseNameSchema>;

/** Maps the on-chain `MindStatus` value to its wire name. */
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

/** Maps the on-chain `CurvePhase` value to its wire name. */
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

/** Maps a wire status name back to the on-chain value. */
export function mindStatusValue(name: MindStatusName): 0 | 1 | 2 {
  return name === 'alive' ? 0 : name === 'dormant' ? 1 : 2;
}

/** Maps a wire phase name back to the on-chain value. */
export function curvePhaseValue(name: CurvePhaseName): 0 | 1 | 2 {
  return name === 'bonding' ? 0 : name === 'complete' ? 1 : 2;
}

const modelIdSchema = z.enum(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5', 'claude-fable-5-1'] as const satisfies readonly ModelId[]);

// ---------------------------------------------------------------------------
// Metadata document (§5)
// ---------------------------------------------------------------------------

const utf8 = new TextEncoder();
const byteLength = (s: string): number => utf8.encode(s).length;
const httpUrl = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/^https?:\/\/\S+$/i, 'expected an http(s):// URL');

/**
 * `MindMetadata` — `POST /api/metadata` body and stored document. Strict: unknown keys and empty
 * strings are rejected, so clients omit empty optional fields.
 */
export const mindMetadataSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .refine((s) => byteLength(s) <= 64, 'name must be 1..64 UTF-8 bytes'),
  symbol: z
    .string()
    .min(1)
    .refine((s) => byteLength(s) <= 16, 'symbol must be 1..16 UTF-8 bytes'),
  description: z.string().min(1).max(2000).optional(),
  image: z
    .string()
    .min(1)
    .max(512)
    .regex(/^(https?|ipfs):\/\/\S+$/i, 'image must be an http(s):// or ipfs:// URL')
    .optional(),
  persona: z.string().min(1).max(8000),
  model: modelIdSchema,
  links: z
    .strictObject({
      x: httpUrl(256).optional(),
      website: httpUrl(256).optional(),
      telegram: httpUrl(256).optional(),
    })
    .optional(),
});
export type MindMetadata = z.infer<typeof mindMetadataSchema>;

/** `POST /api/metadata` response. */
export const metadataUploadResponseSchema = z.object({
  /** `runner://metadata/<hash>` */
  uri: z.string(),
  /** `sha256(canonicalJson(meta))`: 64 lowercase hex, no `0x`. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  /** `keccak256(toBytes(persona))` — the `personaHash` argument of `createMind`. */
  personaHash: hash32Schema,
});
export type MetadataUploadResponse = z.infer<typeof metadataUploadResponseSchema>;

/** Error body of every non-2xx JSON response. */
export const apiErrorSchema = z.object({ error: z.string() });
export type ApiError = z.infer<typeof apiErrorSchema>;

// ---------------------------------------------------------------------------
// Hashed objects (§3.2)
// ---------------------------------------------------------------------------

/** One memory as hashed (`Memory.contentHash`) and as listed inside an anchor batch. */
export const anchorMemoryItemSchema = z.object({
  seq: id,
  kind: z.enum(['note', 'finding']),
  content: z.string(),
  url: z.string().nullable(),
  createdAt: isoTimestampSchema,
});
export type AnchorMemoryItem = z.infer<typeof anchorMemoryItemSchema>;

/** Anchor batch (`GET /api/minds/:token/memories/batch/:fromSeq-:toSeq`). */
export const anchorBatchSchema = z.object({
  token: addressSchema,
  fromSeq: id,
  toSeq: id,
  memories: z.array(anchorMemoryItemSchema),
});
export type AnchorBatch = z.infer<typeof anchorBatchSchema>;

/** Draw receipt object hashed into `drawCompute`'s `receiptHash`. */
export const drawReceiptObjectSchema = z.object({
  token: addressSchema,
  fromTickId: id,
  toTickId: id,
  ticks: z.array(
    z.object({
      tickId: id,
      model: z.string(),
      inputTokens: count,
      outputTokens: count,
      cacheReadTokens: count,
      cacheWriteTokens: count,
      costUsdMicro: count,
    }),
  ),
  ethUsdPriceMicro: z.number().int().min(1),
  amountWei: bigintStringSchema,
});
export type DrawReceiptObject = z.infer<typeof drawReceiptObjectSchema>;

// ---------------------------------------------------------------------------
// §5 DTOs
// ---------------------------------------------------------------------------

/** Card-level view of a mind. */
export const mindSummarySchema = z.object({
  token: addressSchema,
  name: z.string(),
  symbol: z.string(),
  creator: addressSchema,
  metadataURI: z.string(),
  /** Resolved http(s) image URL, or `null`. */
  image: z.string().nullable(),
  /** bytes32 model id. */
  modelId: hash32Schema,
  /** Catalog id; `null` when `modelId` is not in the catalog. */
  model: modelIdSchema.nullable(),
  status: mindStatusNameSchema,
  phase: curvePhaseNameSchema,
  /** Wei per 1e18 tokens (frozen final curve price once graduated). */
  priceWei: bigintStringSchema,
  marketCapWei: bigintStringSchema,
  progressBps: z.number().int().min(0).max(10_000),
  realEthReserveWei: bigintStringSchema,
  tokensSold: bigintStringSchema,
  mindBalanceWei: bigintStringSchema,
  lastTickAt: isoTimestampSchema.nullable(),
  currentUrl: z.string().nullable(),
  createdAt: isoTimestampSchema,
  trades24h: count,
  volume24hWei: bigintStringSchema,
});
export type MindSummary = z.infer<typeof mindSummarySchema>;

/** Full view of a mind. */
export const mindDetailSchema = mindSummarySchema.extend({
  personaHash: hash32Schema,
  /** Non-null only when `personaVerified`. */
  persona: z.string().nullable(),
  personaVerified: z.boolean(),
  description: z.string().nullable(),
  links: z.object({ x: z.string().nullable(), website: z.string().nullable(), telegram: z.string().nullable() }),
  /** After graduation (MockGraduator: the graduator address). */
  pool: addressSchema.nullable(),
  /** Decimal; `"0"` for MockGraduator. */
  positionId: bigintStringSchema.nullable(),
  lastFrameAt: isoTimestampSchema.nullable(),
});
export type MindDetail = z.infer<typeof mindDetailSchema>;

/** A curve trade. */
export const tradeSchema = z.object({
  txHash: hash32Schema,
  logIndex: count,
  blockNumber: count,
  timestamp: isoTimestampSchema,
  trader: addressSchema,
  isBuy: z.boolean(),
  /** `Trade.ethAmount`: `ethUsed` (fee included) for buys, `ethOut` (fee excluded) for sells. */
  ethAmountWei: bigintStringSchema,
  tokenAmount: bigintStringSchema,
  feeWei: bigintStringSchema,
  /** Post-trade spot price. */
  priceWei: bigintStringSchema,
  realEthReserveWei: bigintStringSchema,
  tokensSold: bigintStringSchema,
});
export type Trade = z.infer<typeof tradeSchema>;

/** A memory. */
export const memorySchema = z.object({
  seq: id,
  kind: z.enum(['note', 'finding']),
  content: z.string(),
  url: z.string().nullable(),
  createdAt: isoTimestampSchema,
  /** `memoryContentHash({ seq, kind, content, url, createdAt })`. */
  contentHash: hash32Schema,
  anchorTx: hash32Schema.nullable(),
});
export type Memory = z.infer<typeof memorySchema>;

/** A persisted thought: `aloud` (the `think_aloud` tool) or `summary` (a tick's final text). */
export const thoughtSchema = z.object({
  id,
  tickId: id,
  kind: z.enum(['aloud', 'summary']),
  text: z.string(),
  createdAt: isoTimestampSchema,
});
export type Thought = z.infer<typeof thoughtSchema>;

/** One tick in the compute ledger. */
export const ledgerEntrySchema = z.object({
  tickId: id,
  startedAt: isoTimestampSchema,
  /** Served model (`message.model`) of the tick's last iteration. */
  model: z.string(),
  iterations: count,
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
  costUsd: usd,
  stopReason: z.string().nullable(),
  error: z.string().nullable(),
  receiptHash: hash32Schema.nullable(),
});
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

/** A draw receipt and its settlement state. */
export const drawReceiptSchema = z.object({
  receiptHash: hash32Schema,
  status: z.enum(['pending', 'confirmed', 'failed', 'dry_run']),
  txHash: hash32Schema.nullable(),
  createdAt: isoTimestampSchema,
  receipt: drawReceiptObjectSchema,
});
export type DrawReceipt = z.infer<typeof drawReceiptSchema>;

/** An indexed `ComputeDrawn` event. */
export const drawSchema = z.object({
  txHash: hash32Schema,
  blockNumber: count,
  timestamp: isoTimestampSchema,
  amountWei: bigintStringSchema,
  receiptHash: hash32Schema,
});
export type Draw = z.infer<typeof drawSchema>;

/** `GET /api/minds/:token/compute` */
export const computeResponseSchema = z.object({
  balanceWei: bigintStringSchema,
  balanceUsd: usd,
  unsettledUsd: usd,
  availableUsd: usd,
  burnUsdPerHour: usd,
  /** `null` when `burnUsdPerHour == 0`. */
  runwayHours: usd.nullable(),
  /** Burn-governor interval; `null` when the mind is not runnable. */
  tickIntervalMs: count.nullable(),
  ledger: z.array(ledgerEntrySchema),
  receipts: z.array(drawReceiptSchema),
  draws: z.array(drawSchema),
});
export type ComputeResponse = z.infer<typeof computeResponseSchema>;

/** `GET /api/health` */
export const healthResponseSchema = z.object({
  ok: z.boolean(),
  chainId: z.number().int().min(1),
  launchpad: addressSchema,
  lastIndexedBlock: count,
  headBlock: count,
  /** Ticks currently in flight. */
  activeMinds: count,
  dryRun: z.boolean(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** `GET /api/minds` */
export const mindsResponseSchema = z.object({
  items: z.array(mindSummarySchema),
  nextCursor: z.string().nullable(),
});
export type MindsResponse = z.infer<typeof mindsResponseSchema>;

/** `GET /api/models` item. */
export const publicModelSchema = z.object({
  id: modelIdSchema,
  label: z.string(),
  description: z.string(),
  modelIdHash: hash32Schema,
  inputUsdPerMTok: usd,
  outputUsdPerMTok: usd,
  cacheReadUsdPerMTok: usd,
  cacheWriteUsdPerMTok: usd,
  isDefault: z.boolean(),
});
export type PublicModel = z.infer<typeof publicModelSchema>;

/** `GET /api/stats` */
export const statsResponseSchema = z.object({
  minds: count,
  alive: count,
  graduated: count,
  /** Σ gross ETH of all trades. */
  totalVolumeWei: bigintStringSchema,
  /** Σ `FeeAccrued.mindAmount`. */
  totalFeesToMindsWei: bigintStringSchema,
});
export type StatsResponse = z.infer<typeof statsResponseSchema>;

// ---------------------------------------------------------------------------
// §6 WebSocket protocol
// ---------------------------------------------------------------------------

/** A captured browser frame. */
export const wsFrameDataSchema = z.object({
  jpegBase64: z.string(),
  url: z.string(),
  at: isoTimestampSchema,
});
export type WsFrameData = z.infer<typeof wsFrameDataSchema>;

export const wsHelloSchema = z.object({
  type: z.literal('hello'),
  token: addressSchema,
  status: mindStatusNameSchema,
  phase: curvePhaseNameSchema,
  frame: wsFrameDataSchema.nullable(),
  at: isoTimestampSchema,
});
export const wsFrameSchema = wsFrameDataSchema.extend({ type: z.literal('frame') });
/**
 * Streamed model output: `delta: true` fragments, then exactly one `delta: false` message with the
 * full block text. `kind` is `text` for assistant text and `thinking` for summarized thinking.
 */
export const wsThoughtSchema = z.object({
  type: z.literal('thought'),
  tickId: id,
  kind: z.enum(['text', 'thinking']),
  text: z.string(),
  delta: z.boolean(),
  at: isoTimestampSchema,
});
export const wsThoughtSavedSchema = z.object({
  type: z.literal('thoughtSaved'),
  thought: thoughtSchema,
});
export const wsActionSchema = z.object({
  type: z.literal('action'),
  tickId: id,
  tool: z.string(),
  /** `redactActionInput(input)`, at most 300 characters. */
  input: z.string().max(300),
  at: isoTimestampSchema,
});
export const wsMemorySchema = z.object({
  type: z.literal('memory'),
  memory: memorySchema,
});
export const wsStatusSchema = z.object({
  type: z.literal('status'),
  status: mindStatusNameSchema,
  phase: curvePhaseNameSchema,
  at: isoTimestampSchema,
});
export const wsBudgetSchema = z.object({
  type: z.literal('budget'),
  balanceWei: bigintStringSchema,
  balanceUsd: usd,
  burnUsdPerHour: usd,
  runwayHours: usd.nullable(),
  at: isoTimestampSchema,
});
export const wsTradeSchema = z.object({
  type: z.literal('trade'),
  trade: tradeSchema,
});
export const wsPongSchema = z.object({ type: z.literal('pong') });
export const wsErrorSchema = z.object({ type: z.literal('error'), message: z.string() });

/** Server → client messages. */
export const wsServerMessageSchema = z.discriminatedUnion('type', [
  wsHelloSchema,
  wsFrameSchema,
  wsThoughtSchema,
  wsThoughtSavedSchema,
  wsActionSchema,
  wsMemorySchema,
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
export type WsThoughtSaved = z.infer<typeof wsThoughtSavedSchema>;
export type WsAction = z.infer<typeof wsActionSchema>;
export type WsMemory = z.infer<typeof wsMemorySchema>;
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

/** Server protocol-ping interval (§6). */
export const WS_PING_INTERVAL_MS = 25_000;
/** Maximum length of the redacted `action.input` field. */
export const WS_ACTION_INPUT_MAX_CHARS = 300;

/** Truncates a tool input for the `action` message (≤ 300 chars), JSON-encoding non-strings. */
export function redactActionInput(input: unknown, max: number = WS_ACTION_INPUT_MAX_CHARS): string {
  const text = typeof input === 'string' ? input : (JSON.stringify(input) ?? '');
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}
