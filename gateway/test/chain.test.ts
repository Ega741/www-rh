import { DrawBatchSchema } from '@beagle/shared/api';
import { receiptHash } from '@beagle/shared/canonical';
import { tokensForUsdMicro } from '@beagle/shared/credit';
import { describe, expect, it } from 'vitest';
import { computeHeadroom, HeadroomRefresher } from '../src/chain/budgets.js';
import { BudgetDrawer, selectBatch } from '../src/chain/drawer.js';
import { Indexer } from '../src/chain/indexer.js';
import { clampStep, PricePoster, usdStringToPriceE18, usdToPriceE18 } from '../src/chain/poster.js';
import { PriceService } from '../src/chain/price.js';
import { Repos, type UsageRow } from '../src/db/repos.js';
import { migrate } from '../src/db/schema.js';
import { Db } from '../src/db/sqlite.js';
import { silentLogger } from '../src/log.js';
import { DESK, FakeChain, WS1, WS2 } from './helpers.js';

function repos(): Repos {
  const db = new Db(':memory:');
  migrate(db);
  return new Repos(db);
}

const purchase = (workspace: string, usdMicro: bigint, receiptId: number) => ({
  eventName: 'CreditPurchased' as const,
  args: { receiptId: BigInt(receiptId), workspace, payer: workspace, tokenAmount: 1000n * 10n ** 18n, usdMicro, priceE18: 10n ** 16n },
});
const opened = (budgetId: number, workspace: string, cap: bigint, deadline: number) => ({
  eventName: 'BudgetOpened' as const,
  args: { budgetId: BigInt(budgetId), owner: workspace, workspace, cap, deadline: BigInt(deadline) },
});
const drawn = (budgetId: number, receiptId: number, workspace: string, tokenAmount: bigint, usdMicro: bigint, hash: string) => ({
  eventName: 'BudgetDrawn' as const,
  args: { budgetId: BigInt(budgetId), receiptId: BigInt(receiptId), workspace, tokenAmount, usdMicro, priceE18: 10n ** 16n, receiptHash: hash },
});

function indexer(r: Repos, chain: FakeChain, confirmations = 0): Indexer {
  return new Indexer(r, chain, { creditDesk: DESK, startBlock: 1, confirmations, chunkBlocks: 2, now: () => 1_700_000_000_000 }, silentLogger);
}

