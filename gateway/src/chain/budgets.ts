/**
 * Budget headroom refresher (SPEC §5.4): for every open, unexpired budget reads
 * `remainingCap = cap − drawn`, `allowance(owner, desk)` and `balanceOf(owner)`, computes
 * `headroom_tokens = min(remainingCap, allowance, balance)` and `headroom_micro` at the desk's
 * current price; stalls on `PriceStale`/`PriceUnavailable` (`price`) or zero headroom with cap left
 * (`allowance`), and clears `draw_failed` once headroom is back.
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

/** Pure headroom computation. */
export function computeHeadroom(budget: Pick<BudgetRow, 'cap' | 'drawn'>, allowance: bigint, balance: bigint): { remainingCap: bigint; headroomTokens: bigint } {
  const remainingCap = budget.cap > budget.drawn ? budget.cap - budget.drawn : 0n;
  let headroomTokens = remainingCap;
  if (allowance < headroomTokens) headroomTokens = allowance;
  if (balance < headroomTokens) headroomTokens = balance;
  return { remainingCap, headroomTokens };
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
    let n = 0;
    for (const budget of budgets) {
      try {
        await this.refreshOne(budget, price, priceError);
        n++;
      } catch (e) {
        this.logger.warn('headroom refresh failed', { budgetId: budget.budgetId, error: e });
      }
    }
    return n;
  }

  private async refreshOne(budget: BudgetRow, price: { priceE18: bigint } | undefined, priceError: PriceError | undefined): Promise<void> {
    const owner = budget.owner as Address;
    const [allowance, balance] = await Promise.all([this.reader.allowance(owner), this.reader.balanceOf(owner)]);
    const { remainingCap, headroomTokens } = computeHeadroom(budget, allowance, balance);
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
