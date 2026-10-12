/**
 * Dashboard API DTOs (SPEC §4.8, §5.4, §5.9) as zod v4 schemas with inferred types.
 *
 * Monetary fields travel as decimal strings in JSON (`"amountMicro": "2500000"`) and parse to
 * `bigint`; so do raw token amounts and `priceE18`. For every `XDtoSchema` there are two types:
 * `XDto` (parsed, bigint) and `XDtoWire` (what the gateway serializes, strings). Use
 * {@link serializeMicro} when building wire objects.
 *
 * Identifiers: workspaces, owners, mints, token accounts and the operator are base58 public keys
 * ({@link AddressSchema}); transactions are base58 signatures ({@link SignatureSchema}); receipt
 * hashes are `0x` + 64 hex ({@link Bytes32Schema}).
 *
 * Timestamps: off-chain `*At` fields (`createdAt`, `registeredAt`, `lastEventAt`, …) are unix
 * **milliseconds**; fields that mirror chain time (`blockTime`) and the price history
 * (`PriceDto.observedAt`, compared with `maxAgeS`) are unix **seconds**.
 *
 * @module api
 */
import { z } from 'zod';
import {
  ALIASES,
  BYOK_PROVIDERS,
  ModelPriceSchema,
  ModelSpecSchema,
  PLANS,
  PROVIDERS,
  TIER_ORDER,
} from './models.js';
import { Base58PubkeySchema, ClusterSchema, SignatureSchema, isBase58Signature } from './solana.js';

export { Base58PubkeySchema, ClusterSchema, SignatureSchema };

// ---------------------------------------------------------------------------------------------
// Primitives

/** Decimal integer string ↔ bigint (µUSD and other money; may be negative). */
export const MicroSchema = z.string().regex(/^-?\d+$/, 'expected a decimal integer string').transform((s) => BigInt(s));
/** Non-negative decimal integer string ↔ bigint (token amounts, `priceE18`). */
export const UintStringSchema = z.string().regex(/^\d+$/, 'expected a non-negative decimal integer string').transform((s) => BigInt(s));
/** A base58 public key: workspace, owner, mint, token account, operator. */
export const AddressSchema = Base58PubkeySchema;
/** `0x` + 64 hex characters (receipt hash). */
export const Bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'expected a 32-byte hex string');
/** Non-negative integer. */
export const UintSchema = z.number().int().nonnegative();
/** Integer (timestamps may legitimately be any integer). */
export const IntSchema = z.number().int();

const BASE64_SIGNATURE_RE = /^[A-Za-z0-9+/]{86}==$/;
/** `true` when `value` is a 64-byte signature in base58 (87–88 chars) or standard base64 (88 chars). */
export function isSignatureInput(value: unknown): value is string {
  return typeof value === 'string' && (BASE64_SIGNATURE_RE.test(value) || isBase58Signature(value));
}
/** A detached Ed25519 signature as sent by clients: base58 or base64 (SPEC §5.3). */
export const SignatureInputSchema = z.string().refine(isSignatureInput, { message: 'expected a 64-byte signature in base58 or base64' });

export const PlanSchema = z.enum(PLANS);
export const ProviderSchema = z.enum(PROVIDERS);
export const ByokProviderSchema = z.enum(BYOK_PROVIDERS);
export const TierSchema = z.enum(TIER_ORDER);
export const AliasSchema = z.enum(ALIASES);
export const PaidBySchema = z.enum(['credit', 'byok']);
export const ProviderHealthStateSchema = z.enum(['ok', 'degraded', 'down']);
export const UsageWindowSchema = z.enum(['24h', '7d', '30d']);
export const UsageStatusSchema = z.enum(['ok', 'error']);
export const LedgerKindSchema = z.enum(['credit', 'debit', 'adjustment', 'upgrade']);
export const CreditEventKindSchema = z.enum(['purchase', 'draw']);
export const BudgetDrawStatusSchema = z.enum(['pending', 'sent', 'confirmed', 'failed']);
/** Why a budget is not drawable right now (SPEC §5.4). */
export const BudgetStalledReasonSchema = z.enum(['price', 'revoked', 'exhausted', 'draw_failed']);
export const UpgradeKindSchema = z.enum(['pro', 'warm']);
/** Where a price point came from (SPEC §3.3). */
export const PriceSourceSchema = z.enum(['manual', 'feed', 'jupiter']);
export type PriceSource = z.output<typeof PriceSourceSchema>;

