import { DrawBatchSchema } from '@beagle/shared/api';
import { receiptHash } from '@beagle/shared/canonical';
import { tokensForUsdMicro } from '@beagle/shared/credit';
import { describe, expect, it } from 'vitest';
import { allocateHeadroom, computeHeadroom, HeadroomRefresher } from '../src/chain/budgets.js';
import type { BlockInfo } from '../src/chain/clients.js';
import { BudgetDrawer, selectBatch } from '../src/chain/drawer.js';
import { Indexer } from '../src/chain/indexer.js';
import { clampStep, needsKeepAlive, PricePoster, usdStringToPriceE18, usdToPriceE18 } from '../src/chain/poster.js';
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

describe('indexer robustness', () => {
  it('never rewinds when the block cannot be fetched (RPC failure is not a reorg)', async () => {
    const r = repos();
    const chain = new FakeChain();
    const ix = indexer(r, chain, 2);
    chain.mine([purchase(WS1, 10_000_000n, 1)]);
    chain.mine();
    chain.mine();
    await ix.step();
    expect(r.ledger.balance(WS1)).toBe(10_000_000n);
    expect(ix.lastBlock()).toBe(1);
    // Partial outage: eth_blockNumber works, eth_getBlockByNumber / eth_getLogs do not.
    const getBlock = chain.getBlock.bind(chain);
    chain.getBlock = async () => undefined;
    chain.getLogs = async () => {
      throw new Error('HTTP 429');
    };
    expect(await ix.checkReorg()).toBe(false);
    expect(await ix.step()).toBeUndefined(); // the chunk is deferred, nothing is rewound
    expect(r.ledger.balance(WS1)).toBe(10_000_000n);
    expect(ix.lastBlock()).toBe(1);
    chain.getBlock = async () => {
      throw new Error('ECONNRESET');
    };
    expect(await ix.checkReorg()).toBe(false);
    chain.mine(); // block 2 becomes confirmed → there is a chunk to fetch
    await expect(ix.step()).rejects.toThrow('ECONNRESET');
    expect(r.ledger.balance(WS1)).toBe(10_000_000n);
    expect(ix.lastBlock()).toBe(1);
    chain.getBlock = getBlock;
    chain.getLogs = FakeChain.prototype.getLogs.bind(chain);
    expect(await ix.step()).toMatchObject({ events: 0 });
    expect(await ix.checkReorg()).toBe(false);
    expect(r.ledger.balance(WS1)).toBe(10_000_000n);
  });

  it('discards a chunk whose logs do not match the block headers (reorg between the two calls)', async () => {
    const r = repos();
    const chain = new FakeChain();
    const ix = new Indexer(r, chain, { creditDesk: DESK, startBlock: 1, confirmations: 0, chunkBlocks: 100, now: () => 1 }, silentLogger);
    chain.mine([purchase(WS1, 100n, 1)]);
    // The logs still carry the orphaned block's hash while the header is already the canonical one.
    const canonical: BlockInfo = { number: 1n, hash: `0x${'e'.repeat(64)}`, timestamp: 1_700_000_001n };
    const getBlock = chain.getBlock.bind(chain);
    chain.getBlock = async (n) => (n === 1n ? canonical : getBlock(n));
    expect(await ix.step()).toBeUndefined();
    expect(r.ledger.balance(WS1)).toBe(0n);
    expect(ix.lastBlock()).toBe(0);
    chain.getBlock = getBlock;
    expect(await ix.step()).toEqual({ from: 1, to: 1, events: 1 });
    expect(r.ledger.balance(WS1)).toBe(100n);
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

  it('allocates one owner\'s backing across its budgets instead of counting it once per budget', async () => {
    const r = repos();
    const chain = new FakeChain();
    const nowMs = 1_700_000_000_000;
    const deadline = 1_700_000_000 + 3600;
    const E = 10n ** 18n;
    // Two budgets for WS2 and one for WS1, all funded by WS2's wallet (100 tokens allowance, 100 balance).
    r.budgets.upsertOpened({ budgetId: 1, owner: WS2, workspace: WS2, cap: 100n * E, deadline, openedBlock: 1, now: nowMs });
    r.budgets.upsertOpened({ budgetId: 2, owner: WS2, workspace: WS2, cap: 100n * E, deadline, openedBlock: 1, now: nowMs });
    r.budgets.upsertOpened({ budgetId: 3, owner: WS2, workspace: WS1, cap: 100n * E, deadline, openedBlock: 1, now: nowMs });
    chain.allowances.set(WS2, 100n * E);
    chain.balances.set(WS2, 100n * E);
    const refresher = new HeadroomRefresher(r, chain, { decimals: 18, now: () => nowMs }, silentLogger);
    expect(await refresher.refreshAll()).toBe(3);
    expect(r.budgets.get(1)).toMatchObject({ headroomTokens: 100n * E, headroomMicro: 1_000_000n, stalledReason: null });
    expect(r.budgets.get(2)).toMatchObject({ headroomTokens: 0n, headroomMicro: 0n, stalledReason: 'allowance' });
    expect(r.budgets.get(3)).toMatchObject({ headroomTokens: 0n, headroomMicro: 0n, stalledReason: 'allowance' });
    // Σ headroom over the owner's budgets never exceeds quote(min(allowance, balance)).
    expect(r.ledger.budgetHeadroom(WS2, 1_700_000_000) + r.ledger.budgetHeadroom(WS1, 1_700_000_000)).toBe(1_000_000n);
    // A partially drawn first budget leaves the remainder to the next one.
    r.budgets.setDrawn(1, 70n * E, nowMs);
    await refresher.refreshAll();
    expect(r.budgets.get(1)?.headroomTokens).toBe(30n * E);
    expect(r.budgets.get(2)?.headroomTokens).toBe(70n * E);
    expect(r.budgets.get(3)?.headroomTokens).toBe(0n);
    expect(r.ledger.budgetHeadroom(WS2, 1_700_000_000)).toBe(1_000_000n);
    // More backing than caps: everybody is fully backed.
    chain.allowances.set(WS2, 1000n * E);
    chain.balances.set(WS2, 1000n * E);
    await refresher.refreshAll();
    expect(r.budgets.get(2)?.headroomTokens).toBe(100n * E);
    expect(r.budgets.get(3)?.headroomTokens).toBe(100n * E);
    expect(allocateHeadroom([{ cap: 10n, drawn: 0n }, { cap: 10n, drawn: 5n }], 12n, 50n)).toEqual([
      { remainingCap: 10n, headroomTokens: 10n },
      { remainingCap: 5n, headroomTokens: 2n },
    ]);
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
    // An oversized oldest row is skipped, not a stop: the smaller rows behind it still settle.
    const oversize = [usageRow('big', 10n, 1), usageRow('b', 2n, 2), usageRow('c', 3n, 3)];
    expect(selectBatch(oversize, 100n, 5n)).toEqual({ usageIds: ['b', 'c'], amountMicro: 5n });
    expect(selectBatch(oversize, 100n, 4n)).toEqual({ usageIds: ['b'], amountMicro: 2n });
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

  it('a receipt timeout keeps the draw sent; the indexer confirms it later and the rows are never drawn twice', async () => {
    const r = repos();
    const chain = new FakeChain();
    const nowMs = 1_700_000_000_000;
    r.workspaces.ensure(WS2, nowMs);
    r.budgets.upsertOpened({ budgetId: 1, owner: WS2, workspace: WS2, cap: 10n ** 21n, deadline: 1_700_000_000 + 7200, openedBlock: 1, now: nowMs });
    r.budgets.setHeadroom(1, 10n ** 21n, 5_000_000n, null, nowMs);
    r.usage.insert(usageRow('u1', 2n, nowMs - 2));
    r.usage.insert(usageRow('u2', 1n, nowMs - 1));
    r.ledger.insert({ workspace: WS2, kind: 'debit', amountMicro: -3n, refType: 'usage', refId: 'u1', memo: null, createdAt: nowMs });
    chain.failReceipt = new Error('Timed out while waiting for transaction');
    const drawer = new BudgetDrawer(r, chain, chain, { chainId: 31337, creditDesk: DESK, decimals: 18, thresholdMicro: 1n, dryRun: false, now: () => nowMs }, silentLogger);
    const [a] = await drawer.tick();
    expect(a?.status).toBe('sent');
    expect(a?.error).toContain('Timed out');
    const draw = r.budgetDraws.get(a!.drawId!)!;
    expect(draw.status).toBe('sent');
    expect(draw.error).toContain('Timed out');
    expect(r.usage.get('u1')?.drawId).toBe(draw.id);
    expect(r.usage.get('u2')?.drawId).toBe(draw.id);
    expect(r.budgets.get(1)?.stalledReason).toBeNull();
    expect(chain.draws).toHaveLength(1);
    // While in flight nothing else is drawn for the workspace.
    r.usage.insert(usageRow('u3', 2n, nowMs));
    r.ledger.insert({ workspace: WS2, kind: 'debit', amountMicro: -2n, refType: 'usage', refId: 'u3', memo: null, createdAt: nowMs });
    expect(await drawer.tick()).toEqual([]);
    // The transaction lands: the indexer confirms the draw and keeps the rows marked.
    chain.mine([drawn(1, 1, WS2, a!.tokens, 3n, draw.receiptHash)]);
    const ix = new Indexer(r, chain, { creditDesk: DESK, startBlock: 1, confirmations: 0, chunkBlocks: 10, now: () => nowMs }, silentLogger);
    await ix.step();
    expect(r.budgetDraws.get(draw.id)?.status).toBe('confirmed');
    expect(r.ledger.balance(WS2)).toBe(-2n);
    expect(r.usage.get('u1')?.drawId).toBe(draw.id);
    expect(r.usage.get('u2')?.drawId).toBe(draw.id);
    // The next draw covers u3 only — u1/u2 are settled.
    chain.failReceipt = undefined;
    const [c] = await drawer.tick();
    expect(c?.status).toBe('sent');
    expect(r.budgetDraws.get(c!.drawId!)?.usageIds).toEqual(['u3']);
    expect(chain.draws).toHaveLength(2);
  });

  it('a draw confirmed by the indexer while the drawer still waits is never flipped to failed', async () => {
    const r = repos();
    const nowMs = 1_700_000_000_000;
    const ix = { current: undefined as Indexer | undefined };
    class RacyChain extends FakeChain {
      override async waitForReceipt(): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint }> {
        // The event is indexed before the receipt wait gives up.
        const d = r.budgetDraws.listInFlight()[0]!;
        this.mine([drawn(1, 1, WS2, d.tokenAmount, d.usdMicro, d.receiptHash)]);
        await ix.current!.step();
        throw new Error('receipt wait timed out');
      }
    }
    const chain = new RacyChain();
    ix.current = new Indexer(r, chain, { creditDesk: DESK, startBlock: 1, confirmations: 0, chunkBlocks: 10, now: () => nowMs }, silentLogger);
    r.workspaces.ensure(WS2, nowMs);
    r.budgets.upsertOpened({ budgetId: 1, owner: WS2, workspace: WS2, cap: 10n ** 21n, deadline: 1_700_000_000 + 7200, openedBlock: 1, now: nowMs });
    r.budgets.setHeadroom(1, 10n ** 21n, 5_000_000n, null, nowMs);
    r.usage.insert(usageRow('u1', 3n, nowMs));
    r.ledger.insert({ workspace: WS2, kind: 'debit', amountMicro: -3n, refType: 'usage', refId: 'u1', memo: null, createdAt: nowMs });
    const drawer = new BudgetDrawer(r, chain, chain, { chainId: 31337, creditDesk: DESK, decimals: 18, thresholdMicro: 1n, dryRun: false, now: () => nowMs }, silentLogger);
    const [a] = await drawer.tick();
    expect(a?.status).toBe('confirmed');
    expect(r.budgetDraws.get(a!.drawId!)?.status).toBe('confirmed');
    expect(r.usage.get('u1')?.drawId).toBe(a!.drawId);
    expect(r.ledger.balance(WS2)).toBe(0n);
    expect(await drawer.tick()).toEqual([]);
    expect(chain.draws).toHaveLength(1);
  });

  it('reconciles in-flight rows left by a crash: stale pending → failed, reverted → failed, mined → kept, unknown → failed after the grace', async () => {
    const r = repos();
    const chain = new FakeChain();
    let nowMs = 1_700_000_000_000;
    r.workspaces.ensure(WS2, nowMs);
    r.workspaces.ensure(WS1, nowMs);
    r.budgets.upsertOpened({ budgetId: 1, owner: WS2, workspace: WS2, cap: 10n ** 21n, deadline: 1_700_000_000 + 7200, openedBlock: 1, now: nowMs });
    r.budgets.setHeadroom(1, 10n ** 21n, 5_000_000n, null, nowMs);
    r.usage.insert(usageRow('u1', 5n, nowMs));
    r.ledger.insert({ workspace: WS2, kind: 'debit', amountMicro: -5n, refType: 'usage', refId: 'u1', memo: null, createdAt: nowMs });
    // An orphaned pending row (insert happened, the process died before `draw` was sent).
    const orphan = r.budgetDraws.insert({ budgetId: 1, workspace: WS2, tokenAmount: 500n, usdMicro: 5n, receiptHash: '0x01', usageIds: ['u1'], batchJson: '{}', txHash: null, status: 'pending', error: null, createdAt: nowMs - 1000, updatedAt: nowMs - 1000 });
    r.usage.setDrawId(['u1'], orphan);
    const drawer = new BudgetDrawer(r, chain, chain, { chainId: 31337, creditDesk: DESK, decimals: 18, thresholdMicro: 1n, dryRun: false, pendingGraceMs: 60_000, sentGraceMs: 600_000, now: () => nowMs }, silentLogger);
    expect(await drawer.tick()).toEqual([]); // blocked while the orphan is young
    nowMs += 61_000;
    const attempts = await drawer.tick(); // orphan fails and releases u1, then a fresh draw goes out
    expect(r.budgetDraws.get(orphan)).toMatchObject({ status: 'failed' });
    expect(r.budgetDraws.get(orphan)?.error).toContain('no transaction sent');
    expect(attempts).toEqual([]); // the budget is stalled (draw_failed) until the next headroom refresh
    expect(r.budgets.get(1)?.stalledReason).toBe('draw_failed');
    expect(r.usage.get('u1')?.drawId).toBeNull();
    r.budgets.setStalled(1, null, nowMs);
    const [fresh] = await drawer.tick();
    expect(fresh?.status).toBe('sent');
    expect(r.usage.get('u1')?.drawId).toBe(fresh!.drawId);
    // Sent rows of another workspace: reverted → failed; mined → untouched; unknown → failed after the grace.
    r.budgets.upsertOpened({ budgetId: 2, owner: WS1, workspace: WS1, cap: 10n ** 21n, deadline: 1_700_000_000 + 7200, openedBlock: 1, now: nowMs });
    const reverted = r.budgetDraws.insert({ budgetId: 2, workspace: WS1, tokenAmount: 1n, usdMicro: 1n, receiptHash: '0x02', usageIds: ['x1'], batchJson: '{}', txHash: '0xaa', status: 'sent', error: null, createdAt: nowMs, updatedAt: nowMs });
    const mined = r.budgetDraws.insert({ budgetId: 2, workspace: WS1, tokenAmount: 1n, usdMicro: 1n, receiptHash: '0x03', usageIds: ['x2'], batchJson: '{}', txHash: '0xbb', status: 'sent', error: null, createdAt: nowMs, updatedAt: nowMs });
    const unknown = r.budgetDraws.insert({ budgetId: 2, workspace: WS1, tokenAmount: 1n, usdMicro: 1n, receiptHash: '0x04', usageIds: ['x3'], batchJson: '{}', txHash: '0xcc', status: 'sent', error: null, createdAt: nowMs, updatedAt: nowMs });
    chain.receipts.set('0xaa', { status: 'reverted', blockNumber: 1n });
    chain.receipts.set('0xbb', { status: 'success', blockNumber: 1n });
    await drawer.reconcile();
    expect(r.budgetDraws.get(reverted)?.status).toBe('failed');
    expect(r.budgetDraws.get(mined)?.status).toBe('sent');
    expect(r.budgetDraws.get(unknown)?.status).toBe('sent');
    nowMs += 600_001;
    await drawer.reconcile();
    expect(r.budgetDraws.get(mined)?.status).toBe('sent');
    expect(r.budgetDraws.get(unknown)?.status).toBe('failed');
    expect(r.budgetDraws.get(unknown)?.error).toContain('not seen by the node');
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

  it('poster re-posts a flat price before the on-chain quote goes stale (keep-alive)', async () => {
    const r = repos();
    const chain = new FakeChain(); // maxPriceAge 3600, price $0.01
    let nowSec = 1_700_000_000;
    const fetchImpl = async (): Promise<Response> => new Response(JSON.stringify({ priceUsd: 0.01 }), { status: 200 });
    const poster = new PricePoster(r, chain, chain, { feedUrl: 'https://feed.example/price', dryRun: false, fetch: fetchImpl, postIntervalMs: 300_000, now: () => nowSec * 1000 }, silentLogger);
    // Fresh quote, identical feed price → the 0.5 % band skips.
    chain.priceUpdatedAt = nowSec - 2999;
    expect(await poster.tick()).toEqual({ action: 'skipped', reason: 'change below 0.5%' });
    // Within two post intervals of maxPriceAge → posted even though nothing changed.
    chain.priceUpdatedAt = nowSec - 3000;
    const posted = await poster.tick();
    expect(posted).toMatchObject({ action: 'posted', priceE18: 10n ** 16n, keepAlive: true });
    expect(r.pricePosts.latest()).toMatchObject({ priceE18: 10n ** 16n, status: 'sent' });
    // Already stale (> maxPriceAge) → still posted.
    chain.priceUpdatedAt = nowSec - 3700;
    expect(await poster.tick()).toMatchObject({ action: 'posted', keepAlive: true });
    // The keep-alive never bypasses minInterval (the contract would revert).
    chain.priceUpdatedAt = nowSec - 30;
    expect(await poster.tick()).toEqual({ action: 'skipped', reason: 'within minInterval' });
    expect(needsKeepAlive(1000, 0, 3600, 300_000)).toBe(false);
    expect(needsKeepAlive(4000, 1000, 3600, 300_000)).toBe(true);
    expect(needsKeepAlive(3999, 1000, 3600, 300_000)).toBe(false);
    nowSec += 1;
  });
});
