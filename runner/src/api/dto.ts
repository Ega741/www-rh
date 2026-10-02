/**
 * Database rows → §5 DTOs (`docs/SPEC.md` §5). Every field is present; unknown values are `null`.
 *
 * @module api/dto
 */
import {
  curvePhaseName,
  marketCapAtPrice,
  mindStatusName,
  modelById,
  ponsProgressBps,
  progressBps,
  type Draw,
  type DrawReceipt,
  type DrawReceiptObject,
  type LedgerEntry,
  type MindDetail,
  type MindSummary,
  type PonsMindInfo,
  type Thought,
  type Trade,
} from '@www-rh/shared';
import type { DrawRow, MindRow, PonsMindRow, ReceiptRow, ThoughtRow, TickRow, TradeRow } from '../db/repos.js';
import { microToUsd } from '../economics/budget.js';

type Hex = `0x${string}`;
const iso = (ms: number): string => new Date(ms).toISOString();
const isoOrNull = (ms: number | null): string | null => (ms === null ? null : iso(ms));

/** 24 h trading activity of one mind. */
export interface Activity24h {
  trades: number;
  volumeWei: bigint;
}

/** Gross ETH of a trade: `ethAmount` for buys, `ethAmount + fee` for sells. */
export function grossEth(t: Pick<TradeRow, 'is_buy' | 'eth_amount' | 'fee'>): bigint {
  return t.is_buy === 1 ? BigInt(t.eth_amount) : BigInt(t.eth_amount) + BigInt(t.fee);
}

/** Aggregates trades per token. */
export function activityByToken(trades: readonly TradeRow[]): Map<string, Activity24h> {
  const out = new Map<string, Activity24h>();
  for (const t of trades) {
    const a = out.get(t.token) ?? { trades: 0, volumeWei: 0n };
    a.trades += 1;
    a.volumeWei += grossEth(t);
    out.set(t.token, a);
  }
  return out;
}

const WAD = 10n ** 18n;

/**
 * Market cap and graduation progress. Curve: `price·TOTAL_SUPPLY/1e18` and `tokensSold/CURVE_SUPPLY`.
 * Pons: `price·supply/1e18` and `realQuoteReserve·10000/graduationThreshold` while bonding, 10000
 * once swept (§9.3).
 */
function marketOf(row: MindRow, pons: PonsMindRow | undefined): { marketCapWei: bigint; progressBps: number } {
  const price = BigInt(row.price_wei);
  if (row.venue !== 'pons') return { marketCapWei: marketCapAtPrice(price), progressBps: Number(progressBps(BigInt(row.tokens_sold))) };
  const supply = pons?.supply == null ? null : BigInt(pons.supply);
  const threshold = pons?.graduation_threshold == null ? null : BigInt(pons.graduation_threshold);
  return {
    marketCapWei: supply === null ? marketCapAtPrice(price) : (price * supply) / WAD,
    progressBps: row.phase >= 1 ? 10_000 : threshold === null ? 0 : Number(ponsProgressBps(BigInt(row.real_eth_reserve), threshold)),
  };
}

/** `MindDetail.pons` of a `pons_minds` row. */
export function ponsInfoDto(p: PonsMindRow): PonsMindInfo {
  return {
    curve: p.curve as Hex,
    account: p.account as Hex,
    deployer: p.deployer as Hex | null,
    launchConfigId: p.launch_config_id,
    feeBps: p.fee_bps,
    creatorTaxBps: p.creator_tax_bps,
    claimableWei: p.claimable,
    launchedHere: p.launched_here === 1,
    adopted: p.adopted === 1,
    poolId: (p.pool_id ?? p.registry_pool_id) as Hex | null,
  };
}

