/**
 * Reservations (SPEC §5.7 gate): a credit-paid request needs `available ≥ MIN_RESERVE`, then holds
 * `min(reserve, max(available, MIN_RESERVE))` until settled or released.
 *
 * @module metering/reserve
 */
import { uuid } from '../auth/crypto.js';
import type { Repos } from '../db/repos.js';

/** Thrown when the workspace cannot cover the minimum reservation (HTTP 402). */
export class InsufficientCreditError extends Error {
  override readonly name = 'InsufficientCreditError';
  readonly code = 'insufficient_credit';
  constructor(
    readonly availableMicro: bigint,
    readonly balanceMicro: bigint,
  ) {
    super('Insufficient credit: burn BEAGLE on the Credits page or open a budget.');
  }
}

/** An active reservation. */
export interface Reservation {
  id: string;
  workspace: string;
  amountMicro: bigint;
}

/** Takes and releases reservations atomically. */
export class ReservationService {
  constructor(
    private readonly repos: Repos,
    private readonly limits: { minReserveMicro: bigint; ttlMs: number },
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Gate + insert in one transaction. Throws {@link InsufficientCreditError}. */
  reserve(workspace: string, reserveMicro: bigint): Reservation {
    const now = this.now();
    return this.repos.transaction(() => {
      const snap = this.repos.ledger.snapshot(workspace, now);
      if (snap.available < this.limits.minReserveMicro) throw new InsufficientCreditError(snap.available, snap.balance);
      const floor = snap.available > this.limits.minReserveMicro ? snap.available : this.limits.minReserveMicro;
      const amountMicro = reserveMicro < floor ? reserveMicro : floor;
      const id = `res_${uuid()}`;
      this.repos.reservations.insert({ id, workspace, amountMicro, createdAt: now, expiresAt: now + this.limits.ttlMs });
      return { id, workspace, amountMicro };
    });
  }

  /** Releases a reservation (idempotent). */
  release(id: string): void {
    this.repos.reservations.delete(id);
  }
}
