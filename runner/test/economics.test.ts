import { describe, expect, it } from 'vitest';
import { costOfUsageMicroUsd, drawReceiptHash } from '@www-rh/shared';
import { applyLogs, decodeLaunchpadLogs } from '../src/indexer/apply.js';
import { computeBudget, epochRemainingWei, runnableThresholdMicro, usdMicroOfWei, weiOfUsdMicro } from '../src/economics/budget.js';
import { averageTickCostUsd, burnUsdPerHour, dailyBudgetUsd, nextTickAt, runwayHours, shouldStopTick, tickIntervalMs } from '../src/economics/governor.js';
import { EconomicsService } from '../src/economics/service.js';
import { selectTicks, Settler } from '../src/economics/settle.js';
import { clampEthUsdMicro, FeedEthUsd, FixedEthUsd } from '../src/economics/ethUsd.js';
import type { RunnerPublicClient } from '../src/chain/clients.js';
import type { Logger } from '../src/log.js';
import { TickUsage } from '../src/economics/usage.js';
import type { LaunchpadReader } from '../src/chain/launchpad.js';
import type { TxQueue } from '../src/chain/txQueue.js';
import type { Repos, TickRow } from '../src/db/repos.js';
import { encodeLog, FakeClock, FakeQueue, memoryRepos, mindCreatedLog, silentLogger, TOKEN } from './helpers.js';

const ETH = 10n ** 18n;
const PRICE = 3_000_000_000; // $3000.000000
const policy = { tickIntervalMs: 20_000, targetRunwayDays: 14, minDailySpendUsd: 0.5, maxTickCostUsd: 0.25, minTickBudgetUsd: 0.05 };

describe('cost charging at the served model', () => {
  it('bills each iteration at message.model, not the requested model', () => {
    const usage = new TickUsage();
    const u = { input_tokens: 10_000, output_tokens: 2_000, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 1_000 };
    const a = usage.charge('claude-opus-5-5', u);
    const b = usage.charge('claude-opus-4-8', u); // server-side fallback served this iteration
    expect(a).toBe(costOfUsageMicroUsd('claude-opus-5-5', u));
    expect(b).toBe(costOfUsageMicroUsd('claude-opus-4-8', u));
    expect(b).toBeGreaterThan(a); // opus-4-8 is priced 5/25 vs 4/20
    expect(usage.totals).toMatchObject({ iterations: 2, inputTokens: 20_000, outputTokens: 4_000, cacheReadTokens: 100_000, cacheWriteTokens: 2_000, costUsdMicro: a + b, servedModel: 'claude-opus-4-8' });
    expect(usage.unknownModels.size).toBe(0);
  });

  it('charges unknown served models at claude-fable-5-1 prices and records them', () => {
    const usage = new TickUsage();
    const cost = usage.charge('claude-mystery-9', { input_tokens: 1000, output_tokens: 1000 });
    expect(cost).toBe(costOfUsageMicroUsd('claude-fable-5-1', { input_tokens: 1000, output_tokens: 1000 }));
    expect([...usage.unknownModels]).toEqual(['claude-mystery-9']);
  });
});

