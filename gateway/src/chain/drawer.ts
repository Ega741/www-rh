/**
 * Budget drawer (SPEC §3.4, §5.4): for every workspace whose `balance − reserved` is negative and
 * that has an open non-stalled budget, settles unsettled credit-paid usage rows against the budget
 * with the largest headroom: `DrawBatch` → `receiptHash` → `budget_draws(pending)` → operator
 * transaction `[ComputeBudget?, BurnChecked(tokenAccount, mint, authority = operator), Memo(beagle:draw …)]`
 * → `sent` (signature + last valid block height). Confirmation and the ledger credit come **only**
 * from the indexer (memo hash match).
 *
 * `reconcile()` runs first on every tick: a `pending` row without a signature older than the grace
 * period fails; a `sent` row is checked with `getSignatureStatuses` — an on-chain error fails it,
 * an unknown signature past `last_valid_block_height` fails it (the blockhash expired, the
 * transaction can never land), anything else is left for the indexer. A failed draw releases its
 * usage rows and stalls the budget (`draw_failed`) until the next successful refresh.
 *
 * @module chain/drawer
 */
import type { DrawBatchWire } from '@beagle/shared/api';
import { receiptHash } from '@beagle/shared/canonical';
import type { Cluster } from '@beagle/shared/clusters';
import { tokensForUsdMicro } from '@beagle/shared/credit';
import { encodeDrawMemo } from '@beagle/shared/memo';
import { createBurnCheckedInstruction } from '@solana/spl-token';
import { ComputeBudgetProgram, PublicKey, TransactionInstruction } from '@solana/web3.js';
import type { BudgetDrawRow, BudgetRow, Repos, UsageRow } from '../db/repos.js';
import type { Logger } from '../log.js';
import type { PriceService } from './price.js';
import type { ChainReader, ChainWriter, RecentBlockhash } from './rpc.js';

/** Options of {@link BudgetDrawer}. */
export interface DrawerOptions {
  cluster: Cluster;
  mint: string;
  tokenProgram: string;
  memoProgram: string;
  operator: string | undefined;
  decimals: number;
  /** Draw once the deficit reaches this (µUSD). */
  thresholdMicro: bigint;
  /** `PRIORITY_FEE_MICROLAMPORTS` (0 = no ComputeBudget instruction). */
  priorityFeeMicrolamports: number;
  /** `DRAW_CONFIRM_TIMEOUT_MS`. */
  confirmTimeoutMs: number;
  /** Max usage rows per batch (default 500). */
  maxRows?: number;
  /** A `pending` row without a signature older than this is a crash leftover → failed (default 10 min). */
  pendingGraceMs?: number;
  dryRun: boolean;
  now?: () => number;
}

/** Default {@link DrawerOptions.pendingGraceMs}. */
export const PENDING_GRACE_MS = 10 * 60_000;

/** What one tick did for one workspace. */
export interface DrawAttempt {
  workspace: string;
  tokenAccount: string;
  drawId: number | undefined;
  amountMicro: bigint;
  tokens: bigint;
  status: 'sent' | 'confirmed' | 'failed' | 'skipped' | 'dry_run';
  signature?: string;
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

/** Inputs of {@link buildDrawInstructions}. */
export interface DrawInstructionInput {
  tokenAccount: string;
  mint: string;
  operator: string;
  amount: bigint;
  decimals: number;
  tokenProgram: string;
  memoProgram: string;
  memo: string;
  priorityFeeMicrolamports: number;
}

/** `[ComputeBudget(priority fee, optional), BurnChecked(delegate = operator), Memo(beagle:draw …)]` (SPEC §3.4). */
export function buildDrawInstructions(input: DrawInstructionInput): TransactionInstruction[] {
  const operator = new PublicKey(input.operator);
  const instructions: TransactionInstruction[] = [];
  if (input.priorityFeeMicrolamports > 0) instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: input.priorityFeeMicrolamports }));
  instructions.push(createBurnCheckedInstruction(new PublicKey(input.tokenAccount), new PublicKey(input.mint), operator, input.amount, input.decimals, [], new PublicKey(input.tokenProgram)));
  instructions.push(
    new TransactionInstruction({
      programId: new PublicKey(input.memoProgram),
      keys: [{ pubkey: operator, isSigner: true, isWritable: false }],
      data: Buffer.from(input.memo, 'utf8'),
    }),
  );
  return instructions;
}

