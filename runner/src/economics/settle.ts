/**
 * Compute settlement (`docs/SPEC.md` §4.1 economics, §3.2 draw receipts).
 *
 * Eligible ticks (no receipt, or a failed one) are included greedily in `tickId` order while
 * `weiOfUsdMicro(Σ cost) <= cap`, `cap = min(mindBalanceWei, epochRemainingWei)`. If not even the
 * first tick fits and the cap is limited by the balance, that tick alone is settled for the whole
 * balance (the shortfall is absorbed by the operator); if the epoch limits, settlement waits for
 * the next epoch. The receipt row is inserted (`pending`, or `dry_run`) before `drawCompute` is
 * queued; it becomes `confirmed` when the indexer commits the matching `ComputeDrawn` log.
 *
 * @module economics/settle
 */
import type { Address, Hex } from 'viem';
import { canonicalJson, drawReceiptHash, type DrawReceiptObject } from '@www-rh/shared';
import type { TxQueue } from '../chain/txQueue.js';
import type { Repos, TickRow } from '../db/repos.js';
import type { Logger } from '../log.js';
import { epochRemainingWei, usdToMicro, weiOfUsdMicro } from './budget.js';
import type { EconomicsService } from './service.js';

/** Outcome of {@link Settler.settle}. */
export type SettleResult =
  | { kind: 'skipped'; reason: 'busy' | 'nothing' | 'below-threshold' | 'cap-zero' | 'epoch-limit' }
  | { kind: 'settled'; receiptHash: Hex; amountWei: bigint; status: 'dry_run' | 'pending' | 'failed'; txHash: Hex | null; error: string | null };

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

/** Pending receipts older than this without a matching indexed `ComputeDrawn` become `failed`. */
export const RECEIPT_RECONCILE_MS = 10 * 60_000;

/** Settles compute spend on-chain through the operator tx queue. */
export class Settler {
  readonly #busy = new Set<string>();

  constructor(
    private readonly repos: Repos,
    private readonly economics: EconomicsService,
    private readonly queue: TxQueue,
    private readonly policy: { drawThresholdUsd: number },
    private readonly log: Logger,
    private readonly onChange: (token: string) => void = () => undefined,
    private readonly now: () => number = Date.now,
  ) {}

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
    const eligible = this.repos.ticks.eligibleForSettlement(token, 1_000);
    if (eligible.length === 0) return { kind: 'skipped', reason: 'nothing' };
    const eligibleMicro = eligible.reduce((s, t) => s + t.cost_usd_micro, 0);
    if (!force && eligibleMicro < usdToMicro(this.policy.drawThresholdUsd)) return { kind: 'skipped', reason: 'below-threshold' };
    const ethUsdMicro = await this.economics.ethUsdMicro();
    const epoch = await this.economics.epochState(token);
    const balanceWei = BigInt(this.repos.minds.get(token)?.mind_balance ?? '0');
    const selection = selectTicks(eligible, balanceWei, epoch === null ? null : epochRemainingWei(epoch), ethUsdMicro);
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
    const outcome = await this.queue.enqueue({ functionName: 'drawCompute', args: [token as Address, selection.amountWei, receiptHash] }, `draw ${token}`);
    this.economics.invalidateEpoch(token);
    switch (outcome.kind) {
      case 'confirmed':
        // stays `pending` until the indexer commits the ComputeDrawn log (balance and unsettled move together)
        if (this.repos.ticks.receipt(id)?.status === 'pending') this.repos.ticks.updateReceipt(id, 'pending', outcome.hash, null, this.now());
        this.onChange(token);
        return { kind: 'settled', receiptHash, amountWei: selection.amountWei, status: 'pending', txHash: outcome.hash, error: null };
      case 'dry_run':
        this.repos.ticks.updateReceipt(id, 'dry_run', null, null, this.now());
        this.onChange(token);
        return { kind: 'settled', receiptHash, amountWei: selection.amountWei, status: 'dry_run', txHash: null, error: null };
      case 'reverted':
      case 'failed': {
        const error = outcome.kind === 'reverted' ? 'transaction reverted' : outcome.error;
        this.repos.ticks.updateReceipt(id, 'failed', outcome.hash, error, this.now());
        this.onChange(token);
        return { kind: 'settled', receiptHash, amountWei: selection.amountWei, status: 'failed', txHash: outcome.hash, error };
      }
    }
  }

  /**
   * Startup reconciliation: `pending` receipts are matched against indexed `ComputeDrawn` logs by
   * `receiptHash` (match → `confirmed`; none after 10 min → `failed`, ticks eligible again).
   */
  reconcile(): void {
    for (const r of this.repos.ticks.receiptsWithStatus('pending')) {
      const draw = this.repos.facts.drawByReceiptHash(r.receipt_hash);
      if (draw !== undefined) this.repos.ticks.updateReceipt(r.id, 'confirmed', draw.tx_hash, null, this.now());
      else if (this.now() - r.created_at >= RECEIPT_RECONCILE_MS) this.repos.ticks.updateReceipt(r.id, 'failed', null, 'no ComputeDrawn log after 10 min', this.now());
    }
  }
}
