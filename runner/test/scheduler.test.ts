import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import type { LaunchpadWrite } from '../src/chain/launchpad.js';
import type { TxQueue } from '../src/chain/txQueue.js';
import type { Repos } from '../src/db/repos.js';
import { FixedEthUsd } from '../src/economics/ethUsd.js';
import { EconomicsService } from '../src/economics/service.js';
import { applyLogs, decodeLaunchpadLogs } from '../src/indexer/apply.js';
import { COOLING_MS, Scheduler } from '../src/mind/scheduler.js';
import type { TickInput, TickResult } from '../src/mind/tick.js';
import { FakeClock, FakeQueue, memoryRepos, mindCreatedLog, silentLogger } from './helpers.js';

const ETH = 10n ** 18n;
const A = '0x00000000000000000000000000000000000000a1' as Address;
const B = '0x00000000000000000000000000000000000000b2' as Address;
const C = '0x00000000000000000000000000000000000000c3' as Address;
const policy = { tickIntervalMs: 20_000, targetRunwayDays: 14, minDailySpendUsd: 0.5, maxTickCostUsd: 0.25, minTickBudgetUsd: 0.05 };

interface Pending {
  token: string;
  input: TickInput;
  resolve(r: Partial<TickResult>): void;
}

function setup(opts: { minds?: Address[]; balance?: bigint; max?: number; model?: string } = {}) {
  const repos = memoryRepos();
  const minds = opts.minds ?? [A, B, C];
  minds.forEach((t, i) => repos.tx(() => applyLogs(repos, decodeLaunchpadLogs([mindCreatedLog(t, BigInt(i + 1), 0, opts.model)]), (b) => 1_790_000_000n + b)));
  // 10 ETH ($30k) keeps the burn governor at its TICK_INTERVAL_MS floor (20 s) for the default tick cost
  for (const t of minds) repos.minds.addBalance(t, opts.balance ?? 10n * ETH);
  const clock = new FakeClock(1_800_000_000_000);
  const economics = new EconomicsService(repos, new FixedEthUsd(3_000_000_000), null, policy, silentLogger, clock.now);
  const queue = new FakeQueue();
  const settles: { token: string; force: boolean }[] = [];
  const pending: Pending[] = [];
  const concurrent = new Map<string, number>();
  let maxPerMind = 0;
  const curves = new Map<string, number>();
  const scheduler = new Scheduler({
    repos,
    economics,
    settler: { settle: async (token, o) => void settles.push({ token, force: o?.force === true }) },
    queue: queue as unknown as Pick<TxQueue, 'enqueue' | 'dryRun'>,
    reader: { getCurve: async (t) => ({ realEthReserve: 0n, tokensSold: 0n, phase: curves.get(t.toLowerCase()) ?? 0, pool: A, positionId: 0n }) },
    runTick: (input) =>
      new Promise<TickResult>((resolve) => {
        const t = input.identity.token;
        concurrent.set(t, (concurrent.get(t) ?? 0) + 1);
        maxPerMind = Math.max(maxPerMind, concurrent.get(t) ?? 0);
        pending.push({
          token: t,
          input,
          resolve: (r) => {
            concurrent.set(t, (concurrent.get(t) ?? 1) - 1);
            resolve({ tickId: 1, status: 'ok', failed: false, stopReason: 'end_turn', error: null, totals: { iterations: 1, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdMicro: 0, servedModel: null }, ...r });
          },
        });
      }),
    publishBudget: () => undefined,
    log: silentLogger,
    config: { maxConcurrentMinds: opts.max ?? 2, harvestIntervalMs: 3_600_000 },
    now: clock.now,
  });
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  return { repos, clock, queue, settles, pending, scheduler, settle, curves, maxPerMind: () => maxPerMind };
}

const statusWrites = (q: FakeQueue): string[] =>
  q.writes.filter((w) => w.write.functionName === 'setMindStatus').map((w) => `${(w.write as Extract<LaunchpadWrite, { functionName: 'setMindStatus' }>).args[1]}`);

