/**
 * Mind scheduler (`docs/SPEC.md` §4.1 `mind/scheduler.ts`).
 *
 * Starts only once the indexer is live and an Anthropic key is set. Every second it fills free
 * slots (`MAX_CONCURRENT_MINDS − inFlight`) with eligible minds ordered by `nextTickAt`:
 * on-chain `Alive`, known model, not in flight (single-flight lock), not cooling, due, and
 * `availableUsd ≥ max(MIN_TICK_BUDGET_USD, MAX_TICK_COST_USD)`. Three consecutive failed ticks put a
 * mind in a local 1 h cooling period. Status transactions (≤ 1 per mind per 60 s, never for paused
 * minds) keep the on-chain status in line with the budget; graduation and harvest are best effort.
 *
 * Every 60 s a sweep re-evaluates every relevant mind (runnable / dormant transitions, threshold
 * settlement, forced settlement of paused minds, cooling expiry), so nothing depends on an event
 * having been observed. A mind that has never ticked is never set `Dormant` (no gas is spent on
 * coins that never ran). A persona is only used when the metadata is resolved (`meta_status = ok`)
 * and verified. Economics snapshots are cached for {@link SNAPSHOT_TTL_MS} (invalidated by ticks
 * and vault / status / config events) so the 1 s poll does not rescan every mind's ticks.
 *
 * @module mind/scheduler
 */
import type { Address } from 'viem';
import { modelById, mindStatusName, curvePhaseName } from '@www-rh/shared';
import type { LaunchpadReader } from '../chain/launchpad.js';
import type { TxQueue } from '../chain/txQueue.js';
import type { MindRow, Repos } from '../db/repos.js';
import { microToUsd } from '../economics/budget.js';
import type { MindEconomics } from '../economics/service.js';
import type { IndexedEvent } from '../indexer/events.js';
import { errorMessage, type Logger } from '../log.js';
import type { TickInput, TickResult } from './tick.js';

/** Consecutive failures before cooling. */
export const COOLING_AFTER_FAILURES = 3;
/** Cooling period. */
export const COOLING_MS = 3_600_000;
/** Minimum spacing of status transactions per mind. */
export const STATUS_TX_SPACING_MS = 60_000;
/** Slot-filling period. */
export const SCHEDULER_POLL_MS = 1_000;
/** Retry period for graduations that failed (e.g. `PoolPriceSkewed`) — every `Complete` mind is retried. */
export const GRADUATE_RETRY_MS = 10 * 60_000;
/** Re-evaluation sweep period. */
export const SWEEP_MS = 60_000;
/** Lifetime of a cached economics snapshot in the poll. */
export const SNAPSHOT_TTL_MS = 10_000;

/** Dependencies of {@link Scheduler}. */
export interface SchedulerDeps {
  repos: Repos;
  economics: { snapshot(token: string): Promise<MindEconomics> };
  settler: { settle(token: string, opts?: { force?: boolean }): Promise<unknown> };
  queue: Pick<TxQueue, 'enqueue' | 'dryRun'>;
  reader: Pick<LaunchpadReader, 'getCurve'> | null;
  runTick(input: TickInput): Promise<TickResult>;
  /** Publishes the WS `budget` message (after each tick). */
  publishBudget(token: string, econ: MindEconomics): void;
  log: Logger;
  config: { maxConcurrentMinds: number; harvestIntervalMs: number };
  now?: () => number;
}

/** Schedules ticks, status transactions, graduation and harvest. */
export class Scheduler {
  readonly #inFlight = new Map<string, Promise<void>>();
  readonly #lastStatusTx = new Map<string, number>();
  readonly #shutdown = new AbortController();
  #pollTimer: NodeJS.Timeout | null = null;
  #harvestTimer: NodeJS.Timeout | null = null;
  #graduateTimer: NodeJS.Timeout | null = null;
  #sweepTimer: NodeJS.Timeout | null = null;
  #polling = false;
  #sweeping = false;
  #stopped = false;
  readonly #snapshots = new Map<string, { econ: MindEconomics; at: number }>();
  /** Fire-and-forget work (event re-evaluations, sweeps) awaited by {@link stop}. */
  readonly #background = new Set<Promise<unknown>>();