/** Serializes a bigint money/amount field for the wire. */
export function serializeMicro(value: bigint): string {
  return value.toString();
}

// ---------------------------------------------------------------------------------------------
// Public routes

/** `GET /api/price`: the current price point. `observedAt` is unix seconds; `stale = now − observedAt > maxAgeS`. */
export const PriceDtoSchema = z.object({
  /** `price_points.id` — every credit event references the point it was priced with. */
  pricePointId: UintSchema,
  priceE18: UintStringSchema,
  observedAt: IntSchema,
  stale: z.boolean(),
  source: PriceSourceSchema,
  /** `PRICE_MAX_AGE_S`. */
  maxAgeS: UintSchema,
  /** Human decimal, e.g. `"0.0025"`. */
  usdPerToken: z.string(),
  /** Human decimal, e.g. `"400"`. */
  tokensPerUsd: z.string(),
});
export type PriceDto = z.output<typeof PriceDtoSchema>;
export type PriceDtoWire = z.input<typeof PriceDtoSchema>;

/** `GET /api/price/history`: points, newest first (a bare array). */
export const PriceHistoryDtoSchema = z.array(PriceDtoSchema);
export type PriceHistoryDto = z.output<typeof PriceHistoryDtoSchema>;
export type PriceHistoryDtoWire = z.input<typeof PriceHistoryDtoSchema>;

/** Query of `GET /api/price/history`. */
export const PriceHistoryQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(100) });
export type PriceHistoryQuery = z.output<typeof PriceHistoryQuerySchema>;

/** `GET /api/quote?tokens=|usdMicro=`: both sides of the conversion at the current price point. */
export const QuoteDtoSchema = z.object({
  tokens: UintStringSchema,
  usdMicro: UintStringSchema,
  priceE18: UintStringSchema,
  pricePointId: UintSchema,
  stale: z.boolean(),
});
export type QuoteDto = z.output<typeof QuoteDtoSchema>;
export type QuoteDtoWire = z.input<typeof QuoteDtoSchema>;

/** Query of `GET /api/quote`: exactly one of `tokens` / `usdMicro`. */
export const QuoteQuerySchema = z
  .object({ tokens: UintStringSchema.optional(), usdMicro: UintStringSchema.optional() })
  .refine((q) => (q.tokens === undefined) !== (q.usdMicro === undefined), {
    message: 'pass exactly one of tokens or usdMicro',
  });
export type QuoteQuery = z.output<typeof QuoteQuerySchema>;

/** The credit token (SPEC §3.1), used by status. */
export const TokenInfoDtoSchema = z.object({
  mint: AddressSchema,
  symbol: z.string(),
  decimals: UintSchema,
  tokenProgram: AddressSchema,
});
export type TokenInfoDto = z.output<typeof TokenInfoDtoSchema>;

/** Indexer progress (SPEC §5.4); `lastSignature` / `lastSlot` are null before the first run. */
export const IndexerStatusDtoSchema = z.object({
  lastSignature: SignatureSchema.nullable(),
  lastSlot: UintSchema.nullable(),
  headSlot: UintSchema,
  lagSlots: IntSchema,
  /** Unix milliseconds of the last credit event applied, or null. */
  lastEventAt: IntSchema.nullable(),
});
export type IndexerStatusDto = z.output<typeof IndexerStatusDtoSchema>;

/** Per-provider status in `GET /api/status`. */
export const ProviderStatusDtoSchema = z.object({ state: ProviderHealthStateSchema, configured: z.boolean() });
export type ProviderStatusDto = z.output<typeof ProviderStatusDtoSchema>;

/** Operator (hot wallet) status; `solBalance` is lamports as a decimal string, present when known. */
export const OperatorStatusDtoSchema = z.object({
  address: AddressSchema.nullable(),
  enabled: z.boolean(),
  dryRun: z.boolean(),
  solBalance: UintStringSchema.optional(),
});
export type OperatorStatusDto = z.output<typeof OperatorStatusDtoSchema>;

