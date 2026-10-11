/**
 * Ledger-facing helpers (SPEC §5.2, §5.7): balance snapshots, admin adjustments and the hourly
 * purge of expired reservations.
 *
 * @module metering/ledger
 */
import type { BalanceSnapshot, Repos } from '../db/repos.js';

/** Balance reads and manual adjustments. */
export class LedgerService {
  constructor(
    private readonly repos: Repos,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** `balance`, `reserved`, `budgetHeadroom`, `available` of `workspace`. */
  snapshot(workspace: string): BalanceSnapshot {
    return this.repos.ledger.snapshot(workspace, this.now());
  }

  /** Current ledger balance. */
  balance(workspace: string): bigint {
    return this.repos.ledger.balance(workspace);
  }

  /** Admin / CLI adjustment (`kind='adjustment'`); creates the workspace if needed. */
  adjust(workspace: string, amountMicro: bigint, memo: string | null, refId?: string): number {
    const now = this.now();
    return this.repos.transaction(() => {
      this.repos.workspaces.ensure(workspace, now);
      return this.repos.ledger.insert({
        workspace,
        kind: 'adjustment',
        amountMicro,
        refType: refId === undefined ? 'admin' : 'admin_ref',
        refId: refId ?? `adj_${now}_${Math.random().toString(36).slice(2, 8)}`,
        memo,
        createdAt: now,
      });
    });
  }

  /** Deletes expired reservations; returns the count. */
  purgeExpiredReservations(): number {
    return this.repos.reservations.purgeExpired(this.now());
  }
}
