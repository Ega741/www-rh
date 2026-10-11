/**
 * Budget drawer (SPEC §5.4): for every workspace whose `balance − reserved` is negative and that has
 * an open non-stalled budget, settles unsettled credit-paid usage rows against the budget with the
 * largest headroom: `DrawBatch` → `receiptHash` → `budget_draws(pending)` → `desk.draw(...)` →
 * `sent` → wait for the receipt. Confirmation and the ledger credit come from the indexer only.
 *
 * Two liveness rules keep the row state honest about the chain:
 * - A receipt **timeout** (or RPC failure while waiting) is not a failure: the transaction is still in
 *   the mempool, so the row stays `sent` with its usage rows marked and the indexer confirms it when
 *   it lands. Only a definitive revert (or a failed send) marks the row `failed` and un-marks rows.
 * - `reconcile()` runs at the start of every tick (so also on boot): a `pending` row without a tx
 *   hash left by a crash fails after a grace period; a `sent` row is checked against the chain —
 *   reverted → failed, mined → left for the indexer, unknown for a long time → failed.
 *
 * @module chain/drawer
 */
import type { DrawBatchWire } from '@beagle/shared/api';
import { receiptHash } from '@beagle/shared/canonical';
import { tokensForUsdMicro } from '@beagle/shared/credit';
import type { Address, Hex } from 'viem';
import type { BudgetDrawRow, BudgetRow, Repos, UsageRow } from '../db/repos.js';
import type { Logger } from '../log.js';
import type { ChainReader, ChainWriter } from './clients.js';

/** Options of {@link BudgetDrawer}. */
export interface DrawerOptions {
  chainId: number;
  creditDesk: Address;
  decimals: number;
  /** Draw once the deficit reaches this (µUSD). */
  thresholdMicro: bigint;
  /** Also draw when the budget expires within this window (default 1 h). */
  expiryWindowSec?: number;
  /** `waitForTransactionReceipt` timeout (default 120 s). */
  receiptTimeoutMs?: number;
  /** Max usage rows per batch (default 500). */
  maxRows?: number;
  /** A `pending` row without a tx hash older than this is a crash leftover → failed (default 10 min). */
  pendingGraceMs?: number;
  /** A `sent` row whose transaction the node has not seen for this long → failed (default 60 min). */
  sentGraceMs?: number;
  dryRun: boolean;
  now?: () => number;
}

/** Default {@link DrawerOptions.pendingGraceMs}. */
export const PENDING_GRACE_MS = 10 * 60_000;
/** Default {@link DrawerOptions.sentGraceMs}. */
export const SENT_GRACE_MS = 60 * 60_000;

/** What one tick did for one workspace. */
export interface DrawAttempt {
  workspace: string;
  budgetId: number;
  drawId: number | undefined;
  amountMicro: bigint;
  tokens: bigint;
  status: 'sent' | 'confirmed' | 'failed' | 'skipped' | 'dry_run';
  txHash?: Hex;
  error?: string;
}

/**
 * Picks the usage rows of one batch: oldest first until `Σ ≥ deficit`, never above `headroomMicro`.
 * A row that does not fit the remaining headroom is skipped (not a stop), so one oversized row never
 * shadows the smaller rows behind it.
 */
export function selectBatch(rows: readonly UsageRow[], deficit: bigint, headroomMicro: bigint): { usageIds: string[]; amountMicro: bigint } | undefined {
  const usageIds: string[] = [];
  let amount = 0n;
  for (const row of rows) {
    if (amount >= deficit) break;
    if (amount + row.chargedMicro > headroomMicro) continue;
    usageIds.push(row.id);
    amount += row.chargedMicro;
  }
  if (usageIds.length === 0 || amount <= 0n) return undefined;
  return { usageIds, amountMicro: amount };
}

/** The drawer. */
export class BudgetDrawer {
  private readonly now: () => number;
  private running = false;

