/**
 * Decodes launchpad logs (viem `parseEventLogs`) and applies them to the database inside the
 * caller's transaction. Each log is first recorded in `chain_events`, so re-applying a range is a
 * no-op (idempotent on `(tx_hash, log_index)`).
 *
 * @module indexer/apply
 */
import { parseEventLogs, type Log } from 'viem';
import { CURVE_SUPPLY, marketCap, mindLaunchpadAbi, priceOf } from '@www-rh/shared';
import type { Repos } from '../db/repos.js';
import type { IndexedEvent } from './events.js';
import type { RawLog } from './source.js';

/** Global counter keys in `indexer_state`. */
export const STATE_TOTAL_VOLUME = 'total_volume_wei';
export const STATE_TOTAL_FEES_TO_MINDS = 'total_fees_to_minds_wei';

/** Events whose rows carry a block timestamp. */
const TIMESTAMPED = new Set(['MindCreated', 'Trade', 'MindFunded', 'ComputeDrawn']);

/** Curve price and a float ETH market-cap sort key for a reserve state. */
export function curveMetrics(realEthReserve: bigint, tokensSold: bigint): { priceWei: string; mcapSort: number } {
  try {
    const state = { realEthReserve, tokensSold };
    return { priceWei: priceOf(state).toString(10), mcapSort: Number(marketCap(state)) / 1e18 };
  } catch {
    return { priceWei: '0', mcapSort: 0 };
  }
}

type Parsed = ReturnType<typeof parseEventLogs<typeof mindLaunchpadAbi>>[number];

/** Decodes raw logs, dropping logs outside the ABI; result is in `(blockNumber, logIndex)` order. */
export function decodeLaunchpadLogs(logs: readonly RawLog[]): { log: RawLog; parsed: Parsed }[] {
  const sorted = [...logs].sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
  const out: { log: RawLog; parsed: Parsed }[] = [];
  for (const log of sorted) {
    const [parsed] = parseEventLogs({ abi: mindLaunchpadAbi, logs: [log as unknown as Log], strict: true });
    if (parsed !== undefined) out.push({ log, parsed });
  }
  return out;
}

/** Block numbers whose timestamps {@link applyLogs} needs and the logs do not carry. */
export function blocksNeedingTimestamps(decoded: readonly { log: RawLog; parsed: Parsed }[]): bigint[] {
  const blocks = new Set<bigint>();
  for (const { log, parsed } of decoded) if (log.blockTimestamp === undefined && TIMESTAMPED.has(parsed.eventName)) blocks.add(log.blockNumber);
  return [...blocks];
}

/** Receives inconsistencies found while applying logs (logged as errors by the indexer). */
export type AnomalySink = (message: string, fields: Record<string, unknown>) => void;

/** Per-log context of the apply helpers. */
export interface ApplyContext {
  log: RawLog;
  txHash: string;
  blockNumber: number;
  /** Block time (unix ms) of the log. */
  ms(): number;
  onAnomaly: AnomalySink;
}

type A = `0x${string}`;
/** The venue-independent `MindCore` events (identical on `MindLaunchpad` and `PonsMindRegistry`). */
export type CoreEvent =
  | { eventName: 'MindCreated'; args: { token: A; creator: A; name: string; symbol: string; metadataURI: string; modelId: A; personaHash: A } }
  | { eventName: 'FeeAccrued'; args: { token: A; mindAmount: bigint; protocolAmount: bigint } }
  | { eventName: 'MindFunded'; args: { token: A; from: A; amount: bigint } }
  | { eventName: 'ComputeDrawn'; args: { token: A; amount: bigint; receiptHash: A } }
  | { eventName: 'MemoryAnchored'; args: { token: A; seq: bigint; contentHash: A; uri: string } }
  | { eventName: 'MindConfigUpdated'; args: { token: A; modelId: A; personaHash: A; metadataURI: string } }
  | { eventName: 'MindStatusChanged'; args: { token: A; status: number } }
  | { eventName: 'Harvested'; args: { token: A; ethOut: bigint; tokensBurned: bigint } };

/** Names of {@link CoreEvent}. */
export const CORE_EVENTS: ReadonlySet<string> = new Set(['MindCreated', 'FeeAccrued', 'MindFunded', 'ComputeDrawn', 'MemoryAnchored', 'MindConfigUpdated', 'MindStatusChanged', 'Harvested']);