/** `MindSummary` of a row (`pons`: the mind's `pons_minds` row in Pons mode). */
export function mindSummaryDto(row: MindRow, activity: Activity24h | undefined, pons?: PonsMindRow): MindSummary {
  const market = marketOf(row, pons);
  return {
    token: row.token as Hex,
    name: row.name,
    symbol: row.symbol,
    creator: row.creator as Hex,
    metadataURI: row.metadata_uri,
    image: row.meta_image,
    modelId: row.model_id as Hex,
    model: modelById(row.model_id)?.id ?? null,
    venue: row.venue,
    status: mindStatusName(row.status),
    phase: curvePhaseName(row.phase),
    priceWei: row.price_wei,
    marketCapWei: market.marketCapWei.toString(10),
    progressBps: market.progressBps,
    realEthReserveWei: row.real_eth_reserve,
    tokensSold: row.tokens_sold,
    mindBalanceWei: row.mind_balance,
    lastTickAt: isoOrNull(row.last_tick_at),
    currentUrl: row.current_url,
    createdAt: iso(row.created_at),
    trades24h: activity?.trades ?? 0,
    volume24hWei: (activity?.volumeWei ?? 0n).toString(10),
  };
}

function parseLinks(json: string | null): MindDetail['links'] {
  const empty = { x: null, website: null, telegram: null };
  if (json === null) return empty;
  try {
    const v = JSON.parse(json) as Record<string, unknown>;
    const pick = (k: string): string | null => (typeof v[k] === 'string' ? (v[k] as string) : null);
    return { x: pick('x'), website: pick('website'), telegram: pick('telegram') };
  } catch {
    return empty;
  }
}

/** `MindDetail` of a row (`pons`: the mind's `pons_minds` row in Pons mode). */
export function mindDetailDto(row: MindRow, activity: Activity24h | undefined, pons?: PonsMindRow): MindDetail {
  const verified = row.meta_status === 'ok' && row.meta_persona_verified === 1;
  return {
    ...mindSummaryDto(row, activity, pons),
    personaHash: row.persona_hash as Hex,
    persona: verified ? row.meta_persona : null,
    personaVerified: verified,
    description: row.meta_description,
    links: parseLinks(row.meta_links),
    pool: row.pool as Hex | null,
    positionId: row.position_id,
    lastFrameAt: isoOrNull(row.last_frame_at),
    pons: pons === undefined ? null : ponsInfoDto(pons),
  };
}

/** `Trade` of a row. */
export function tradeDto(t: TradeRow): Trade {
  return {
    txHash: t.tx_hash as Hex,
    logIndex: t.log_index,
    blockNumber: t.block_number,
    timestamp: iso(t.timestamp),
    trader: t.trader as Hex,
    isBuy: t.is_buy === 1,
    ethAmountWei: t.eth_amount,
    tokenAmount: t.token_amount,
    feeWei: t.fee,
    priceWei: t.price_wei,
    realEthReserveWei: t.real_eth_reserve,
    tokensSold: t.tokens_sold,
  };
}

/** `Thought` of a row. */
export function thoughtDto(t: ThoughtRow): Thought {
  return { id: t.id, tickId: t.tick_id, kind: t.kind, text: t.text, createdAt: iso(t.created_at) };
}

/** `LedgerEntry` of a tick row. */
export function ledgerEntryDto(t: TickRow): LedgerEntry {
  return {
    tickId: t.id,
    startedAt: iso(t.started_at),
    model: t.served_model ?? t.requested_model,
    iterations: t.iterations,
    inputTokens: t.input_tokens,
    outputTokens: t.output_tokens,
    cacheReadTokens: t.cache_read_tokens,
    cacheWriteTokens: t.cache_write_tokens,
    costUsd: microToUsd(t.cost_usd_micro),
    stopReason: t.stop_reason,
    error: t.error,
    receiptHash: t.receipt_hash as Hex | null,
  };
}

/**
 * `DrawReceipt` of a receipt row. The internal `unknown` status (possibly broadcast, hash unknown)
 * is reported as `pending` — the §5 contract only knows pending / confirmed / failed / dry_run.
 */
export function drawReceiptDto(r: ReceiptRow): DrawReceipt {
  return {
    receiptHash: r.receipt_hash as Hex,
    status: r.status === 'unknown' ? 'pending' : r.status,
    txHash: r.tx_hash as Hex | null,
    createdAt: iso(r.created_at),
    receipt: JSON.parse(r.receipt_json) as DrawReceiptObject,
  };
}

/** `Draw` of an indexed `ComputeDrawn` row. */
export function drawDto(d: DrawRow): Draw {
  return { txHash: d.tx_hash as Hex, blockNumber: d.block_number, timestamp: iso(d.timestamp), amountWei: d.amount, receiptHash: d.receipt_hash as Hex };
}