describe('Scheduler', () => {
  it('fills free slots by nextTickAt, never runs two ticks of one mind, refills when a tick ends', async () => {
    const s = setup();
    expect(await s.scheduler.poll()).toEqual([A.toLowerCase(), B.toLowerCase()]);
    expect(s.scheduler.inFlight).toBe(2);
    expect(await s.scheduler.poll()).toEqual([]); // slots full
    s.pending[0]?.resolve({});
    await s.settle();
    expect(s.scheduler.inFlight).toBe(1);
    // A just ended (not due for TICK_INTERVAL_MS), C never ticked → C fills the slot
    expect(await s.scheduler.poll()).toEqual([C.toLowerCase()]);
    s.clock.advance(20_000);
    expect(await s.scheduler.poll()).toEqual([]); // B and C in flight, slots full again
    s.pending[1]?.resolve({});
    await s.settle();
    expect(await s.scheduler.poll()).toEqual([A.toLowerCase()]);
    expect(s.maxPerMind()).toBe(1);
  });

  it('skips minds that are not Alive, have an unknown model or no budget', async () => {
    const s = setup();
    s.repos.minds.setStatus(A, 1);
    s.repos.minds.setConfig(B, `0x${'99'.repeat(32)}`, `0x${'00'.repeat(32)}`, '');
    s.repos.minds.addBalance(C, -10n * ETH + 10n ** 13n); // $0.03 < $0.25 threshold
    expect(await s.scheduler.poll()).toEqual([]);
  });

  it('puts a mind in a 1 h cooling period after 3 consecutive failed ticks', async () => {
    const s = setup({ minds: [A], max: 1 });
    for (let i = 0; i < 3; i++) {
      expect(await s.scheduler.poll()).toEqual([A.toLowerCase()]);
      s.pending[i]?.resolve({ status: 'failed', failed: true, error: 'boom' });
      await s.settle();
      s.clock.advance(20_000);
    }
    expect(s.repos.minds.get(A)?.cooling_until).toBe(s.clock.now() - 20_000 + COOLING_MS);
    expect(await s.scheduler.poll()).toEqual([]);
    s.clock.advance(COOLING_MS);
    expect(await s.scheduler.poll()).toEqual([A.toLowerCase()]);
    s.pending[3]?.resolve({});
    await s.settle();
    expect(s.repos.minds.get(A)?.failed_ticks).toBe(0);
  });

  it('a successful tick resets the failure counter', async () => {
    const s = setup({ minds: [A], max: 1 });
    await s.scheduler.poll();
    s.pending[0]?.resolve({ failed: true });
    await s.settle();
    expect(s.repos.minds.get(A)?.failed_ticks).toBe(1);
    s.clock.advance(20_000);
    await s.scheduler.poll();
    s.pending[1]?.resolve({});
    await s.settle();
    expect(s.repos.minds.get(A)?.failed_ticks).toBe(0);
  });

  it('stop() aborts in-flight ticks through their signal and waits for them', async () => {
    const s = setup({ minds: [A], max: 1 });
    await s.scheduler.poll();
    const p = s.pending[0]!;
    p.input.signal?.addEventListener('abort', () => p.resolve({ status: 'failed', failed: false, error: 'tick aborted (shutdown)' }));
    await s.scheduler.stop();
    expect(p.input.signal?.aborted).toBe(true);
    expect(s.scheduler.inFlight).toBe(0);
    expect(await s.scheduler.poll()).toEqual([]);
  });

  it('status management: settle then Dormant when out of budget; Alive at 2x threshold; ≤ 1 status tx / 60 s; never for paused minds', async () => {
    const s = setup({ minds: [A], balance: 10n ** 13n }); // $0.03
    await s.scheduler.reevaluate(A);
    expect(s.settles).toEqual([{ token: A.toLowerCase(), force: true }]);
    expect(statusWrites(s.queue)).toEqual(['1']);
    await s.scheduler.reevaluate(A);
    expect(statusWrites(s.queue)).toEqual(['1']); // rate limited (on-chain status not yet changed)
    s.repos.minds.setStatus(A, 1);
    s.repos.minds.addBalance(A, 3n * 10n ** 14n); // $0.93 < 2 x $0.25? no: 0.93 >= 0.5 → Alive
    s.clock.advance(60_000);
    await s.scheduler.reevaluate(A);
    expect(statusWrites(s.queue)).toEqual(['1', '0']);
    s.repos.minds.setStatus(A, 2);
    s.clock.advance(60_000);
    await s.scheduler.reevaluate(A);
    expect(statusWrites(s.queue)).toEqual(['1', '0']);
    expect(s.settles.at(-1)).toEqual({ token: A.toLowerCase(), force: true });
  });

  it('Dormant → Alive requires 2x the runnable threshold', async () => {
    const s = setup({ minds: [A], balance: 10n ** 14n }); // $0.30: runnable (≥ 0.25) but < 0.50
    s.repos.minds.setStatus(A, 1);
    await s.scheduler.reevaluate(A);
    expect(statusWrites(s.queue)).toEqual([]);
  });

  it('graduates on live curve:complete when still Complete; sweeps Complete minds; harvests graduated positions', async () => {
    const s = setup({ minds: [A, B] });
    s.curves.set(A.toLowerCase(), 1);
    s.scheduler.onEvent({ type: 'curve:complete', token: A.toLowerCase(), blockNumber: 1, txHash: '0x' });
    s.curves.set(B.toLowerCase(), 2); // someone else graduated it already
    s.scheduler.onEvent({ type: 'curve:complete', token: B.toLowerCase(), blockNumber: 1, txHash: '0x' });
    await s.settle();
    expect(s.queue.writes.map((w) => `${w.write.functionName} ${w.write.args[0]}`)).toEqual([`graduate ${A.toLowerCase()}`]);
    s.repos.minds.setGraduated(B, A, '42');
    await s.scheduler.harvestSweep();
    expect(s.queue.writes.map((w) => w.write.functionName)).toEqual(['graduate', 'harvest']);
    s.repos.minds.setComplete(A, '4', '1', 1);
    s.queue.outcome = () => ({ kind: 'failed', error: 'PoolPriceSkewed', revert: 'PoolPriceSkewed', hash: null });
    await s.scheduler.graduateSweep();
    await s.scheduler.graduateSweep(); // retried on the next sweep
    expect(s.queue.writes.filter((w) => w.write.functionName === 'graduate')).toHaveLength(3);
  });
});

export type { Repos };
