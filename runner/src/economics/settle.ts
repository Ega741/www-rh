/**
 * Compute settlement (`docs/SPEC.md` §4.1 economics, §3.2 draw receipts).
 *
 * Eligible ticks (no receipt, or a `failed` one; in live mode also those of `dry_run` receipts) are
 * included greedily in `tickId` order while `weiOfUsdMicro(Σ cost) <= cap`,
 * `cap = min(mindBalanceWei, epochRemainingWei)` minus the amounts of the mind's live receipts. If
 * not even the first tick fits and the cap is limited by the balance, that tick alone is settled for
 * the whole balance (the shortfall is absorbed by the operator); if the epoch limits, settlement
 * waits for the next epoch. The receipt row is inserted (`pending`, or `dry_run`) before
 * `drawCompute` is queued, the signed transaction (hash, nonce, raw bytes) is persisted before it is
 * broadcast, and the receipt becomes `confirmed` when the indexer commits the matching
 * `ComputeDrawn` log.
 *
 * Receipt lifecycle (no double draw): any failure after the transaction may have been broadcast —
 * broadcast error, receipt timeout, transport error while polling, "already known" / "nonce too low"
 * — leaves the receipt `pending` with its tx hash (or `unknown` without one). Its ticks are released
 * (`failed`) only when the transaction is **proven** never mined: simulation revert or failure before
 * broadcast, a reverted receipt, or its nonce consumed by another transaction (observed twice, the
 * second time after the indexer passed the first observation without a matching `ComputeDrawn`).
 * {@link Settler.reconcile} (at startup and every 60 s) resolves live receipts by hash
 * (`eth_getTransactionReceipt`), by indexed `ComputeDrawn(receiptHash)`, or — without a hash —
 * through the operator nonce; still-minable transactions are re-broadcast with the exact same signed
 * bytes (same receipt, same amount, same hash).
 *
 * @module economics/settle
 */
import type { Address, Hex } from 'viem';
import { canonicalJson, drawReceiptHash, type DrawReceiptObject } from '@www-rh/shared';
import type { DrawChainView } from '../chain/launchpad.js';
import type { TxOutcome, TxQueue } from '../chain/txQueue.js';
import type { ReceiptRow, Repos, TickRow } from '../db/repos.js';
import { errorMessage, type Logger } from '../log.js';
import { epochRemainingWei, usdToMicro, weiOfUsdMicro } from './budget.js';
import type { EconomicsService } from './service.js';

/** Outcome of {@link Settler.settle}. */
export type SettleResult =
  | { kind: 'skipped'; reason: 'busy' | 'nothing' | 'below-threshold' | 'cap-zero' | 'epoch-limit' }
  | {
      kind: 'settled';
      receiptHash: Hex;
      amountWei: bigint;
      /** `pending` also covers "broadcast, outcome unknown" (the tx hash is then set). */
      status: 'dry_run' | 'pending' | 'unknown' | 'confirmed' | 'failed';
      txHash: Hex | null;
      error: string | null;
    };

/** Result of {@link selectTicks}. */
export interface Selection {
  ticks: TickRow[];
  amountWei: bigint;
}

/**
 * Greedy tick selection (pure; exported for tests).
 *
 * @returns the ticks and amount to draw, or the reason nothing is drawn.
 */
export function selectTicks(
  eligible: readonly TickRow[],
  balanceWei: bigint,
  epochRemainingWei: bigint | null,
  ethUsdMicro: number,
): Selection | { reason: 'nothing' | 'cap-zero' | 'epoch-limit' } {
  if (eligible.length === 0) return { reason: 'nothing' };
  const epochLimits = epochRemainingWei !== null && epochRemainingWei < balanceWei;
  const cap = epochLimits ? (epochRemainingWei as bigint) : balanceWei;
  if (cap === 0n) return { reason: 'cap-zero' };
  const chosen: TickRow[] = [];
  let micro = 0n;
  for (const t of eligible) {
    const next = micro + BigInt(t.cost_usd_micro);
    if (weiOfUsdMicro(next, ethUsdMicro) > cap) break;
    chosen.push(t);
    micro = next;
  }
  if (chosen.length === 0) {
    if (epochLimits) return { reason: 'epoch-limit' };
    return { ticks: [eligible[0] as TickRow], amountWei: balanceWei };
  }
  const want = weiOfUsdMicro(micro, ethUsdMicro);
  return { ticks: chosen, amountWei: want < cap ? want : cap };
}

