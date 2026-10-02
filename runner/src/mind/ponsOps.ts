/**
 * Pons-mode operator transactions of the scheduler (`docs/SPEC.md` §9.4, §9.7):
 *
 * - **harvest** (`registry.harvest(token)`) per {@link harvestDecision}: after ticks and on vault /
 *   escrow events (`threshold`, `runway`), and in the hourly sweep (`hourly`, `pool`); at most one
 *   harvest transaction per mind per {@link HARVEST_TX_SPACING_MS};
 * - **createGraduatedPool** (`registry.createGraduatedPool(token)`, best effort) for a launch that has
 *   been `Swept` for more than {@link SWEPT_POOL_DELAY_MS} (Pons auto-graduates the curve; seeding
 *   the v4 pool is permissionless); the on-chain phase is re-read first (`Rescued` is mapped to
 *   `graduated` locally, it emits nothing we index);
 * - **pool id** (§9.7): `harvest` uses `poolIdOf(token)` when set, else `derivedPoolId(token)`. After
 *   graduation the derived id is read through once (`registry.derivedPoolId`, stored in
 *   `pons_minds.derived_pool_id`), so no transaction is needed when `PoolRegistered` is not observed;
 *   **setPoolId** (`registry.setPoolId(token, poolId)`) is sent only as an override, for an observed
 *   `PoolRegistered` id (live event, and the 10-min sweep) that differs from the derived one (or when
 *   the derived id cannot be read).
 *
 * Nothing here calls the in-house curve's `graduate` / `harvest`. Every transaction goes through the
 * DRY_RUN-aware queue.
 *
 * @module mind/ponsOps
 */
import type { Address, Hex } from 'viem';
import type { PonsReader } from '../chain/pons.js';
import type { TxQueue } from '../chain/txQueue.js';
import type { Repos } from '../db/repos.js';
import { harvestDecision, harvestInputs, type HarvestReason, type HarvestTrigger } from '../economics/harvest.js';
import type { MindEconomics } from '../economics/service.js';
import { errorMessage, type Logger } from '../log.js';

/** Hourly harvest sweep. */
export const PONS_HARVEST_SWEEP_MS = 3_600_000;
/** Pool sweep (createGraduatedPool / setPoolId). */
export const PONS_POOL_SWEEP_MS = 10 * 60_000;
/** A launch `Swept` for longer than this gets `createGraduatedPool`. */
export const SWEPT_POOL_DELAY_MS = 10 * 60_000;
/** Minimum spacing of harvest transactions per mind. */
export const HARVEST_TX_SPACING_MS = 5 * 60_000;
/** Minimum spacing of createGraduatedPool / setPoolId transactions per mind. */
export const POOL_TX_SPACING_MS = 10 * 60_000;

/** Dependencies of {@link PonsOps}. */
export interface PonsOpsDeps {
  repos: Repos;
  queue: Pick<TxQueue, 'enqueue'>;
  reader: Pick<PonsReader, 'launchedToken' | 'derivedPoolId'> | null;
  economics: { snapshot(token: string): Promise<MindEconomics> };
  log: Logger;
  config: { harvestMinWei: bigint; harvestIntervalMs: number };
  now?: () => number;
}

/** Pons-mode harvest / pool transactions. */
export class PonsOps {
  readonly #lastTx = new Map<string, number>();
  readonly #busy = new Set<string>();
  #stopped = false;

  constructor(private readonly deps: PonsOpsDeps) {}

