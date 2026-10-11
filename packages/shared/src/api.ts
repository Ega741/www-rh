/**
 * Dashboard API DTOs (SPEC §4.8, §5.9) as zod v4 schemas with inferred types.
 *
 * Monetary fields travel as decimal strings in JSON (`"amountMicro": "2500000"`) and parse to
 * `bigint`. For every `XDtoSchema` there are two types: `XDto` (parsed, bigint) and `XDtoWire`
 * (what the gateway serializes, strings). Use {@link serializeMicro} when building wire objects.
 *
 * Timestamps: off-chain `*At` fields are unix **milliseconds**; fields mirroring on-chain values
 * (`PriceDto.updatedAt`, `QuoteDto.updatedAt`, `BudgetDto.deadline`, `CreditEventDto.blockTime`)
 * are unix **seconds**, as on chain.
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

// ---------------------------------------------------------------------------------------------
// Primitives

/** Decimal integer string ↔ bigint (µUSD and other money; may be negative). */
export const MicroSchema = z.string().regex(/^-?\d+$/, 'expected a decimal integer string').transform((s) => BigInt(s));
/** Non-negative decimal integer string ↔ bigint (token amounts, `priceE18`, ids). */
export const UintStringSchema = z.string().regex(/^\d+$/, 'expected a non-negative decimal integer string').transform((s) => BigInt(s));
/** `0x` + 40 hex characters (any case). */
export const AddressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected an address');
/** `0x` + 64 hex characters (tx hash, block hash, receipt hash). */
export const Bytes32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'expected a 32-byte hex string');
/** Any `0x`-prefixed hex string. */
export const HexSchema = z.string().regex(/^0x[0-9a-fA-F]*$/, 'expected a hex string');
/** Non-negative integer. */
export const UintSchema = z.number().int().nonnegative();
/** Integer (timestamps may legitimately be any integer). */
export const IntSchema = z.number().int();

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
export const BudgetStalledReasonSchema = z.enum(['price', 'allowance', 'draw_failed']);
export const UpgradeKindSchema = z.enum(['pro', 'warm']);
export const PriceSourceKindSchema = z.enum(['manual', 'chainlink', 'unknown']);

/** Serializes a bigint money/amount field for the wire. */
export function serializeMicro(value: bigint): string {
  return value.toString();
}

// ---------------------------------------------------------------------------------------------
// Public routes

/** `GET /api/price`. `updatedAt` is unix seconds (on-chain). */
export const PriceDtoSchema = z.object({
  priceE18: UintStringSchema,
  updatedAt: UintSchema,
  stale: z.boolean(),
  /** Human decimal, e.g. `"0.0025"`. */
  usdPerToken: z.string(),
  /** Human decimal, e.g. `"400"`. */
  tokensPerUsd: z.string(),
  source: PriceSourceKindSchema,
  maxPriceAge: UintSchema,
});
export type PriceDto = z.output<typeof PriceDtoSchema>;
export type PriceDtoWire = z.input<typeof PriceDtoSchema>;

