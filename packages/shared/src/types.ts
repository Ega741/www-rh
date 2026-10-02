/**
 * API DTOs (SPEC §5) and WebSocket messages (SPEC §6) as zod schemas + inferred TS types.
 *
 * Conventions: addresses are lowercase hex; bigints are decimal strings; timestamps are ISO-8601.
 *
 * @module types
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/** Lowercase `0x`-prefixed 20-byte address. */
export const addressSchema = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/, 'expected lowercase 0x-prefixed 20-byte address');
/** `0x`-prefixed 32-byte hex (tx hashes, keccak hashes). Case-insensitive. */
export const hash32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'expected 0x-prefixed 32-byte hex');
/** Non-negative integer encoded as a decimal string (bigint over the wire). */
export const bigintStringSchema = z.string().regex(/^(0|[1-9][0-9]*)$/, 'expected decimal integer string');
/** ISO-8601 timestamp. */
export const isoTimestampSchema = z.iso.datetime({ offset: true });

export type Address = z.infer<typeof addressSchema>;
export type Hash32 = z.infer<typeof hash32Schema>;
export type BigintString = z.infer<typeof bigintStringSchema>;

/** Serialises a bigint for the API. */
export function toBigintString(value: bigint): BigintString {
  if (value < 0n) throw new RangeError('API bigints must be non-negative');
  return value.toString(10);
}

/** Parses an API bigint string. */
export function fromBigintString(value: BigintString): bigint {
  return BigInt(value);
}

// ---------------------------------------------------------------------------
// Enumerations (string form used by the API)
// ---------------------------------------------------------------------------

export const mindStatusNameSchema = z.enum(['alive', 'dormant', 'retired']);
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
      return 'retired';
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

// ---------------------------------------------------------------------------
// §5 DTOs
// ---------------------------------------------------------------------------

export const mindSummarySchema = z.object({
  token: addressSchema,
  name: z.string(),
  symbol: z.string(),
  creator: addressSchema,
  metadataURI: z.string(),
  image: z.string().optional(),
  /** `bytes32` model id hash. */
  modelId: hash32Schema,
  /** Model id string resolved from the catalog (or the hash if unknown). */
  model: z.string(),
  status: mindStatusNameSchema,
  phase: curvePhaseNameSchema,
  priceWei: bigintStringSchema,
  marketCapWei: bigintStringSchema,
  progressBps: z.number().int().min(0).max(10_000),
  realEthReserve: bigintStringSchema,
  tokensSold: bigintStringSchema,
  mindBalanceWei: bigintStringSchema,
  lastTickAt: isoTimestampSchema.optional(),
  currentUrl: z.string().optional(),
  createdAt: isoTimestampSchema,
  trades24h: z.number().int().min(0),
  volume24hWei: bigintStringSchema,
});
export type MindSummary = z.infer<typeof mindSummarySchema>;

export const mindDetailSchema = mindSummarySchema.extend({
  personaHash: hash32Schema,
  pool: addressSchema.optional(),
  positionId: bigintStringSchema.optional(),
  description: z.string().optional(),
  /** Persona prompt text from the metadata JSON, if resolvable. */
  persona: z.string().optional(),
  lastFrameAt: isoTimestampSchema.optional(),
});
export type MindDetail = z.infer<typeof mindDetailSchema>;

export const tradeSchema = z.object({
  txHash: hash32Schema,
  logIndex: z.number().int().min(0),
  blockNumber: z.number().int().min(0),
  timestamp: isoTimestampSchema,
  trader: addressSchema,
  isBuy: z.boolean(),
  ethAmount: bigintStringSchema,
  tokenAmount: bigintStringSchema,
  fee: bigintStringSchema,
  priceWei: bigintStringSchema,
});
export type Trade = z.infer<typeof tradeSchema>;

export const memoryKindSchema = z.enum(['note', 'finding', 'thought']);
export type MemoryKind = z.infer<typeof memoryKindSchema>;

export const memorySchema = z.object({
  seq: z.number().int().min(0),
  kind: memoryKindSchema,
  content: z.string(),
  url: z.string().optional(),
  createdAt: isoTimestampSchema,
  contentHash: hash32Schema,
  anchorTx: hash32Schema.optional(),
});
export type Memory = z.infer<typeof memorySchema>;

export const thoughtSchema = z.object({
  id: z.number().int().min(0),
  tickId: z.number().int().min(0),
  kind: z.enum(['thought', 'summary']),
  text: z.string(),
  createdAt: isoTimestampSchema,
});
export type Thought = z.infer<typeof thoughtSchema>;

export const ledgerEntrySchema = z.object({
  tickId: z.number().int().min(0),
  model: z.string(),
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cacheReadTokens: z.number().int().min(0),
  cacheWriteTokens: z.number().int().min(0),
  costUsd: z.number().min(0),
  settledTx: hash32Schema.optional(),
});
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

export const drawSchema = z.object({
  txHash: hash32Schema,
  amountWei: bigintStringSchema,
  to: addressSchema,
  receiptHash: hash32Schema,
  timestamp: isoTimestampSchema,
});
export type Draw = z.infer<typeof drawSchema>;