describe('indexer', () => {
  it('starts at START_BLOCK − 1, applies events in chunks, credits the ledger exactly once', async () => {
    const r = repos();
    const chain = new FakeChain();
    const ix = indexer(r, chain);
    expect(ix.lastBlock()).toBe(0);
    expect(await ix.step()).toBeUndefined();
    chain.mine([purchase(WS1, 10_000_000n, 1)]);
    chain.mine();
    chain.mine([opened(1, WS2, 500n * 10n ** 18n, 1_800_000_000), purchase(WS2, 5n, 2)]);
    const res = await ix.step();
    expect(res).toEqual({ from: 1, to: 3, events: 3 });
    expect(r.ledger.balance(WS1)).toBe(10_000_000n);
    expect(r.ledger.balance(WS2)).toBe(5n);
    expect(r.budgets.get(1)).toMatchObject({ owner: WS2, workspace: WS2, cap: 500n * 10n ** 18n, drawn: 0n, closed: false, deadline: 1_800_000_000 });
    expect(ix.status()).toMatchObject({ lastBlock: 3, head: 3, lagBlocks: 0, lastEventAt: 1_700_000_003 });
    // Re-applying the same logs is a no-op.
    const logs = await chain.getLogs(1n, 3n);
    expect(ix.applyChunk(logs, new Map(), 3, undefined)).toBe(0);
    expect(r.ledger.balance(WS1)).toBe(10_000_000n);
    expect(r.creditEvents.list(WS1, 10)[0]).toMatchObject({ kind: 'purchase', receiptId: 1, usdMicro: 10_000_000n, blockNumber: 1 });
  });

  it('respects confirmations and marks draws confirmed by receipt hash', async () => {
    const r = repos();
    const chain = new FakeChain();
    const ix = indexer(r, chain, 1);
    chain.mine([opened(7, WS1, 10n ** 21n, 1_800_000_000)]);
    expect(await ix.step()).toBeUndefined(); // head 1 − 1 confirmation = 0
    chain.mine();
    await ix.step();
    r.workspaces.ensure(WS1, 1);
    r.budgetDraws.insert({ budgetId: 7, workspace: WS1, tokenAmount: 3n, usdMicro: 3n, receiptHash: '0xabc', usageIds: ['u1'], batchJson: '{}', txHash: '0x1', status: 'sent', error: null, createdAt: 1, updatedAt: 1 });
    chain.mine([drawn(7, 3, WS1, 300n, 3n, '0xABC')]);
    chain.mine();
    await ix.step();
    expect(r.ledger.balance(WS1)).toBe(3n);
    expect(r.budgets.get(7)?.drawn).toBe(300n);
    expect(r.budgetDraws.byReceiptHash('0xabc')?.status).toBe('confirmed');
    chain.mine([{ eventName: 'BudgetClosed', args: { budgetId: 7n, drawn: 300n } }]);
    chain.mine();
    await ix.step();
    expect(r.budgets.get(7)?.closed).toBe(true);
  });

  it('rewinds on a reorg: deletes events, ledger rows and recomputes drawn', async () => {
    const r = repos();
    const chain = new FakeChain();
    const ix = new Indexer(r, chain, { creditDesk: DESK, startBlock: 1, confirmations: 0, chunkBlocks: 100, now: () => 1 }, silentLogger);
    chain.mine([opened(1, WS1, 10n ** 21n, 1_800_000_000)]);
    chain.mine([purchase(WS1, 100n, 1)]);
    chain.mine([drawn(1, 2, WS1, 50n, 7n, '0xdd')]);
    await ix.step();
    expect(r.ledger.balance(WS1)).toBe(107n);
    expect(r.budgets.get(1)?.drawn).toBe(50n);
    chain.reorg(3n);
    expect(await ix.checkReorg()).toBe(true);
    expect(ix.lastBlock()).toBe(0);
    expect(r.ledger.balance(WS1)).toBe(0n);
    expect(r.creditEvents.list(WS1, 10)).toEqual([]);
    expect(r.budgets.get(1)?.drawn).toBe(0n);
    // Replays from the rewound cursor; the purchase comes back, the dropped draw does not.
    await ix.step();
    expect(r.ledger.balance(WS1)).toBe(100n);
    expect(await ix.checkReorg()).toBe(false);
  });
});

describe('headroom refresher', () => {
  it('computes min(remainingCap, allowance, balance) and quotes it; stalls on allowance and price', async () => {
    const r = repos();
    const chain = new FakeChain();
    const nowMs = 1_700_000_000_000;
    r.budgets.upsertOpened({ budgetId: 1, owner: WS2, workspace: WS2, cap: 500n * 10n ** 18n, deadline: 1_700_000_000 + 3600, openedBlock: 1, now: nowMs });
    const refresher = new HeadroomRefresher(r, chain, { decimals: 18, now: () => nowMs }, silentLogger);
    expect(await refresher.refreshAll()).toBe(1);
    expect(r.budgets.get(1)).toMatchObject({ headroomTokens: 0n, headroomMicro: 0n, stalledReason: 'allowance' });
    chain.allowances.set(WS2, 500n * 10n ** 18n);
    chain.balances.set(WS2, 300n * 10n ** 18n);
    await refresher.refreshAll();
    expect(r.budgets.get(1)).toMatchObject({ headroomTokens: 300n * 10n ** 18n, headroomMicro: 3_000_000n, stalledReason: null });
    expect(r.ledger.budgetHeadroom(WS2, 1_700_000_000)).toBe(3_000_000n);
    chain.priceFailure = 'stale';
    await refresher.refreshAll();
    expect(r.budgets.get(1)).toMatchObject({ headroomMicro: 0n, stalledReason: 'price' });
    chain.priceFailure = undefined;
    r.budgets.setStalled(1, 'draw_failed', nowMs);
    await refresher.refreshAll();
    expect(r.budgets.get(1)?.stalledReason).toBeNull();
    expect(computeHeadroom({ cap: 10n, drawn: 4n }, 100n, 5n)).toEqual({ remainingCap: 6n, headroomTokens: 5n });
  });
});