/** The drawer. */
export class BudgetDrawer {
  private readonly now: () => number;
  private running = false;

  constructor(
    private readonly repos: Repos,
    private readonly reader: ChainReader,
    private readonly writer: ChainWriter | undefined,
    private readonly price: PriceService,
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
      const out: DrawAttempt[] = [];
      for (const { workspace, deficit } of this.repos.ledger.workspacesInDeficit(now)) {
        if (deficit < this.options.thresholdMicro) continue;
        const budgets = this.repos.budgets.listDrawable(workspace);
        const best = budgets[0];
        if (best === undefined) continue;
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
  private fail(draw: Pick<BudgetDrawRow, 'id' | 'tokenAccount' | 'usageIds' | 'workspace'>, error: string): boolean {
    const t = this.now();
    return this.repos.transaction(() => {
      const current = this.repos.budgetDraws.get(draw.id);
      if (current === undefined || (current.status !== 'pending' && current.status !== 'sent')) return false;
      this.repos.budgetDraws.setStatus(draw.id, 'failed', t, { error });
      this.repos.usage.clearDrawId(draw.usageIds, draw.id);
      this.repos.budgets.setStalled(draw.tokenAccount, 'draw_failed', t);
      this.logger.error('drawer: draw failed', { workspace: draw.workspace, tokenAccount: draw.tokenAccount, drawId: draw.id, error });
      return true;
    });
  }

  /**
   * Resolves `pending`/`sent` rows this process is not waiting on (crash leftovers, interrupted
   * confirmations, dropped transactions). Public for tests; `tick()` calls it first.
   */
  async reconcile(): Promise<void> {
    const now = this.now();
    const inFlight = this.repos.budgetDraws.listInFlight();
    const sent = inFlight.filter((d) => d.signature !== null);
    for (const draw of inFlight) {
      if (draw.signature !== null) continue;
      const age = now - draw.updatedAt;
      if (age > (this.options.pendingGraceMs ?? PENDING_GRACE_MS)) this.fail(draw, `no transaction sent within ${Math.round(age / 1000)} s (gateway restarted?)`);
    }
    if (sent.length === 0) return;
    let statuses: Awaited<ReturnType<ChainReader['getSignatureStatuses']>>;
    try {
      statuses = await this.reader.getSignatureStatuses(sent.map((d) => d.signature as string));
    } catch (e) {
      this.logger.warn('drawer: signature status lookup failed', { error: e });
      return;
    }
    let blockHeight: number | undefined;
    for (let i = 0; i < sent.length; i++) {
      const draw = sent[i] as BudgetDrawRow;
      const status = statuses[i] ?? null;
      if (status === null) {
        if (draw.lastValidBlockHeight === null) continue;
        if (blockHeight === undefined) {
          try {
            blockHeight = await this.reader.getBlockHeight();
          } catch (e) {
            this.logger.warn('drawer: block height lookup failed', { error: e });
            return;
          }
        }
        if (blockHeight > draw.lastValidBlockHeight) this.fail(draw, `transaction ${draw.signature} never landed: blockhash expired at block height ${draw.lastValidBlockHeight}`);
        continue;
      }
      if (status.err !== null && status.err !== undefined) this.fail(draw, `transaction ${draw.signature} failed on chain: ${JSON.stringify(status.err)}`);
      // Confirmed / finalized without error: the indexer confirms it (and credits the ledger) when it reaches the signature.
    }
  }

  /** Draws from `budget` for `workspace`'s `deficit`. */
  async drawFor(workspace: string, deficit: bigint, budget: BudgetRow): Promise<DrawAttempt | undefined> {
    if (this.repos.budgetDraws.listInFlight().some((d) => d.workspace === workspace)) return undefined;
    const rows = this.repos.usage.unsettled(workspace, this.options.maxRows ?? 500);
    const batchRows = selectBatch(rows, deficit, budget.headroomMicro);
    if (batchRows === undefined) return undefined;
    const price = this.price.current();
    if (price === undefined || price.stale) {
      this.logger.warn('drawer: price unavailable or stale; not drawing', { workspace });
      return undefined;
    }
    const tokens = tokensForUsdMicro(batchRows.amountMicro, price.priceE18, this.options.decimals);
    if (tokens === 0n) return undefined;
    if (tokens > budget.headroomTokens) {
      this.logger.warn('drawer: headroom tokens below the batch; waiting for the next refresh', { workspace, tokenAccount: budget.tokenAccount, tokens: tokens.toString(), headroomTokens: budget.headroomTokens.toString() });
      return undefined;
    }
    const batch: DrawBatchWire = {
      v: 1,
      cluster: this.options.cluster,
      mint: this.options.mint,
      tokenAccount: budget.tokenAccount,
      workspace,
      usageIds: batchRows.usageIds,
      amountMicro: batchRows.amountMicro.toString(),
      priceE18: price.priceE18.toString(),
      pricePointId: price.id,
    };
    const hash = receiptHash(batch);
    const base: DrawAttempt = { workspace, tokenAccount: budget.tokenAccount, drawId: undefined, amountMicro: batchRows.amountMicro, tokens, status: 'skipped' };
    const operator = this.options.operator;
    if (this.writer === undefined || this.options.dryRun || operator === undefined) {
      this.logger.info('drawer: dry run', { workspace, tokenAccount: budget.tokenAccount, amountMicro: batchRows.amountMicro.toString(), tokens: tokens.toString(), receiptHash: hash });
      return { ...base, status: 'dry_run' };
    }
    const now = this.now();
    const previous = this.repos.budgetDraws.byReceiptHash(hash);
    if (previous !== undefined && previous.status !== 'failed') return undefined; // same batch already in flight or settled
    const drawId = this.repos.transaction(() => {
      if (previous !== undefined) {
        this.repos.budgetDraws.setStatus(previous.id, 'pending', now, { signature: null, lastValidBlockHeight: null, error: null });
        this.repos.usage.setDrawId(batchRows.usageIds, previous.id);
        return previous.id;
      }
      const id = this.repos.budgetDraws.insert({
        tokenAccount: budget.tokenAccount,
        workspace,
        tokenAmount: tokens,
        usdMicro: batchRows.amountMicro,
        receiptHash: hash,
        usageIds: batchRows.usageIds,
        batchJson: JSON.stringify(batch),
        signature: null,
        lastValidBlockHeight: null,
        status: 'pending',
        error: null,
        createdAt: now,
        updatedAt: now,
      });
      this.repos.usage.setDrawId(batchRows.usageIds, id);
      return id;
    });
    const draw = { id: drawId, tokenAccount: budget.tokenAccount, usageIds: batchRows.usageIds, workspace };
    const failed = (error: string): DrawAttempt => {
      this.fail(draw, error);
      return { ...base, drawId, status: 'failed', error };
    };
    const instructions = buildDrawInstructions({
      tokenAccount: budget.tokenAccount,
      mint: this.options.mint,
      operator,
      amount: tokens,
      decimals: this.options.decimals,
      tokenProgram: this.options.tokenProgram,
      memoProgram: this.options.memoProgram,
      memo: encodeDrawMemo({ workspace, receiptHash: hash }),
      priorityFeeMicrolamports: this.options.priorityFeeMicrolamports,
    });
    let recent: RecentBlockhash;
    let signature: string;
    try {
      recent = await this.reader.getLatestBlockhash();
      signature = await this.writer.signAndSend(instructions, recent);
    } catch (e) {
      return failed(`send failed: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500));
    }
    this.repos.budgetDraws.setStatus(drawId, 'sent', this.now(), { signature, lastValidBlockHeight: recent.lastValidBlockHeight });
    this.logger.info('drawer: draw sent', { workspace, tokenAccount: budget.tokenAccount, drawId, signature, amountMicro: batchRows.amountMicro.toString(), tokens: tokens.toString() });
    try {
      const outcome = await this.writer.confirm(signature, recent, this.options.confirmTimeoutMs);
      if (outcome.status === 'failed') return { ...failed(`transaction failed on chain: ${JSON.stringify(outcome.err)}`), signature };
      if (outcome.status === 'expired') return { ...failed('blockhash expired before the transaction landed'), signature };
      if (outcome.status === 'timeout') this.logger.warn('drawer: confirmation timed out; leaving the draw sent for reconciliation', { drawId, signature });
    } catch (e) {
      // Unknown as far as we know: keep `sent` (rows stay marked); reconcile() decides later from the chain.
      this.logger.warn('drawer: confirmation failed; leaving the draw sent for reconciliation', { drawId, signature, error: e });
    }
    const current = this.repos.budgetDraws.get(drawId);
    return { ...base, drawId, status: current?.status === 'confirmed' ? 'confirmed' : 'sent', signature };
  }
}
