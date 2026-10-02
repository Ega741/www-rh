/**
 * Log source abstraction for the indexer (`eth_blockNumber`, `eth_getLogs`, block timestamps),
 * with a viem implementation. Tests inject an in-memory fake.
 *
 * @module indexer/source
 */
import type { Address, Hex } from 'viem';
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

/** What the indexer needs from the chain. */
export interface LogSource {
  getBlockNumber(): Promise<bigint>;
  /** Logs emitted by `address` in `[fromBlock, toBlock]`, in chain order. */
  getLogs(address: Address, fromBlock: bigint, toBlock: bigint): Promise<RawLog[]>;
  /** Timestamp (seconds) of a block. */
  getBlockTimestamp(blockNumber: bigint): Promise<bigint>;
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

  async getBlockTimestamp(blockNumber: bigint): Promise<bigint> {
    const cached = this.#timestamps.get(blockNumber);
    if (cached !== undefined) return cached;
    const block = await this.client.getBlock({ blockNumber });
    if (this.#timestamps.size > 4096) this.#timestamps.clear();
    this.#timestamps.set(blockNumber, block.timestamp);
    return block.timestamp;
  }
}