/** `GET /api/status`. */
export const StatusDtoSchema = z.object({
  cluster: ClusterSchema,
  mint: AddressSchema,
  token: TokenInfoDtoSchema,
  indexer: IndexerStatusDtoSchema,
  price: PriceDtoSchema,
  providers: z.record(ProviderSchema, ProviderStatusDtoSchema),
  house: z.object({ enabled: z.boolean(), warmUntil: IntSchema.nullable(), largeModel: z.string() }),
  operator: OperatorStatusDtoSchema,
  version: z.string(),
});
export type StatusDto = z.output<typeof StatusDtoSchema>;
export type StatusDtoWire = z.input<typeof StatusDtoSchema>;

/** Pro plan pricing. */
export const ProPriceDtoSchema = z.object({ priceMicro: MicroSchema, days: UintSchema });

/** `GET /api/config`: what a client needs to build burns and budgets (the web reconciles it with the committed deployment). */
export const ConfigDtoSchema = z.object({
  cluster: ClusterSchema,
  /** Public RPC endpoint the gateway suggests to clients (never one carrying a secret). */
  rpcUrl: z.string(),
  mint: AddressSchema,
  decimals: UintSchema,
  symbol: z.string(),
  tokenProgram: AddressSchema,
  memoProgram: AddressSchema,
  /** The delegate of every budget; null while draws are disabled (no operator key). */
  operator: AddressSchema.nullable(),
  /** Explorer base URL (`https://explorer.solana.com`); build links with `explorerTxUrl(cluster, …)`. */
  explorer: z.string(),
  aliases: z.array(z.string()),
  markupBps: UintSchema,
  byokFeeBps: UintSchema,
  /** `MIN_CREDIT_USD` in µUSD: burns quoting below it earn no credit (SPEC §3.2). */
  minCreditMicro: MicroSchema,
  pro: ProPriceDtoSchema,
  warmHourPriceMicro: MicroSchema,
});
export type ConfigDto = z.output<typeof ConfigDtoSchema>;
export type ConfigDtoWire = z.input<typeof ConfigDtoSchema>;

/** One model in `GET /api/models`: the catalog entry plus live availability. */
export const ModelDtoSchema = ModelSpecSchema.extend({
  /** Serving possible right now (provider configured and not down; plan satisfied). */
  available: z.boolean(),
  providerState: ProviderHealthStateSchema,
});
export type ModelDto = z.output<typeof ModelDtoSchema>;
export type ModelDtoWire = z.input<typeof ModelDtoSchema>;

/** One alias in `GET /api/models`. */
export const AliasDtoSchema = z.object({ id: AliasSchema, description: z.string() });
export type AliasDto = z.output<typeof AliasDtoSchema>;

/** `GET /api/models`. */
export const ModelsDtoSchema = z.object({ models: z.array(ModelDtoSchema), aliases: z.array(AliasDtoSchema) });
export type ModelsDto = z.output<typeof ModelsDtoSchema>;
export type ModelsDtoWire = z.input<typeof ModelsDtoSchema>;

/** Error envelope of every `/api/*` route. */
export const ErrorDtoSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
export type ErrorDto = z.output<typeof ErrorDtoSchema>;

/** `GET /healthz`. */
export const HealthzDtoSchema = z.object({ ok: z.literal(true) });
export type HealthzDto = z.output<typeof HealthzDtoSchema>;

// ---------------------------------------------------------------------------------------------
// Auth and workspace

/** `GET /api/auth/nonce`. */
export const NonceDtoSchema = z.object({ nonce: z.string().min(8) });
export type NonceDto = z.output<typeof NonceDtoSchema>;

/** Body of `POST /api/auth/verify` (SPEC §5.3): the exact signed text, its signature, the signer. */
export const VerifyRequestSchema = z.object({
  message: z.string().min(1).max(4096),
  signature: SignatureInputSchema,
  publicKey: AddressSchema,
});
export type VerifyRequest = z.output<typeof VerifyRequestSchema>;

/** `POST /api/auth/verify`. */
export const VerifyDtoSchema = z.object({ token: z.string(), workspace: AddressSchema });
export type VerifyDto = z.output<typeof VerifyDtoSchema>;

/** `GET /api/me`. */
export const MeDtoSchema = z.object({
  workspace: AddressSchema,
  plan: PlanSchema,
  planUntil: IntSchema.nullable(),
  balanceMicro: MicroSchema,
  reservedMicro: MicroSchema,
  budgetHeadroomMicro: MicroSchema,
  availableMicro: MicroSchema,
  createdAt: IntSchema,
});
export type MeDto = z.output<typeof MeDtoSchema>;
export type MeDtoWire = z.input<typeof MeDtoSchema>;