/** Builds the §3.2 receipt object for `ticks`. */
export function buildReceipt(token: string, ticks: readonly TickRow[], ethUsdMicro: number, amountWei: bigint): DrawReceiptObject {
  const sorted = [...ticks].sort((a, b) => a.id - b.id);
  return {
    token: token.toLowerCase() as `0x${string}`,
    fromTickId: (sorted[0] as TickRow).id,
    toTickId: (sorted[sorted.length - 1] as TickRow).id,
    ticks: sorted.map((t) => ({
      tickId: t.id,
      model: t.served_model ?? t.requested_model,
      inputTokens: t.input_tokens,
      outputTokens: t.output_tokens,
      cacheReadTokens: t.cache_read_tokens,
      cacheWriteTokens: t.cache_write_tokens,
      costUsdMicro: t.cost_usd_micro,
    })),
    ethUsdPriceMicro: ethUsdMicro,
    amountWei: amountWei.toString(10),
  };
}

/** Reconciliation period of live receipts. */
export const RECEIPT_RECONCILE_INTERVAL_MS = 60_000;
/** Minimum spacing of the two observations of a "cannot be mined any more" proof. */
export const RECEIPT_PROOF_SPACING_MS = 30_000;
/** A broadcast, unmined transaction whose nonce is still free is re-broadcast after this long. */
export const RECEIPT_REBROADCAST_AFTER_MS = 120_000;

/** Optional settler dependencies / knobs. */
export interface SettlerOptions {
  /** Chain reads used to resolve live receipts; `null` = only indexed `ComputeDrawn` logs are used (nothing is ever released). */
  chain?: DrawChainView | null;
  proofSpacingMs?: number;
  rebroadcastAfterMs?: number;
}

type SettleQueue = Pick<TxQueue, 'enqueue' | 'dryRun'> & Partial<Pick<TxQueue, 'rebroadcast'>>;

/** Settles compute spend on-chain through the operator tx queue. */
export class Settler {
  readonly #busy = new Set<string>();
  /** Receipts whose transaction this process is sending right now (never reconciled meanwhile). */
  readonly #inFlight = new Set<number>();
  #reconciling: Promise<void> | null = null;
  #timer: NodeJS.Timeout | null = null;
  readonly #chain: DrawChainView | null;

  constructor(
    private readonly repos: Repos,
    private readonly economics: EconomicsService,
    private readonly queue: SettleQueue,
    private readonly policy: { drawThresholdUsd: number },
    private readonly log: Logger,
    private readonly onChange: (token: string) => void = () => undefined,
    private readonly now: () => number = Date.now,
    private readonly opts: SettlerOptions = {},
  ) {
    this.#chain = opts.chain ?? null;
  }

