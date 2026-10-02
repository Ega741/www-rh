/**
 * Decodes launchpad logs and applies them to the database. Called inside one transaction per
 * batch; every log is first recorded in `chain_events`, so re-applying a batch is a no-op (R9).
 *
 * @module indexer/apply
 */
import { decodeEventLog, type Hex } from 'viem';
import { marketCap, mindLaunchpadAbi, priceOf } from '@www-rh/shared';
import type { Repos } from '../db/repos.js';
import { unixToIso } from '../util.js';
import type { IndexedEvent } from './events.js';
import type { RawLog } from './source.js';

/** Events whose rows carry a block timestamp. */
export const TIMESTAMPED_EVENTS: ReadonlySet<string> = new Set(['MindCreated', 'Trade', 'MindFunded', 'ComputeDrawn']);

type Decoded = ReturnType<typeof decodeEventLog<typeof mindLaunchpadAbi>>;

/** Decodes a launchpad log, or `undefined` for logs outside the ABI. */
export function decodeLaunchpadLog(log: RawLog): Decoded | undefined {
  if (log.topics.length === 0) return undefined;
  try {
    return decodeEventLog({ abi: mindLaunchpadAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
  } catch {
    return undefined;
  }
}

/** Curve price + display market cap (as a float ETH sort key) for a reserve state. */
export function curveMetrics(realEthReserve: bigint, tokensSold: bigint): { priceWei: string; mcapSort: number } {
  try {
    const state = { realEthReserve, tokensSold };
    return { priceWei: priceOf(state).toString(10), mcapSort: Number(marketCap(state)) / 1e18 };
  } catch {
    return { priceWei: '0', mcapSort: 0 };
  }
}

const STATE_CURRENT_GRADUATOR = 'current_graduator';
/** Global counter keys in `indexer_state`. */
export const STATE_VOLUME_TOTAL = 'volume_total_wei';
export const STATE_FEES_TO_MINDS = 'fees_to_minds_wei';

/**
 * Applies `logs` (chain order) and returns the domain events to emit after commit.
 *
 * @param timestampOf resolves a block number to unix seconds (pre-fetched by the caller).
 * @param liveFrom first block whose events are "live" (`null` = treat everything as history).
 */
export function applyLogs(repos: Repos, logs: readonly RawLog[], timestampOf: (block: bigint) => bigint, liveFrom: bigint | null): IndexedEvent[] {
  const out: IndexedEvent[] = [];
  for (const log of logs) {
    const decoded = decodeLaunchpadLog(log);
    if (decoded === undefined) continue;
    const args = decoded.args as Record<string, unknown>;
    const token = typeof args['token'] === 'string' ? (args['token'] as string).toLowerCase() : null;
    const txHash = log.transactionHash.toLowerCase();
    const blockNumber = Number(log.blockNumber);
    if (!repos.events.insertIfNew(txHash, log.logIndex, blockNumber, decoded.eventName, token)) continue;
    const live = liveFrom !== null && log.blockNumber >= liveFrom;
    const base = { blockNumber, txHash, live };
    const at = (): string => unixToIso(log.blockTimestamp ?? timestampOf(log.blockNumber));

    switch (decoded.eventName) {
      case 'MindCreated': {
        const a = decoded.args;
        const t = a.token.toLowerCase();
        const metrics = curveMetrics(0n, 0n);
        repos.minds.insertCreated({
          token: t,
          creator: a.creator.toLowerCase(),
          name: a.name,
          symbol: a.symbol,
          metadataUri: a.metadataURI,
          modelId: a.modelId.toLowerCase(),
          personaHash: a.personaHash.toLowerCase(),
          blockNumber,
          logIndex: log.logIndex,
          createdAt: at(),
          priceWei: metrics.priceWei,
          mcapSort: metrics.mcapSort,
        });
        out.push({ type: 'mind:created', token: t, ...base });
        break;
      }
      case 'Trade': {
        const a = decoded.args;
        const t = a.token.toLowerCase();
        const metrics = curveMetrics(a.realEthReserve, a.tokensSold);
        const timestamp = at();
        const trade = {
          tx_hash: txHash,
          log_index: log.logIndex,
          block_number: blockNumber,
          timestamp,
          token: t,
          trader: a.trader.toLowerCase(),
          is_buy: a.isBuy ? 1 : 0,
          eth_amount: a.ethAmount.toString(10),
          token_amount: a.tokenAmount.toString(10),
          fee: a.fee.toString(10),
          real_eth_reserve: a.realEthReserve.toString(10),
          tokens_sold: a.tokensSold.toString(10),
          price_wei: metrics.priceWei,
        };
        repos.trades.insert(trade);
        repos.minds.applyTrade(t, { realEthReserve: trade.real_eth_reserve, tokensSold: trade.tokens_sold, priceWei: metrics.priceWei, mcapSort: metrics.mcapSort, at: timestamp });
        repos.state.addBigint(STATE_VOLUME_TOTAL, a.ethAmount);
        out.push({ type: 'trade', token: t, trade, ...base });
        break;
      }
      case 'CurveCompleted': {
        const t = decoded.args.token.toLowerCase();
        repos.minds.setPhase(t, 1);
        out.push({ type: 'curve:complete', token: t, ...base });
        break;
      }
      case 'Graduated': {
        const a = decoded.args;
        const t = a.token.toLowerCase();
        repos.minds.setGraduated(t, a.pool.toLowerCase(), a.positionId.toString(10), repos.state.get(STATE_CURRENT_GRADUATOR) ?? null);
        out.push({ type: 'graduated', token: t, ...base });
        break;
      }
      case 'MindFunded': {
        const a = decoded.args;
        const t = a.token.toLowerCase();
        repos.facts.insertFunding({ txHash, logIndex: log.logIndex, blockNumber, timestamp: at(), token: t, from: a.from.toLowerCase(), amount: a.amount.toString(10) });
        repos.minds.addBalance(t, a.amount);
        out.push({ type: 'mind:funded', token: t, amount: a.amount, ...base });
        break;
      }
      case 'FeeAccrued': {
        const a = decoded.args;
        const t = a.token.toLowerCase();
        repos.facts.insertFeeAccrual({ txHash, logIndex: log.logIndex, blockNumber, token: t, mindAmount: a.mindAmount.toString(10), protocolAmount: a.protocolAmount.toString(10) });
        repos.minds.addBalance(t, a.mindAmount);
        repos.state.addBigint(STATE_FEES_TO_MINDS, a.mindAmount);
        break;
      }
      case 'ComputeDrawn': {
        const a = decoded.args;
        const t = a.token.toLowerCase();
        const timestamp = at();
        const receiptHash = a.receiptHash.toLowerCase();
        repos.facts.insertDraw({ tx_hash: txHash, log_index: log.logIndex, block_number: blockNumber, timestamp, token: t, amount: a.amount.toString(10), receipt_hash: receiptHash });
        repos.minds.addBalance(t, -a.amount);
        repos.compute.confirmByHash(receiptHash, txHash, timestamp);
        out.push({ type: 'draw', token: t, amount: a.amount, receiptHash, ...base });
        break;
      }
      case 'MemoryAnchored': {
        const a = decoded.args;
        const t = a.token.toLowerCase();
        const contentHash = a.contentHash.toLowerCase();
        repos.facts.insertAnchor({ txHash, logIndex: log.logIndex, blockNumber, token: t, seq: Number(a.seq), contentHash, uri: a.uri });
        repos.memories.confirmBatchByUri(t, a.uri, contentHash, txHash);
        out.push({ type: 'anchor', token: t, seq: Number(a.seq), contentHash, uri: a.uri, ...base });
        break;
      }
      case 'MindConfigUpdated': {
        const a = decoded.args;
        const t = a.token.toLowerCase();
        repos.minds.setConfig(t, a.modelId.toLowerCase(), a.personaHash.toLowerCase(), a.metadataURI);
        out.push({ type: 'mind:config', token: t, ...base });
        break;
      }
      case 'MindStatusChanged': {
        const a = decoded.args;
        const t = a.token.toLowerCase();
        repos.minds.setStatus(t, a.status);
        out.push({ type: 'mind:status', token: t, status: a.status, ...base });
        break;
      }
      case 'Harvested': {
        const a = decoded.args;
        const t = a.token.toLowerCase();
        repos.facts.insertHarvest({ txHash, logIndex: log.logIndex, blockNumber, token: t, ethOut: a.ethOut.toString(10), tokensBurned: a.tokensBurned.toString(10) });
        out.push({ type: 'harvested', token: t, ethOut: a.ethOut, ...base });
        break;
      }
      case 'GraduatorUpdated': {
        repos.state.set(STATE_CURRENT_GRADUATOR, decoded.args.graduator.toLowerCase());
        break;
      }
      default:
        // Admin / OpenZeppelin events are recorded in chain_events only.
        break;
    }
  }
  return out;
}

/** Block numbers whose timestamps `applyLogs` will need and the logs do not carry. */
export function blocksNeedingTimestamps(logs: readonly RawLog[]): bigint[] {
  const blocks = new Set<bigint>();
  for (const log of logs) {
    if (log.blockTimestamp !== undefined) continue;
    const decoded = decodeLaunchpadLog(log);
    if (decoded !== undefined && TIMESTAMPED_EVENTS.has(decoded.eventName)) blocks.add(log.blockNumber);
  }
  return [...blocks];
}
