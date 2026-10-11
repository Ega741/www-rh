/**
 * Budget headroom refresher (SPEC §5.4): for every open, unexpired budget reads
 * `remainingCap = cap − drawn`, `allowance(owner, desk)` and `balanceOf(owner)`, and computes
 * `headroom_tokens` and `headroom_micro` at the desk's current price; stalls on
 * `PriceStale`/`PriceUnavailable` (`price`) or zero headroom with cap left (`allowance`), and clears
 * `draw_failed` once headroom is back.
 *
 * Allowance and balance are one number per owner, so an owner's backing
 * `min(allowance, balance)` is **allocated across** that owner's open budgets in `budget_id` order
 * (each capped by its `remainingCap`) instead of being counted once per budget: Σ headroom over an
 * owner's budgets never exceeds what a draw could actually move.
 *
 * @module chain/budgets
 */
import { quoteUsdMicro } from '@beagle/shared/credit';
import type { Address } from 'viem';
import type { BudgetRow, Repos } from '../db/repos.js';
import type { Logger } from '../log.js';
import { PriceError, type ChainReader } from './clients.js';

/** Options of {@link HeadroomRefresher}. */
export interface HeadroomOptions {
  decimals: number;
  now?: () => number;
}

/** Per-budget result of {@link allocateHeadroom}. */
export interface HeadroomAllocation {
  remainingCap: bigint;
  headroomTokens: bigint;
}

/**
 * Pure allocation of one owner's backing `min(allowance, balance)` across `budgets` (in the order
 * given, i.e. `budget_id` ascending): each budget takes `min(remainingCap, backing left)`.
 */
export function allocateHeadroom(budgets: readonly Pick<BudgetRow, 'cap' | 'drawn'>[], allowance: bigint, balance: bigint): HeadroomAllocation[] {
  let backing = allowance < balance ? allowance : balance;
  if (backing < 0n) backing = 0n;
  return budgets.map((budget) => {
    const remainingCap = budget.cap > budget.drawn ? budget.cap - budget.drawn : 0n;
    const headroomTokens = remainingCap < backing ? remainingCap : backing;
    backing -= headroomTokens;
    return { remainingCap, headroomTokens };
  });
}

/** Pure headroom computation for a single budget (`min(remainingCap, allowance, balance)`). */
export function computeHeadroom(budget: Pick<BudgetRow, 'cap' | 'drawn'>, allowance: bigint, balance: bigint): HeadroomAllocation {
  return allocateHeadroom([budget], allowance, balance)[0] as HeadroomAllocation;
}

/** Refreshes `budgets.headroom_*`. */
export class HeadroomRefresher {
  private readonly now: () => number;

  constructor(
    private readonly repos: Repos,
    private readonly reader: ChainReader,
    private readonly options: HeadroomOptions,
    private readonly logger: Logger,
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Refreshes every open budget; returns the number refreshed. */
  async refreshAll(): Promise<number> {
    const nowSec = Math.floor(this.now() / 1000);
    const budgets = this.repos.budgets.listOpen(nowSec);
    if (budgets.length === 0) return 0;
    let price: { priceE18: bigint } | undefined;
    let priceError: PriceError | undefined;
    try {
      price = await this.reader.quote(10n ** BigInt(this.options.decimals));
    } catch (e) {
      priceError = e instanceof PriceError ? e : new PriceError('rpc', e instanceof Error ? e.message : String(e), { cause: e });
    }
    const byOwner = new Map<string, BudgetRow[]>();
    for (const budget of budgets) {
      const list = byOwner.get(budget.owner) ?? [];
      list.push(budget);
      byOwner.set(budget.owner, list);
    }
    let n = 0;
    for (const [owner, owned] of byOwner) {
      let allowance: bigint;
      let balance: bigint;
      try {
        [allowance, balance] = await Promise.all([this.reader.allowance(owner as Address), this.reader.balanceOf(owner as Address)]);
      } catch (e) {
        this.logger.warn('headroom refresh failed', { owner, budgetIds: owned.map((b) => b.budgetId), error: e });
        continue;
      }
      const allocations = allocateHeadroom(owned, allowance, balance);
      owned.forEach((budget, i) => {
        try {
          this.refreshOne(budget, allocations[i] as HeadroomAllocation, price, priceError);
          n++;
        } catch (e) {
          this.logger.warn('headroom refresh failed', { budgetId: budget.budgetId, error: e });
        }
      });
    }
    return n;
  }

  private refreshOne(budget: BudgetRow, { remainingCap, headroomTokens }: HeadroomAllocation, price: { priceE18: bigint } | undefined, priceError: PriceError | undefined): void {
    const now = this.now();
    if (price === undefined) {
      // Keep tokens current, but the budget cannot back credit without a price.
      const reason: BudgetRow['stalledReason'] = priceError?.code === 'rpc' ? (budget.stalledReason ?? 'price') : 'price';
      this.repos.budgets.setHeadroom(budget.budgetId, headroomTokens, 0n, reason, now);
      return;
    }
    const headroomMicro = quoteUsdMicro(headroomTokens, price.priceE18, this.options.decimals);
    let stalled: BudgetRow['stalledReason'] = null;
    if (headroomTokens === 0n && remainingCap > 0n) stalled = 'allowance';
    else if (budget.stalledReason === 'draw_failed' && headroomTokens === 0n) stalled = 'draw_failed';
    this.repos.budgets.setHeadroom(budget.budgetId, headroomTokens, headroomMicro, stalled, now);
  }
}