/** `GET /api/balance`. */
export const BalanceDtoSchema = z.object({
  balanceMicro: MicroSchema,
  reservedMicro: MicroSchema,
  budgetHeadroomMicro: MicroSchema,
  availableMicro: MicroSchema,
  plan: PlanSchema,
  planUntil: IntSchema.nullable(),
  price: PriceDtoSchema,
});
export type BalanceDto = z.output<typeof BalanceDtoSchema>;
export type BalanceDtoWire = z.input<typeof BalanceDtoSchema>;

// ---------------------------------------------------------------------------------------------
// API keys

/** `GET /api/keys` row / `POST /api/keys` result (`key` present only on creation). */
export const ApiKeyDtoSchema = z.object({
  id: z.string(),
  /** First 12 characters (`bgl_xxxxxxxx`). */
  prefix: z.string(),
  name: z.string(),
  createdAt: IntSchema,
  lastUsedAt: IntSchema.nullable(),
  /** The full key, returned once by `POST /api/keys`. */
  key: z.string().optional(),
});
export type ApiKeyDto = z.output<typeof ApiKeyDtoSchema>;

/** `GET /api/keys`: a bare array (SPEC §5.9, unpaginated lists). */
export const ApiKeyListDtoSchema = z.array(ApiKeyDtoSchema);
export type ApiKeyListDto = z.output<typeof ApiKeyListDtoSchema>;

/** Body of `POST /api/keys`. */
export const CreateApiKeyRequestSchema = z.object({ name: z.string().trim().min(1).max(64).default('default') });
export type CreateApiKeyRequest = z.output<typeof CreateApiKeyRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Usage, ledger, receipts

/** One `usage` row (SPEC §5.2). */
export const UsageRowDtoSchema = z.object({
  id: z.string(),
  workspace: AddressSchema,
  apiKeyId: z.string().nullable(),
  endpoint: z.string(),
  requestedModel: z.string(),
  servedModel: z.string().nullable(),
  provider: ProviderSchema.nullable(),
  tier: TierSchema.nullable(),
  paidBy: PaidBySchema.nullable(),
  inputTokens: UintSchema,
  outputTokens: UintSchema,
  cacheReadTokens: UintSchema,
  cacheWriteTokens: UintSchema,
  upstreamCostMicro: MicroSchema,
  chargedMicro: MicroSchema,
  status: UsageStatusSchema,
  httpStatus: UintSchema,
  errorCode: z.string().nullable(),
  latencyMs: UintSchema,
  routeReasons: z.array(z.string()),
  stream: z.boolean(),
  difficulty: z.number().nullable(),
  drawId: IntSchema.nullable(),
  createdAt: IntSchema,
});
export type UsageRowDto = z.output<typeof UsageRowDtoSchema>;
export type UsageRowDtoWire = z.input<typeof UsageRowDtoSchema>;

/** `GET /api/usage`: newest first; `nextBefore` is the cursor for the next page (null at the end). */
export const UsageListDtoSchema = z.object({ rows: z.array(UsageRowDtoSchema), nextBefore: IntSchema.nullable() });
export type UsageListDto = z.output<typeof UsageListDtoSchema>;
export type UsageListDtoWire = z.input<typeof UsageListDtoSchema>;

/** Query of `GET /api/usage`. */
export const UsageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().optional(),
  model: z.string().min(1).optional(),
  status: UsageStatusSchema.optional(),
});
export type UsageQuery = z.output<typeof UsageQuerySchema>;

/** `GET /api/usage/summary`. */
export const UsageSummaryDtoSchema = z.object({
  window: UsageWindowSchema,
  requests: UintSchema,
  chargedMicro: MicroSchema,
  upstreamCostMicro: MicroSchema,
  inputTokens: UintSchema,
  outputTokens: UintSchema,
  byModel: z.array(z.object({ model: z.string(), requests: UintSchema, chargedMicro: MicroSchema })),
  /** `day` is `YYYY-MM-DD` (UTC). */
  byDay: z.array(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), requests: UintSchema, chargedMicro: MicroSchema })),
});
export type UsageSummaryDto = z.output<typeof UsageSummaryDtoSchema>;
export type UsageSummaryDtoWire = z.input<typeof UsageSummaryDtoSchema>;

