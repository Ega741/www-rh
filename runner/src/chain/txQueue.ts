/**
 * The operator transaction queue (`docs/SPEC.md` §4.1 `chain/txQueue.ts`): every operator
 * transaction is simulated, signed, broadcast and awaited (60 s receipt timeout) before the next one
 * starts, so nonces never race. In dry run the queue only records the intent.
 *
 * Outcomes distinguish what is *proven* from what is merely *unknown*:
 * - `failed` — the transaction was never broadcast (simulation revert, RPC failure while preparing
 *   or signing, or the `beforeBroadcast` hook threw);
 * - `unknown` — it may have been broadcast and may still be mined: broadcast errors (including
 *   "already known" / "nonce too low" on a retry), receipt-wait timeouts, transport errors while
 *   polling, or replacement. The hash is always known here because transactions are signed locally
 *   before broadcast; callers must keep their records live and resolve them later by hash;
 * - `confirmed` / `reverted` — the receipt was observed.
 *
 * Broadcast retries re-send the SAME signed bytes (same hash, same nonce), so a retry can never
 * create a second transaction.
 *
 * @module chain/txQueue
 */
import { BaseError, HttpRequestError, NonceTooLowError, TimeoutError, type Hex } from 'viem';
import { errorMessage, type Logger } from '../log.js';
import { sleep as defaultSleep } from '../util.js';
import { revertName, type LaunchpadSender, type LaunchpadWrite, type SignedTx } from './launchpad.js';

/** Outcome of a queued transaction. */
export type TxOutcome =
  | { kind: 'dry_run' }
  | { kind: 'confirmed'; hash: Hex }
  | { kind: 'reverted'; hash: Hex }
  /** Proven never broadcast (simulation revert, preparation / signing failure, cancelled broadcast). `hash` is always `null` from this queue. */
  | { kind: 'failed'; error: string; revert: string | null; hash: Hex | null }
  /** Possibly broadcast; the transaction may still be mined. `hash` when known. */
  | { kind: 'unknown'; error: string; hash: Hex | null };

/** Per-transaction hooks. */
export interface TxHooks {
  /**
   * Called with the signed transaction right before it is broadcast (persist the hash / nonce /
   * raw bytes here). Throwing cancels the broadcast: the outcome is `failed`.
   */
  beforeBroadcast?(signed: SignedTx): void;
}

/** Receipt wait timeout. */
export const TX_RECEIPT_TIMEOUT_MS = 60_000;
/** Broadcast attempts of one signed transaction (identical bytes). */
export const MAX_BROADCAST_ATTEMPTS = 3;

/** Every message in a viem error chain (for classification). */
function chainText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur !== undefined && cur !== null && depth < 8; depth++) {
    if (cur instanceof BaseError) parts.push(cur.shortMessage, cur.details ?? '');
    if (cur instanceof Error) parts.push(cur.message);
    cur = (cur as { cause?: unknown }).cause;
  }
  return parts.join(' | ');
}

/** The node already has this exact transaction (a previous attempt reached it). */
export function isAlreadyKnown(err: unknown): boolean {
  return /already known|known transaction|already imported|alreadyknown|transaction already exists/i.test(chainText(err));
}

/** The nonce was consumed — possibly by this very transaction on an earlier attempt. */
export function isNonceTooLow(err: unknown): boolean {
  if (err instanceof BaseError && err.walk((e) => e instanceof NonceTooLowError) instanceof NonceTooLowError) return true;
  return /nonce too low|nonce has already been used|oldnonce|lower than the current nonce/i.test(chainText(err));
}

/** Transport-level failures worth re-sending the same bytes for. */
export function isTransientRpcError(err: unknown): boolean {
  if (err instanceof BaseError && err.walk((e) => e instanceof HttpRequestError || e instanceof TimeoutError) !== null) return true;
  return /timed? ?out|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|fetch failed|network|502|503|504/i.test(chainText(err));
}

/** Options of {@link TxQueue}. */
export interface TxQueueOptions {
  receiptTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

type Job = { kind: 'write'; write: LaunchpadWrite; label: string; hooks: TxHooks } | { kind: 'rebroadcast'; raw: Hex; label: string };

/** FIFO operator transaction queue. */
export class TxQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #pending = 0;
  #dryRunReason: string | null;
  #closed = false;

