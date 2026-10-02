import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { modelIdToHash, personaHash } from '@www-rh/shared';
import type { TxQueue } from '../src/chain/txQueue.js';
import type { Repos } from '../src/db/repos.js';
import { FixedEthUsd } from '../src/economics/ethUsd.js';
import { harvestDecision, harvestInputs, type HarvestInputs } from '../src/economics/harvest.js';
import { EconomicsService } from '../src/economics/service.js';
import { HARVEST_TX_SPACING_MS, PonsOps, SWEPT_POOL_DELAY_MS } from '../src/mind/ponsOps.js';
import { Scheduler } from '../src/mind/scheduler.js';
import type { TickResult } from '../src/mind/tick.js';
import { CREATOR, FakeClock, FakeQueue, memoryRepos, PERSONA, silentLogger } from './helpers.js';
import { FakePonsReader, launchedToken, PACCOUNT, PCURVE, PTOKEN } from './ponsHelpers.js';

const MIN = 2_000_000_000_000_000n; // HARVEST_MIN_WEI default (0.002 ether)
const policy = { tickIntervalMs: 20_000, targetRunwayDays: 14, minDailySpendUsd: 0.5, maxTickCostUsd: 0.25, minTickBudgetUsd: 0.05 };

describe('harvest decision table (SPEC §9.4)', () => {
  const base: HarvestInputs = { claimableWei: 0n, sweepableWei: 0n, harvestMinWei: MIN, vaultCoversNextTick: true, harvestCoversNextTick: true, poolSweepDue: false, trigger: 'evaluate' };
  const rows: [string, Partial<HarvestInputs>, ReturnType<typeof harvestDecision>][] = [
    ['claimable at the threshold', { claimableWei: MIN }, 'threshold'],
    ['claimable above the threshold, vault fine', { claimableWei: 3n * MIN }, 'threshold'],
    ['claimable below the threshold, vault fine', { claimableWei: MIN - 1n }, null],
    ['vault cannot cover the next tick, claimable can', { claimableWei: MIN / 4n, vaultCoversNextTick: false }, 'runway'],
    ['vault cannot cover, claimable cannot either', { claimableWei: MIN / 4n, vaultCoversNextTick: false, harvestCoversNextTick: false }, null],
    ['vault cannot cover, only pending curve fees (sweepable) can', { sweepableWei: MIN / 4n, vaultCoversNextTick: false }, 'runway'],
    ['nothing to harvest even when the vault is empty', { vaultCoversNextTick: false }, null],
    ['HARVEST_MIN_WEI = 0 never harvests nothing', { harvestMinWei: 0n }, null],
    ['hourly: claimable + sweepable reach the threshold', { claimableWei: MIN / 2n, sweepableWei: MIN / 2n, trigger: 'hourly' }, 'hourly'],
    ['not hourly: claimable + sweepable alone do not trigger', { claimableWei: MIN / 2n, sweepableWei: MIN / 2n }, null],
    ['hourly: graduated pool due for a sweep', { poolSweepDue: true, trigger: 'hourly' }, 'pool'],
    ['not hourly: pool sweep waits for the hourly pass', { poolSweepDue: true }, null],
    ['hourly, below every threshold', { claimableWei: 1n, trigger: 'hourly' }, null],
  ];
  it.each(rows)('%s', (_name, over, expected) => {
    expect(harvestDecision({ ...base, ...over })).toBe(expected);
  });

  it('harvestInputs: sweepable only while the registry can sweep the curve; pool sweep due after HARVEST_INTERVAL_MS', () => {
    const econ = {
      claimableWei: null,
      budget: { balanceWei: 0n, epochRemainingWei: null, unsettledUsdMicro: 0, ethUsdMicro: 3_000_000_000, balanceUsdMicro: 0, availableUsdMicro: 0, vaultUsdMicro: 0 },
      thresholdUsdMicro: 250_000,
      hasBudget: false,
    };
    const row = { claimable: '1000', pending_fee: '10000', pending_tax: '500', launched_here: 1, adopted: 0, launch_phase: 0, pool_id: null, registry_pool_id: null, last_harvest_at: null };
    const o = { harvestMinWei: MIN, harvestIntervalMs: 6 * 3_600_000, now: 10_000_000_000, trigger: 'evaluate' as const, mindCanTick: true };
    const i = harvestInputs(row, econ, o);
    expect([i.claimableWei, i.sweepableWei, i.vaultCoversNextTick, i.harvestCoversNextTick, i.poolSweepDue]).toEqual([1000n, 7000n + 500n, false, false, false]);
    expect(harvestInputs({ ...row, launched_here: 0 }, econ, o).sweepableWei).toBe(0n); // prepared, not adopted yet: the account is not the recipient
    expect(harvestInputs({ ...row, launched_here: 0, adopted: 1 }, econ, o).sweepableWei).toBe(7500n); // adopted: the account sweeps the curve
    expect(harvestInputs({ ...row, launch_phase: 1 }, econ, o).sweepableWei).toBe(0n); // swept: fees went to the escrow already
    expect(harvestInputs(row, { ...econ, claimableWei: 5n }, o).claimableWei).toBe(5n); // on-chain claimable wins over the indexed value
    expect(harvestInputs(row, econ, { ...o, mindCanTick: false }).vaultCoversNextTick).toBe(true); // a paused mind needs no runway harvest
    // $0.25 threshold at $3000/ETH ≈ 8.4e13 wei: 1e14 claimable covers the next tick
    expect(harvestInputs({ ...row, claimable: '100000000000000' }, econ, o).harvestCoversNextTick).toBe(true);
    const grad = { ...row, launch_phase: 2, registry_pool_id: `0x${'90'.repeat(32)}` };
    expect(harvestInputs(grad, econ, o).poolSweepDue).toBe(true);
    expect(harvestInputs({ ...grad, last_harvest_at: o.now - 3_600_000 }, econ, o).poolSweepDue).toBe(false);
    expect(harvestInputs({ ...grad, last_harvest_at: o.now - 6 * 3_600_000 }, econ, o).poolSweepDue).toBe(true);
    expect(harvestInputs({ ...grad, registry_pool_id: null }, econ, o).poolSweepDue).toBe(false);
  });
});