/** Generic `?limit&before` cursor query. */
export const CursorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().optional(),
});
export type CursorQuery = z.output<typeof CursorQuerySchema>;

/** One `ledger` row. `amountMicro` is positive for credits, negative for debits. */
export const LedgerRowDtoSchema = z.object({
  id: UintSchema,
  workspace: AddressSchema,
  kind: LedgerKindSchema,
  amountMicro: MicroSchema,
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  memo: z.string().nullable(),
  createdAt: IntSchema,
});
export type LedgerRowDto = z.output<typeof LedgerRowDtoSchema>;
export type LedgerRowDtoWire = z.input<typeof LedgerRowDtoSchema>;

/** `GET /api/ledger`. */
export const LedgerListDtoSchema = z.object({ rows: z.array(LedgerRowDtoSchema), nextBefore: IntSchema.nullable() });
export type LedgerListDto = z.output<typeof LedgerListDtoSchema>;
export type LedgerListDtoWire = z.input<typeof LedgerListDtoSchema>;

/**
 * One indexed burn (`credit_events` row, SPEC §3.2, §5.9): a purchase or an operator draw, with
 * the price point it was credited at. Event id = `<signature>:<ixIndex>`.
 */
export const CreditEventDtoSchema = z.object({
  signature: SignatureSchema,
  /** Index of the burn instruction within the transaction (top-level and inner, in order). */
  ixIndex: UintSchema,
  slot: UintSchema,
  /** Unix seconds; null when the RPC reported no block time. */
  blockTime: IntSchema.nullable(),
  kind: CreditEventKindSchema,
  workspace: AddressSchema,
  /** Owner of the burned token account (null only when the account could not be resolved). */
  payer: AddressSchema.nullable(),
  tokenAccount: AddressSchema,
  tokenAmount: UintStringSchema,
  usdMicro: MicroSchema,
  priceE18: UintStringSchema,
  pricePointId: UintSchema.nullable(),
  priceStale: z.boolean(),
  /** The first memo of the transaction, verbatim, or null. */
  memo: z.string().nullable(),
  /** Draws: the `DrawBatch` hash from the memo; purchases: null. */
  receiptHash: Bytes32Schema.nullable(),
  explorerUrl: z.string().nullable(),
});
export type CreditEventDto = z.output<typeof CreditEventDtoSchema>;
export type CreditEventDtoWire = z.input<typeof CreditEventDtoSchema>;

/** `GET /api/receipts`. */
export const CreditEventListDtoSchema = z.object({ rows: z.array(CreditEventDtoSchema), nextBefore: IntSchema.nullable() });
export type CreditEventListDto = z.output<typeof CreditEventListDtoSchema>;
export type CreditEventListDtoWire = z.input<typeof CreditEventListDtoSchema>;

/** Token counts of one request (all four fields present in receipts). */
export const UsageTokensSchema = z.object({
  inputTokens: UintSchema,
  outputTokens: UintSchema,
  cacheReadTokens: UintSchema,
  cacheWriteTokens: UintSchema,
});
export type UsageTokensDto = z.output<typeof UsageTokensSchema>;

/**
 * The verifiable usage receipt (SPEC §5.7). `hash = receiptHash(receipt)` over exactly these
 * fields. Hashing the parsed (bigint) and the wire (string) form gives the same digest.
 */
export const UsageReceiptSchema = z.object({
  v: z.literal(1),
  requestId: z.string(),
  workspace: AddressSchema,
  createdAt: IntSchema,
  endpoint: z.string(),
  requestedModel: z.string(),
  servedModel: z.string(),
  provider: ProviderSchema,
  paidBy: PaidBySchema,
  usage: UsageTokensSchema,
  price: ModelPriceSchema,
  upstreamCostMicro: MicroSchema,
  markupBps: UintSchema,
  chargedMicro: MicroSchema,
  routeReasons: z.array(z.string()),
});
export type UsageReceipt = z.output<typeof UsageReceiptSchema>;
export type UsageReceiptWire = z.input<typeof UsageReceiptSchema>;