function usageRow(id: string, charged: bigint, createdAt: number): UsageRow {
  return {
    id,
    workspace: WS2,
    apiKeyId: 'k',
    endpoint: 'chat.completions',
    requestedModel: 'beagle/auto',
    servedModel: 'house/gpt-oss-20b',
    provider: 'house',
    tier: 'house',
    paidBy: 'credit',
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    upstreamCostMicro: charged,
    chargedMicro: charged,
    status: 'ok',
    httpStatus: 200,
    errorCode: null,
    latencyMs: 1,
    routeReasons: [],
    stream: false,
    difficulty: null,
    drawId: null,
    priceJson: null,
    markupBps: 0,
    createdAt,
  };
}

describe('budget drawer', () => {
  it('selectBatch takes oldest rows until the deficit is covered, capped by headroom', () => {
    const rows = [usageRow('a', 3n, 1), usageRow('b', 4n, 2), usageRow('c', 5n, 3)];
    expect(selectBatch(rows, 6n, 100n)).toEqual({ usageIds: ['a', 'b'], amountMicro: 7n });
    expect(selectBatch(rows, 100n, 100n)).toEqual({ usageIds: ['a', 'b', 'c'], amountMicro: 12n });
    expect(selectBatch(rows, 100n, 8n)).toEqual({ usageIds: ['a', 'b'], amountMicro: 7n });
    expect(selectBatch(rows, 100n, 2n)).toBeUndefined();
    expect(selectBatch([], 1n, 100n)).toBeUndefined();
  });

  it('draws for a workspace in deficit, records pending → sent, and the indexer confirms it', async () => {
    const r = repos();
    const chain = new FakeChain();
    const nowMs = 1_700_000_000_000;
    r.workspaces.ensure(WS2, nowMs);
    r.budgets.upsertOpened({ budgetId: 1, owner: WS2, workspace: WS2, cap: 500n * 10n ** 18n, deadline: 1_700_000_000 + 7200, openedBlock: 1, now: nowMs });
    r.budgets.setHeadroom(1, 500n * 10n ** 18n, 5_000_000n, null, nowMs);
    r.usage.insert(usageRow('u1', 2n, nowMs - 2));
    r.usage.insert(usageRow('u2', 1n, nowMs - 1));
    r.ledger.insert({ workspace: WS2, kind: 'debit', amountMicro: -3n, refType: 'usage', refId: 'u1', memo: null, createdAt: nowMs });
    const drawer = new BudgetDrawer(r, chain, chain, { chainId: 31337, creditDesk: DESK, decimals: 18, thresholdMicro: 1n, dryRun: false, now: () => nowMs }, silentLogger);
    const attempts = await drawer.tick();
    expect(attempts).toHaveLength(1);
    const a = attempts[0]!;
    expect(a.status).toBe('sent');
    expect(a.amountMicro).toBe(3n);
    expect(a.tokens).toBe(tokensForUsdMicro(3n, 10n ** 16n));
    expect(chain.draws).toHaveLength(1);
    const draw = r.budgetDraws.get(a.drawId!)!;
    expect(draw.status).toBe('sent');
    expect(draw.txHash).toBe(chain.draws[0]!.txHash);
    expect(draw.usageIds).toEqual(['u1', 'u2']);
    const batch = DrawBatchSchema.parse(JSON.parse(draw.batchJson));
    expect(batch).toMatchObject({ v: 1, chainId: 31337, desk: DESK, budgetId: 1, workspace: WS2, usageIds: ['u1', 'u2'], amountMicro: 3n, priceE18: 10n ** 16n });
    expect(receiptHash(JSON.parse(draw.batchJson))).toBe(draw.receiptHash);
    expect(receiptHash(batch)).toBe(draw.receiptHash);
    expect(r.usage.get('u1')?.drawId).toBe(draw.id);
    // A second tick does not double-draw while the first is in flight.
    expect(await drawer.tick()).toEqual([]);
    // The indexer sees BudgetDrawn with the same hash → confirmed + ledger credit.
    chain.mine([drawn(1, 1, WS2, a.tokens, 3n, draw.receiptHash)]);
    const ix = new Indexer(r, chain, { creditDesk: DESK, startBlock: 1, confirmations: 0, chunkBlocks: 10, now: () => nowMs }, silentLogger);
    await ix.step();
    expect(r.budgetDraws.get(draw.id)?.status).toBe('confirmed');
    expect(r.ledger.balance(WS2)).toBe(0n);
    expect(r.budgets.get(1)?.drawn).toBe(a.tokens);
    expect(await drawer.tick()).toEqual([]);
  });

  it('skips below the threshold unless the budget expires within an hour; dry run sends nothing', async () => {
    const r = repos();
    const chain = new FakeChain();
    const nowMs = 1_700_000_000_000;
    r.workspaces.ensure(WS2, nowMs);
    r.budgets.upsertOpened({ budgetId: 1, owner: WS2, workspace: WS2, cap: 10n ** 21n, deadline: 1_700_000_000 + 7200, openedBlock: 1, now: nowMs });
    r.budgets.setHeadroom(1, 10n ** 21n, 5_000_000n, null, nowMs);
    r.usage.insert(usageRow('u1', 5n, nowMs));
    r.ledger.insert({ workspace: WS2, kind: 'debit', amountMicro: -5n, refType: 'usage', refId: 'u1', memo: null, createdAt: nowMs });
    const drawer = new BudgetDrawer(r, chain, chain, { chainId: 31337, creditDesk: DESK, decimals: 18, thresholdMicro: 1_000_000n, dryRun: false, now: () => nowMs }, silentLogger);
    expect(await drawer.tick()).toEqual([]);
    r.budgets.upsertOpened({ budgetId: 1, owner: WS2, workspace: WS2, cap: 10n ** 21n, deadline: 1_700_000_000 + 1800, openedBlock: 1, now: nowMs });
    expect((await drawer.tick())[0]?.status).toBe('sent');
    const dry = new BudgetDrawer(repos(), chain, chain, { chainId: 31337, creditDesk: DESK, decimals: 18, thresholdMicro: 1n, dryRun: true, now: () => nowMs }, silentLogger);
    expect(await dry.tick()).toEqual([]);
  });

  it('marks failed draws, un-marks usage rows and stalls the budget', async () => {
    const r = repos();
    const chain = new FakeChain();
    const nowMs = 1_700_000_000_000;
    r.workspaces.ensure(WS2, nowMs);
    r.budgets.upsertOpened({ budgetId: 1, owner: WS2, workspace: WS2, cap: 10n ** 21n, deadline: 1_700_000_000 + 7200, openedBlock: 1, now: nowMs });
    r.budgets.setHeadroom(1, 10n ** 21n, 5_000_000n, null, nowMs);
    r.usage.insert(usageRow('u1', 5n, nowMs));
    r.ledger.insert({ workspace: WS2, kind: 'debit', amountMicro: -5n, refType: 'usage', refId: 'u1', memo: null, createdAt: nowMs });
    chain.failDraw = new Error('execution reverted: BudgetExceeded');
    const drawer = new BudgetDrawer(r, chain, chain, { chainId: 31337, creditDesk: DESK, decimals: 18, thresholdMicro: 1n, dryRun: false, now: () => nowMs }, silentLogger);
    const [a] = await drawer.tick();
    expect(a?.status).toBe('failed');
    expect(a?.error).toContain('BudgetExceeded');
    expect(r.budgetDraws.get(a!.drawId!)?.status).toBe('failed');
    expect(r.usage.get('u1')?.drawId).toBeNull();
    expect(r.budgets.get(1)?.stalledReason).toBe('draw_failed');
    expect(await drawer.tick()).toEqual([]); // stalled budgets are skipped
    chain.failDraw = undefined;
    chain.receiptStatus = 'reverted';
    r.budgets.setStalled(1, null, nowMs);
    const [b] = await drawer.tick();
    expect(b?.status).toBe('failed');
    expect(b?.error).toBe('transaction reverted');
  });
});

