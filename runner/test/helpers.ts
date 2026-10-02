/**
 * Test helpers: in-memory repositories, launchpad log encoding, a fake log source, a fake tx queue
 * and a fixed-price ETH/USD source. No network.
 */
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex, type AbiEvent, type Address, type Hex } from 'viem';
import { mindLaunchpadAbi, modelIdToHash, personaHash } from '@www-rh/shared';
import { Repos } from '../src/db/repos.js';
import { Db } from '../src/db/sqlite.js';
import type { RawLog, LogSource } from '../src/indexer/source.js';
import { silentLogger } from '../src/log.js';
import type { LaunchpadWrite } from '../src/chain/launchpad.js';
import type { TxOutcome } from '../src/chain/txQueue.js';

export { silentLogger };

/** Fresh in-memory repositories. */
export function memoryRepos(): Repos {
  return new Repos(Db.open(':memory:'));
}

export const TOKEN = '0x1111111111111111111111111111111111111111' as Address;
export const TOKEN2 = '0x2222222222222222222222222222222222222222' as Address;
export const CREATOR = '0x3333333333333333333333333333333333333333' as Address;
export const LAUNCHPAD = '0x5fbdb2315678afecb367f032d93f642f64180aa3' as Address;
export const PERSONA = 'You love maps and old trains.';

type EventName = Extract<(typeof mindLaunchpadAbi)[number], { type: 'event' }>['name'];

/** Encodes a launchpad event as a raw log. */
export function encodeLog(eventName: EventName, args: Record<string, unknown>, at: { block: bigint; logIndex: number; tx?: Hex; timestamp?: bigint }): RawLog {
  const event = mindLaunchpadAbi.find((i) => i.type === 'event' && i.name === eventName) as AbiEvent;
  const indexed: Record<string, unknown> = {};
  for (const input of event.inputs) if (input.indexed === true && input.name !== undefined) indexed[input.name] = args[input.name];
  const topics = encodeEventTopics({ abi: [event], eventName, args: indexed } as Parameters<typeof encodeEventTopics>[0]) as Hex[];
  const dataInputs = event.inputs.filter((i) => i.indexed !== true);
  const data = encodeAbiParameters(dataInputs, dataInputs.map((i) => args[i.name as string]));
  const log: RawLog = {
    address: LAUNCHPAD,
    topics,
    data,
    blockNumber: at.block,
    transactionHash: at.tx ?? keccak256(toHex(`tx-${at.block}-${at.logIndex}`)),
    logIndex: at.logIndex,
  };
  if (at.timestamp !== undefined) log.blockTimestamp = at.timestamp;
  return log;
}

/** A `MindCreated` log for `token`. */
export function mindCreatedLog(token: Address, block: bigint, logIndex = 0, model = 'claude-opus-5-5'): RawLog {
  return encodeLog(
    'MindCreated',
    { token, creator: CREATOR, name: 'Mind', symbol: 'MIND', metadataURI: 'runner://metadata/' + 'ab'.repeat(32), modelId: modelIdToHash(model), personaHash: personaHash(PERSONA) },
    { block, logIndex },
  );
}

/** In-memory {@link LogSource}. */
export class FakeLogSource implements LogSource {
  head = 0n;
  logs: RawLog[] = [];
  calls: { from: bigint; to: bigint }[] = [];
  failNext = 0;

  async getBlockNumber(): Promise<bigint> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('rpc down');
    }
    return this.head;
  }

  async getLogs(_address: Address, fromBlock: bigint, toBlock: bigint): Promise<RawLog[]> {
    this.calls.push({ from: fromBlock, to: toBlock });
    return this.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
  }

  async getBlockTimestamp(blockNumber: bigint): Promise<bigint> {
    return 1_790_000_000n + blockNumber;
  }
}

/** A tx queue double recording every write. */
export class FakeQueue {
  readonly writes: { write: LaunchpadWrite; label: string }[] = [];
  outcome: (write: LaunchpadWrite) => TxOutcome = () => ({ kind: 'confirmed', hash: `0x${'aa'.repeat(32)}` });

  constructor(public dryRun = false) {}

  async enqueue(write: LaunchpadWrite, label: string): Promise<TxOutcome> {
    this.writes.push({ write, label });
    return this.dryRun ? { kind: 'dry_run' } : this.outcome(write);
  }
}

/** A controllable clock. */
export class FakeClock {
  constructor(public t = 1_790_000_000_000) {}
  now = (): number => this.t;
  advance(ms: number): void {
    this.t += ms;
  }
}