/** A Pons mind row set (registered, with a vault balance and an escrow balance). */
function seedPonsMind(repos: Repos, opts: { balance?: bigint; claimable?: bigint; status?: number; ticked?: number | null } = {}): void {
  repos.minds.insertCreated({
    token: PTOKEN, creator: CREATOR.toLowerCase(), name: 'Pons Mind', symbol: 'PMND', metadataUri: '', modelId: modelIdToHash('claude-opus-5-5'), personaHash: personaHash(PERSONA),
    blockNumber: 1, logIndex: 0, createdAt: 1, priceWei: '0', mcapSort: 0, venue: 'pons',
  });
  repos.pons.insert({ token: PTOKEN, curve: PCURVE, account: PACCOUNT, launchedHere: true });
  repos.pons.patch(PTOKEN, { claimable: (opts.claimable ?? 0n).toString() });
  if (opts.balance !== undefined) repos.minds.addBalance(PTOKEN, opts.balance);
  if (opts.status !== undefined) repos.minds.setStatus(PTOKEN, opts.status);
  if (opts.ticked != null) repos.minds.tickStarted(PTOKEN, opts.ticked);
}

function world(opts: Parameters<typeof seedPonsMind>[1] & { dryRun?: boolean } = {}) {
  const repos = memoryRepos();
  seedPonsMind(repos, opts);
  const clock = new FakeClock(1_800_000_000_000);
  const reader = new FakePonsReader();
  const economics = new EconomicsService(repos, new FixedEthUsd(3_000_000_000), null, policy, silentLogger, clock.now);
  const queue = new FakeQueue(opts.dryRun ?? false);
  const pons = new PonsOps({ repos, queue: queue as unknown as Pick<TxQueue, 'enqueue'>, reader, economics, log: silentLogger, config: { harvestMinWei: MIN, harvestIntervalMs: 21_600_000 }, now: clock.now });
  const ticks: string[] = [];
  const scheduler = new Scheduler({
    repos,
    economics,
    settler: { settle: async () => undefined },
    queue: queue as unknown as Pick<TxQueue, 'enqueue' | 'dryRun'>,
    reader: { getCurve: async () => { throw new Error('getCurve must not be called in Pons mode'); } },
    runTick: async (input) => (ticks.push(input.identity.token), { tickId: 1, status: 'ok', failed: false, stopReason: 'end_turn', error: null, totals: { iterations: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdMicro: 0, servedModel: null } } satisfies TickResult),
    publishBudget: () => undefined,
    log: silentLogger,
    config: { maxConcurrentMinds: 2, harvestIntervalMs: 21_600_000 },
    now: clock.now,
    pons,
  });
  const writes = (): string[] => queue.writes.map((w) => `${w.write.functionName}${w.write.functionName === 'setMindStatus' ? `:${w.write.args[1]}` : ''}`);
  return { repos, clock, reader, economics, queue, pons, scheduler, writes };
}