describe('budget arithmetic (table-driven)', () => {
  it.each([
    // balance, epochRemaining, unsettled, balanceUsd, available, vault
    [ETH, null, 0, 3_000_000_000, 3_000_000_000, 3_000_000_000],
    [ETH, ETH / 10n, 0, 3_000_000_000, 300_000_000, 3_000_000_000],
    [ETH, ETH / 10n, 400_000_000, 3_000_000_000, -100_000_000, 2_600_000_000],
    [ETH / 1000n, ETH, 1_000_000, 3_000_000, 2_000_000, 2_000_000],
    [0n, 0n, 5, 0, -5, 0],
  ] as const)('balance=%s epoch=%s unsettled=%s', (balanceWei, epochRemaining, unsettled, balanceUsd, available, vault) => {
    const b = computeBudget({ balanceWei, epochRemainingWei: epochRemaining, unsettledUsdMicro: unsettled, ethUsdMicro: PRICE });
    expect(b.balanceUsdMicro).toBe(balanceUsd);
    expect(b.availableUsdMicro).toBe(available);
    expect(b.vaultUsdMicro).toBe(vault);
  });

  it('usdMicroOfWei floors, weiOfUsdMicro rounds up', () => {
    expect(usdMicroOfWei(1n, PRICE)).toBe(0);
    expect(usdMicroOfWei(ETH, PRICE)).toBe(PRICE);
    expect(weiOfUsdMicro(1, PRICE)).toBe(333_333_334n); // ceil(1e18 / 3e9)
    expect(weiOfUsdMicro(3_000_000_000, PRICE)).toBe(ETH);
    expect(weiOfUsdMicro(0, PRICE)).toBe(0n);
  });

  it('epoch allowance resets only after the epoch elapsed', () => {
    const base = { maxPerEpoch: ETH / 4n, epochSeconds: 86_400, drawn: ETH / 10n, epochStart: 1_000n };
    expect(epochRemainingWei({ ...base, now: 1_000n + 86_399n })).toBe(ETH / 4n - ETH / 10n);
    expect(epochRemainingWei({ ...base, now: 1_000n + 86_400n })).toBe(ETH / 4n);
    expect(epochRemainingWei({ ...base, drawn: ETH, now: 2_000n })).toBe(0n);
  });

  it('runnable threshold = max(MIN_TICK_BUDGET_USD, MAX_TICK_COST_USD)', () => {
    expect(runnableThresholdMicro(policy)).toBe(250_000);
    expect(runnableThresholdMicro({ minTickBudgetUsd: 1, maxTickCostUsd: 0.25 })).toBe(1_000_000);
  });
});

describe('burn governor (table-driven)', () => {
  it.each([
    // vaultUsd, avgTickCostUsd, dailyBudget, intervalMs
    [140, 0.25, 10, 20_000 > 2_160_000 ? 20_000 : 2_160_000],
    [1400, 0.25, 100, 216_000],
    [1, 0.25, 0.5, 43_200_000],
    [100_000, 0.01, 100_000 / 14, 20_000],
    [0, 0.1, 0.5, 17_280_000],
  ])('vault=$%s avg=$%s', (vault, avg, daily, interval) => {
    expect(dailyBudgetUsd(vault, policy)).toBeCloseTo(daily, 9);
    expect(tickIntervalMs(avg, vault, policy)).toBe(interval);
  });

  it('average defaults to MAX_TICK_COST_USD without history; next tick; burn; runway; per-tick guard', () => {
    expect(averageTickCostUsd([], policy)).toBe(0.25);
    expect(averageTickCostUsd([100_000, 300_000], policy)).toBeCloseTo(0.2, 12);
    expect(nextTickAt(null, 1000)).toBe(0);
    expect(nextTickAt(5_000, 1000)).toBe(6_000);
    expect(burnUsdPerHour(6_000_000)).toBe(1);
    expect(runwayHours(10, 2)).toBe(5);
    expect(runwayHours(10, 0)).toBeNull();
    expect(shouldStopTick(249_999, policy)).toBe(false);
    expect(shouldStopTick(250_000, policy)).toBe(true);
  });
});

function tick(id: number, cost: number): TickRow {
  return {
    id, token: TOKEN, started_at: 0, ended_at: 1, requested_model: 'claude-opus-5-5', served_model: 'claude-opus-5-5', iterations: 1,
    input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd_micro: cost, stop_reason: 'end_turn', status: 'ok',
    error: null, receipt_id: null, receipt_hash: null, receipt_status: null,
  };
}