  /**
   * @param sender `null` puts the queue in dry-run mode.
   */
  constructor(
    private readonly sender: LaunchpadSender | null,
    private readonly log: Logger,
    dryRunReason: string | null = sender === null ? 'DRY_RUN' : null,
    private readonly opts: TxQueueOptions = {},
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

  #run<T>(fn: () => Promise<T>): Promise<T> {
    this.#pending++;
    const run = async (): Promise<T> => {
      try {
        return await fn();
      } finally {
        this.#pending--;
      }
    };
    const result = this.#tail.then(run, run);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  /** Enqueues `write`; resolves when it is confirmed, reverted, failed, unknown, or recorded (dry run). */
  enqueue(write: LaunchpadWrite, label: string, hooks: TxHooks = {}): Promise<TxOutcome> {
    if (this.#closed) return Promise.resolve({ kind: 'failed', error: 'tx queue closed (shutting down)', revert: null, hash: null });
    return this.#run(() => this.#execute({ kind: 'write', write, label, hooks }) as Promise<TxOutcome>);
  }

  /**
   * Re-broadcasts an already signed transaction (identical bytes: it can only ever be mined once).
   * Runs in FIFO order with the other transactions.
   */
  rebroadcast(raw: Hex, label: string): Promise<'sent' | 'already-known' | 'skipped' | { error: string }> {
    if (this.#closed) return Promise.resolve('skipped');
    return this.#run(() => this.#execute({ kind: 'rebroadcast', raw, label }) as Promise<'sent' | 'already-known' | 'skipped' | { error: string }>);
  }

  async #broadcast(raw: Hex, label: string): Promise<{ ok: true; alreadyKnown: boolean } | { ok: false; error: unknown }> {
    const sender = this.sender as LaunchpadSender;
    const sleep = this.opts.sleep ?? ((ms: number) => defaultSleep(ms));
    let last: unknown = null;
    for (let attempt = 0; attempt < MAX_BROADCAST_ATTEMPTS; attempt++) {
      try {
        await sender.broadcast(raw);
        return { ok: true, alreadyKnown: false };
      } catch (err) {
        if (isAlreadyKnown(err)) return { ok: true, alreadyKnown: true };
        last = err;
        // "nonce too low": maybe this very transaction landed on an earlier attempt — the caller resolves it by hash
        if (isNonceTooLow(err) || !isTransientRpcError(err)) break;
        this.log.warn('broadcast failed; re-sending the same signed transaction', { label, attempt: attempt + 1, error: errorMessage(err) });
        await sleep(500 * 2 ** attempt);
      }
    }
    return { ok: false, error: last };
  }

  async #execute(job: Job): Promise<TxOutcome | 'sent' | 'already-known' | 'skipped' | { error: string }> {
    if (this.#dryRunReason !== null || this.sender === null) {
      if (job.kind === 'rebroadcast') return 'skipped';
      this.log.info(`dry run: would send ${job.write.functionName}`, { label: job.label, args: job.write.args, reason: this.#dryRunReason });
      return { kind: 'dry_run' };
    }
    if (job.kind === 'rebroadcast') {
      const r = await this.#broadcast(job.raw, job.label);
      if (r.ok) return r.alreadyKnown ? 'already-known' : 'sent';
      return { error: errorMessage(r.error) };
    }
    const { write, label, hooks } = job;
    let signed: SignedTx;
    try {
      signed = await this.sender.sign(write);
    } catch (err) {
      const revert = revertName(err) ?? null;
      const error = revert ?? errorMessage(err);
      this.log.warn(`${write.functionName} not sent`, { label, error });
      return { kind: 'failed', error, revert, hash: null };
    }
    try {
      hooks.beforeBroadcast?.(signed);
    } catch (err) {
      this.log.error(`${write.functionName} not broadcast: beforeBroadcast hook failed`, { label, error: errorMessage(err) });
      return { kind: 'failed', error: `not broadcast: ${errorMessage(err)}`, revert: null, hash: null };
    }
    const sent = await this.#broadcast(signed.raw, label);
    if (!sent.ok) {
      const error = errorMessage(sent.error);
      this.log.warn(`${write.functionName} broadcast outcome unknown`, { label, hash: signed.hash, nonce: signed.nonce, error });
      return { kind: 'unknown', error: `broadcast: ${error}`, hash: signed.hash };
    }
    this.log.info(`sent ${write.functionName}`, { label, hash: signed.hash, nonce: signed.nonce, alreadyKnown: sent.alreadyKnown });
    try {
      const status = await this.sender.waitForReceipt(signed.hash, this.opts.receiptTimeoutMs ?? TX_RECEIPT_TIMEOUT_MS);
      if (status === 'success') return { kind: 'confirmed', hash: signed.hash };
      this.log.warn(`${write.functionName} reverted`, { label, hash: signed.hash });
      return { kind: 'reverted', hash: signed.hash };
    } catch (err) {
      const error = errorMessage(err);
      this.log.warn(`${write.functionName} receipt not observed (may still be mined)`, { label, hash: signed.hash, error });
      return { kind: 'unknown', error: `receipt: ${error}`, hash: signed.hash };
    }
  }

  /** Waits until the queue is empty, at most `timeoutMs`. */
  async drain(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.#tail, new Promise((resolve) => (timer = setTimeout(resolve, timeoutMs)).unref())]);
    clearTimeout(timer);
  }

  /** Refuses new transactions (shutdown); queued ones still run. */
  close(): void {
    this.#closed = true;
  }
}