describe('PonsOps (harvest / createGraduatedPool / setPoolId)', () => {
  it('queues harvest(token) when claimable ≥ HARVEST_MIN_WEI, at most once per 5 min per mind (DRY_RUN-aware queue)', async () => {
    const w = world({ claimable: MIN, balance: 10n ** 18n, dryRun: true });
    const econ = await w.economics.snapshot(PTOKEN);
    expect(econ.claimableWei).toBe(MIN); // the indexed escrow balance (no chain reader)
    expect(await w.pons.maybeHarvest(PTOKEN, econ, 'evaluate')).toBe('threshold');
    expect(await w.pons.maybeHarvest(PTOKEN, econ, 'evaluate')).toBeNull();
    w.clock.advance(HARVEST_TX_SPACING_MS);
    expect(await w.pons.maybeHarvest(PTOKEN, econ, 'evaluate')).toBe('threshold');
    expect(w.writes()).toEqual(['harvest', 'harvest']);
    expect(w.queue.writes[0]?.write.args[0]).toBe(PTOKEN);
  });

  it('hourly sweep harvests pending curve fees + claimable that reach the threshold', async () => {
    const w = world({ claimable: MIN / 2n, balance: 10n ** 18n });
    w.repos.pons.patch(PTOKEN, { pending_fee: (MIN).toString() }); // creator share 70 % of the pending fee
    await w.scheduler.reevaluate(PTOKEN);
    expect(w.writes()).toEqual([]); // below the threshold for the per-event rule
    await w.pons.harvestSweep();
    expect(w.writes()).toEqual(['harvest']);
  });

  it('createGraduatedPool only after 10 min in Swept and only while the launch is still Swept on chain; Rescued maps to graduated', async () => {
    const w = world();
    w.repos.minds.advancePhase(PTOKEN, 1);
    w.repos.pons.patch(PTOKEN, { launch_phase: 1, swept_at: w.clock.now() - SWEPT_POOL_DELAY_MS + 60_000 });
    w.reader.launched.set(PTOKEN, launchedToken(PCURVE, { phase: 1 }));
    await w.pons.poolSweep();
    expect(w.writes()).toEqual([]); // swept 9 min ago
    w.clock.advance(2 * 60_000);
    await w.pons.poolSweep();
    expect(w.writes()).toEqual(['createGraduatedPool']);
    await w.pons.poolSweep();
    expect(w.writes()).toEqual(['createGraduatedPool']); // rate limited (10 min)
    w.reader.launched.set(PTOKEN, launchedToken(PCURVE, { phase: 3 })); // Rescued
    w.clock.advance(10 * 60_000);
    await w.pons.poolSweep();
    expect(w.writes()).toEqual(['createGraduatedPool']);
    expect(w.repos.minds.get(PTOKEN)?.phase).toBe(2);
    expect(w.repos.pons.get(PTOKEN)?.launch_phase).toBe(3);
  });

  it('setPoolId for a recorded PoolRegistered the registry does not have yet', async () => {
    const w = world();
    const poolId = `0x${'90'.repeat(32)}`;
    w.repos.pons.patch(PTOKEN, { pool_id: poolId });
    await w.pons.poolSweep();
    expect(w.queue.writes.map((x) => [x.write.functionName, ...x.write.args])).toEqual([['setPoolId', PTOKEN, poolId]]);
    w.repos.pons.patch(PTOKEN, { registry_pool_id: poolId });
    w.clock.advance(60 * 60_000);
    await w.pons.poolSweep();
    expect(w.queue.writes).toHaveLength(1);
  });
});

describe('Scheduler in Pons mode', () => {
  it('never sends the curve graduate / harvest; a live PoolRegistered sends setPoolId', async () => {
    const w = world({ balance: 10n ** 18n });
    w.repos.minds.setComplete(PTOKEN, '1', '1', 1);
    w.scheduler.onEvent({ type: 'curve:complete', token: PTOKEN, blockNumber: 1, txHash: '0x' });
    await w.scheduler.graduateSweep();
    w.repos.minds.setGraduated(PTOKEN, null, '7');
    await w.scheduler.harvestSweep();
    w.scheduler.onEvent({ type: 'pons:pool-registered', token: PTOKEN, poolId: `0x${'90'.repeat(32)}`, blockNumber: 2, txHash: '0x' });
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(w.writes()).toEqual(['setPoolId']);
    await w.scheduler.stop();
  });

  it('out of vault budget with enough claimable: harvests instead of going Dormant; without claimable: Dormant as in curve mode', async () => {
    const w = world({ balance: 10n ** 13n, claimable: 10n ** 14n, ticked: 1_799_999_000_000 }); // vault $0.03 < $0.25; claimable $0.30
    await w.scheduler.reevaluate(PTOKEN);
    expect(w.writes()).toEqual(['harvest']);
    w.repos.pons.patch(PTOKEN, { claimable: '0' });
    w.clock.advance(HARVEST_TX_SPACING_MS);
    await w.scheduler.reevaluate(PTOKEN);
    expect(w.writes()).toEqual(['harvest', 'setMindStatus:1']);
  });

  it('escrow credits re-evaluate the mind (and harvest past the threshold)', async () => {
    const w = world({ balance: 10n ** 18n });
    w.repos.pons.patch(PTOKEN, { claimable: MIN.toString() });
    w.scheduler.onEvent({ type: 'pons:credited', token: PTOKEN, amount: MIN, blockNumber: 3, txHash: '0x' });
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(w.writes()).toEqual(['harvest']);
    await w.scheduler.stop();
  });
});

export type { Address };
