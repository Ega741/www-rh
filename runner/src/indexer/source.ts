/**
 * Log source abstraction for the indexer (`eth_blockNumber`, `eth_getLogs`, block timestamps),
 * with a viem implementation. Tests inject an in-memory fake.
 *
 * @module indexer/source
 */
import { hexToBigInt, hexToNumber, toHex, type Address, type Hex } from 'viem';
import type { RunnerPublicClient } from '../chain/clients.js';

/** A raw (undecoded) mined log. */
export interface RawLog {
  address: Hex;
  topics: readonly Hex[];
  data: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
  /** Some RPCs (geth ≥ 1.14.x, Nitro) return `blockTimestamp` with logs. */
  blockTimestamp?: bigint;
}

/** Hash and parent hash of a block. */
export interface BlockHeader {
  hash: Hex;
  parentHash: Hex;
}

/** An `eth_getLogs` filter: one or several addresses, optional topic filters (`null` = any, array = OR). */
export interface LogFilter {
  address: Address | readonly Address[];
  topics?: readonly (Hex | readonly Hex[] | null)[];
  fromBlock: bigint;
  toBlock: bigint;
}

/** What the indexer needs from the chain. */
export interface LogSource {
  getBlockNumber(): Promise<bigint>;
  /** Logs emitted by `address` in `[fromBlock, toBlock]`, in chain order. */
  getLogs(address: Address, fromBlock: bigint, toBlock: bigint): Promise<RawLog[]>;
  /** Logs matching `filter` (Pons mode: address sets and indexed-topic filters). */
  getLogsFiltered(filter: LogFilter): Promise<RawLog[]>;
  /** Timestamp (seconds) of a block. */
  getBlockTimestamp(blockNumber: bigint): Promise<bigint>;
  /** Hash and parent hash of a block (never cached: used for reorg detection). Rejects when the node does not have the block. */
  getBlockHeader(blockNumber: bigint): Promise<BlockHeader>;
}

function toBigint(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  return undefined;
}

/** {@link LogSource} over a viem public client. */
export class ViemLogSource implements LogSource {
  readonly #timestamps = new Map<bigint, bigint>();

  constructor(private readonly client: RunnerPublicClient) {}

  getBlockNumber(): Promise<bigint> {
    return this.client.getBlockNumber({ cacheTime: 0 });
  }

  async getLogs(address: Address, fromBlock: bigint, toBlock: bigint): Promise<RawLog[]> {
    const logs = await this.client.getLogs({ address, fromBlock, toBlock });
    const out: RawLog[] = [];
    for (const log of logs) {
      if (log.blockNumber === null || log.transactionHash === null || log.logIndex === null) continue;
      const ts = toBigint((log as { blockTimestamp?: unknown }).blockTimestamp);
      const raw: RawLog = {
        address: log.address,
        topics: log.topics,
        data: log.data,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
      };
      if (ts !== undefined) raw.blockTimestamp = ts;
      out.push(raw);
    }
    return out;
  }

  async getLogsFiltered(filter: LogFilter): Promise<RawLog[]> {
    const rpc = (await this.client.request({
      method: 'eth_getLogs',
      params: [
        {
          address: (Array.isArray(filter.address) ? [...filter.address] : filter.address) as Address,
          topics: (filter.topics ?? []).map((t) => (t === null ? null : Array.isArray(t) ? [...t] : t)) as never,
          fromBlock: toHex(filter.fromBlock),
          toBlock: toHex(filter.toBlock),
        },
      ],
    })) as readonly { address: Hex; topics: Hex[]; data: Hex; blockNumber: Hex | null; transactionHash: Hex | null; logIndex: Hex | null; blockTimestamp?: unknown }[];
    const out: RawLog[] = [];
    for (const log of rpc) {
      if (log.blockNumber === null || log.transactionHash === null || log.logIndex === null) continue;
      const raw: RawLog = { address: log.address, topics: log.topics, data: log.data, blockNumber: hexToBigInt(log.blockNumber), transactionHash: log.transactionHash, logIndex: hexToNumber(log.logIndex) };
      const ts = toBigint(log.blockTimestamp);
      if (ts !== undefined) raw.blockTimestamp = ts;
      out.push(raw);
    }
    return out;
  }

  async getBlockTimestamp(blockNumber: bigint): Promise<bigint> {
    const cached = this.#timestamps.get(blockNumber);
    if (cached !== undefined) return cached;
    const block = await this.client.getBlock({ blockNumber });
    this.#remember(blockNumber, block.timestamp);
    return block.timestamp;
  }

  #remember(blockNumber: bigint, timestamp: bigint): void {
    if (this.#timestamps.size > 4096) this.#timestamps.clear();
    this.#timestamps.set(blockNumber, timestamp);
  }

  async getBlockHeader(blockNumber: bigint): Promise<BlockHeader> {
    const block = await this.client.getBlock({ blockNumber, includeTransactions: false });
    if (block.hash === null) throw new Error(`block ${blockNumber} is pending`);
    this.#remember(blockNumber, block.timestamp);
    return { hash: block.hash, parentHash: block.parentHash };
  }
}