/**
 * `GET /api/receipts/:requestId` (SPEC §5.7, §5.9): `{ receipt, hash }` with
 * `hash = receiptHash(receipt)`. The receipt is nested, never spread into the envelope, so
 * `receiptHash(dto.receipt)` recomputes the hash from the parsed or the wire form alike.
 */
export const ReceiptDtoSchema = z.object({ receipt: UsageReceiptSchema, hash: Bytes32Schema });
export type ReceiptDto = z.output<typeof ReceiptDtoSchema>;
export type ReceiptDtoWire = z.input<typeof ReceiptDtoSchema>;

/**
 * The batch a budget draw settles (SPEC §5.4); `receiptHash(batch)` goes into the draw memo
 * (`beagle:draw v1 ws=<workspace> h=<hash>`) and the indexer confirms the draw by it.
 */
export const DrawBatchSchema = z.object({
  v: z.literal(1),
  cluster: ClusterSchema,
  mint: AddressSchema,
  tokenAccount: AddressSchema,
  workspace: AddressSchema,
  usageIds: z.array(z.string()),
  amountMicro: MicroSchema,
  priceE18: UintStringSchema,
  pricePointId: UintSchema,
});
export type DrawBatch = z.output<typeof DrawBatchSchema>;
export type DrawBatchWire = z.input<typeof DrawBatchSchema>;

// ---------------------------------------------------------------------------------------------
// BYOK providers

/** One stored provider key (`GET /api/providers`). */
export const ProviderKeyDtoSchema = z.object({
  provider: ByokProviderSchema,
  last4: z.string(),
  baseUrl: z.string().nullable(),
  createdAt: IntSchema,
  /** Last upstream auth failure seen with this key, if any. */
  lastError: z.string().nullable(),
});
export type ProviderKeyDto = z.output<typeof ProviderKeyDtoSchema>;

/** `GET /api/providers`: a bare array (SPEC §5.9). */
export const ProviderKeyListDtoSchema = z.array(ProviderKeyDtoSchema);
export type ProviderKeyListDto = z.output<typeof ProviderKeyListDtoSchema>;

/** Body of `PUT /api/providers/:provider` (`baseUrl` must be https; SSRF checks happen in the gateway). */
export const PutProviderKeyRequestSchema = z.object({
  apiKey: z.string().trim().min(8),
  baseUrl: z.url({ protocol: /^https$/ }).optional(),
});
export type PutProviderKeyRequest = z.output<typeof PutProviderKeyRequestSchema>;

/** `POST /api/providers/:provider/test`. */
export const ProviderTestDtoSchema = z.object({ ok: z.boolean(), model: z.string().nullable(), latencyMs: UintSchema, error: z.string().nullable() });
export type ProviderTestDto = z.output<typeof ProviderTestDtoSchema>;

// ---------------------------------------------------------------------------------------------
// Budgets (SPL delegation, SPEC §3.4)

/** One `budget_draws` row: an operator delegate burn settling `usageIds`. */
export const BudgetDrawDtoSchema = z.object({
  id: UintSchema,
  tokenAccount: AddressSchema,
  workspace: AddressSchema,
  tokenAmount: UintStringSchema,
  usdMicro: MicroSchema,
  receiptHash: Bytes32Schema,
  usageIds: z.array(z.string()),
  /** Set once the draw transaction was sent. */
  signature: SignatureSchema.nullable(),
  status: BudgetDrawStatusSchema,
  error: z.string().nullable(),
  createdAt: IntSchema,
  updatedAt: IntSchema,
});
export type BudgetDrawDto = z.output<typeof BudgetDrawDtoSchema>;
export type BudgetDrawDtoWire = z.input<typeof BudgetDrawDtoSchema>;

/** `GET /api/budgets/:tokenAccount/draws`: a bare array (SPEC §5.9). */
export const BudgetDrawListDtoSchema = z.array(BudgetDrawDtoSchema);
export type BudgetDrawListDto = z.output<typeof BudgetDrawListDtoSchema>;
export type BudgetDrawListDtoWire = z.input<typeof BudgetDrawListDtoSchema>;

/**
 * `GET /api/budgets[/:tokenAccount]`. Budget id = the token account; `cap` = `delegatedAmount`,
 * `balance` = the account's token amount, `headroomTokens = delegate == operator ?
 * min(cap, balance) : 0`, `headroomMicro` at the current price (0 while the price is stale).
 */