  #now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Reserves the per-mind rate-limit slot of `kind`; false when used within `spacing`. */
  #slot(kind: string, token: string, spacing: number): boolean {
    const key = `${kind}:${token}`;
    const last = this.#lastTx.get(key);
    const now = this.#now();
    if (last !== undefined && now - last < spacing) return false;
    this.#lastTx.set(key, now);
    return true;
  }

  /**
   * Evaluates the harvest table for `token` with `econ` and queues `harvest(token)` when it says so.
   * Returns the reason when a harvest was queued.
   */
  async maybeHarvest(token: string, econ: MindEconomics, trigger: HarvestTrigger): Promise<HarvestReason | null> {
    if (this.#stopped) return null;
    const row = this.deps.repos.pons.get(token);
    const mind = this.deps.repos.minds.get(token);
    if (row === undefined || mind === undefined) return null;
    const inputs = harvestInputs(row, econ, {
      harvestMinWei: this.deps.config.harvestMinWei,
      harvestIntervalMs: this.deps.config.harvestIntervalMs,
      now: this.#now(),
      trigger,
      mindCanTick: mind.status !== 2 && econ.modelKnown,
    });
    const reason = harvestDecision(inputs);
    if (reason === null || this.#busy.has(token) || !this.#slot('harvest', token, HARVEST_TX_SPACING_MS)) return null;
    this.#busy.add(token);
    try {
      this.deps.log.info('harvesting', { token, reason, claimableWei: inputs.claimableWei, sweepableWei: inputs.sweepableWei });
      const outcome = await this.deps.queue.enqueue({ functionName: 'harvest', args: [token as Address] }, `harvest ${token} (${reason})`);
      if (outcome.kind === 'failed' || outcome.kind === 'reverted') this.deps.log.info('harvest not done', { token, outcome: outcome.kind === 'failed' ? outcome.error : 'reverted' });
      return reason;
    } catch (err) {
      this.deps.log.warn('harvest failed', { token, error: errorMessage(err) });
      return null;
    } finally {
      this.#busy.delete(token);
    }
  }

  /** Hourly: re-evaluates every Pons mind (rules 1–4). */
  async harvestSweep(): Promise<void> {
    for (const row of this.deps.repos.pons.all()) {
      if (this.#stopped) return;
      try {
        await this.maybeHarvest(row.token, await this.deps.economics.snapshot(row.token), 'hourly');
      } catch (err) {
        this.deps.log.warn('harvest sweep: evaluation failed', { token: row.token, error: errorMessage(err) });
      }
    }
  }

  /**
   * `registry.derivedPoolId(token)`, read through once and stored (the pool key is fixed per launch); `null`
   * when it cannot be read (no reader, RPC failure, a registry without the view) or is zero.
   */
  async resolvePoolId(token: string): Promise<string | null> {
    const row = this.deps.repos.pons.get(token);
    if (row === undefined) return null;
    if (row.derived_pool_id !== null) return row.derived_pool_id;
    if (this.deps.reader === null) return null;
    try {
      const id = (await this.deps.reader.derivedPoolId(token as Address)).toLowerCase();
      if (/^0x0{64}$/.test(id)) return null;
      this.deps.repos.pons.patch(token, { derived_pool_id: id });
      return id;
    } catch (err) {
      this.deps.log.debug('derivedPoolId unavailable', { token, error: errorMessage(err) });
      return null;
    }
  }

  /**
   * An observed `PoolRegistered` id: nothing to send when the registry already has it or derives the same id
   * (§9.7); otherwise `setPoolId` as an override (DRY_RUN-aware, rate limited).
   */
  async setPoolId(token: string, poolId: string): Promise<void> {
    if (this.#stopped) return;
    const row = this.deps.repos.pons.get(token);
    const id = poolId.toLowerCase();
    if (row === undefined || row.registry_pool_id === id) return;
    if ((await this.resolvePoolId(token)) === id) return; // harvest falls back to derivedPoolId: no transaction needed
    if (!this.#slot('setPoolId', token, POOL_TX_SPACING_MS)) return;
    try {
      this.deps.log.info('recording the graduated pool id (override of derivedPoolId)', { token, poolId });
      await this.deps.queue.enqueue({ functionName: 'setPoolId', args: [token as Address, poolId as Hex] }, `setPoolId ${token}`);
    } catch (err) {
      this.deps.log.warn('setPoolId failed', { token, error: errorMessage(err) });
    }
  }

  /** `createGraduatedPool(token)` when the launch is still `Swept` on chain (best effort, rate limited). */
  async #createPool(token: string): Promise<void> {
    try {
      if (this.deps.reader !== null) {
        const phase = (await this.deps.reader.launchedToken(token as Address)).phase;
        if (phase !== 1) {
          if (phase >= 2) {
            // PoolCreated is indexed from PoolGraduated; Rescued emits nothing we index
            this.deps.repos.pons.patch(token, { launch_phase: phase });
            this.deps.repos.minds.advancePhase(token, 2);
          }
          return;
        }
      }
      if (!this.#slot('createGraduatedPool', token, POOL_TX_SPACING_MS)) return;
      this.deps.log.info('launch swept for more than 10 min: creating the graduated pool', { token });
      const outcome = await this.deps.queue.enqueue({ functionName: 'createGraduatedPool', args: [token as Address] }, `createGraduatedPool ${token}`);
      if (outcome.kind === 'failed' || outcome.kind === 'reverted') this.deps.log.info('createGraduatedPool not done; retried by the next sweep', { token, outcome: outcome.kind === 'failed' ? outcome.error : 'reverted' });
    } catch (err) {
      this.deps.log.warn('createGraduatedPool failed', { token, error: errorMessage(err) });
    }
  }

  /**
   * Every 10 min (and once when the indexer is live): pools of launches swept > 10 min ago, the derived pool id
   * of graduated pools (read through), observed pool ids that need a `setPoolId` override.
   */
  async poolSweep(): Promise<void> {
    const now = this.#now();
    for (const row of this.deps.repos.pons.all()) {
      if (this.#stopped) return;
      const mind = this.deps.repos.minds.get(row.token);
      if (mind === undefined) continue;
      if (mind.phase === 1 && row.swept_at !== null && now - row.swept_at > SWEPT_POOL_DELAY_MS) await this.#createPool(row.token);
      if (row.launch_phase === 2 && row.derived_pool_id === null) await this.resolvePoolId(row.token);
      if (row.pool_id !== null && row.registry_pool_id !== row.pool_id) await this.setPoolId(row.token, row.pool_id);
    }
  }

  /** Stops issuing transactions. */
  stop(): void {
    this.#stopped = true;
  }
}