  /**
   * Settles `token` when its unreceipted spend reaches `DRAW_THRESHOLD_USD`, or whenever there is
   * any with `force` (before going Dormant, after a creator pause).
   */
  async settle(token: string, opts: { force?: boolean } = {}): Promise<SettleResult> {
    const key = token.toLowerCase();
    if (this.#busy.has(key)) return { kind: 'skipped', reason: 'busy' };
    this.#busy.add(key);
    try {
      return await this.#settle(key, opts.force === true);
    } finally {
      this.#busy.delete(key);
    }
  }

  async #settle(token: string, force: boolean): Promise<SettleResult> {
    const eligible = this.repos.ticks.eligibleForSettlement(token, 1_000, { includeDryRun: !this.queue.dryRun });
    if (eligible.length === 0) return { kind: 'skipped', reason: 'nothing' };
    const eligibleMicro = eligible.reduce((s, t) => s + t.cost_usd_micro, 0);
    if (!force && eligibleMicro < usdToMicro(this.policy.drawThresholdUsd)) return { kind: 'skipped', reason: 'below-threshold' };
    const ethUsdMicro = await this.economics.ethUsdMicro();
    const epoch = await this.economics.epochState(token);
    // live receipts may still be drawn: never count their amount twice against the vault / epoch
    const liveWei = this.repos.ticks.liveReceipts(token).reduce((s, r) => s + BigInt(r.amount_wei), 0n);
    const sub = (v: bigint): bigint => (v > liveWei ? v - liveWei : 0n);
    const balanceWei = sub(BigInt(this.repos.minds.get(token)?.mind_balance ?? '0'));
    const selection = selectTicks(eligible, balanceWei, epoch === null ? null : sub(epochRemainingWei(epoch)), ethUsdMicro);
    if ('reason' in selection) return { kind: 'skipped', reason: selection.reason };

    const receipt = buildReceipt(token, selection.ticks, ethUsdMicro, selection.amountWei);
    const receiptHash = drawReceiptHash(receipt);
    const at = this.now();
    const status = this.queue.dryRun ? 'dry_run' : 'pending';
    const id = this.repos.tx(() =>
      this.repos.ticks.insertReceipt(
        { token, receipt_hash: receiptHash.toLowerCase(), receipt_json: canonicalJson(receipt), amount_wei: receipt.amountWei, status, tx_hash: null, error: null, created_at: at, updated_at: at },
        selection.ticks.map((t) => t.id),
      ),
    );
    this.onChange(token);
    if (status === 'dry_run') {
      this.log.info('draw receipt recorded (dry run)', { token, receiptHash, amountWei: selection.amountWei });
      return { kind: 'settled', receiptHash, amountWei: selection.amountWei, status: 'dry_run', txHash: null, error: null };
    }
    return this.#send(id, token, receiptHash, selection.amountWei);
  }