/** `GET /api/quote?tokens=|usdMicro=`. `updatedAt` is unix seconds. */
export const QuoteDtoSchema = z.object({
  tokens: UintStringSchema,
  usdMicro: UintStringSchema,
  priceE18: UintStringSchema,
  updatedAt: UintSchema,
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

/** Credit token summary used by status and config. */
export const TokenInfoDtoSchema = z.object({
  address: AddressSchema,
  symbol: z.string(),
  decimals: UintSchema,
  nativeBurn: z.boolean(),
});
export type TokenInfoDto = z.output<typeof TokenInfoDtoSchema>;

/** Indexer progress (SPEC §5.4). */
export const IndexerStatusDtoSchema = z.object({
  lastBlock: IntSchema,
  head: IntSchema,
  lagBlocks: IntSchema,
  lastEventAt: IntSchema.nullable(),
});
export type IndexerStatusDto = z.output<typeof IndexerStatusDtoSchema>;

/** Per-provider status in `GET /api/status`. */
export const ProviderStatusDtoSchema = z.object({ state: ProviderHealthStateSchema, configured: z.boolean() });
export type ProviderStatusDto = z.output<typeof ProviderStatusDtoSchema>;

/** `GET /api/status`. */
export const StatusDtoSchema = z.object({
  chainId: UintSchema,
  creditDesk: AddressSchema.nullable(),
  token: TokenInfoDtoSchema.nullable(),
  indexer: IndexerStatusDtoSchema,
  providers: z.record(ProviderSchema, ProviderStatusDtoSchema),
  house: z.object({ enabled: z.boolean(), warmUntil: IntSchema.nullable(), largeModel: z.string() }),
  operator: z.object({ enabled: z.boolean(), dryRun: z.boolean() }),
  version: z.string(),
});
export type StatusDto = z.output<typeof StatusDtoSchema>;
export type StatusDtoWire = z.input<typeof StatusDtoSchema>;

/** Pro plan pricing. */
export const ProPriceDtoSchema = z.object({ priceMicro: MicroSchema, days: UintSchema });

/** `GET /api/config`. */
export const ConfigDtoSchema = z.object({
  chainId: UintSchema,
  creditDesk: AddressSchema.nullable(),
  token: TokenInfoDtoSchema.nullable(),
  priceSource: AddressSchema.nullable(),
  /** Explorer base URL, or null (anvil). */
  explorer: z.string().nullable(),
  aliases: z.array(z.string()),
  markupBps: UintSchema,
  byokFeeBps: UintSchema,
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

/** Body of `POST /api/auth/verify`. */
export const VerifyRequestSchema = z.object({ message: z.string().min(1), signature: HexSchema });
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

/** One indexed `CreditPurchased` / `BudgetDrawn` event with explorer link (`GET /api/receipts`). */
export const CreditEventDtoSchema = z.object({
  txHash: Bytes32Schema,
  logIndex: UintSchema,
  kind: CreditEventKindSchema,
  receiptId: UintSchema,
  workspace: AddressSchema,
  /** `msg.sender` of the purchase; null for budget draws. */
  payer: AddressSchema.nullable(),
  tokenAmount: UintStringSchema,
  usdMicro: MicroSchema,
  priceE18: UintStringSchema,
  budgetId: UintSchema.nullable(),
  receiptHash: Bytes32Schema.nullable(),
  blockNumber: UintSchema,
  blockHash: Bytes32Schema,
  /** Unix seconds (block timestamp). */
  blockTime: UintSchema,
  explorerTxUrl: z.string().nullable(),
});
export type CreditEventDto = z.output<typeof CreditEventDtoSchema>;
export type CreditEventDtoWire = z.input<typeof CreditEventDtoSchema>;

/** `GET /api/receipts`. */
export const CreditEventListDtoSchema = z.object({ rows: z.array(CreditEventDtoSchema), nextBefore: IntSchema.nullable() });
export type CreditEventListDto = z.output<typeof CreditEventListDtoSchema>;

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
 * fields; `workspace` is the lowercase workspace id. Hashing the parsed (bigint) and the wire
 * (string) form gives the same digest.
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

/** `GET /api/receipts/:requestId`: the receipt plus its hash. */
export const ReceiptDtoSchema = UsageReceiptSchema.extend({ hash: Bytes32Schema });
export type ReceiptDto = z.output<typeof ReceiptDtoSchema>;
export type ReceiptDtoWire = z.input<typeof ReceiptDtoSchema>;

/** The batch a budget draw settles (SPEC §5.4); `receiptHash(batch)` is passed to `desk.draw`. */
export const DrawBatchSchema = z.object({
  v: z.literal(1),
  chainId: UintSchema,
  desk: AddressSchema,
  budgetId: UintSchema,
  workspace: AddressSchema,
  usageIds: z.array(z.string()),
  amountMicro: MicroSchema,
  priceE18: UintStringSchema,
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
// Budgets

/** One `budget_draws` row. */
export const BudgetDrawDtoSchema = z.object({
  id: UintSchema,
  budgetId: UintSchema,
  workspace: AddressSchema,
  tokenAmount: UintStringSchema,
  usdMicro: MicroSchema,
  receiptHash: Bytes32Schema,
  usageIds: z.array(z.string()),
  txHash: Bytes32Schema.nullable(),
  status: BudgetDrawStatusSchema,
  error: z.string().nullable(),
  createdAt: IntSchema,
  updatedAt: IntSchema,
});
export type BudgetDrawDto = z.output<typeof BudgetDrawDtoSchema>;
export type BudgetDrawDtoWire = z.input<typeof BudgetDrawDtoSchema>;

/** `GET /api/budgets[/:id]`. `deadline` is unix seconds (on-chain). */
export const BudgetDtoSchema = z.object({
  budgetId: UintSchema,
  owner: AddressSchema,
  workspace: AddressSchema,
  cap: UintStringSchema,
  drawn: UintStringSchema,
  remainingCap: UintStringSchema,
  headroomTokens: UintStringSchema,
  headroomMicro: MicroSchema,
  deadline: UintSchema,
  closed: z.boolean(),
  stalledReason: BudgetStalledReasonSchema.nullable(),
  draws: z.array(BudgetDrawDtoSchema),
});
export type BudgetDto = z.output<typeof BudgetDtoSchema>;
export type BudgetDtoWire = z.input<typeof BudgetDtoSchema>;

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

/** Body of `POST /api/admin/price`. */
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