describe('settlement selection (table-driven)', () => {
  const ticks = [tick(1, 300_000), tick(2, 300_000), tick(3, 300_000)]; // $0.30 each = 1e14 wei each at $3000
  const perTick = weiOfUsdMicro(300_000, PRICE);

  it('includes ticks greedily while the amount fits min(balance, epoch)', () => {
    const r = selectTicks(ticks, ETH, null, PRICE);
    expect('ticks' in r && r.ticks.map((t) => t.id)).toEqual([1, 2, 3]);
    expect('ticks' in r && r.amountWei).toBe(weiOfUsdMicro(900_000, PRICE));
    const partial = selectTicks(ticks, 2n * perTick + 1n, null, PRICE);
    expect('ticks' in partial && partial.ticks.map((t) => t.id)).toEqual([1, 2]);
    const epoch = selectTicks(ticks, ETH, perTick, PRICE);
    expect('ticks' in epoch && epoch.ticks.map((t) => t.id)).toEqual([1]);
  });

  it('balance-limited: the first tick alone for the whole balance; epoch-limited: wait; zero cap: nothing', () => {
    const small = selectTicks(ticks, perTick / 2n, null, PRICE);
    expect(small).toEqual({ ticks: [ticks[0]], amountWei: perTick / 2n });
    expect(selectTicks(ticks, ETH, perTick / 2n, PRICE)).toEqual({ reason: 'epoch-limit' });
    expect(selectTicks(ticks, 0n, null, PRICE)).toEqual({ reason: 'cap-zero' });
    expect(selectTicks(ticks, ETH, 0n, PRICE)).toEqual({ reason: 'cap-zero' });
    expect(selectTicks([], ETH, null, PRICE)).toEqual({ reason: 'nothing' });
  });
});

function seedMind(repos: Repos, balanceWei: bigint): void {
  repos.tx(() => applyLogs(repos, decodeLaunchpadLogs([mindCreatedLog(TOKEN, 1n)]), () => 1_790_000_000n));
  repos.minds.addBalance(TOKEN, balanceWei);
}

function addTick(repos: Repos, cost: number, at = 1): number {
  const id = repos.ticks.start(TOKEN, 'claude-opus-5-5', at);
  repos.ticks.finish(id, { endedAt: at + 1, servedModel: 'claude-opus-5-5', iterations: 1, inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdMicro: cost, stopReason: 'end_turn', status: 'ok', error: null });
  return id;
}

function fakeReader(epoch: { maxPerEpoch: bigint; drawn: bigint; epochStart: bigint; now: bigint }, calls: { n: number }): LaunchpadReader {
  return {
    address: TOKEN,
    getMind: async () => { throw new Error('unused'); },
    getCurve: async () => { throw new Error('unused'); },
    mindBalance: async () => 0n,
    drawLimit: async () => ({ maxPerEpoch: epoch.maxPerEpoch, epochSeconds: 86_400 }),
    drawnInEpoch: async () => {
      calls.n++;
      return { drawn: epoch.drawn, epochStart: epoch.epochStart };
    },
    feeParams: async () => ({ tradeFeeBps: 100, mindShareBps: 7000, graduationFeeBps: 250 }),
    operator: async () => TOKEN,
    latestTimestamp: async () => epoch.now,
  };
}

describe('EconomicsService', () => {
  it('combines indexed balance, cached epoch state and unsettled spend; cache expires after 60 s and on invalidation', async () => {
    const repos = memoryRepos();
    seedMind(repos, ETH / 100n); // $30
    addTick(repos, 1_000_000, 1);
    const clock = new FakeClock();
    const calls = { n: 0 };
    const svc = new EconomicsService(repos, new FixedEthUsd(PRICE), fakeReader({ maxPerEpoch: ETH / 4n, drawn: 0n, epochStart: 0n, now: 10n }, calls), policy, silentLogger, clock.now);
    const s = await svc.snapshot(TOKEN);
    expect(s.budget.balanceUsdMicro).toBe(30_000_000);
    expect(s.budget.unsettledUsdMicro).toBe(1_000_000);
    expect(s.budget.availableUsdMicro).toBe(29_000_000);
    expect(s.hasBudget).toBe(true);
    expect(s.modelKnown).toBe(true);
    expect(s.avgTickCostUsd).toBe(1);
    await svc.snapshot(TOKEN);
    expect(calls.n).toBe(1);
    clock.advance(60_000);
    await svc.snapshot(TOKEN);
    expect(calls.n).toBe(2);
    svc.invalidateEpoch(TOKEN);
    await svc.snapshot(TOKEN);
    expect(calls.n).toBe(3);
  });
});