  constructor(
    private readonly repos: Repos,
    private readonly reader: ChainReader,
    private readonly writer: ChainWriter | undefined,
    private readonly options: DrawerOptions,
    private readonly logger: Logger,
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  /** One pass: reconcile leftovers, then draw for every workspace in deficit. */
  async tick(): Promise<DrawAttempt[]> {
    if (this.running) return [];
    this.running = true;
    try {
      await this.reconcile();
      const now = this.now();
      const nowSec = Math.floor(now / 1000);
      const out: DrawAttempt[] = [];
      for (const { workspace, deficit } of this.repos.ledger.workspacesInDeficit(now)) {
        const budgets = this.repos.budgets.listDrawable(workspace, nowSec);
        if (budgets.length === 0) continue;
        const best = budgets[0] as BudgetRow;
        const expiresSoon = best.deadline - nowSec <= (this.options.expiryWindowSec ?? 3600);
        if (deficit < this.options.thresholdMicro && !expiresSoon) continue;
        const attempt = await this.drawFor(workspace, deficit, best);
        if (attempt !== undefined) out.push(attempt);
      }
      return out;
    } finally {
      this.running = false;
    }
  }

  /**
   * Marks `draw` failed and releases its usage rows — unless the indexer confirmed it in the meantime
   * (a confirmed draw is never rewritten). Returns whether the row changed.
   */
  private fail(draw: Pick<BudgetDrawRow, 'id' | 'budgetId' | 'usageIds' | 'workspace'>, error: string): boolean {
    const t = this.now();
    return this.repos.transaction(() => {
      const current = this.repos.budgetDraws.get(draw.id);
      if (current === undefined || (current.status !== 'pending' && current.status !== 'sent')) return false;
      this.repos.budgetDraws.setStatus(draw.id, 'failed', t, { error });
      this.repos.usage.clearDrawId(draw.usageIds, draw.id);
      this.repos.budgets.setStalled(draw.budgetId, 'draw_failed', t);
      this.logger.error('drawer: draw failed', { workspace: draw.workspace, budgetId: draw.budgetId, drawId: draw.id, error });
      return true;
    });
  }

  /**
   * Resolves `pending`/`sent` rows this process is not waiting on (crash leftovers, interrupted
   * receipt waits, dropped transactions). Public for tests; `tick()` calls it first.
   */
  async reconcile(): Promise<void> {
    const now = this.now();
    for (const draw of this.repos.budgetDraws.listInFlight()) {
      const age = now - draw.updatedAt;
      if (draw.txHash === null) {
        if (age > (this.options.pendingGraceMs ?? PENDING_GRACE_MS)) this.fail(draw, `no transaction sent within ${Math.round(age / 1000)} s (gateway restarted?)`);
        continue;
      }
      let receipt: Awaited<ReturnType<ChainReader['getTransactionReceipt']>>;
      try {
        receipt = await this.reader.getTransactionReceipt(draw.txHash as Hex);
      } catch (e) {
        this.logger.warn('drawer: receipt lookup failed', { drawId: draw.id, txHash: draw.txHash, error: e });
        continue;
      }
      if (receipt === undefined) {
        if (age > (this.options.sentGraceMs ?? SENT_GRACE_MS)) this.fail(draw, `transaction ${draw.txHash} not seen by the node after ${Math.round(age / 1000)} s`);
        continue;
      }
      if (receipt.status === 'reverted') this.fail(draw, 'transaction reverted');
      // Mined successfully: the indexer confirms it (and credits the ledger) when it reaches the block.
    }
  }

  /** Draws from `budget` for `workspace`'s `deficit`. */
  async drawFor(workspace: string, deficit: bigint, budget: BudgetRow): Promise<DrawAttempt | undefined> {
    if (this.repos.budgetDraws.listInFlight().some((d) => d.workspace === workspace)) return undefined;
    const rows = this.repos.usage.unsettled(workspace, this.options.maxRows ?? 500);
    const batchRows = selectBatch(rows, deficit, budget.headroomMicro);
    if (batchRows === undefined) return undefined;
    let priceE18: bigint;
    try {
      priceE18 = (await this.reader.quote(10n ** BigInt(this.options.decimals))).priceE18;
    } catch (e) {
      this.logger.warn('drawer: price unavailable', { workspace, error: e });
      return undefined;
    }
    const tokens = tokensForUsdMicro(batchRows.amountMicro, priceE18, this.options.decimals);
    if (tokens > budget.headroomTokens && budget.headroomTokens > 0n) {
      this.logger.warn('drawer: headroom tokens below the batch; waiting for the next refresh', { workspace, budgetId: budget.budgetId });
      return undefined;
    }
    const batch: DrawBatchWire = {
      v: 1,
      chainId: this.options.chainId,
      desk: this.options.creditDesk,
      budgetId: budget.budgetId,
      workspace,
      usageIds: batchRows.usageIds,
      amountMicro: batchRows.amountMicro.toString(),
      priceE18: priceE18.toString(),
    };
    const hash = receiptHash(batch);
    const base: DrawAttempt = { workspace, budgetId: budget.budgetId, drawId: undefined, amountMicro: batchRows.amountMicro, tokens, status: 'skipped' };
    if (this.writer === undefined || this.options.dryRun) {
      this.logger.info('drawer: dry run', { workspace, budgetId: budget.budgetId, amountMicro: batchRows.amountMicro, tokens, receiptHash: hash });
      return { ...base, status: 'dry_run' };
    }
    const now = this.now();
    const previous = this.repos.budgetDraws.byReceiptHash(hash);
    if (previous !== undefined && previous.status !== 'failed') return undefined; // same batch already in flight or settled
    const drawId = this.repos.transaction(() => {
      if (previous !== undefined) {
        this.repos.budgetDraws.setStatus(previous.id, 'pending', now, { txHash: null, error: null });
        this.repos.usage.setDrawId(batchRows.usageIds, previous.id);
        return previous.id;
      }
      const id = this.repos.budgetDraws.insert({
        budgetId: budget.budgetId,
        workspace,
        tokenAmount: tokens,
        usdMicro: batchRows.amountMicro,
        receiptHash: hash,
        usageIds: batchRows.usageIds,
        batchJson: JSON.stringify(batch),
        txHash: null,
        status: 'pending',
        error: null,
        createdAt: now,
        updatedAt: now,
      });
      this.repos.usage.setDrawId(batchRows.usageIds, id);
      return id;
    });
    const draw = { id: drawId, budgetId: budget.budgetId, usageIds: batchRows.usageIds, workspace };
    const failed = (error: string): DrawAttempt => {
      this.fail(draw, error);
      return { ...base, drawId, status: 'failed', error };
    };
    let txHash: Hex;
    try {
      txHash = await this.writer.draw(BigInt(budget.budgetId), tokens, hash);
    } catch (e) {
      return failed(e instanceof Error ? e.message.slice(0, 500) : String(e));
    }
    this.repos.budgetDraws.setStatus(drawId, 'sent', this.now(), { txHash });
    this.logger.info('drawer: draw sent', { workspace, budgetId: budget.budgetId, drawId, txHash, amountMicro: batchRows.amountMicro, tokens });
    try {
      const receipt = await this.writer.waitForReceipt(txHash, this.options.receiptTimeoutMs ?? 120_000);
      if (receipt.status !== 'success') return { ...failed('transaction reverted'), txHash };
    } catch (e) {
      // Still in the mempool as far as we know: keep `sent` (rows stay marked); the indexer confirms it
      // when it lands and `reconcile()` fails it only once the node reports a revert or forgets it.
      const error = `receipt wait failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
      const current = this.repos.budgetDraws.get(drawId);
      if (current?.status === 'sent') this.repos.budgetDraws.setStatus(drawId, 'sent', this.now(), { error });
      this.logger.warn('drawer: receipt wait failed; leaving the draw sent for reconciliation', { workspace, budgetId: budget.budgetId, drawId, txHash, error });
      return { ...base, drawId, status: current?.status === 'confirmed' ? 'confirmed' : 'sent', txHash, error };
    }
    const current = this.repos.budgetDraws.get(drawId);
    return { ...base, drawId, status: current?.status === 'confirmed' ? 'confirmed' : 'sent', txHash };
  }
}
