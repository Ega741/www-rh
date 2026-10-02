/**
 * The operator transaction queue (`docs/SPEC.md` §4.1 `chain/txQueue.ts`): every operator
 * transaction is simulated, sent and awaited (60 s receipt timeout) before the next one starts, so
 * nonces never race. In dry run the queue only records the intent.
 *
 * @module chain/txQueue
 */
import type { Hex } from 'viem';
import { errorMessage, type Logger } from '../log.js';
import { revertName, type LaunchpadSender, type LaunchpadWrite } from './launchpad.js';

/** Outcome of a queued transaction. */
export type TxOutcome =
  | { kind: 'dry_run' }
  | { kind: 'confirmed'; hash: Hex }
  | { kind: 'reverted'; hash: Hex }
  /** Simulation revert, send failure or receipt timeout (`hash` set when the tx was broadcast). */
  | { kind: 'failed'; error: string; revert: string | null; hash: Hex | null };

/** Receipt wait timeout. */
export const TX_RECEIPT_TIMEOUT_MS = 60_000;

/** FIFO operator transaction queue. */
export class TxQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;
  #dryRunReason: string | null;

  /**
   * @param sender `null` puts the queue in dry-run mode.
   */
  constructor(
    private readonly sender: LaunchpadSender | null,
    private readonly log: Logger,
    dryRunReason: string | null = sender === null ? 'DRY_RUN' : null,
  ) {
    this.#dryRunReason = sender === null ? (dryRunReason ?? 'DRY_RUN') : dryRunReason;
  }

  /** Whether transactions are only recorded. */
  get dryRun(): boolean {
    return this.#dryRunReason !== null;
  }

  /** Switches to dry run (e.g. the operator key does not match `operator()`). */
  forceDryRun(reason: string): void {
    this.#dryRunReason = reason;
  }

  /** Queued + in-flight transactions. */
  get pending(): number {
    return this.#pending;
  }

  /** Enqueues `write`; resolves when it is confirmed, reverted, failed, or recorded (dry run). */
  enqueue(write: LaunchpadWrite, label: string): Promise<TxOutcome> {
    this.#pending++;
    const run = async (): Promise<TxOutcome> => {
      try {
        return await this.#execute(write, label);
      } finally {
        this.#pending--;
      }
    };
    const result = this.#tail.then(run, run);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  async #execute(write: LaunchpadWrite, label: string): Promise<TxOutcome> {
    if (this.#dryRunReason !== null || this.sender === null) {
      this.log.info(`dry run: would send ${write.functionName}`, { label, args: write.args, reason: this.#dryRunReason });
      return { kind: 'dry_run' };
    }
    let hash: Hex | null = null;
    try {
      hash = await this.sender.send(write);
      this.log.info(`sent ${write.functionName}`, { label, hash });
      const status = await this.sender.waitForReceipt(hash, TX_RECEIPT_TIMEOUT_MS);
      if (status === 'success') return { kind: 'confirmed', hash };
      this.log.warn(`${write.functionName} reverted`, { label, hash });
      return { kind: 'reverted', hash };
    } catch (err) {
      const revert = revertName(err) ?? null;
      const error = revert ?? errorMessage(err);
      this.log.warn(`${write.functionName} failed`, { label, error, hash });
      return { kind: 'failed', error, revert, hash };
    }
  }

  /** Waits until the queue is empty, at most `timeoutMs`. */
  async drain(timeoutMs: number): Promise<void> {
    await Promise.race([this.#tail, new Promise((resolve) => setTimeout(resolve, timeoutMs).unref())]);
  }
}
