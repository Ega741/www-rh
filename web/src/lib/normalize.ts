/**
 * Normalisers from runner JSON (SPEC §5) to UI view models.
 *
 * Every payload is first validated with the shared zod schema (`@www-rh/shared/types`). A mismatch
 * is logged once per payload kind and the payload is then read leniently instead of being
 * rejected, so a runner/shared version skew degrades the UI instead of blanking it. Required
 * identity fields still throw {@link ShapeError}; optional fields degrade to `null`; pre-R11 field
 * names are accepted alongside the `…Wei` names.
 *
 * @module lib/normalize
 */
import {
  computeResponseSchema,
  healthResponseSchema,
  launchConfigResponseSchema,
  memorySchema,
  metadataUploadResponseSchema,
  mindDetailSchema,
  mindsResponseSchema,
  ponsAdoptionsResponseSchema,
  publicModelSchema,
  statsResponseSchema,
  thoughtSchema,
  tradeSchema,
} from '@www-rh/shared';
import type { Address, Hex } from 'viem';
import {
  ShapeError,
  asJson,
  isObject,
  mapValid,
  readAddress,
  readBigint,
  readBigintOr,
  readBoolean,
  readHash,
  readList,
  readNumber,
  readString,
  readText,
  readTime,
  requireAddress,
  requireString,
  type JsonObject,
} from './json';
import type {
  ComputeInfo,
  ComputeReceipt,
  CurvePhaseName,
  Health,
  LedgerEntry,
  Memory,
  MetadataUploadResult,
  MindDetail,
  MindLinks,
  MindStatusName,
  MindSummary,
  MindsPage,
  ModelInfo,
  PendingAdoption,
  PonsInfo,
  Stats,
  Thought,
  Trade,
  VenueName,
} from './types';
import type { PonsLaunchConfig, PonsLaunchSettings } from './pons/launch';

function obj(raw: unknown, what: string): Record<string, unknown> {
  if (!isObject(raw)) throw new ShapeError(`${what}: expected an object`);
  return raw;
}

/** Structural view of a zod schema (the web app does not depend on zod directly). */
export interface SafeParser {
  safeParse(value: unknown): { success: true } | { success: false; error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> } };
}

const warnedShapes = new Set<string>();

/**
 * Validates `raw` with a shared zod schema. Returns `true` when it matches; otherwise logs the
 * first issues once per `label` and returns `false` (callers keep rendering leniently).
 */