describe('Settler', () => {
  function setup(opts: { dryRun?: boolean; balance?: bigint } = {}) {
    const repos = memoryRepos();
    seedMind(repos, opts.balance ?? ETH);
    const clock = new FakeClock();
    const queue = new FakeQueue(opts.dryRun ?? false);
    const econ = new EconomicsService(repos, new FixedEthUsd(PRICE), null, policy, silentLogger, clock.now);
    const settler = new Settler(repos, econ, queue as unknown as TxQueue, { drawThresholdUsd: 2 }, silentLogger, () => undefined, clock.now);
    return { repos, clock, queue, settler };
  }

  it('waits for DRAW_THRESHOLD_USD unless forced, then records a pending receipt and sends drawCompute', async () => {
    const { repos, queue, settler } = setup();
    addTick(repos, 1_500_000);
    expect(await settler.settle(TOKEN)).toEqual({ kind: 'skipped', reason: 'below-threshold' });
    addTick(repos, 600_000);
    const r = await settler.settle(TOKEN);
    expect(r.kind).toBe('settled');
    if (r.kind !== 'settled') return;
    expect(r.status).toBe('pending');
    expect(queue.writes).toHaveLength(1);
    const [write] = queue.writes;
    expect(write?.write.functionName).toBe('drawCompute');
    const receiptRow = repos.ticks.receiptByHash(r.receiptHash);
    expect(receiptRow?.status).toBe('pending');
    // the stored canonical JSON re-hashes to the receipt hash sent on-chain
    expect(drawReceiptHash(JSON.parse(receiptRow!.receipt_json))).toBe(r.receiptHash);
    expect(write?.write.args[2]).toBe(r.receiptHash);
    expect(write?.write.args[1]).toBe(weiOfUsdMicro(2_100_000, PRICE));
    // still unsettled until the indexer commits ComputeDrawn
    expect(repos.ticks.unsettledMicro(TOKEN)).toBe(2_100_000);
    expect(await settler.settle(TOKEN, { force: true })).toEqual({ kind: 'skipped', reason: 'nothing' });
    const drawn = encodeLog('ComputeDrawn', { token: TOKEN, amount: write!.write.args[1], receiptHash: r.receiptHash }, { block: 5n, logIndex: 0, timestamp: 1_790_000_100n });
    repos.tx(() => applyLogs(repos, decodeLaunchpadLogs([drawn]), () => 0n));
    expect(repos.ticks.receiptByHash(r.receiptHash)?.status).toBe('confirmed');
    expect(repos.ticks.unsettledMicro(TOKEN)).toBe(0);
    expect(BigInt(repos.minds.get(TOKEN)!.mind_balance)).toBe(ETH - weiOfUsdMicro(2_100_000, PRICE));
  });

  it('a failed draw makes the ticks eligible again; dry-run receipts never settle', async () => {
    const { repos, queue, settler } = setup();
    addTick(repos, 3_000_000);
    queue.outcome = () => ({ kind: 'failed', error: 'DrawLimitExceeded', revert: 'DrawLimitExceeded', hash: null });
    const first = await settler.settle(TOKEN);
    expect(first.kind === 'settled' && first.status).toBe('failed');
    expect(repos.ticks.eligibleForSettlement(TOKEN, 10)).toHaveLength(1);
    queue.outcome = () => ({ kind: 'confirmed', hash: `0x${'bb'.repeat(32)}` });
    const second = await settler.settle(TOKEN);
    expect(second.kind === 'settled' && second.status).toBe('pending');

    const dry = setup({ dryRun: true });
    addTick(dry.repos, 3_000_000);
    const r = await dry.settler.settle(TOKEN);
    expect(r.kind === 'settled' && r.status).toBe('dry_run');
    expect(dry.queue.writes).toHaveLength(0);
    expect(dry.repos.ticks.unsettledMicro(TOKEN)).toBe(3_000_000);
  });

  it('reconciles pending receipts: indexed draw → confirmed; never released by age alone (no proof it was not mined)', async () => {
    const { repos, clock, settler } = setup();
    addTick(repos, 3_000_000);
    const r = await settler.settle(TOKEN);
    if (r.kind !== 'settled') throw new Error('expected a receipt');
    await settler.reconcile();
    expect(repos.ticks.receiptByHash(r.receiptHash)?.status).toBe('pending');
    clock.advance(10 * 60_000);
    await settler.reconcile(); // the old behaviour (→ failed after 10 min) allowed a double draw
    expect(repos.ticks.receiptByHash(r.receiptHash)?.status).toBe('pending');
    expect(repos.ticks.eligibleForSettlement(TOKEN, 10)).toHaveLength(0);
    repos.facts.insertDraw({ tx_hash: `0x${'aa'.repeat(32)}`, log_index: 0, block_number: 7, timestamp: 1, token: TOKEN, amount: r.amountWei.toString(), receipt_hash: r.receiptHash.toLowerCase() });
    await settler.reconcile();
    expect(repos.ticks.receiptByHash(r.receiptHash)?.status).toBe('confirmed');
  });
});