/** Adds a signed delta to the indexed vault balance, reporting a balance that would go negative. */
export function addVaultBalance(repos: Repos, token: string, delta: bigint, event: string, ctx: Pick<ApplyContext, 'txHash' | 'onAnomaly'>): void {
  const r = repos.minds.addBalance(token, delta);
  if (r?.clampedFrom != null) ctx.onAnomaly('indexed vault balance would go negative; stored as 0 (missed vault change?)', { token, event, txHash: ctx.txHash, wouldBe: r.clampedFrom });
}

/**
 * Applies one `MindCore` event (shared by both venues) and returns its domain event.
 *
 * @param created price / venue of a newly created mind (curve: the initial curve price; pons: unknown until the curve is read).
 */
export function applyCoreEvent(repos: Repos, ev: CoreEvent, ctx: ApplyContext, created: { venue: 'pons' | 'curve'; priceWei: string; mcapSort: number }): IndexedEvent | null {
  const { log, txHash, blockNumber } = ctx;
  const base = { blockNumber, txHash };
  switch (ev.eventName) {
    case 'MindCreated': {
      const a = ev.args;
      const t = a.token.toLowerCase();
      repos.minds.insertCreated({
        token: t, creator: a.creator.toLowerCase(), name: a.name, symbol: a.symbol, metadataUri: a.metadataURI,
        modelId: a.modelId.toLowerCase(), personaHash: a.personaHash.toLowerCase(), blockNumber, logIndex: log.logIndex,
        createdAt: ctx.ms(), priceWei: created.priceWei, mcapSort: created.mcapSort, venue: created.venue,
      });
      return { type: 'mind:created', token: t, ...base };
    }
    case 'FeeAccrued': {
      const a = ev.args;
      const t = a.token.toLowerCase();
      repos.facts.insertFeeAccrual({ txHash, logIndex: log.logIndex, blockNumber, token: t, mindAmount: a.mindAmount.toString(10), protocolAmount: a.protocolAmount.toString(10) });
      addVaultBalance(repos, t, a.mindAmount, 'FeeAccrued', ctx);
      repos.state.addBigint(STATE_TOTAL_FEES_TO_MINDS, a.mindAmount);
      return { type: 'fee:accrued', token: t, mindAmount: a.mindAmount, ...base };
    }
    case 'MindFunded': {
      const a = ev.args;
      const t = a.token.toLowerCase();
      repos.facts.insertFunding({ txHash, logIndex: log.logIndex, blockNumber, timestamp: ctx.ms(), token: t, from: a.from.toLowerCase(), amount: a.amount.toString(10) });
      addVaultBalance(repos, t, a.amount, 'MindFunded', ctx);
      return { type: 'mind:funded', token: t, amount: a.amount, ...base };
    }
    case 'ComputeDrawn': {
      const a = ev.args;
      const t = a.token.toLowerCase();
      const receiptHash = a.receiptHash.toLowerCase();
      const at = ctx.ms();
      repos.facts.insertDraw({ tx_hash: txHash, log_index: log.logIndex, block_number: blockNumber, timestamp: at, token: t, amount: a.amount.toString(10), receipt_hash: receiptHash });
      addVaultBalance(repos, t, -a.amount, 'ComputeDrawn', ctx);
      // the receipt becomes confirmed together with the vault balance change (SPEC §4.1 settlement)
      const receipt = repos.ticks.receiptByHash(receiptHash);
      if (receipt !== undefined) {
        if (receipt.status === 'failed' || receipt.status === 'dry_run') {
          ctx.onAnomaly('ComputeDrawn for a receipt that was not live (possible double draw)', { token: t, receiptHash, status: receipt.status, txHash });
        }
        repos.ticks.updateReceipt(receipt.id, 'confirmed', txHash, null, at);
      }
      return { type: 'compute:drawn', token: t, amount: a.amount, receiptHash, ...base };
    }
    case 'MemoryAnchored': {
      const a = ev.args;
      const t = a.token.toLowerCase();
      const contentHash = a.contentHash.toLowerCase();
      repos.facts.insertAnchorLog({ txHash, logIndex: log.logIndex, blockNumber, token: t, seq: Number(a.seq), contentHash, uri: a.uri });
      const anchor = repos.memories.anchorByUri(t, a.uri);
      if (anchor !== undefined && anchor.content_hash === contentHash) repos.memories.updateAnchor(anchor.id, 'confirmed', txHash, null, Date.now());
      return { type: 'memory:anchored', token: t, seq: Number(a.seq), contentHash, uri: a.uri, ...base };
    }
    case 'MindConfigUpdated': {
      const a = ev.args;
      const t = a.token.toLowerCase();
      repos.minds.setConfig(t, a.modelId.toLowerCase(), a.personaHash.toLowerCase(), a.metadataURI);
      return { type: 'mind:config', token: t, ...base };
    }
    case 'MindStatusChanged': {
      const t = ev.args.token.toLowerCase();
      repos.minds.setStatus(t, ev.args.status);
      return { type: 'mind:status', token: t, status: ev.args.status, ...base };
    }
    case 'Harvested': {
      const a = ev.args;
      const t = a.token.toLowerCase();
      repos.facts.insertHarvest({ txHash, logIndex: log.logIndex, blockNumber, token: t, ethOut: a.ethOut.toString(10), tokensBurned: a.tokensBurned.toString(10) });
      return { type: 'harvested', token: t, ethOut: a.ethOut, ...base };
    }
  }
}