export const BudgetDtoSchema = z.object({
  tokenAccount: AddressSchema,
  owner: AddressSchema,
  workspace: AddressSchema,
  /** The account's current delegate (the operator while open; null / another key once revoked). */
  delegate: AddressSchema.nullable(),
  cap: UintStringSchema,
  balance: UintStringSchema,
  headroomTokens: UintStringSchema,
  headroomMicro: MicroSchema,
  closed: z.boolean(),
  stalledReason: BudgetStalledReasonSchema.nullable(),
  /** Unix milliseconds of `POST /api/budgets/register`, or null when the scanner found it. */
  registeredAt: IntSchema.nullable(),
  lastSeenSlot: UintSchema.nullable(),
  draws: z.array(BudgetDrawDtoSchema),
});
export type BudgetDto = z.output<typeof BudgetDtoSchema>;
export type BudgetDtoWire = z.input<typeof BudgetDtoSchema>;

/** `GET /api/budgets`: a bare array (SPEC §5.9). */
export const BudgetListDtoSchema = z.array(BudgetDtoSchema);
export type BudgetListDto = z.output<typeof BudgetListDtoSchema>;
export type BudgetListDtoWire = z.input<typeof BudgetListDtoSchema>;

/** Body of `POST /api/budgets/register`: the delegated token account; `workspace` to fund another workspace. */
export const RegisterBudgetRequestSchema = z.object({
  tokenAccount: AddressSchema,
  workspace: AddressSchema.optional(),
});
export type RegisterBudgetRequest = z.output<typeof RegisterBudgetRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Upgrades

/** One `upgrades` row (`GET /api/upgrades`, `POST /api/upgrades`). */
export const UpgradeDtoSchema = z.object({
  id: z.string(),
  workspace: AddressSchema,
  kind: UpgradeKindSchema,
  quantity: UintSchema,
  amountMicro: MicroSchema,
  startsAt: IntSchema,
  endsAt: IntSchema,
  createdAt: IntSchema,
});
export type UpgradeDto = z.output<typeof UpgradeDtoSchema>;
export type UpgradeDtoWire = z.input<typeof UpgradeDtoSchema>;

/** `GET /api/upgrades`: a bare array (SPEC §5.9). */
export const UpgradeListDtoSchema = z.array(UpgradeDtoSchema);
export type UpgradeListDto = z.output<typeof UpgradeListDtoSchema>;
export type UpgradeListDtoWire = z.input<typeof UpgradeListDtoSchema>;

/** `GET /api/upgrades/prices`. */
export const UpgradePricesDtoSchema = z.object({ pro: ProPriceDtoSchema, warmHourPriceMicro: MicroSchema });
export type UpgradePricesDto = z.output<typeof UpgradePricesDtoSchema>;
export type UpgradePricesDtoWire = z.input<typeof UpgradePricesDtoSchema>;

/** Body of `POST /api/upgrades` (`quantity`: pro periods or warm hours, 1–168). */
export const UpgradeRequestSchema = z.object({
  kind: UpgradeKindSchema,
  quantity: z.number().int().min(1).max(168).default(1),
});
export type UpgradeRequest = z.output<typeof UpgradeRequestSchema>;

// ---------------------------------------------------------------------------------------------
// Admin

/** Body of `POST /api/admin/credit`. */
export const AdminCreditRequestSchema = z.object({
  workspace: AddressSchema,
  amountMicro: MicroSchema,
  memo: z.string().max(200).optional(),
});
export type AdminCreditRequest = z.output<typeof AdminCreditRequestSchema>;

/** Body of `POST /api/admin/price` (a manual price point, SPEC §3.3). */
export const AdminPriceRequestSchema = z.object({ priceE18: UintStringSchema });
export type AdminPriceRequest = z.output<typeof AdminPriceRequestSchema>;

/** One row of `GET /api/admin/workspaces`. */
export const AdminWorkspaceDtoSchema = z.object({
  workspace: AddressSchema,
  plan: PlanSchema,
  planUntil: IntSchema.nullable(),
  balanceMicro: MicroSchema,
  createdAt: IntSchema,
  keys: UintSchema,
});
export type AdminWorkspaceDto = z.output<typeof AdminWorkspaceDtoSchema>;