describe('ETH/USD fallback sanity bounds (finding 16)', () => {
  const bounds = { min: 100_000_000, max: 100_000_000_000 };
  const feed = (answer: bigint, ageS: number, now: number): RunnerPublicClient =>
    ({
      readContract: async ({ functionName }: { functionName: string }) =>
        functionName === 'decimals' ? 8 : [1n, answer, 0n, BigInt(Math.floor(now / 1000) - ageS), 1n],
    }) as unknown as RunnerPublicClient;
  const logs = (): { lines: string[]; log: Logger } => {
    const lines: string[] = [];
    const log: Logger = { ...silentLogger, warn: (m) => void lines.push(`warn ${m}`), error: (m) => void lines.push(`error ${m}`), child: () => log };
    return { lines, log };
  };

  it('a healthy feed is used; a stale feed falls back to ETH_USD_PRICE clamped into ETH_USD_MIN..ETH_USD_MAX (logged)', async () => {
    const now = 1_800_000_000_000;
    expect(await new FeedEthUsd(feed(2_500n * 10n ** 8n, 10, now), TOKEN, 3_000_000_000, silentLogger, () => now, bounds).ethUsdMicro()).toBe(2_500_000_000);
    const a = logs();
    expect(await new FeedEthUsd(feed(2_500n * 10n ** 8n, 7_200, now), TOKEN, 3_000_000_000_000, a.log, () => now, bounds).ethUsdMicro()).toBe(100_000_000_000);
    expect(a.lines).toEqual(['warn ETH/USD feed rejected, using ETH_USD_PRICE', 'error ETH_USD_PRICE fallback outside ETH_USD_MIN..ETH_USD_MAX; clamped']);
    const b = logs();
    expect(await new FeedEthUsd(feed(2_500n * 10n ** 8n, 7_200, now), TOKEN, 1_000_000, b.log, () => now, bounds).ethUsdMicro()).toBe(100_000_000);
  });

  it('an implausible feed answer is rejected like a stale one; a fixed price is clamped too', async () => {
    const now = 1_800_000_000_000;
    expect(await new FeedEthUsd(feed(1n * 10n ** 8n, 10, now), TOKEN, 3_000_000_000, silentLogger, () => now, bounds).ethUsdMicro()).toBe(3_000_000_000); // $1 answer → fallback
    const c = logs();
    expect(await new FixedEthUsd(5_000_000, bounds, c.log).ethUsdMicro()).toBe(100_000_000);
    expect(c.lines).toEqual(['error ETH_USD_PRICE outside ETH_USD_MIN..ETH_USD_MAX; clamped']);
    expect(clampEthUsdMicro(3_000_000_000, bounds)).toEqual({ micro: 3_000_000_000, clamped: false });
  });
});
