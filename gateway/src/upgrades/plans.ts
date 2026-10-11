/**
 * Upgrades (SPEC §5.11): `pro` (`PRO_PRICE_USD` per `PRO_DAYS`) and `warm` hours
 * (`WARM_HOUR_PRICE_USD` each, 1–168). `purchase` charges `ledger(kind='upgrade')`, inserts the
 * `upgrades` row and applies the plan / warm window.
 *
 * Upgrades are **prepaid from credit**: the gate is `balance − reserved ≥ amount` (402 otherwise).
 * Budget headroom does not count — the drawer only ever settles usage rows (§5.4, §9), so an upgrade
 * paid from headroom could never be drawn from the owner's wallet.
 *
 * @module upgrades/plans
 */
import type { UpgradeDtoWire, UpgradePricesDtoWire } from '@beagle/shared/api';
import { uuid } from '../auth/crypto.js';
import type { Config } from '../config.js';
import type { Repos, UpgradeRow } from '../db/repos.js';
import { InsufficientCreditError } from '../metering/reserve.js';
import type { WarmService } from './warm.js';

/** Maximum warm hours per purchase. */
export const MAX_WARM_HOURS = 168;

/** Thrown for bad purchase parameters (HTTP 400). */
export class UpgradeInputError extends Error {
  override readonly name = 'UpgradeInputError';
}

/** Upgrade pricing and purchases. */
export class UpgradeService {
  constructor(
    private readonly repos: Repos,
    private readonly config: Config,
    private readonly warm: WarmService,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** `GET /api/upgrades/prices`. */
  prices(): UpgradePricesDtoWire {
    return {
      pro: { priceMicro: this.config.economics.proPriceMicro.toString(), days: this.config.economics.proDays },
      warmHourPriceMicro: this.config.economics.warmHourPriceMicro.toString(),
    };
  }

  /** Price of `quantity` units of `kind`. */
  amountFor(kind: 'pro' | 'warm', quantity: number): bigint {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_WARM_HOURS) throw new UpgradeInputError(`quantity must be an integer in [1, ${MAX_WARM_HOURS}]`);
    return (kind === 'pro' ? this.config.economics.proPriceMicro : this.config.economics.warmHourPriceMicro) * BigInt(quantity);
  }

  /** Buys an upgrade. Throws {@link InsufficientCreditError} (402) or {@link UpgradeInputError} (400). */
  purchase(workspace: string, kind: 'pro' | 'warm', quantity: number): UpgradeRow {
    const amount = this.amountFor(kind, quantity);
    const now = this.now();
    const row = this.repos.transaction(() => {
      const ws = this.repos.workspaces.ensure(workspace, now);
      const snap = this.repos.ledger.snapshot(workspace, now);
      if (snap.balance - snap.reserved < amount) throw new InsufficientCreditError(snap.available, snap.balance);
      const id = `upg_${uuid()}`;
      if (amount > 0n) {
        this.repos.ledger.insert({ workspace, kind: 'upgrade', amountMicro: -amount, refType: 'upgrade', refId: id, memo: `${kind} x${quantity}`, createdAt: now });
      }
      let startsAt: number;
      let endsAt: number;
      if (kind === 'pro') {
        const { planUntil } = this.repos.workspaces.effectivePlan(ws, now);
        startsAt = Math.max(now, planUntil ?? now);
        endsAt = startsAt + quantity * this.config.economics.proDays * 86_400_000;
        this.repos.workspaces.setPlan(workspace, 'pro', endsAt);
      } else {
        const window = this.warm.extend(quantity);
        startsAt = window.startsAt;
        endsAt = window.endsAt;
      }
      const upgrade: UpgradeRow = { id, workspace: workspace.toLowerCase(), kind, quantity, amountMicro: amount, startsAt, endsAt, createdAt: now };
      this.repos.upgrades.insert(upgrade);
      return upgrade;
    });
    if (kind === 'warm') void this.warm.ensureWarm();
    return row;
  }

  /** `GET /api/upgrades`. */
  list(workspace: string): UpgradeRow[] {
    return this.repos.upgrades.list(workspace);
  }

  /** Wire form of a row. */
  static toDto(row: UpgradeRow): UpgradeDtoWire {
    return {
      id: row.id,
      workspace: row.workspace,
      kind: row.kind,
      quantity: row.quantity,
      amountMicro: row.amountMicro.toString(),
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      createdAt: row.createdAt,
    };
  }
}
