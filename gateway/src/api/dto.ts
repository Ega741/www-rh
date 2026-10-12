/**
 * Wire DTO builders (SPEC §5.9) shared by the dashboard routes, the CLI and the in-process
 * `BeagleApi`. Every monetary value is serialized with `serializeMicro`; token amounts and
 * `priceE18` are decimal strings; addresses and signatures are base58 verbatim.
 *
 * @module api/dto
 */
import type {
  AdminWorkspaceDto,
  ApiKeyDto,
  BalanceDtoWire,
  BudgetDrawDtoWire,
  BudgetDtoWire,
  ConfigDtoWire,
  CreditEventDtoWire,
  DrawBatchWire,
  LedgerRowDtoWire,
  MeDtoWire,
  ModelDtoWire,
  ModelsDtoWire,
  ProviderKeyDto,
  StatusDtoWire,
  UsageListDtoWire,
  UsageRowDtoWire,
  UsageSummaryDtoWire,
} from '@beagle/shared/api';
import { serializeMicro } from '@beagle/shared/api';
import { SYSTEM_PROGRAM_ID } from '@beagle/shared/addresses';
import { explorerTxUrl } from '@beagle/shared/clusters';
import { ALIASES, ALIAS_DESCRIPTIONS, PROVIDERS, type ModelSpec, type Plan, type Provider } from '@beagle/shared/models';
import type { OpenAiModel, OpenAiModelList } from '@beagle/shared/openai';
import type { ApiKeyRow, BudgetDrawRow, BudgetRow, CreditEventRow, LedgerRow, ProviderKeyRow, UsageRow, WorkspaceRow } from '../db/repos.js';
import type { Services } from '../services.js';

/** `ApiKeyDto` (without the key). */
export function apiKeyDto(row: ApiKeyRow, key?: string): ApiKeyDto {
  return { id: row.id, prefix: row.prefix, name: row.name, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt, ...(key === undefined ? {} : { key }) };
}

/** `UsageRowDto`. */
export function usageRowDto(row: UsageRow): UsageRowDtoWire {
  return {
    id: row.id,
    workspace: row.workspace,
    apiKeyId: row.apiKeyId,
    endpoint: row.endpoint,
    requestedModel: row.requestedModel,
    servedModel: row.servedModel,
    provider: row.provider,
    tier: row.tier,
    paidBy: row.paidBy,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    upstreamCostMicro: serializeMicro(row.upstreamCostMicro),
    chargedMicro: serializeMicro(row.chargedMicro),
    status: row.status,
    httpStatus: row.httpStatus,
    errorCode: row.errorCode,
    latencyMs: row.latencyMs,
    routeReasons: row.routeReasons,
    stream: row.stream,
    difficulty: row.difficulty,
    drawId: row.drawId,
    createdAt: row.createdAt,
  };
}

/** `GET /api/usage`. */
export function usageListDto(services: Services, workspace: string, q: { limit: number; before?: number; model?: string; status?: 'ok' | 'error' }): UsageListDtoWire {
  const rows = services.repos.usage.list(workspace, q);
  const last = rows[rows.length - 1];
  return { rows: rows.map(usageRowDto), nextBefore: rows.length === q.limit && last !== undefined ? last.createdAt : null };
}

/** Window length in ms. */
export function windowMs(window: '24h' | '7d' | '30d'): number {
  return window === '24h' ? 86_400_000 : window === '7d' ? 7 * 86_400_000 : 30 * 86_400_000;
}

/** `GET /api/usage/summary`. */
export function usageSummaryDto(services: Services, workspace: string, window: '24h' | '7d' | '30d'): UsageSummaryDtoWire {
  const s = services.repos.usage.summary(workspace, services.now() - windowMs(window));
  return {
    window,
    requests: s.requests,
    chargedMicro: serializeMicro(s.chargedMicro),
    upstreamCostMicro: serializeMicro(s.upstreamCostMicro),
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    byModel: s.byModel.map((m) => ({ model: m.model, requests: m.requests, chargedMicro: serializeMicro(m.chargedMicro) })),
    byDay: s.byDay.map((d) => ({ day: d.day, requests: d.requests, chargedMicro: serializeMicro(d.chargedMicro) })),
  };
}

/** `LedgerRowDto`. */
export function ledgerRowDto(row: LedgerRow): LedgerRowDtoWire {
  return {
    id: row.id,
    workspace: row.workspace,
    kind: row.kind,
    amountMicro: serializeMicro(row.amountMicro),
    refType: row.refType,
    refId: row.refId,
    memo: row.memo,
    createdAt: row.createdAt,
  };
}

/** Explorer link of a signature on the configured cluster (localnet links carry the RPC URL). */
export function explorerLink(services: Services, signature: string): string {
  const info = services.chainInfo;
  return explorerTxUrl(info.cluster, signature, { rpcUrl: info.rpcUrl });
}