/**
 * Applies decoded launchpad logs (chain order) and returns the domain events of the newly applied ones.
 *
 * @param timestampOf block number → unix seconds (pre-fetched by the caller).
 * @param onAnomaly inconsistencies (a vault balance that would go negative, a `ComputeDrawn` for a
 *   receipt that had been released) — never silently swallowed.
 */
export function applyLogs(
  repos: Repos,
  decoded: readonly { log: RawLog; parsed: Parsed }[],
  timestampOf: (block: bigint) => bigint,
  onAnomaly: AnomalySink = () => undefined,
): IndexedEvent[] {
  const out: IndexedEvent[] = [];
  const initial = curveMetrics(0n, 0n);
  for (const { log, parsed } of decoded) {
    const args = parsed.args as { token?: string };
    const token = typeof args.token === 'string' ? args.token.toLowerCase() : null;
    const txHash = log.transactionHash.toLowerCase();
    const blockNumber = Number(log.blockNumber);
    if (!repos.chain.insertEvent(txHash, log.logIndex, blockNumber, parsed.eventName, token)) continue;
    const ctx: ApplyContext = { log, txHash, blockNumber, ms: () => Number(log.blockTimestamp ?? timestampOf(log.blockNumber)) * 1000, onAnomaly };
    const base = { blockNumber, txHash };
    if (CORE_EVENTS.has(parsed.eventName)) {
      const ev = applyCoreEvent(repos, parsed as unknown as CoreEvent, ctx, { venue: 'curve', ...initial });
      if (ev !== null) out.push(ev);
      continue;
    }

    switch (parsed.eventName) {
      case 'Trade': {
        const a = parsed.args;
        const t = a.token.toLowerCase();
        const m = curveMetrics(a.realEthReserve, a.tokensSold);
        const trade = {
          tx_hash: txHash, log_index: log.logIndex, block_number: blockNumber, timestamp: ctx.ms(), token: t, trader: a.trader.toLowerCase(),
          is_buy: a.isBuy ? 1 : 0, eth_amount: a.ethAmount.toString(10), token_amount: a.tokenAmount.toString(10), fee: a.fee.toString(10),
          real_eth_reserve: a.realEthReserve.toString(10), tokens_sold: a.tokensSold.toString(10), price_wei: m.priceWei,
        };
        repos.trades.insert(trade);
        repos.minds.applyTrade(t, { realEthReserve: trade.real_eth_reserve, tokensSold: trade.tokens_sold, priceWei: m.priceWei, mcapSort: m.mcapSort });
        // gross ETH: ethAmount for buys, ethAmount + fee for sells (SPEC §5)
        repos.state.addBigint(STATE_TOTAL_VOLUME, a.isBuy ? a.ethAmount : a.ethAmount + a.fee);
        out.push({ type: 'trade', token: t, trade, ...base });
        break;
      }
      case 'CurveCompleted': {
        const t = parsed.args.token.toLowerCase();
        const m = curveMetrics(parsed.args.realEthReserve, CURVE_SUPPLY);
        repos.minds.setComplete(t, parsed.args.realEthReserve.toString(10), m.priceWei, m.mcapSort);
        out.push({ type: 'curve:complete', token: t, ...base });
        break;
      }
      case 'CurveReopened': {
        // a post-grace sell reopened a Complete curve: phase is Bonding again; the reserve and price
        // follow from that sell's Trade log, which comes next in the same transaction
        const t = parsed.args.token.toLowerCase();
        repos.minds.setReopened(t);
        out.push({ type: 'curve:reopened', token: t, ...base });
        break;
      }
      case 'Graduated': {
        const a = parsed.args;
        const t = a.token.toLowerCase();
        repos.minds.setGraduated(t, a.pool.toLowerCase(), a.positionId.toString(10));
        out.push({ type: 'graduated', token: t, ...base });
        break;
      }
      default:
        // admin / OpenZeppelin events are recorded in chain_events only
        break;
    }
  }
  return out;
}