export function checkShape(schema: SafeParser, raw: unknown, label: string): boolean {
  const result = schema.safeParse(raw);
  if (result.success) return true;
  if (!warnedShapes.has(label)) {
    warnedShapes.add(label);
    const issues = result.error.issues.slice(0, 3).map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`);
    console.warn(`[www-rh] ${label} does not match the shared schema; rendering leniently.`, issues);
  }
  return false;
}

/** Maps any status value (R11 name or on-chain enum number) to a status name. */
export function toStatusName(value: unknown): MindStatusName {
  if (value === 'alive' || value === 0) return 'alive';
  if (value === 'paused' || value === 2) return 'paused';
  return 'dormant';
}

/** Venue name, or `null` when absent / unknown (SPEC §9.3). */
export function toVenueName(value: unknown): VenueName | null {
  return value === 'pons' || value === 'curve' ? value : null;
}

/** Maps any phase value (R11 name or on-chain enum number) to a phase name. */
export function toPhaseName(value: unknown): CurvePhaseName {
  if (value === 'complete' || value === 1) return 'complete';
  if (value === 'graduated' || value === 2) return 'graduated';
  return 'bonding';
}

const ZERO_HASH = `0x${'0'.repeat(64)}` as Hex;

/** `MindSummary`. */
export function normalizeMindSummary(raw: unknown): MindSummary {
  const o = obj(raw, 'mind');
  return {
    token: requireAddress(o, 'token', 'token', 'address'),
    name: requireString(o, 'name', 'name'),
    symbol: requireString(o, 'symbol', 'symbol'),
    creator: readAddress(o, 'creator') ?? ('0x0000000000000000000000000000000000000000' as Address),
    metadataURI: readString(o, 'metadataURI', 'metadataUri') ?? '',
    image: readText(o, 'image', 'imageUrl'),
    modelId: readHash(o, 'modelId') ?? ZERO_HASH,
    model: readText(o, 'model'),
    status: toStatusName(o['status']),
    phase: toPhaseName(o['phase']),
    priceWei: readBigintOr(o, 0n, 'priceWei'),
    marketCapWei: readBigintOr(o, 0n, 'marketCapWei'),
    progressBps: Math.min(10_000, Math.max(0, readNumber(o, 'progressBps') ?? 0)),
    realEthReserveWei: readBigintOr(o, 0n, 'realEthReserveWei', 'realEthReserve'),
    tokensSold: readBigintOr(o, 0n, 'tokensSold', 'tokensSoldWei'),
    mindBalanceWei: readBigintOr(o, 0n, 'mindBalanceWei', 'mindBalance'),
    lastTickAt: readTime(o, 'lastTickAt'),
    currentUrl: readText(o, 'currentUrl'),
    createdAt: readTime(o, 'createdAt') ?? 0,
    trades24h: readNumber(o, 'trades24h') ?? 0,
    volume24hWei: readBigintOr(o, 0n, 'volume24hWei', 'volume24h'),
    venue: toVenueName(o['venue']),
  };
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** `MindDetail.pons` (SPEC §9.3), or `null` when absent or without a curve / account. */
export function normalizePonsInfo(raw: unknown): PonsInfo | null {
  if (!isObject(raw)) return null;
  const curve = readAddress(raw, 'curve');
  const account = readAddress(raw, 'account');
  if (curve === null || account === null) return null;
  const deployer = readAddress(raw, 'deployer');
  return {
    curve,
    account,
    deployer: deployer === ZERO_ADDRESS ? null : deployer,
    launchConfigId: readBigint(raw, 'launchConfigId'),
    feeBps: readNumber(raw, 'feeBps'),
    creatorTaxBps: readNumber(raw, 'creatorTaxBps'),
    claimableWei: readBigintOr(raw, 0n, 'claimableWei', 'claimable'),
    launchedHere: readBoolean(raw, 'launchedHere') ?? false,
    adopted: readBoolean(raw, 'adopted') ?? false,
    left: readBoolean(raw, 'left') ?? false,
    poolId: readHash(raw, 'poolId'),
  };
}

/** One entry of `GET /api/minds/:token/adoptions` (SPEC §9.7). */
export function normalizePendingAdoption(raw: unknown): PendingAdoption {
  const o = obj(raw, 'adoption');
  const preparer = readAddress(o, 'preparer', 'creator');
  const account = readAddress(o, 'account');
  if (preparer === null || account === null) throw new ShapeError('adoption: missing preparer or account');
  return {
    preparer,
    account,
    modelId: readHash(o, 'modelId'),
    personaHash: readHash(o, 'personaHash'),
    metadataURI: readString(o, 'metadataURI', 'metadataUri'),
  };
}

/**
 * `GET /api/minds/:token/adoptions` → pending preparations (shared `ponsAdoptionsResponseSchema`:
 * a bare array; `{ items }` / `{ adoptions }` are accepted too).
 */
export function normalizePendingAdoptions(raw: unknown): PendingAdoption[] {
  checkShape(ponsAdoptionsResponseSchema, raw, 'GET /api/minds/:token/adoptions');
  return mapValid(readList(raw, 'items', 'adoptions'), normalizePendingAdoption, 'adoption');
}

function normalizeLinks(raw: unknown): MindLinks | null {
  if (!isObject(raw)) return null;
  const links: MindLinks = {};
  const x = readText(raw, 'x', 'twitter');
  const website = readText(raw, 'website', 'web');
  const telegram = readText(raw, 'telegram');
  if (x !== null) links.x = x;
  if (website !== null) links.website = website;
  if (telegram !== null) links.telegram = telegram;
  return Object.keys(links).length > 0 ? links : null;
}

/** `MindDetail`. Accepts metadata fields at the top level or under `metadata`. */
export function normalizeMindDetail(raw: unknown): MindDetail {
  checkShape(mindDetailSchema, raw, 'MindDetail');
  const o = obj(raw, 'mind');
  const meta = isObject(o['metadata']) ? o['metadata'] : {};
  const summary = normalizeMindSummary(o);
  const pool = readAddress(o, 'pool');
  return {
    ...summary,
    image: summary.image ?? readText(meta, 'image'),
    personaHash: readHash(o, 'personaHash') ?? ZERO_HASH,
    personaVerified: readBoolean(o, 'personaVerified'),
    pool: pool === '0x0000000000000000000000000000000000000000' ? null : pool,
    positionId: readBigint(o, 'positionId'),
    description: readText(o, 'description') ?? readText(meta, 'description'),
    persona: readText(o, 'persona') ?? readText(meta, 'persona'),
    links: normalizeLinks(o['links'] ?? meta['links']),
    lastFrameAt: readTime(o, 'lastFrameAt'),
    pons: normalizePonsInfo(o['pons']),
  };
}

/** `GET /api/minds` page (`{ items, nextCursor }` or a bare array). */
export function normalizeMindsPage(raw: unknown): MindsPage {
  checkShape(mindsResponseSchema, raw, 'GET /api/minds');
  const items = mapValid(readList(raw, 'items', 'minds'), normalizeMindSummary, 'mind');
  const cursor = isObject(raw) ? raw['nextCursor'] : null;
  return {
    items,
    nextCursor: typeof cursor === 'string' && cursor !== '' ? cursor : typeof cursor === 'number' ? String(cursor) : null,
  };
}

/** `Trade`. */
export function normalizeTrade(raw: unknown): Trade {
  checkShape(tradeSchema, raw, 'Trade');
  const o = obj(raw, 'trade');
  const txHash = readHash(o, 'txHash', 'transactionHash');
  if (txHash === null) throw new ShapeError('trade: missing txHash');
  return {
    txHash,
    logIndex: readNumber(o, 'logIndex') ?? 0,
    blockNumber: readNumber(o, 'blockNumber') ?? 0,
    timestamp: readTime(o, 'timestamp', 'createdAt', 'at') ?? 0,
    trader: requireAddress(o, 'trader', 'trader'),
    isBuy: readBoolean(o, 'isBuy') ?? readString(o, 'side') === 'buy',
    ethAmountWei: readBigintOr(o, 0n, 'ethAmountWei', 'ethAmount'),
    tokenAmount: readBigintOr(o, 0n, 'tokenAmount', 'tokenAmountWei'),
    feeWei: readBigintOr(o, 0n, 'feeWei', 'fee'),
    priceWei: readBigintOr(o, 0n, 'priceWei'),
  };
}

/** `Memory` (R7: kind ∈ note | finding). */
export function normalizeMemory(raw: unknown): Memory {
  checkShape(memorySchema, raw, 'Memory');
  const o = obj(raw, 'memory');
  const seq = readNumber(o, 'seq');
  if (seq === null) throw new ShapeError('memory: missing seq');
  const anchor = isObject(o['anchor']) ? o['anchor'] : {};
  return {
    seq,
    kind: readString(o, 'kind') === 'finding' ? 'finding' : 'note',
    content: requireString(o, 'content', 'content'),
    url: readText(o, 'url'),
    createdAt: readTime(o, 'createdAt', 'at') ?? 0,
    contentHash: readHash(o, 'contentHash'),
    anchorTx: readHash(o, 'anchorTx', 'anchorTxHash') ?? readHash(anchor, 'txHash', 'tx'),
    anchorUri: readText(o, 'anchorUri') ?? readText(anchor, 'uri'),
  };
}

/** `Thought` (R7: kind ∈ aloud | summary). */
export function normalizeThought(raw: unknown): Thought {
  checkShape(thoughtSchema, raw, 'Thought');
  const o = obj(raw, 'thought');
  return {
    id: readNumber(o, 'id') ?? 0,
    tickId: readNumber(o, 'tickId') ?? 0,
    kind: readString(o, 'kind') === 'summary' ? 'summary' : 'aloud',
    text: requireString(o, 'text', 'text'),
    createdAt: readTime(o, 'createdAt', 'at') ?? 0,
  };
}

function normalizeLedgerEntry(raw: unknown): LedgerEntry {
  const o = obj(raw, 'ledger entry');
  const micro = readNumber(o, 'costUsdMicro');
  const receiptHash = readHash(o, 'receiptHash');
  return {
    tickId: readNumber(o, 'tickId', 'id') ?? 0,
    model: readString(o, 'model') ?? 'unknown',
    inputTokens: readNumber(o, 'inputTokens') ?? 0,
    outputTokens: readNumber(o, 'outputTokens') ?? 0,
    cacheReadTokens: readNumber(o, 'cacheReadTokens') ?? 0,
    cacheWriteTokens: readNumber(o, 'cacheWriteTokens') ?? 0,
    costUsd: readNumber(o, 'costUsd') ?? (micro !== null ? micro / 1e6 : 0),
    iterations: readNumber(o, 'iterations'),
    stopReason: readText(o, 'stopReason'),
    error: readText(o, 'error'),
    receiptHash,
    settled: receiptHash !== null || readHash(o, 'settledTx', 'drawTx') !== null,
    startedAt: readTime(o, 'startedAt', 'createdAt', 'at'),
  };
}

/** Keys of the canonical draw receipt object (R2). */
export const RECEIPT_OBJECT_KEYS = ['token', 'fromTickId', 'toTickId', 'ticks', 'ethUsdPriceMicro', 'amountWei'] as const;

/**
 * Extracts the canonical receipt object (exactly the R2 keys, values as served) from a receipt
 * entry, looking at `entry.receipt` first and then at the entry itself.
 */
export function extractReceiptObject(entry: Record<string, unknown>): JsonObject | null {
  const source = isObject(entry['receipt']) ? entry['receipt'] : entry;
  const out: JsonObject = {};
  for (const key of RECEIPT_OBJECT_KEYS) {
    const value = asJson(source[key]);
    if (value === undefined || value === null) return null;
    out[key] = value;
  }
  return Array.isArray(out['ticks']) ? out : null;
}

/** One compute receipt (R2 / W6). */
export function normalizeReceipt(raw: unknown): ComputeReceipt {
  const o = obj(raw, 'receipt');
  const object = extractReceiptObject(o);
  const inner = isObject(o['receipt']) ? o['receipt'] : o;
  const receiptHash = readHash(o, 'receiptHash', 'hash');
  if (receiptHash === null) throw new ShapeError('receipt: missing receiptHash');
  const ticks = Array.isArray(inner['ticks']) ? inner['ticks'] : null;
  let costUsd: number | null = readNumber(o, 'costUsd');
  if (costUsd === null && ticks !== null) {
    costUsd = ticks.reduce<number>((sum, t) => sum + (isObject(t) ? (readNumber(t, 'costUsdMicro') ?? 0) : 0), 0) / 1e6;
  }
  return {
    receiptHash,
    status: readText(o, 'status'),
    txHash: readHash(o, 'txHash', 'drawTx', 'tx'),
    amountWei: readBigint(o, 'amountWei') ?? readBigint(inner, 'amountWei') ?? 0n,
    fromTickId: readNumber(o, 'fromTickId') ?? readNumber(inner, 'fromTickId'),
    toTickId: readNumber(o, 'toTickId') ?? readNumber(inner, 'toTickId'),
    tickCount: ticks !== null ? ticks.length : readNumber(o, 'tickCount', 'ticks'),
    costUsd,
    createdAt: readTime(o, 'createdAt', 'timestamp', 'settledAt'),
    object,
  };
}

/** `GET /api/minds/:token/compute` (receipts per R2; legacy `draws` accepted). */
export function normalizeCompute(raw: unknown): ComputeInfo {
  checkShape(computeResponseSchema, raw, 'GET /api/minds/:token/compute');
  const o = obj(raw, 'compute');
  const balanceUsd = readNumber(o, 'balanceUsd') ?? 0;
  const burnUsdPerHour = readNumber(o, 'burnUsdPerHour') ?? 0;
  const runway = o['runwayHours'];
  return {
    balanceWei: readBigintOr(o, 0n, 'balanceWei'),
    balanceUsd,
    burnUsdPerHour,
    runwayHours: typeof runway === 'number' && Number.isFinite(runway) ? runway : null,
    unsettledUsd: readNumber(o, 'unsettledUsd'),
    availableUsd: readNumber(o, 'availableUsd'),
    tickIntervalMs: readNumber(o, 'tickIntervalMs'),
    ledger: mapValid(readList(o['ledger']), normalizeLedgerEntry, 'ledger entry'),
    receipts: mapValid(readList(o['receipts'] ?? o['draws']), normalizeReceipt, 'receipt'),
  };
}

/** `GET /api/stats`. */
export function normalizeStats(raw: unknown): Stats {
  checkShape(statsResponseSchema, raw, 'GET /api/stats');
  const o = obj(raw, 'stats');
  return {
    minds: readNumber(o, 'minds') ?? 0,
    alive: readNumber(o, 'alive') ?? 0,
    graduated: readNumber(o, 'graduated') ?? 0,
    volumeWei: readBigintOr(o, 0n, 'totalVolumeWei', 'volumeTotalWei', 'volumeWei', 'volumeEthTotal'),
    feesToMindsWei: readBigintOr(o, 0n, 'totalFeesToMindsWei', 'feesToMindsWei', 'feesToMindsEth'),
  };
}

/** `GET /api/health`. */
export function normalizeHealth(raw: unknown): Health {
  checkShape(healthResponseSchema, raw, 'GET /api/health');
  const o = obj(raw, 'health');
  return {
    ok: readBoolean(o, 'ok') ?? false,
    chainId: readNumber(o, 'chainId'),
    launchpad: readAddress(o, 'launchpad'),
    lastIndexedBlock: readNumber(o, 'lastIndexedBlock'),
    headBlock: readNumber(o, 'headBlock'),
    activeMinds: readNumber(o, 'activeMinds'),
    dryRun: readBoolean(o, 'dryRun'),
    venue: toVenueName(o['venue']),
    registry: readAddress(o, 'registry'),
  };
}

function normalizeLaunchConfigItem(raw: unknown): PonsLaunchConfig {
  const o = obj(raw, 'launch config');
  const id = readBigint(o, 'id', 'launchConfigId');
  const supply = readBigint(o, 'supply');
  const phantomQuote = readBigint(o, 'phantomQuote', 'phantomQuoteWei');
  const graduationThreshold = readBigint(o, 'graduationThreshold', 'graduationThresholdWei');
  if (id === null || supply === null || phantomQuote === null || graduationThreshold === null) {
    throw new ShapeError('launch config: missing id, supply, phantomQuote or graduationThreshold');
  }
  return {
    id,
    supply,
    curveFeeBps: readNumber(o, 'curveFeeBps') ?? 0,
    phantomQuote,
    graduationThreshold,
    enabled: readBoolean(o, 'enabled') ?? true,
  };
}

/** `GET /api/launch-config` (SPEC §9.4). */
export function normalizeLaunchConfig(raw: unknown): PonsLaunchSettings {
  checkShape(launchConfigResponseSchema, raw, 'GET /api/launch-config');
  const o = obj(raw, 'launch config');
  const launchFee = readBigint(o, 'launchFee', 'launchFeeWei');
  if (launchFee === null) throw new ShapeError('launch config: missing launchFee');
  return {
    launchFee,
    configs: mapValid(readList(o['configs']), normalizeLaunchConfigItem, 'launch config'),
    maxCreatorTaxBps: readNumber(o, 'maxCreatorTaxBps') ?? 0,
    snipeTaxSeconds: readNumber(o, 'snipeTaxSeconds') ?? 15,
  };
}

/** `GET /api/models` item. */
export function normalizeModel(raw: unknown): ModelInfo {
  checkShape(publicModelSchema, raw, 'PublicModel');
  const o = obj(raw, 'model');
  const id = requireString(o, 'id', 'id');
  const hash = readHash(o, 'modelIdHash', 'modelId');
  if (hash === null) throw new ShapeError('model: missing modelIdHash');
  return {
    id,
    label: readString(o, 'label') ?? id,
    description: readString(o, 'description') ?? '',
    modelIdHash: hash,
    inputUsdPerMTok: readNumber(o, 'inputUsdPerMTok') ?? 0,
    outputUsdPerMTok: readNumber(o, 'outputUsdPerMTok') ?? 0,
    cacheReadUsdPerMTok: readNumber(o, 'cacheReadUsdPerMTok') ?? 0,
    cacheWriteUsdPerMTok: readNumber(o, 'cacheWriteUsdPerMTok') ?? 0,
    isDefault: readBoolean(o, 'isDefault') ?? false,
  };
}

/** `POST /api/metadata` response (R1). */
export function normalizeMetadataUpload(raw: unknown): MetadataUploadResult {
  checkShape(metadataUploadResponseSchema, raw, 'POST /api/metadata');
  const o = obj(raw, 'metadata upload');
  const uri = requireString(o, 'uri', 'uri');
  const personaHash = readHash(o, 'personaHash');
  if (personaHash === null) throw new ShapeError('metadata upload: missing personaHash');
  return { uri, hash: readString(o, 'hash') ?? '', personaHash };
}