describe('price service and poster', () => {
  it('reads, caches and quotes; reports stale/unavailable', async () => {
    const chain = new FakeChain();
    let now = 1_700_000_000_000;
    chain.priceUpdatedAt = 1_700_000_000;
    const svc = new PriceService({ reader: chain, source: 'manual', decimals: 18, now: () => now, ttlMs: 1000 });
    const dto = await svc.priceDto();
    expect(dto).toMatchObject({ priceE18: '10000000000000000', stale: false, source: 'manual', maxPriceAge: 3600, usdPerToken: '0.01', tokensPerUsd: '100' });
    expect(await svc.quote({ tokens: 1000n * 10n ** 18n })).toMatchObject({ usdMicro: '10000000', tokens: (1000n * 10n ** 18n).toString() });
    expect(await svc.quote({ usdMicro: 2_500_000n })).toMatchObject({ tokens: (250n * 10n ** 18n).toString() });
    chain.priceE18 = 0n;
    expect((await svc.priceDto()).priceE18).toBe('10000000000000000'); // cached
    now += 2000;
    expect((await svc.priceDto()).stale).toBe(true);
    await expect(svc.quote({ tokens: 1n })).rejects.toMatchObject({ status: 503 });
    const none = new PriceService({ reader: undefined, source: 'unknown', decimals: 18 });
    expect(await none.priceDto()).toMatchObject({ priceE18: '0', stale: true, source: 'unknown' });
  });

  it('poster clamps steps, respects minInterval and the 0.5% band, records posts', async () => {
    expect(usdToPriceE18(0.01)).toBe(10n ** 16n);
    expect(usdStringToPriceE18('0.0025')).toBe(2_500_000_000_000_000n);
    expect(clampStep(100n, 200n, 2500)).toBe(125n);
    expect(clampStep(100n, 10n, 2500)).toBe(75n);
    expect(clampStep(0n, 10n, 2500)).toBe(10n);
    const r = repos();
    const chain = new FakeChain();
    let nowSec = 1_700_000_000;
    chain.priceUpdatedAt = nowSec;
    let feed = 0.02;
    const fetchImpl = async (): Promise<Response> => new Response(JSON.stringify({ priceUsd: feed }), { status: 200 });
    const poster = new PricePoster(r, chain, chain, { feedUrl: 'https://feed.example/price', dryRun: false, fetch: fetchImpl, now: () => nowSec * 1000 }, silentLogger);
    expect(await poster.tick()).toEqual({ action: 'skipped', reason: 'within minInterval' });
    nowSec += 61;
    const posted = await poster.tick();
    chain.priceUpdatedAt = nowSec;
    expect(posted.action).toBe('posted');
    if (posted.action === 'posted') expect(posted.priceE18).toBe(12_500_000_000_000_000n); // clamped +25 %
    expect(r.pricePosts.latest()).toMatchObject({ priceE18: 12_500_000_000_000_000n, status: 'sent' });
    nowSec += 61;
    feed = 0.012501;
    expect(await poster.tick()).toEqual({ action: 'skipped', reason: 'change below 0.5%' });
    const dry = new PricePoster(r, chain, undefined, { feedUrl: 'x', dryRun: true, fetch: fetchImpl, now: () => (nowSec + 100) * 1000 }, silentLogger);
    feed = 0.014;
    expect((await dry.tick()).action).toBe('dry_run');
  });
});