/** `CreditEventDto` with the explorer link. */
export function creditEventDto(services: Services, row: CreditEventRow): CreditEventDtoWire {
  return {
    signature: row.signature,
    ixIndex: row.ixIndex,
    slot: row.slot,
    blockTime: row.blockTime,
    kind: row.kind,
    workspace: row.workspace,
    payer: row.payer,
    tokenAccount: row.tokenAccount,
    tokenAmount: row.tokenAmount.toString(),
    usdMicro: serializeMicro(row.usdMicro),
    priceE18: row.priceE18.toString(),
    pricePointId: row.pricePointId,
    priceStale: row.priceStale,
    memo: row.memo,
    receiptHash: row.receiptHash,
    explorerUrl: explorerLink(services, row.signature),
  };
}

/** `BudgetDrawDto` plus the canonical `batch` whose `receiptHash` recomputes. */
export function budgetDrawDto(row: BudgetDrawRow): BudgetDrawDtoWire & { batch: DrawBatchWire | null } {
  let batch: DrawBatchWire | null = null;
  try {
    batch = JSON.parse(row.batchJson) as DrawBatchWire;
  } catch {
    batch = null;
  }
  return {
    id: row.id,
    tokenAccount: row.tokenAccount,
    workspace: row.workspace,
    tokenAmount: row.tokenAmount.toString(),
    usdMicro: serializeMicro(row.usdMicro),
    receiptHash: row.receiptHash,
    usageIds: row.usageIds,
    signature: row.signature,
    status: row.status,
    error: row.error,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    batch,
  };
}

/** `BudgetDto`. */
export function budgetDto(services: Services, row: BudgetRow): BudgetDtoWire {
  return {
    tokenAccount: row.tokenAccount,
    owner: row.owner,
    workspace: row.workspace,
    delegate: row.delegate,
    cap: row.cap.toString(),
    balance: row.balance.toString(),
    headroomTokens: row.headroomTokens.toString(),
    headroomMicro: serializeMicro(row.headroomMicro),
    closed: row.closed,
    stalledReason: row.stalledReason,
    registeredAt: row.registeredAt,
    lastSeenSlot: row.lastSeenSlot,
    draws: services.repos.budgetDraws.listByTokenAccount(row.tokenAccount).map(budgetDrawDto),
  };
}

/** `ProviderKeyDto`. */
export function providerKeyDto(row: ProviderKeyRow): ProviderKeyDto {
  return { provider: row.provider as ProviderKeyDto['provider'], last4: row.last4, baseUrl: row.baseUrl, createdAt: row.createdAt, lastError: row.lastError };
}

/** `GET /api/me`. */
export function meDto(services: Services, ws: WorkspaceRow): MeDtoWire {
  const { plan, planUntil } = services.repos.workspaces.effectivePlan(ws, services.now());
  const snap = services.ledger.snapshot(ws.owner);
  return {
    workspace: ws.owner,
    plan,
    planUntil,
    balanceMicro: serializeMicro(snap.balance),
    reservedMicro: serializeMicro(snap.reserved),
    budgetHeadroomMicro: serializeMicro(snap.budgetHeadroom),
    availableMicro: serializeMicro(snap.available),
    createdAt: ws.createdAt,
  };
}

/** `GET /api/balance`. */
export function balanceDto(services: Services, workspace: string): BalanceDtoWire {
  const ws = services.repos.workspaces.ensure(workspace, services.now());
  const { plan, planUntil } = services.repos.workspaces.effectivePlan(ws, services.now());
  const snap = services.ledger.snapshot(workspace);
  return {
    balanceMicro: serializeMicro(snap.balance),
    reservedMicro: serializeMicro(snap.reserved),
    budgetHeadroomMicro: serializeMicro(snap.budgetHeadroom),
    availableMicro: serializeMicro(snap.available),
    plan,
    planUntil,
    price: services.price.priceDto(),
  };
}

/** Whether `model` can be served right now for a workspace on `plan` (BYOK keys count as available). */
export function modelAvailability(services: Services, model: ModelSpec, plan: Plan, byok: readonly Provider[]): { available: boolean; providerState: 'ok' | 'degraded' | 'down' } {
  const state = services.health.state(model.provider);
  const hasKey = byok.includes(model.provider) || services.registry.platformConfigured(model.provider);
  const planOk = model.requiresPlan === undefined || model.requiresPlan === plan;
  const available = hasKey && planOk && (state !== 'down' || byok.includes(model.provider));
  return { available, providerState: hasKey ? state : 'down' };
}