  constructor(private readonly deps: SchedulerDeps) {}

  #now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Ticks currently running. */
  get inFlight(): number {
    return this.#inFlight.size;
  }

  /** Whether `token` is ticking. */
  isTicking(token: string): boolean {
    return this.#inFlight.has(token.toLowerCase());
  }

  #track<T>(p: Promise<T>): void {
    const tracked = p.catch(() => undefined).finally(() => this.#background.delete(tracked));
    this.#background.add(tracked);
  }

  /** Forgets the cached snapshot of `token`. */
  #invalidate(token: string): void {
    this.#snapshots.delete(token.toLowerCase());
  }

  async #snapshot(token: string, fresh = false): Promise<MindEconomics> {
    const now = this.#now();
    const cached = this.#snapshots.get(token);
    if (!fresh && cached !== undefined && now - cached.at < SNAPSHOT_TTL_MS) return cached.econ;
    const econ = await this.deps.economics.snapshot(token);
    this.#snapshots.set(token, { econ, at: now });
    return econ;
  }

  /** Starts the timers and runs the one-off graduation sweep. */
  start(): void {
    if (this.#pollTimer !== null) return;
    this.#pollTimer = setInterval(() => void this.poll(), SCHEDULER_POLL_MS);
    this.#pollTimer.unref();
    this.#harvestTimer = setInterval(() => this.#track(this.harvestSweep()), this.deps.config.harvestIntervalMs);
    this.#harvestTimer.unref();
    this.#graduateTimer = setInterval(() => this.#track(this.graduateSweep()), GRADUATE_RETRY_MS);
    this.#graduateTimer.unref();
    this.#sweepTimer = setInterval(() => this.#track(this.sweep()), SWEEP_MS);
    this.#sweepTimer.unref();
    this.#track(this.graduateSweep());
    this.#track(this.sweep());
    void this.poll();
  }

  /** Fills free slots with due, eligible minds (exposed for tests). Returns the tokens started. */
  async poll(): Promise<string[]> {
    if (this.#polling || this.#stopped) return [];
    this.#polling = true;
    try {
      const free = this.deps.config.maxConcurrentMinds - this.#inFlight.size;
      if (free <= 0) return [];
      const now = this.#now();
      const candidates: { mind: MindRow; econ: MindEconomics }[] = [];
      for (const mind of this.deps.repos.minds.all()) {
        if (mind.status !== 0 || this.#inFlight.has(mind.token) || mind.mind_balance === '0') continue;
        if (mind.cooling_until !== null && mind.cooling_until > now) continue;
        if (modelById(mind.model_id) === undefined) continue;
        const econ = await this.#snapshot(mind.token);
        if (now < econ.nextTickAt || !econ.hasBudget) continue;
        candidates.push({ mind, econ });
      }
      candidates.sort((a, b) => a.econ.nextTickAt - b.econ.nextTickAt || a.mind.created_at - b.mind.created_at);
      const started: string[] = [];
      for (const { mind, econ } of candidates.slice(0, free)) {
        this.#launch(mind, econ);
        started.push(mind.token);
      }
      return started;
    } finally {
      this.#polling = false;
    }
  }

  #launch(mind: MindRow, econ: MindEconomics): void {
    const spec = modelById(mind.model_id);
    if (spec === undefined) return;
    const input: TickInput = {
      identity: {
        token: mind.token,
        name: mind.name,
        symbol: mind.symbol,
        modelId: mind.model_id,
        personaHash: mind.persona_hash,
        verifiedPersona: verifiedPersona(mind),
      },
      spec,
      vaultUsd: microToUsd(econ.budget.vaultUsdMicro),
      runwayHours: econ.runwayHours,
      currentUrl: mind.current_url,
      signal: this.#shutdown.signal,
    };
    const job = (async () => {
      let result: TickResult | null = null;
      try {
        result = await this.deps.runTick(input);
      } catch (err) {
        this.deps.log.error('tick crashed', { token: mind.token, error: errorMessage(err) });
      }
      this.#afterTick(mind.token, result);
      this.#invalidate(mind.token);
      await this.reevaluate(mind.token, { afterTick: true });
    })().finally(() => this.#inFlight.delete(mind.token));
    this.#inFlight.set(mind.token, job);
  }

  #afterTick(token: string, result: TickResult | null): void {
    const row = this.deps.repos.minds.get(token);
    if (row === undefined) return;
    const now = this.#now();
    const failed = result === null || result.failed;
    const failures = failed ? row.failed_ticks + 1 : 0;
    const cooling = failures >= COOLING_AFTER_FAILURES ? now + COOLING_MS : null;
    if (cooling !== null) this.deps.log.warn('mind cooling for 1 h after consecutive failed ticks', { token, failures });
    this.deps.repos.minds.tickEnded(token, now, cooling !== null ? 0 : failures, cooling ?? row.cooling_until);
  }

  /**
   * Re-evaluates budget-driven status and settlement for `token` (after a tick, on live vault /
   * status / config events, and in the periodic sweep).
   */
  async reevaluate(token: string, opts: { afterTick?: boolean; sweep?: boolean } = {}): Promise<void> {
    if (this.#stopped) return;
    const mind = this.deps.repos.minds.get(token);
    if (mind === undefined) return;
    try {
      const econ = await this.#snapshot(token, true);
      if (opts.afterTick === true) this.deps.publishBudget(token, econ);
      if (mind.status === 2) {
        await this.deps.settler.settle(token, { force: true });
        return;
      }
      if (opts.afterTick === true || opts.sweep === true) await this.deps.settler.settle(token);
      if (mind.status === 0 && (!econ.hasBudget || !econ.modelKnown)) {
        if (this.#inFlight.has(token) && opts.afterTick !== true) return;
        // a mind that never ticked has nothing to settle and costs nothing: no status transaction (spam coins)
        if (mind.last_tick_at === null) return;
        await this.deps.settler.settle(token, { force: true });
        await this.#setStatus(token, 1);
      } else if (mind.status === 1 && econ.modelKnown && econ.budget.availableUsdMicro >= 2 * econ.thresholdUsdMicro) {
        await this.#setStatus(token, 0);
      }
    } catch (err) {
      this.deps.log.warn('re-evaluation failed', { token, error: errorMessage(err) });
    }
  }

  /**
   * Every {@link SWEEP_MS}: clears expired cooling periods and re-evaluates every mind that can need
   * a transition or a settlement — paused minds (forced settlement), Alive minds that ever ticked
   * (threshold settlement, Dormant when out of budget) and Dormant minds with a balance (Alive
   * again) — independently of observed events.
   */
  async sweep(): Promise<void> {
    if (this.#stopped || this.#sweeping) return;
    this.#sweeping = true;
    try {
      for (const token of this.deps.repos.minds.clearExpiredCooling(this.#now())) {
        this.deps.log.info('cooling period over', { token });
        this.#invalidate(token);
      }
      for (const mind of this.deps.repos.minds.all()) {
        if (this.#stopped) break;
        if (this.#inFlight.has(mind.token)) continue;
        const relevant = mind.status === 2 || (mind.status === 0 && mind.last_tick_at !== null) || (mind.status === 1 && mind.mind_balance !== '0');
        if (relevant) await this.reevaluate(mind.token, { sweep: true });
      }
    } finally {
      this.#sweeping = false;
    }
  }

  async #setStatus(token: string, status: 0 | 1): Promise<void> {
    const now = this.#now();
    const last = this.#lastStatusTx.get(token);
    if (last !== undefined && now - last < STATUS_TX_SPACING_MS) return;
    this.#lastStatusTx.set(token, now);
    this.deps.log.info(`setting mind ${status === 0 ? 'Alive' : 'Dormant'}`, { token });
    await this.deps.queue.enqueue({ functionName: 'setMindStatus', args: [token as Address, status] }, `status ${token}`);
  }

  /** Reacts to a live indexed event. */
  onEvent(ev: IndexedEvent): void {
    if (this.#stopped) return;
    switch (ev.type) {
      case 'fee:accrued':
      case 'mind:funded':
      case 'compute:drawn':
      case 'mind:config':
        this.#invalidate(ev.token);
        this.#track(this.reevaluate(ev.token));
        break;
      case 'mind:status':
        this.#invalidate(ev.token);
        if (ev.status === 2 && this.#inFlight.has(ev.token)) {
          // a creator pause observed mid-tick: let the tick finish, then settle
          this.#track((this.#inFlight.get(ev.token) ?? Promise.resolve()).then(() => this.reevaluate(ev.token)));
        } else this.#track(this.reevaluate(ev.token));
        break;
      case 'curve:complete':
        this.#track(this.#graduate(ev.token));
        break;
      default:
        break;
    }
  }

  async #graduate(token: string): Promise<void> {
    try {
      if (this.deps.reader !== null) {
        const curve = await this.deps.reader.getCurve(token as Address);
        if (curve.phase !== 1) return;
      }
      const outcome = await this.deps.queue.enqueue({ functionName: 'graduate', args: [token as Address] }, `graduate ${token}`);
      if (outcome.kind === 'failed' || outcome.kind === 'reverted') {
        // e.g. PoolPriceSkewed: expected to succeed on a later sweep
        this.deps.log.info('graduation not done; will retry on the next sweep', { token, outcome: outcome.kind === 'failed' ? outcome.error : 'reverted' });
      }
    } catch (err) {
      this.deps.log.warn('graduate failed', { token, error: errorMessage(err) });
    }
  }

  /** When the indexer becomes live and every 10 min: graduate every mind still `Complete`. */
  async graduateSweep(): Promise<void> {
    for (const m of this.deps.repos.minds.all()) {
      if (this.#stopped) return;
      if (m.phase === 1) await this.#graduate(m.token);
    }
  }

  /** Every `HARVEST_INTERVAL_MS`: harvest every graduated mind with `positionId != 0`. */
  async harvestSweep(): Promise<void> {
    for (const m of this.deps.repos.minds.all()) {
      if (this.#stopped) return;
      if (m.phase !== 2 || m.position_id === null || m.position_id === '0') continue;
      try {
        if (this.deps.reader !== null && (await this.deps.reader.getCurve(m.token as Address)).phase !== 2) continue;
        await this.deps.queue.enqueue({ functionName: 'harvest', args: [m.token as Address] }, `harvest ${m.token}`);
      } catch (err) {
        this.deps.log.warn('harvest failed', { token: m.token, error: errorMessage(err) });
      }
    }
  }

  /** Stops picking ticks, aborts in-flight ticks and waits for them and for background work. */
  async stop(): Promise<void> {
    this.#stopped = true;
    for (const t of [this.#pollTimer, this.#harvestTimer, this.#graduateTimer, this.#sweepTimer]) if (t !== null) clearInterval(t);
    this.#pollTimer = null;
    this.#harvestTimer = null;
    this.#graduateTimer = null;
    this.#sweepTimer = null;
    this.#shutdown.abort(new Error('shutdown'));
    await Promise.allSettled([...this.#inFlight.values()]);
    await Promise.allSettled([...this.#background]);
  }
}

/** The persona a tick may use: resolved metadata (`meta_status = ok`) whose persona verified against the on-chain hash. */
export function verifiedPersona(row: Pick<MindRow, 'meta_status' | 'meta_persona_verified' | 'meta_persona'>): string | null {
  return row.meta_status === 'ok' && row.meta_persona_verified === 1 ? row.meta_persona : null;
}

/** WS `status` message for a mind row. */
export function statusMessage(row: MindRow, now: number): { type: 'status'; status: ReturnType<typeof mindStatusName>; phase: ReturnType<typeof curvePhaseName>; at: string } {
  return { type: 'status', status: mindStatusName(row.status), phase: curvePhaseName(row.phase), at: new Date(now).toISOString() };
}