/** `GET /health` */
export const healthResponseSchema = z.object({
  ok: z.boolean(),
  chainId: z.number().int(),
  launchpad: addressSchema,
  lastIndexedBlock: z.number().int().min(0),
  headBlock: z.number().int().min(0),
  activeMinds: z.number().int().min(0),
  dryRun: z.boolean(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** `GET /minds` query. */
export const mindsSortSchema = z.enum(['created', 'mcap', 'activity']);
export type MindsSort = z.infer<typeof mindsSortSchema>;

export const mindsQuerySchema = z.object({
  sort: mindsSortSchema.default('created'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type MindsQuery = z.infer<typeof mindsQuerySchema>;

/** `GET /minds` response. */
export const mindsResponseSchema = z.object({
  items: z.array(mindSummarySchema),
  nextCursor: z.string().nullable().optional(),
});
export type MindsResponse = z.infer<typeof mindsResponseSchema>;

/** `GET /minds/:token/compute` */
export const computeResponseSchema = z.object({
  balanceWei: bigintStringSchema,
  balanceUsd: z.number().min(0),
  burnUsdPerHour: z.number().min(0),
  /** `null` when the burn rate is zero (infinite runway). */
  runwayHours: z.number().min(0).nullable(),
  ledger: z.array(ledgerEntrySchema),
  draws: z.array(drawSchema),
});
export type ComputeResponse = z.infer<typeof computeResponseSchema>;

/** `GET /models` item (public fields only). */
export const publicModelSchema = z.object({
  id: z.string(),
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

/** `GET /stats` */
export const statsResponseSchema = z.object({
  minds: z.number().int().min(0),
  alive: z.number().int().min(0),
  graduated: z.number().int().min(0),
  volumeEthTotal: bigintStringSchema,
  feesToMindsEth: bigintStringSchema,
});
export type StatsResponse = z.infer<typeof statsResponseSchema>;

/** Metadata JSON stored at `metadataURI` (SPEC §2.3 `MindInfo.metadataURI`, §7 create form). */
export const mindMetadataSchema = z.object({
  name: z.string().min(1).max(64),
  symbol: z.string().min(1).max(16),
  description: z.string().default(''),
  image: z.string().optional(),
  persona: z.string(),
  model: z.string(),
  links: z.record(z.string(), z.string()).optional(),
});
export type MindMetadata = z.infer<typeof mindMetadataSchema>;

/** `POST /api/metadata` response. */
export const metadataUploadResponseSchema = z.object({
  uri: z.string(),
  hash: hash32Schema,
});
export type MetadataUploadResponse = z.infer<typeof metadataUploadResponseSchema>;

// ---------------------------------------------------------------------------
// §6 WebSocket protocol
// ---------------------------------------------------------------------------

export const wsHelloSchema = z.object({
  type: z.literal('hello'),
  token: addressSchema,
  status: mindStatusNameSchema,
  phase: curvePhaseNameSchema,
  lastFrame: z.string().optional(),
});
export const wsFrameSchema = z.object({
  type: z.literal('frame'),
  jpegBase64: z.string(),
  url: z.string(),
  at: isoTimestampSchema,
});
export const wsThoughtSchema = z.object({
  type: z.literal('thought'),
  text: z.string(),
  delta: z.boolean(),
  tickId: z.number().int().min(0),
  at: isoTimestampSchema,
});
export const wsActionSchema = z.object({
  type: z.literal('action'),
  tool: z.string(),
  /** Redacted tool input, at most 300 characters. */
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
  balanceUsd: z.number().min(0),
  burnUsdPerHour: z.number().min(0),
  at: isoTimestampSchema,
});
export const wsTradeSchema = z.object({
  type: z.literal('trade'),
  trade: tradeSchema,
});

/** Server → client messages. */
export const wsServerMessageSchema = z.discriminatedUnion('type', [
  wsHelloSchema,
  wsFrameSchema,
  wsThoughtSchema,
  wsActionSchema,
  wsMemorySchema,
  wsStatusSchema,
  wsBudgetSchema,
  wsTradeSchema,
]);
export type WsServerMessage = z.infer<typeof wsServerMessageSchema>;
export type WsHello = z.infer<typeof wsHelloSchema>;
export type WsFrame = z.infer<typeof wsFrameSchema>;
export type WsThought = z.infer<typeof wsThoughtSchema>;
export type WsAction = z.infer<typeof wsActionSchema>;
export type WsMemory = z.infer<typeof wsMemorySchema>;
export type WsStatus = z.infer<typeof wsStatusSchema>;
export type WsBudget = z.infer<typeof wsBudgetSchema>;
export type WsTrade = z.infer<typeof wsTradeSchema>;

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

/**
 * Truncates a tool input for the `action` message (`≤ 300 chars`), JSON-encoding objects.
 */
export function redactActionInput(input: unknown, max: number = WS_ACTION_INPUT_MAX_CHARS): string {
  const text = typeof input === 'string' ? input : JSON.stringify(input) ?? '';
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}