/** One `ModelDto`. */
export function modelDto(services: Services, model: ModelSpec, plan: Plan, byok: readonly Provider[]): ModelDtoWire {
  const { available, providerState } = modelAvailability(services, model, plan, byok);
  return {
    id: model.id,
    provider: model.provider,
    upstreamId: model.upstreamId,
    displayName: model.displayName,
    tier: model.tier,
    contextWindow: model.contextWindow,
    maxOutput: model.maxOutput,
    price: { ...model.price },
    capabilities: { ...model.capabilities },
    autoEligible: model.autoEligible,
    ...(model.requiresPlan === undefined ? {} : { requiresPlan: model.requiresPlan }),
    ...(model.notes === undefined ? {} : { notes: model.notes }),
    available,
    providerState,
  };
}

/** `GET /api/models`. */
export function modelsDto(services: Services, plan: Plan = 'free', byok: readonly Provider[] = []): ModelsDtoWire {
  return {
    models: services.catalog.map((m) => modelDto(services, m, plan, byok)),
    aliases: ALIASES.map((id) => ({ id, description: ALIAS_DESCRIPTIONS[id] })),
  };
}

/** `GET /v1/models`. */
export function openAiModelList(services: Services, plan: Plan, byok: readonly Provider[], created = Math.floor(services.now() / 1000)): OpenAiModelList {
  const data: OpenAiModel[] = services.catalog.map((m) => {
    const { available } = modelAvailability(services, m, plan, byok);
    return {
      id: m.id,
      object: 'model',
      created,
      owned_by: m.provider,
      beagle: { tier: m.tier, price: { ...m.price }, available, requiresPlan: m.requiresPlan ?? null, alias: false },
    };
  });
  for (const alias of ALIASES) {
    data.push({ id: alias, object: 'model', created, owned_by: 'beagle', beagle: { tier: null, price: null, available: data.some((d) => d.beagle?.available === true), requiresPlan: null, alias: true } });
  }
  return { object: 'list', data };
}

/** The mint for DTOs: the all-zero key stands for "no mint configured" (`isUnsetAddress` in `@beagle/shared`). */
function mintOf(services: Services): string {
  return services.chainInfo.mint ?? SYSTEM_PROGRAM_ID;
}

/** `GET /api/status`. */
export function statusDto(services: Services): StatusDtoWire {
  const info = services.chainInfo;
  const providers = {} as Record<Provider, { state: 'ok' | 'degraded' | 'down'; configured: boolean }>;
  for (const p of PROVIDERS) providers[p] = { state: services.health.state(p), configured: services.registry.platformConfigured(p) };
  const large = services.catalog.find((m) => m.id === 'house/gpt-oss-120b');
  const solBalance = services.runtime.operatorSolBalance;
  return {
    cluster: info.cluster,
    mint: mintOf(services),
    token: { mint: mintOf(services), symbol: info.symbol, decimals: info.decimals, tokenProgram: info.tokenProgram },
    indexer: services.indexer?.status() ?? { lastSignature: null, lastSlot: null, headSlot: 0, lagSlots: 0, lastEventAt: null },
    price: services.price.priceDto(),
    providers,
    house: { enabled: services.config.providers.houseBaseUrl !== undefined, warmUntil: services.warm.warmUntil(), largeModel: large?.upstreamId ?? services.config.providers.houseModelLarge },
    operator: {
      address: info.operator ?? null,
      enabled: services.chain?.writer !== undefined && !services.config.operator.dryRun,
      dryRun: services.config.operator.dryRun,
      ...(solBalance === undefined ? {} : { solBalance: solBalance.toString() }),
    },
    version: services.version,
  };
}

/** `GET /api/config`. */
export function configDto(services: Services): ConfigDtoWire {
  const info = services.chainInfo;
  return {
    cluster: info.cluster,
    rpcUrl: info.rpcUrl,
    mint: mintOf(services),
    decimals: info.decimals,
    symbol: info.symbol,
    tokenProgram: info.tokenProgram,
    memoProgram: info.memoProgram,
    operator: info.operator ?? null,
    explorer: info.explorer,
    aliases: [...ALIASES],
    markupBps: services.config.economics.markupBps,
    byokFeeBps: services.config.economics.byokFeeBps,
    minCreditMicro: serializeMicro(services.config.price.minCreditMicro),
    pro: { priceMicro: serializeMicro(services.config.economics.proPriceMicro), days: services.config.economics.proDays },
    warmHourPriceMicro: serializeMicro(services.config.economics.warmHourPriceMicro),
  };
}

/** `GET /api/admin/workspaces` row. */
export function adminWorkspaceDto(services: Services, ws: WorkspaceRow): { [K in keyof AdminWorkspaceDto]: AdminWorkspaceDto[K] extends bigint ? string : AdminWorkspaceDto[K] } {
  const { plan, planUntil } = services.repos.workspaces.effectivePlan(ws, services.now());
  return { workspace: ws.owner, plan, planUntil, balanceMicro: serializeMicro(services.ledger.balance(ws.owner)), createdAt: ws.createdAt, keys: services.repos.apiKeys.countByWorkspace(ws.owner) };
}