  async #send(id: number, token: string, receiptHash: Hex, amountWei: bigint): Promise<SettleResult> {
    this.#inFlight.add(id);
    let outcome: TxOutcome;
    try {
      outcome = await this.queue.enqueue({ functionName: 'drawCompute', args: [token as Address, amountWei, receiptHash] }, `draw ${token}`, {
        // persisted before broadcast: after a crash the receipt can still be resolved by hash
        beforeBroadcast: (signed) => this.repos.ticks.markSigned(id, signed, this.now()),
      });
    } catch (err) {
      // the queue never rejects; be conservative anyway
      outcome = { kind: 'unknown', error: errorMessage(err), hash: null };
    } finally {
      this.#inFlight.delete(id);
    }
    this.economics.invalidateEpoch(token);
    const result = this.#applyOutcome(id, token, receiptHash, amountWei, outcome);
    this.onChange(token);
    return result;
  }

  #applyOutcome(id: number, token: string, receiptHash: Hex, amountWei: bigint, outcome: TxOutcome): SettleResult {
    const settled = (status: Extract<SettleResult, { kind: 'settled' }>['status'], txHash: Hex | null, error: string | null): SettleResult => ({ kind: 'settled', receiptHash, amountWei, status, txHash, error });
    const row = this.repos.ticks.receipt(id);
    if (row?.status === 'confirmed') return settled('confirmed', row.tx_hash as Hex | null, null); // the indexer was faster
    const stored = (row?.tx_hash ?? null) as Hex | null;
    const keepLive = (hash: Hex, error: string): SettleResult => {
      this.repos.ticks.updateReceipt(id, 'pending', hash, `outcome unknown: ${error}`, this.now());
      this.log.warn('draw outcome unknown: receipt kept pending until reconciled by hash', { token, receiptHash, hash, error });
      return settled('pending', hash, error);
    };
    switch (outcome.kind) {
      case 'confirmed':
        // stays `pending` until the indexer commits the ComputeDrawn log (balance and unsettled move together)
        this.repos.ticks.updateReceipt(id, 'pending', outcome.hash, null, this.now());
        return settled('pending', outcome.hash, null);
      case 'dry_run':
        this.repos.ticks.updateReceipt(id, 'dry_run', null, null, this.now());
        return settled('dry_run', null, null);
      case 'reverted':
        // a reverted transaction never draws and can never be mined again: proven
        this.repos.ticks.updateReceipt(id, 'failed', outcome.hash, 'transaction reverted', this.now());
        return settled('failed', outcome.hash, 'transaction reverted');
      case 'failed': {
        const hash = outcome.hash ?? stored;
        if (hash === null) {
          // never broadcast (simulation revert, preparation failure): ticks become eligible again
          this.repos.ticks.updateReceipt(id, 'failed', null, outcome.error, this.now());
          return settled('failed', null, outcome.error);
        }
        // a hash means it may have been broadcast: keep it live
        return keepLive(hash, outcome.error);
      }
      case 'unknown': {
        const hash = outcome.hash ?? stored;
        if (hash !== null) return keepLive(hash, outcome.error);
        this.repos.ticks.updateReceipt(id, 'unknown', null, `outcome unknown: ${outcome.error}`, this.now());
        this.log.warn('draw outcome unknown and no tx hash: receipt kept live until reconciled', { token, receiptHash, error: outcome.error });
        return settled('unknown', null, outcome.error);
      }
    }
  }

  /** Ticks of `dry_run` receipts that live mode will settle again (logged once at startup in live mode). */
  releaseDryRunForLive(): { ticks: number; receipts: number; costUsdMicro: number } {
    const r = this.repos.ticks.dryRunTickCount();
    if (r.ticks > 0) this.log.warn('live mode: ticks of dry-run receipts will be settled on-chain', r);
    return r;
  }

  /**
   * Resolves live (`pending` / `unknown`) receipts — at startup and every
   * {@link RECEIPT_RECONCILE_INTERVAL_MS}. Never releases ticks without proof that the transaction
   * cannot be mined.
   */
  reconcile(): Promise<void> {
    this.#reconciling ??= (async () => {
      try {
        for (const r of this.repos.ticks.receiptsWithStatus('pending', 'unknown')) {
          if (this.#inFlight.has(r.id)) continue;
          try {
            await this.#reconcileOne(r);
          } catch (err) {
            this.log.warn('receipt reconciliation failed; retrying on the next pass', { token: r.token, receiptHash: r.receipt_hash, error: errorMessage(err) });
          }
        }
      } finally {
        this.#reconciling = null;
      }
    })();
    return this.#reconciling;
  }

  /** Starts the periodic reconciliation. */
  startReconciler(intervalMs: number = RECEIPT_RECONCILE_INTERVAL_MS): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => void this.reconcile(), intervalMs);
    this.#timer.unref();
  }

  /** Stops the periodic reconciliation and waits for a running pass. */
  async stop(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await this.#reconciling?.catch(() => undefined);
  }

  #fail(r: ReceiptRow, error: string): void {
    this.repos.ticks.updateReceipt(r.id, 'failed', null, error, this.now());
    this.log.warn('draw receipt released for re-settlement (proven not mined)', { token: r.token, receiptHash: r.receipt_hash, txHash: r.tx_hash, reason: error });
    this.onChange(r.token);
  }

  async #reconcileOne(r: ReceiptRow): Promise<void> {
    const draw = this.repos.facts.drawByReceiptHash(r.receipt_hash);
    if (draw !== undefined) {
      this.repos.ticks.updateReceipt(r.id, 'confirmed', draw.tx_hash, null, this.now());
      this.onChange(r.token);
      return;
    }
    if (r.status === 'pending' && r.tx_hash === null) {
      // the signed hash is persisted before any broadcast: no hash and not in flight = never sent
      this.#fail(r, 'never broadcast (the runner stopped before sending it)');
      return;
    }
    const chain = this.#chain;
    if (chain === null) return; // nothing can be proven without chain access: stays live
    if (r.tx_hash !== null) await this.#reconcileByHash(r, r.tx_hash as Hex, chain);
    else await this.#reconcileWithoutHash(r, chain);
  }

  async #reconcileByHash(r: ReceiptRow, hash: Hex, chain: DrawChainView): Promise<void> {
    const mined = await chain.transactionReceipt(hash);
    if (mined !== null) {
      if (mined.status === 'reverted') {
        this.#fail(r, 'transaction reverted');
        return;
      }
      // success: drawCompute always emits ComputeDrawn — normally the indexer confirms it
      const indexed = this.repos.state.lastBlock();
      if (indexed !== undefined && indexed >= mined.blockNumber) {
        this.log.error('draw transaction mined but its ComputeDrawn log was not indexed; confirming from the receipt', { token: r.token, hash, block: mined.blockNumber });
        this.repos.ticks.updateReceipt(r.id, 'confirmed', hash, null, this.now());
        this.onChange(r.token);
      } else if (r.check_block !== null) this.repos.ticks.setReceiptCheck(r.id, { checkBlock: null, checkAt: null });
      return;
    }
    const nonce = r.tx_nonce ?? (await chain.transactionNonce(hash));
    if (nonce === null) {
      // legacy row without a stored nonce and a transaction this node does not know: use the nonce floor
      await this.#reconcileWithoutHash(r, chain);
      return;
    }
    const minedNonce = await chain.nonce('latest');
    if (minedNonce > nonce) {
      await this.#proveDead(r, chain, `nonce ${nonce} consumed by another transaction`);
      return;
    }
    if (r.check_block !== null) this.repos.ticks.setReceiptCheck(r.id, { checkBlock: null, checkAt: null });
    // still minable: re-send the exact same signed bytes now and then (same receipt, same hash)
    const since = r.broadcast_at ?? r.updated_at;
    if (r.raw_tx !== null && !this.queue.dryRun && this.queue.rebroadcast !== undefined && this.now() - since >= (this.opts.rebroadcastAfterMs ?? RECEIPT_REBROADCAST_AFTER_MS)) {
      const res = await this.queue.rebroadcast(r.raw_tx as Hex, `draw ${r.token} (re-broadcast)`);
      this.repos.ticks.markRebroadcast(r.id, this.now());
      this.log.info('re-broadcast pending draw transaction', { token: r.token, hash, nonce, result: typeof res === 'string' ? res : res.error });
    }
  }

  async #reconcileWithoutHash(r: ReceiptRow, chain: DrawChainView): Promise<void> {
    // any transaction an earlier attempt broadcast has a nonce below the operator's pending nonce
    // observed now; once every nonce below that floor is mined, the indexer tells whether it drew
    if (r.nonce_floor === null) {
      this.repos.ticks.setReceiptCheck(r.id, { nonceFloor: await chain.nonce('pending'), checkBlock: null, checkAt: null });
      return;
    }
    const minedNonce = await chain.nonce('latest');
    if (minedNonce < r.nonce_floor) {
      if (r.check_block !== null) this.repos.ticks.setReceiptCheck(r.id, { checkBlock: null, checkAt: null });
      return;
    }
    await this.#proveDead(r, chain, `operator nonce passed ${r.nonce_floor} without a ComputeDrawn for this receipt`);
  }

  /** Two-phase proof: the condition must hold at two passes, the second after the indexer passed the first one's head. */
  async #proveDead(r: ReceiptRow, chain: DrawChainView, reason: string): Promise<void> {
    if (r.check_block === null || r.check_at === null) {
      this.repos.ticks.setReceiptCheck(r.id, { checkBlock: Number(await chain.blockNumber()), checkAt: this.now() });
      return;
    }
    if (this.now() - r.check_at < (this.opts.proofSpacingMs ?? RECEIPT_PROOF_SPACING_MS)) return;
    const indexed = this.repos.state.lastBlock();
    if (indexed === undefined || indexed < BigInt(r.check_block)) return;
    if (this.repos.facts.drawByReceiptHash(r.receipt_hash) !== undefined) return; // confirmed on the next pass
    this.#fail(r, `not mined: ${reason}`);
  }
}
