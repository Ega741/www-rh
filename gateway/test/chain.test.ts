import { DrawBatchSchema } from '@beagle/shared/api';
import { COMPUTE_BUDGET_PROGRAM_ID, MEMO_PROGRAM_ID, resolveDeployment, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@beagle/shared/addresses';
import { receiptHash } from '@beagle/shared/canonical';
import { tokensForUsdMicro } from '@beagle/shared/credit';
import { encodeDrawMemo } from '@beagle/shared/memo';
import { describe, expect, it } from 'vitest';
import { configDto } from '../src/api/dto.js';
import { BudgetRegisterError, BudgetScanner, budgetScanFilters, computeHeadroom } from '../src/chain/budgets.js';
import { BudgetDrawer, buildDrawInstructions, selectBatch } from '../src/chain/drawer.js';
import { extractBurns, extractMemo, flattenInstructions, Indexer, resolveOwner, type IndexerOptions } from '../src/chain/indexer.js';
import { PriceService, usdToPriceE18, type PriceServiceOptions } from '../src/chain/price.js';
import { ChainConfigError, parseMintAccount, parseTokenAccount, TransactionRejectedError, verifyMint, type RpcParsedAccount, type RpcParsedTransaction, type RpcSignatureInfo } from '../src/chain/rpc.js';
import { testConfig } from '../src/config.js';
import { Repos, type UsageRow } from '../src/db/repos.js';
import { migrate } from '../src/db/schema.js';
import { Db } from '../src/db/sqlite.js';
import { createLogger, silentLogger } from '../src/log.js';
import { createServices } from '../src/services.js';
import { ATA1, ATA2, FakeRpc, fixture, makeBurnTx, makeTokenAccount, META, MINT, OPERATOR, testPubkey, testSignature, WS1, WS2 } from './helpers.js';

const T0 = 1_791_808_200_000; // ms, just after the fixtures' block times
const PRICE = 10n ** 16n; // $0.01

function repos(): Repos {
  const db = new Db(':memory:');
  migrate(db);
  return new Repos(db);
}

function priceService(r: Repos, now: () => number, overrides: Partial<PriceServiceOptions> = {}): PriceService {
  const svc = new PriceService(
    r,
    { source: 'manual', initialPriceE18: PRICE, jupiterUrl: 'https://jup.test/price/v3', mint: MINT, minChangeBps: 50, maxStepBps: 2500, maxAgeS: 3600, decimals: 6, now, ...overrides },
    silentLogger,
  );
  svc.init();
  return svc;
}

function indexer(r: Repos, rpc: FakeRpc, price: PriceService, overrides: Partial<IndexerOptions> = {}): Indexer {
  return new Indexer(
    r,
    rpc,
    price,
    { mint: MINT, operator: OPERATOR, decimals: 6, pageLimit: 1000, fetchConcurrency: 2, indexFromSignature: undefined, creditWhenStale: true, minCreditMicro: 1000n, now: () => T0, ...overrides },
    silentLogger,
  );
}

function scanner(r: Repos, rpc: FakeRpc, price: PriceService, now: () => number = () => T0): BudgetScanner {
  return new BudgetScanner(r, rpc, price, { mint: MINT, operator: OPERATOR, tokenProgram: TOKEN_PROGRAM_ID, decimals: 6, now }, silentLogger);
}

function drawer(r: Repos, rpc: FakeRpc, price: PriceService, now: () => number = () => T0, extra: { dryRun?: boolean; thresholdMicro?: bigint; priorityFee?: number; writer?: boolean; pendingGraceMs?: number } = {}): BudgetDrawer {
  return new BudgetDrawer(
    r,
    rpc,
    extra.writer === false ? undefined : rpc,
    price,
    {
      cluster: 'localnet',
      mint: MINT,
      tokenProgram: TOKEN_PROGRAM_ID,
      memoProgram: MEMO_PROGRAM_ID,
      operator: OPERATOR,
      decimals: 6,
      thresholdMicro: extra.thresholdMicro ?? 1n,
      priorityFeeMicrolamports: extra.priorityFee ?? 0,
      confirmTimeoutMs: 1000,
      dryRun: extra.dryRun ?? false,
      now,
      ...(extra.pendingGraceMs === undefined ? {} : { pendingGraceMs: extra.pendingGraceMs }),
    },
    silentLogger,
  );
}

/** A budget row for `tokenAccount` with a fresh headroom. */
function openBudget(r: Repos, tokenAccount: string, owner: string, cap: bigint, balance: bigint, headroomMicro: bigint, workspace?: string): void {
  r.workspaces.ensure(owner, T0);
  r.budgets.upsert({ tokenAccount, owner, delegate: OPERATOR, cap, balance, now: T0, ...(workspace === undefined ? {} : { workspace }) });
  r.budgets.setHeadroom(tokenAccount, cap < balance ? cap : balance, headroomMicro, null, T0);
}

function usageRow(id: string, charged: bigint, createdAt: number, workspace = WS2): UsageRow {
  return {
    id,
    workspace,
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

/** Puts a credit-paid debt of `micro` on `workspace` (usage rows + ledger debit). */
function debt(r: Repos, workspace: string, rows: { id: string; charged: bigint }[]): void {
  r.workspaces.ensure(workspace, T0);
  let total = 0n;
  rows.forEach((row, i) => {
    r.usage.insert(usageRow(row.id, row.charged, T0 - rows.length + i, workspace));
    total += row.charged;
  });
  r.ledger.insert({ workspace, kind: 'debit', amountMicro: -total, refType: 'usage', refId: rows.map((x) => x.id).join(','), memo: null, createdAt: T0 });
}

const txFixtures = (): Map<string, RpcParsedTransaction> =>
  new Map(
    ['tx-transfer', 'tx-burn', 'tx-burnchecked-memo', 'tx-approve', 'tx-draw', 'tx-two-burns'].map((name) => {
      const tx = fixture<RpcParsedTransaction>(name);
      return [tx.transaction.signatures[0] as string, tx];
    }),
  );

describe('jsonParsed parsing (validator fixtures)', () => {
  it('extracts burn / burnChecked of the mint with amounts, authority, flattened index and owner', () => {
    const burn = fixture<RpcParsedTransaction>('tx-burn');
    expect(extractBurns(burn, MINT)).toEqual([{ ixIndex: 0, program: 'spl-token', type: 'burn', tokenAccount: ATA1, authority: WS1, amount: 1_000_000n }]);
    expect(resolveOwner(burn, ATA1)).toBe(WS1);
    expect(extractMemo(burn)).toBeNull();

    const checked = fixture<RpcParsedTransaction>('tx-burnchecked-memo');
    expect(extractBurns(checked, MINT)).toEqual([{ ixIndex: 0, program: 'spl-token', type: 'burnChecked', tokenAccount: ATA1, authority: WS1, amount: 1_000_000_000n }]);
    expect(extractMemo(checked)).toBe(META.purchaseMemo);

    const draw = fixture<RpcParsedTransaction>('tx-draw');
    expect(extractBurns(draw, MINT)).toEqual([{ ixIndex: 1, program: 'spl-token', type: 'burnChecked', tokenAccount: ATA2, authority: OPERATOR, amount: 7_000_000n }]);
    expect(resolveOwner(draw, ATA2)).toBe(WS2);
    expect(extractMemo(draw)).toBe(META.drawMemo);

    const two = fixture<RpcParsedTransaction>('tx-two-burns');
    expect(extractBurns(two, MINT).map((b) => [b.ixIndex, b.type, b.amount])).toEqual([
      [0, 'burnChecked', 2_000_000n],
      [2, 'burn', 3_000_000n],
    ]);
    expect(extractMemo(two)).toBe('hello world');
    expect(extractBurns(two, testPubkey(9))).toEqual([]); // another mint
  });

  it('walks inner instructions in order and ignores transfers, approvals and revokes', () => {
    const transfer = fixture<RpcParsedTransaction>('tx-transfer');
    expect(flattenInstructions(transfer).map((ix) => (ix.parsed as { type?: string } | undefined)?.type)).toEqual([
      'createIdempotent',
      'getAccountDataSize',
      'createAccount',
      'initializeImmutableOwner',
      'initializeAccount3',
      'transferChecked',
    ]);
    expect(extractBurns(transfer, MINT)).toEqual([]);
    expect(extractBurns(fixture<RpcParsedTransaction>('tx-approve'), MINT)).toEqual([]);
    expect(extractBurns(fixture<RpcParsedTransaction>('tx-revoke'), MINT)).toEqual([]);
    // An inner burn counts, with the flattened index.
    const inner = makeBurnTx({ signature: testSignature(1), slot: 1, tokenAccount: ATA1, owner: WS1, amount: 5n });
    const outer: RpcParsedTransaction = {
      ...inner,
      transaction: { ...inner.transaction, message: { ...inner.transaction.message, instructions: [{ programId: testPubkey(3), accounts: [], data: 'xx' }] } },
      meta: { ...inner.meta!, innerInstructions: [{ index: 0, instructions: inner.transaction.message.instructions }] },
    };
    expect(extractBurns(outer, MINT)).toEqual([{ ixIndex: 1, program: 'spl-token', type: 'burnChecked', tokenAccount: ATA1, authority: WS1, amount: 5n }]);
    expect(resolveOwner(outer, ATA1)).toBe(WS1);
    expect(resolveOwner(outer, testPubkey(4))).toBeUndefined();
  });

  it('parses token accounts (delegated, revoked, missing) and the mint', () => {
    const delegated = fixture<{ value: (RpcParsedAccount | null)[] }>('token-accounts-delegated').value;
    expect(parseTokenAccount(ATA2, delegated[0])).toEqual({ address: ATA2, mint: MINT, owner: WS2, amount: 100_000_000_000n, delegate: OPERATOR, delegatedAmount: 500_000_000n, programId: TOKEN_PROGRAM_ID });
    expect(parseTokenAccount(ATA1, delegated[1])).toMatchObject({ owner: WS1, delegate: null, delegatedAmount: 0n, amount: 98_999_000_000n });
    expect(parseTokenAccount(testPubkey(5), delegated[2])).toBeUndefined();
    const revoked = fixture<{ value: (RpcParsedAccount | null)[] }>('token-accounts-revoked').value;
    expect(parseTokenAccount(ATA2, revoked[0])).toMatchObject({ delegate: null, delegatedAmount: 0n, amount: 99_993_000_000n });
    const mint = fixture<{ value: RpcParsedAccount }>('mint-account').value;
    expect(parseMintAccount(mint)).toEqual({ decimals: 6, supply: 999_998_987_000_000n, programId: TOKEN_PROGRAM_ID });
    expect(parseMintAccount(delegated[0])).toBeUndefined();
    expect(parseTokenAccount(ATA1, mint)).toBeUndefined();
    const gpa = fixture<{ pubkey: string; account: RpcParsedAccount }[]>('gpa-delegated');
    expect(gpa.map((e) => e.pubkey)).toEqual([ATA2]);
    expect(delegated[0]).toMatchObject(makeTokenAccount({ owner: WS2, amount: 100_000_000_000n, delegate: OPERATOR, delegatedAmount: 500_000_000n }));
  });
});

describe('indexer', () => {
  it('indexes the captured session: purchases, memo credit, orphan draw, two burns in one tx; idempotent; cursor', async () => {
    const r = repos();
    const rpc = new FakeRpc();
    const txs = txFixtures();
    for (const [sig, tx] of txs) rpc.transactions.set(sig, tx);
    rpc.signatures = fixture<RpcSignatureInfo[]>('signatures-for-mint').filter((s) => txs.has(s.signature));
    rpc.slot = 130;
    const lines: string[] = [];
    const price = priceService(r, () => T0);
    const ix = new Indexer(
      r,
      rpc,
      price,
      { mint: MINT, operator: OPERATOR, decimals: 6, pageLimit: 1000, fetchConcurrency: 2, indexFromSignature: undefined, creditWhenStale: true, minCreditMicro: 1000n, now: () => T0 },
      createLogger({ level: 'warn', write: (l) => lines.push(l) }),
    );
    expect(ix.status()).toEqual({ lastSignature: null, lastSlot: null, headSlot: 0, lagSlots: 0, lastEventAt: null });

    const res = await ix.step();
    expect(res).toEqual({ processed: 6, events: 5 });
    expect(r.ledger.balance(WS1)).toBe(10_000n + 20_000n + 30_000n);
    expect(r.ledger.balance(WS2)).toBe(10_000_000n + 70_000n);
    const purchase = r.creditEvents.get(META.sigs.burnCheckedSig, 0)!;
    expect(purchase).toMatchObject({ kind: 'purchase', workspace: WS2, payer: WS1, tokenAccount: ATA1, authority: WS1, tokenAmount: 1_000_000_000n, usdMicro: 10_000_000n, priceE18: PRICE, pricePointId: 1, priceStale: false, memo: META.purchaseMemo, receiptHash: null, slot: 125, blockTime: 1_791_808_152 });
    expect(r.creditEvents.get(META.sigs.burnSig, 0)).toMatchObject({ kind: 'purchase', workspace: WS1, payer: WS1, usdMicro: 10_000n, memo: null });
    expect(r.creditEvents.get(META.sigs.drawSig, 1)).toMatchObject({ kind: 'draw', workspace: WS2, payer: WS2, authority: OPERATOR, tokenAmount: 7_000_000n, usdMicro: 70_000n, receiptHash: META.hash, memo: META.drawMemo });
    expect(lines.some((l) => l.includes('orphan_draw'))).toBe(true);
    expect(r.creditEvents.get(META.sigs.twoSig, 0)).toMatchObject({ usdMicro: 20_000n, memo: 'hello world', workspace: WS1 });
    expect(r.creditEvents.get(META.sigs.twoSig, 2)).toMatchObject({ usdMicro: 30_000n, workspace: WS1 });
    expect(r.creditEvents.get(META.sigs.twoSig, 1)).toBeUndefined();
    expect(r.ledger.hasRef('credit_event', `${META.sigs.twoSig}:2`)).toBe(true);
    // The poll reached the cursor, so the indexer is in sync with head 130 although the newest burn is at slot 128.
    expect(ix.status()).toEqual({ lastSignature: META.sigs.twoSig, lastSlot: 128, headSlot: 130, lagSlots: 0, lastEventAt: T0 });
    expect(r.creditEvents.list(WS1, 10).map((e) => [e.signature, e.ixIndex])).toEqual([
      [META.sigs.twoSig, 2],
      [META.sigs.twoSig, 0],
      [META.sigs.burnSig, 0],
    ]);
    // Transactions were fetched oldest first, in pairs.
    const fetched = rpc.calls.filter((c) => c.method === 'getParsedTransaction').map((c) => c.args[0]);
    expect(fetched).toEqual([META.sigs.transferSig, META.sigs.burnSig, META.sigs.burnCheckedSig, META.sigs.approveSig, META.sigs.drawSig, META.sigs.twoSig]);

    // Nothing new: the next poll asks for signatures until the cursor and applies nothing.
    rpc.calls.length = 0;
    expect(await ix.step()).toBeUndefined();
    expect(rpc.calls[0]).toEqual({ method: 'getSignaturesForAddress', args: [MINT, { limit: 1000, until: META.sigs.twoSig }] });
    // Re-applying a transaction is a no-op.
    expect(await ix.applyParsedTransaction(META.sigs.burnSig, txs.get(META.sigs.burnSig)!)).toBe(0);
    expect(r.ledger.balance(WS1)).toBe(60_000n);
    // A quiet mint is not lagging: the head moves on, polls find nothing new, the lag stays 0.
    rpc.slot = 5_000;
    expect(await ix.step()).toBeUndefined();
    expect(ix.status()).toMatchObject({ lastSlot: 128, headSlot: 5_000, lagSlots: 0 });
    // A poll that cannot finish (transaction not yet available) leaves the synced slot behind: the lag grows.
    rpc.signatures = [{ signature: 'pendingSig1111111111111111111111111111111111111111111111111111111111111111111111111', slot: 5_001, err: null, blockTime: null, memo: null, confirmationStatus: 'confirmed' } as RpcSignatureInfo, ...rpc.signatures];
    rpc.slot = 5_050;
    await ix.step();
    expect(ix.status()).toMatchObject({ headSlot: 5_050, lagSlots: 50 });
  });

  it('first run takes only the newest page; INDEX_FROM_SIGNATURE pages everything after it; failed txs advance the cursor', async () => {
    const r = repos();
    const rpc = new FakeRpc();
    const price = priceService(r, () => T0);
    const sigs: string[] = [];
    for (let i = 1; i <= 5; i++) {
      sigs.push(rpc.addTransaction(makeBurnTx({ signature: testSignature(i), slot: 100 + i, tokenAccount: ATA1, owner: WS1, amount: BigInt(i) * 1_000_000n })));
    }
    // Fresh database, no INDEX_FROM_SIGNATURE: the newest 2 only.
    const fresh = indexer(r, rpc, price, { pageLimit: 2 });
    expect(await fresh.step()).toEqual({ processed: 2, events: 2 });
    expect(r.ledger.balance(WS1)).toBe(40_000n + 50_000n);
    expect(fresh.lastSignature()).toBe(sigs[4]);
    expect(rpc.calls.filter((c) => c.method === 'getSignaturesForAddress')).toHaveLength(1);

    // Another database with INDEX_FROM_SIGNATURE = the first burn: pages backwards with `before` until `until`.
    const r2 = repos();
    const price2 = priceService(r2, () => T0);
    rpc.calls.length = 0;
    const from = indexer(r2, rpc, price2, { pageLimit: 2, indexFromSignature: sigs[0] });
    expect(await from.step()).toEqual({ processed: 4, events: 4 });
    expect(r2.ledger.balance(WS1)).toBe(20_000n + 30_000n + 40_000n + 50_000n);
    const pages = rpc.calls.filter((c) => c.method === 'getSignaturesForAddress').map((c) => c.args[1]);
    expect(pages).toEqual([
      { limit: 2, until: sigs[0] },
      { limit: 2, until: sigs[0], before: sigs[3] },
      { limit: 2, until: sigs[0], before: sigs[1] },
    ]);
    // A failed transaction is skipped but moves the cursor.
    const failed = rpc.addTransaction(makeBurnTx({ signature: testSignature(6), slot: 106, tokenAccount: ATA1, owner: WS1, amount: 1n, err: { InstructionError: [0, 'Custom'] } }));
    expect(await from.step()).toEqual({ processed: 1, events: 0 });
    expect(from.lastSignature()).toBe(failed);
    expect(r2.creditEvents.get(failed, 0)).toBeUndefined();
  });

  it('stops at a transaction the RPC cannot serve yet and resumes from the cursor; owner falls back to getAccountInfo', async () => {
    const r = repos();
    const rpc = new FakeRpc();
    const price = priceService(r, () => T0);
    const ix = indexer(r, rpc, price);
    const first = rpc.addTransaction(makeBurnTx({ signature: testSignature(11), slot: 111, tokenAccount: ATA1, owner: WS1, amount: 1_000_000n }));
    const pending = testSignature(12);
    rpc.addPendingSignature(pending, 112);
    rpc.addTransaction(makeBurnTx({ signature: testSignature(13), slot: 113, tokenAccount: ATA1, owner: WS1, amount: 2_000_000n }));
    expect(await ix.step()).toEqual({ processed: 1, events: 1 });
    expect(ix.lastSignature()).toBe(first);
    expect(r.ledger.balance(WS1)).toBe(10_000n);
    // The transaction becomes available: a burn whose preTokenBalances lack the owner → account lookup.
    const tx = makeBurnTx({ signature: pending, slot: 112, tokenAccount: ATA2, owner: WS2, amount: 3_000_000n });
    tx.meta!.preTokenBalances = [];
    tx.meta!.postTokenBalances = [];
    rpc.transactions.set(pending, tx);
    rpc.accounts.set(ATA2, makeTokenAccount({ owner: WS2, amount: 1n }));
    expect(await ix.step()).toEqual({ processed: 2, events: 2 });
    expect(r.creditEvents.get(pending, 0)).toMatchObject({ workspace: WS2, payer: WS2 });
    expect(r.ledger.balance(WS1)).toBe(30_000n);
    expect(ix.lastSignature()).toBe(testSignature(13));
  });

  it('applies the dust guard, credits at a stale price when allowed and defers otherwise', async () => {
    const r = repos();
    const rpc = new FakeRpc();
    let nowMs = T0;
    const price = priceService(r, () => nowMs);
    const ix = indexer(r, rpc, price, { now: () => nowMs });
    rpc.addTransaction(makeBurnTx({ signature: testSignature(21), slot: 121, tokenAccount: ATA1, owner: WS1, amount: 50_000n })); // $0.0005 < MIN_CREDIT_USD
    await ix.step();
    expect(r.creditEvents.get(testSignature(21), 0)).toMatchObject({ usdMicro: 0n });
    expect(r.ledger.balance(WS1)).toBe(0n);
    expect(r.ledger.hasRef('credit_event', `${testSignature(21)}:0`)).toBe(false);

    nowMs += 3601 * 1000; // price is now stale
    rpc.addTransaction(makeBurnTx({ signature: testSignature(22), slot: 122, tokenAccount: ATA1, owner: WS1, amount: 1_000_000n }));
    await ix.step();
    expect(r.creditEvents.get(testSignature(22), 0)).toMatchObject({ usdMicro: 10_000n, priceStale: true });
    expect(r.ledger.balance(WS1)).toBe(10_000n);

    const strict = indexer(r, rpc, price, { now: () => nowMs, creditWhenStale: false });
    rpc.addTransaction(makeBurnTx({ signature: testSignature(23), slot: 123, tokenAccount: ATA1, owner: WS1, amount: 1_000_000n }));
    expect(await strict.step()).toEqual({ processed: 0, events: 0 });
    expect(strict.lastSignature()).toBe(testSignature(22));
    price.set(PRICE); // fresh point → the deferred burn is applied
    expect(await strict.step()).toEqual({ processed: 1, events: 1 });
    expect(r.ledger.balance(WS1)).toBe(20_000n);

    // No price point at all (feed source, nothing fetched yet) → deferred as well.
    const r2 = repos();
    const empty = priceService(r2, () => nowMs, { source: 'feed', feedUrl: 'https://feed.test/p' });
    const rpc2 = new FakeRpc();
    rpc2.addTransaction(makeBurnTx({ signature: testSignature(24), slot: 124, tokenAccount: ATA1, owner: WS1, amount: 1_000_000n }));
    const noPrice = indexer(r2, rpc2, empty, { now: () => nowMs });
    expect(await noPrice.step()).toEqual({ processed: 0, events: 0 });
    expect(noPrice.lastSignature()).toBeUndefined();
  });

  it('confirms a draw by memo hash: batch price, confirmed status, signature, usage rows claimed', async () => {
    const r = repos();
    const rpc = new FakeRpc();
    const price = priceService(r, () => T0);
    const ix = indexer(r, rpc, price);
    openBudget(r, ATA2, WS2, 500_000_000n, 100_000_000_000n, 5_000_000n);
    r.usage.insert(usageRow('u1', 35_000n, T0 - 1));
    r.ledger.insert({ workspace: WS2, kind: 'debit', amountMicro: -35_000n, refType: 'usage', refId: 'u1', memo: null, createdAt: T0 });
    const batchPrice = 5n * 10n ** 15n; // $0.005
    const drawId = r.budgetDraws.insert({
      tokenAccount: ATA2,
      workspace: WS2,
      tokenAmount: 7_000_000n,
      usdMicro: 35_000n,
      receiptHash: META.hash,
      usageIds: ['u1'],
      batchJson: JSON.stringify({ v: 1, cluster: 'localnet', mint: MINT, tokenAccount: ATA2, workspace: WS2, usageIds: ['u1'], amountMicro: '35000', priceE18: batchPrice.toString(), pricePointId: 7 }),
      signature: null,
      lastValidBlockHeight: null,
      status: 'failed',
      error: 'gave up',
      createdAt: T0,
      updatedAt: T0,
    });
    rpc.addTransaction(fixture<RpcParsedTransaction>('tx-draw'));
    expect(await ix.step()).toEqual({ processed: 1, events: 1 });
    expect(r.creditEvents.get(META.sigs.drawSig, 1)).toMatchObject({ kind: 'draw', workspace: WS2, usdMicro: 35_000n, priceE18: batchPrice, pricePointId: 7, priceStale: false, receiptHash: META.hash });
    expect(r.budgetDraws.get(drawId)).toMatchObject({ status: 'confirmed', signature: META.sigs.drawSig, error: null });
    expect(r.usage.get('u1')?.drawId).toBe(drawId);
    expect(r.ledger.balance(WS2)).toBe(0n);
    // A delegate burn by someone other than the operator, or without a draw memo, is a purchase for the owner.
    rpc.addTransaction(makeBurnTx({ signature: testSignature(31), slot: 131, tokenAccount: ATA2, owner: WS2, authority: testPubkey(8), amount: 1_000_000n, memo: META.drawMemo }));
    rpc.addTransaction(makeBurnTx({ signature: testSignature(32), slot: 132, tokenAccount: ATA2, owner: WS2, authority: OPERATOR, amount: 1_000_000n }));
    await ix.step();
    expect(r.creditEvents.get(testSignature(31), 0)).toMatchObject({ kind: 'purchase', workspace: WS2, authority: testPubkey(8) });
    expect(r.creditEvents.get(testSignature(32), 0)).toMatchObject({ kind: 'purchase', workspace: WS2, authority: OPERATOR });
    expect(r.ledger.balance(WS2)).toBe(20_000n);
  });

  it('finality sweep: a finalized signature leaves the sweep set; a missing one is corroborated and reverted only after consecutive misses', async () => {
    const r = repos();
    const rpc = new FakeRpc();
    let nowMs = T0;
    const price = priceService(r, () => nowMs);
    const ix = indexer(r, rpc, price, { now: () => nowMs });
    const s1 = rpc.addTransaction(makeBurnTx({ signature: testSignature(41), slot: 150, tokenAccount: ATA1, owner: WS1, amount: 1_000_000n }));
    const s2 = rpc.addTransaction(makeBurnTx({ signature: testSignature(42), slot: 151, tokenAccount: ATA1, owner: WS1, amount: 2_000_000n }));
    // A confirmed draw that will be dropped too.
    openBudget(r, ATA2, WS2, 500_000_000n, 100_000_000_000n, 5_000_000n);
    r.usage.insert(usageRow('u1', 3n, T0 - 1));
    r.ledger.insert({ workspace: WS2, kind: 'debit', amountMicro: -3n, refType: 'usage', refId: 'u1', memo: null, createdAt: T0 });
    const batch = { v: 1, cluster: 'localnet', mint: MINT, tokenAccount: ATA2, workspace: WS2, usageIds: ['u1'], amountMicro: '3', priceE18: PRICE.toString(), pricePointId: 1 };
    const hash = receiptHash(batch);
    const drawId = r.budgetDraws.insert({ tokenAccount: ATA2, workspace: WS2, tokenAmount: 300n, usdMicro: 3n, receiptHash: hash, usageIds: ['u1'], batchJson: JSON.stringify(batch), signature: testSignature(43), lastValidBlockHeight: 400, status: 'sent', error: null, createdAt: T0, updatedAt: T0 });
    r.usage.setDrawId(['u1'], drawId);
    const s3 = rpc.addTransaction(makeBurnTx({ signature: testSignature(43), slot: 152, tokenAccount: ATA2, owner: WS2, authority: OPERATOR, amount: 300n, memo: encodeDrawMemo({ workspace: WS2, receiptHash: hash }) }));
    await ix.step();
    expect(r.ledger.balance(WS1)).toBe(30_000n);
    expect(r.ledger.balance(WS2)).toBe(0n);
    expect(r.budgetDraws.get(drawId)?.status).toBe('confirmed');
    // Young events are not checked yet.
    expect(await ix.sweepFinality()).toEqual({ checked: 0, reverted: [], finalized: 0 });
    nowMs += 3 * 60_000;
    // s1 and s3 vanish from the RPC entirely (status null, getTransaction null); s2 is healthy.
    rpc.transactions.delete(s1);
    rpc.transactions.delete(s3);
    expect(await ix.sweepFinality()).toEqual({ checked: 3, reverted: [], finalized: 1 });
    // One answer never reverts a credit: balances intact, misses counted, s2 marked finalized and out of the set.
    expect(r.ledger.balance(WS1)).toBe(30_000n);
    expect(r.ledger.balance(WS2)).toBe(0n);
    expect(r.budgetDraws.get(drawId)?.status).toBe('confirmed');
    expect(r.creditEvents.get(s1, 0)).toMatchObject({ finalityMisses: 1, finalizedAt: null });
    expect(r.creditEvents.get(s2, 0)).toMatchObject({ finalityMisses: 0, finalizedAt: nowMs });
    expect(r.creditEvents.signaturesForSweep(0, nowMs, 10).map((c) => c.signature)).toEqual([s1, s3]);
    expect(await ix.sweepFinality()).toEqual({ checked: 2, reverted: [], finalized: 0 });
    expect(r.creditEvents.get(s1, 0)?.finalityMisses).toBe(2);
    expect(r.ledger.balance(WS1)).toBe(30_000n);
    // Third consecutive miss: reverted (credit events + ledger rows gone; the draw back to failed, its rows released).
    const swept = await ix.sweepFinality();
    expect(swept.checked).toBe(2);
    expect(swept.reverted.sort()).toEqual([s1, s3].sort());
    expect(r.creditEvents.get(s1, 0)).toBeUndefined();
    expect(r.ledger.hasRef('credit_event', `${s1}:0`)).toBe(false);
    expect(r.ledger.balance(WS1)).toBe(20_000n);
    expect(r.ledger.balance(WS2)).toBe(-3n);
    expect(r.budgetDraws.get(drawId)).toMatchObject({ status: 'failed' });
    expect(r.usage.get('u1')?.drawId).toBeNull();
    expect(r.budgets.get(ATA2)?.stalledReason).toBe('draw_failed');
    expect(await ix.sweepFinality()).toEqual({ checked: 0, reverted: [], finalized: 0 });

    // A single null from getSignatureStatuses (lagging / snapshot-restarted node) is corroborated by getTransaction: not even a miss.
    const s4 = rpc.addTransaction(makeBurnTx({ signature: testSignature(44), slot: 160, tokenAccount: ATA1, owner: WS1, amount: 1_000_000n }));
    await ix.step();
    expect(r.ledger.balance(WS1)).toBe(30_000n);
    nowMs += 3 * 60_000;
    rpc.statuses.set(s4, null);
    expect(await ix.sweepFinality()).toEqual({ checked: 1, reverted: [], finalized: 0 });
    expect(r.creditEvents.get(s4, 0)?.finalityMisses).toBe(0);
    // Both routes fail once, then the node catches up: the counter resets, the event is finalized, the credit stays.
    const tx4 = rpc.transactions.get(s4)!;
    rpc.transactions.delete(s4);
    expect(await ix.sweepFinality()).toEqual({ checked: 1, reverted: [], finalized: 0 });
    expect(r.creditEvents.get(s4, 0)?.finalityMisses).toBe(1);
    rpc.transactions.set(s4, tx4);
    rpc.statuses.delete(s4);
    expect(await ix.sweepFinality()).toEqual({ checked: 1, reverted: [], finalized: 1 });
    expect(r.creditEvents.get(s4, 0)).toMatchObject({ finalityMisses: 0, finalizedAt: nowMs });
    expect(r.ledger.balance(WS1)).toBe(30_000n);
    expect(await ix.sweepFinality()).toEqual({ checked: 0, reverted: [], finalized: 0 });

    // A transaction reported failed at finalized is reverted the same way (after the misses); a `confirmed` one keeps being checked.
    const s5 = rpc.addTransaction(makeBurnTx({ signature: testSignature(45), slot: 161, tokenAccount: ATA1, owner: WS1, amount: 1_000_000n }));
    const s6 = rpc.addTransaction(makeBurnTx({ signature: testSignature(46), slot: 162, tokenAccount: ATA1, owner: WS1, amount: 1_000_000n }));
    await ix.step();
    expect(r.ledger.balance(WS1)).toBe(50_000n);
    nowMs += 3 * 60_000;
    rpc.statuses.set(s5, { slot: 161, confirmations: null, err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'finalized' });
    rpc.transactions.get(s5)!.meta!.err = { InstructionError: [0, 'Custom'] };
    rpc.statuses.set(s6, { slot: 162, confirmations: 5, err: null, confirmationStatus: 'confirmed' });
    expect(await ix.sweepFinality()).toEqual({ checked: 2, reverted: [], finalized: 0 });
    expect(await ix.sweepFinality()).toEqual({ checked: 2, reverted: [], finalized: 0 });
    expect((await ix.sweepFinality()).reverted).toEqual([s5]);
    expect(r.ledger.balance(WS1)).toBe(40_000n);
    expect(r.creditEvents.signaturesForSweep(0, nowMs, 10).map((c) => c.signature)).toEqual([s6]);
    // Events outside the slot window are not re-checked.
    rpc.slot = 162 + 5000;
    await ix.step();
    expect(await ix.sweepFinality()).toEqual({ checked: 0, reverted: [], finalized: 0 });
    expect(r.ledger.balance(WS1)).toBe(40_000n);
  });

  it('a walk that hits the page cap queues the unfetched range as a backfill gap and drains it on later polls (no burn is skipped)', async () => {
    const r = repos();
    const rpc = new FakeRpc();
    const price = priceService(r, () => T0);
    const lines: string[] = [];
    const ix = new Indexer(
      r,
      rpc,
      price,
      { mint: MINT, operator: OPERATOR, decimals: 6, pageLimit: 1, fetchConcurrency: 2, indexFromSignature: undefined, creditWhenStale: true, minCreditMicro: 1000n, maxPages: 2, now: () => T0 },
      createLogger({ level: 'info', write: (l) => lines.push(l) }),
    );
    const sigs: string[] = [];
    sigs.push(rpc.addTransaction(makeBurnTx({ signature: testSignature(61), slot: 201, tokenAccount: ATA1, owner: WS1, amount: 1_000_000n })));
    expect(await ix.step()).toEqual({ processed: 1, events: 1 });
    expect(ix.lastSignature()).toBe(sigs[0]);
    for (let i = 2; i <= 6; i++) sigs.push(rpc.addTransaction(makeBurnTx({ signature: testSignature(60 + i), slot: 200 + i, tokenAccount: ATA1, owner: WS1, amount: BigInt(i) * 1_000_000n })));
    // Poll 1: the two newest pages (#6, #5) are applied and the cursor moves to #6; the rest (#2..#4) is queued, not skipped.
    expect(await ix.step()).toEqual({ processed: 2, events: 2 });
    expect(ix.lastSignature()).toBe(sigs[5]);
    expect(r.ledger.balance(WS1)).toBe(10_000n + 50_000n + 60_000n);
    expect(ix.backfillGaps()).toEqual([{ before: sigs[4], until: sigs[0], untilSlot: 201 }]);
    expect(lines.some((l) => l.includes('page cap reached'))).toBe(true);
    // Poll 2: nothing new at the head; two more pages of the gap (#4, #3), cursor untouched.
    expect(await ix.step()).toEqual({ processed: 2, events: 2 });
    expect(r.ledger.balance(WS1)).toBe(10_000n + 30_000n + 40_000n + 50_000n + 60_000n);
    expect(ix.backfillGaps()).toEqual([{ before: sigs[2], until: sigs[0], untilSlot: 201 }]);
    expect(ix.lastSignature()).toBe(sigs[5]);
    // Poll 3: #2, then `until` is reached: the gap is drained.
    expect(await ix.step()).toEqual({ processed: 1, events: 1 });
    expect(r.ledger.balance(WS1)).toBe(210_000n);
    expect(ix.backfillGaps()).toEqual([]);
    expect(await ix.step()).toBeUndefined();
    expect(r.creditEvents.list(WS1, 10)).toHaveLength(6);
  });

  it('a cursor signature the RPC no longer knows is resumed from its slot (not the whole history); an unknown INDEX_FROM_SIGNATURE is refused', async () => {
    const r = repos();
    const rpc = new FakeRpc();
    const price = priceService(r, () => T0);
    const ix = indexer(r, rpc, price);
    rpc.addTransaction(makeBurnTx({ signature: testSignature(71), slot: 90, tokenAccount: ATA1, owner: WS1, amount: 1_000_000n }));
    const s1 = rpc.addTransaction(makeBurnTx({ signature: testSignature(72), slot: 101, tokenAccount: ATA1, owner: WS1, amount: 1_000_000n }));
    await ix.step();
    expect(ix.lastSignature()).toBe(s1);
    expect(r.ledger.balance(WS1)).toBe(20_000n);
    // s1 is dropped at finality: the RPC forgets it and would hand back the whole history.
    rpc.signatures = rpc.signatures.filter((s) => s.signature !== s1);
    rpc.transactions.delete(s1);
    const s2 = rpc.addTransaction(makeBurnTx({ signature: testSignature(73), slot: 102, tokenAccount: ATA1, owner: WS1, amount: 2_000_000n }));
    rpc.calls.length = 0;
    expect(await ix.step()).toEqual({ processed: 1, events: 1 });
    expect(ix.lastSignature()).toBe(s2);
    expect(rpc.calls.filter((c) => c.method === 'getParsedTransaction').map((c) => c.args[0])).toEqual([s2]); // nothing older than the cursor's slot is re-fetched
    expect(r.ledger.balance(WS1)).toBe(40_000n);
    expect(ix.backfillGaps()).toEqual([]);

    // Fresh database with an INDEX_FROM_SIGNATURE the RPC does not know: refuse rather than index everything.
    const r2 = repos();
    const lines: string[] = [];
    const strict = new Indexer(
      r2,
      rpc,
      priceService(r2, () => T0),
      { mint: MINT, operator: OPERATOR, decimals: 6, pageLimit: 1000, fetchConcurrency: 2, indexFromSignature: testSignature(99), creditWhenStale: true, minCreditMicro: 1000n, now: () => T0 },
      createLogger({ level: 'error', write: (l) => lines.push(l) }),
    );
    rpc.calls.length = 0;
    expect(await strict.step()).toBeUndefined();
    expect(rpc.calls.some((c) => c.method === 'getSignaturesForAddress')).toBe(false);
    expect(lines.some((l) => l.includes('INDEX_FROM_SIGNATURE is unknown'))).toBe(true);
    expect(r2.ledger.balance(WS1)).toBe(0n);
  });

  it('defers the poll when the owner lookup fails at the RPC; a burn with neither owner nor authority is recorded without credit', async () => {
    const r = repos();
    class FlakyRpc extends FakeRpc {
      failAccounts: Error | undefined;
      override async getMultipleParsedAccounts(addresses: readonly string[]): Promise<(RpcParsedAccount | null)[]> {
        if (this.failAccounts) throw this.failAccounts;
        return super.getMultipleParsedAccounts(addresses);
      }
    }
    const rpc = new FlakyRpc();
    const price = priceService(r, () => T0);
    const ix = indexer(r, rpc, price);
    const tx = makeBurnTx({ signature: testSignature(81), slot: 181, tokenAccount: ATA2, owner: WS2, amount: 3_000_000n });
    tx.meta!.preTokenBalances = [];
    tx.meta!.postTokenBalances = [];
    rpc.addTransaction(tx);
    rpc.failAccounts = new Error('429 Too Many Requests');
    expect(await ix.step()).toEqual({ processed: 0, events: 0 });
    expect(ix.lastSignature()).toBeUndefined();
    expect(r.creditEvents.get(testSignature(81), 0)).toBeUndefined();
    rpc.failAccounts = undefined;
    rpc.accounts.set(ATA2, makeTokenAccount({ owner: WS2, amount: 1n }));
    expect(await ix.step()).toEqual({ processed: 1, events: 1 });
    expect(r.creditEvents.get(testSignature(81), 0)).toMatchObject({ workspace: WS2, payer: WS2, usdMicro: 30_000n });
    // Account gone and no authority in the instruction: recorded, nobody credited (no workspace invented from the address).
    const orphan = makeBurnTx({ signature: testSignature(82), slot: 182, tokenAccount: ATA1, owner: WS1, amount: 3_000_000n });
    orphan.meta!.preTokenBalances = [];
    orphan.meta!.postTokenBalances = [];
    delete (orphan.transaction.message.instructions[0]!.parsed as { info: Record<string, unknown> }).info['authority'];
    rpc.addTransaction(orphan);
    expect(await ix.step()).toEqual({ processed: 1, events: 1 });
    expect(r.creditEvents.get(testSignature(82), 0)).toMatchObject({ workspace: ATA1, payer: null, authority: null, usdMicro: 0n });
    expect(r.ledger.balance(ATA1)).toBe(0n);
  });
});

describe('mint verification (boot)', () => {
  const mintAccount = (decimals: number, programId: string = TOKEN_PROGRAM_ID): RpcParsedAccount => {
    const m = fixture<{ value: RpcParsedAccount }>('mint-account').value;
    const info = (m.data!.parsed as { info: Record<string, unknown> }).info;
    return { ...m, owner: programId, data: { ...m.data!, parsed: { type: 'mint', info: { ...info, decimals } } } };
  };

  it('adopts the chain decimals for an overridden mint before the workers exist, so every quote uses them', async () => {
    const rpc = new FakeRpc();
    rpc.accounts.set(MINT, mintAccount(9));
    const chain = rpc.context();
    chain.deployment = resolveDeployment('localnet', { mint: MINT }); // MINT_ADDRESS given: the record's decimals do not describe this mint
    expect(await verifyMint(chain, silentLogger)).toEqual({ status: 'verified', decimals: 9, tokenProgram: TOKEN_PROGRAM_ID });
    expect(chain.decimals).toBe(9);
    const services = createServices(testConfig({ INITIAL_PRICE_USD: '0.01' }), { logger: silentLogger, chain });
    try {
      expect(configDto(services).decimals).toBe(9);
      rpc.addTransaction(makeBurnTx({ signature: testSignature(91), slot: 191, tokenAccount: ATA1, owner: WS1, amount: 1_000_000_000n }));
      await services.indexer!.step();
      expect(services.repos.creditEvents.get(testSignature(91), 0)?.usdMicro).toBe(10_000n); // one whole 9-decimal token at $0.01 — not $10
      expect(services.ledger.balance(WS1)).toBe(10_000n);
      expect(services.price.quote({ tokens: 1_000_000_000n }).usdMicro).toBe('10000');
      rpc.accounts.set(ATA2, makeTokenAccount({ owner: WS2, amount: 10n ** 12n, delegate: OPERATOR, delegatedAmount: 10n ** 12n }));
      expect((await services.budgets!.register(ATA2)).headroomMicro).toBe(10_000_000n); // 1000 whole tokens = $10
    } finally {
      services.close();
    }
  });

  it('refuses to boot when the committed record or TOKEN_PROGRAM contradicts the mint account; keeps the config when the mint is unreadable', async () => {
    const rpc = new FakeRpc();
    rpc.accounts.set(MINT, mintAccount(9));
    await expect(verifyMint(rpc.context(), silentLogger)).rejects.toBeInstanceOf(ChainConfigError);
    rpc.accounts.set(MINT, mintAccount(6, TOKEN_2022_PROGRAM_ID));
    await expect(verifyMint(rpc.context(), silentLogger)).rejects.toThrow(/owned by/);
    const overridden = rpc.context();
    overridden.deployment = resolveDeployment('localnet', { mint: MINT, tokenProgram: TOKEN_PROGRAM_ID });
    await expect(verifyMint(overridden, silentLogger)).rejects.toThrow(/TOKEN_PROGRAM/);
    const adopt = rpc.context();
    adopt.deployment = resolveDeployment('localnet', { mint: MINT });
    expect(await verifyMint(adopt, silentLogger)).toEqual({ status: 'verified', decimals: 6, tokenProgram: TOKEN_2022_PROGRAM_ID });
    expect(adopt.tokenProgram).toBe(TOKEN_2022_PROGRAM_ID);
    rpc.accounts.delete(MINT);
    const untouched = rpc.context();
    expect(await verifyMint(untouched, silentLogger)).toEqual({ status: 'not_found' });
    expect(untouched.decimals).toBe(6);
  });
});

describe('budget scanner', () => {
  it('scans with the §3.4 getProgramAccounts filters and upserts budgets with headroom', async () => {
    const r = repos();
    const rpc = new FakeRpc();
    const price = priceService(r, () => T0);
    const gpa = fixture<{ pubkey: string; account: RpcParsedAccount }[]>('gpa-delegated');
    for (const e of gpa) rpc.accounts.set(e.pubkey, e.account);
    rpc.accounts.set(ATA1, makeTokenAccount({ owner: WS1, amount: 10n })); // not delegated → ignored
    rpc.accounts.set(testPubkey(6), makeTokenAccount({ owner: WS1, amount: 10n, delegate: testPubkey(7), delegatedAmount: 5n })); // another delegate → ignored
    const s = scanner(r, rpc, price);
    expect(await s.scan()).toBe(1);
    expect(rpc.calls[0]).toEqual({ method: 'getParsedProgramAccounts', args: [TOKEN_PROGRAM_ID, budgetScanFilters(MINT, OPERATOR)] });
    expect(budgetScanFilters(MINT, OPERATOR)).toEqual([{ dataSize: 165 }, { memcmp: { offset: 0, bytes: MINT } }, { memcmp: { offset: 76, bytes: OPERATOR } }]);
    const row = r.budgets.get(ATA2)!;
    expect(row).toMatchObject({ owner: WS2, workspace: WS2, delegate: OPERATOR, cap: 500_000_000n, balance: 100_000_000_000n, headroomTokens: 500_000_000n, headroomMicro: 5_000_000n, stalledReason: null, closed: false, registeredAt: null });
    expect(r.ledger.budgetHeadroom(WS2)).toBe(5_000_000n);
    expect(r.ledger.snapshot(WS2, T0)).toEqual({ balance: 0n, reserved: 0n, budgetHeadroom: 5_000_000n, available: 5_000_000n });
    expect(r.budgets.get(ATA1)).toBeUndefined();
    // Headroom is min(delegatedAmount, amount).
    rpc.accounts.set(ATA2, makeTokenAccount({ owner: WS2, amount: 100_000_000n, delegate: OPERATOR, delegatedAmount: 500_000_000n }));
    await s.refresh();
    expect(r.budgets.get(ATA2)).toMatchObject({ headroomTokens: 100_000_000n, headroomMicro: 1_000_000n, balance: 100_000_000n });
  });

  it('refresh follows delegate changes: exhausted, revoked (closed), closed account, re-approved, price stall, draw_failed cleared', async () => {
    const r = repos();
    const rpc = new FakeRpc();
    let nowMs = T0;
    const price = priceService(r, () => nowMs);
    const s = scanner(r, rpc, price, () => nowMs);
    rpc.accounts.set(ATA2, makeTokenAccount({ owner: WS2, amount: 100_000_000_000n, delegate: OPERATOR, delegatedAmount: 500_000_000n }));
    await s.scan();
    expect(r.budgets.get(ATA2)?.stalledReason).toBeNull();
    // exhausted: delegatedAmount 0 with the delegate still set
    rpc.accounts.set(ATA2, makeTokenAccount({ owner: WS2, amount: 100_000_000_000n, delegate: OPERATOR, delegatedAmount: 0n }));
    expect(await s.refresh()).toBe(1);
    expect(r.budgets.get(ATA2)).toMatchObject({ closed: false, stalledReason: 'exhausted', headroomTokens: 0n, headroomMicro: 0n, cap: 0n });
    expect(r.ledger.budgetHeadroom(WS2)).toBe(0n);
    // revoked (the fixture of the revoked account)
    rpc.accounts.set(ATA2, fixture<{ value: RpcParsedAccount[] }>('token-accounts-revoked').value[0]!);
    await s.refresh();
    expect(r.budgets.get(ATA2)).toMatchObject({ closed: true, stalledReason: 'revoked', delegate: null, headroomMicro: 0n });
    expect(r.budgets.listOpen()).toEqual([]);
    // re-approved → found again by the scan, reopened
    rpc.accounts.set(ATA2, makeTokenAccount({ owner: WS2, amount: 100_000_000_000n, delegate: OPERATOR, delegatedAmount: 200_000_000n }));
    await s.scan();
    expect(r.budgets.get(ATA2)).toMatchObject({ closed: false, stalledReason: null, cap: 200_000_000n, headroomMicro: 2_000_000n });
    // draw_failed is cleared by the next successful refresh
    r.budgets.setStalled(ATA2, 'draw_failed', nowMs);
    expect(r.budgets.listDrawable(WS2)).toEqual([]);
    await s.refresh();
    expect(r.budgets.get(ATA2)?.stalledReason).toBeNull();
    expect(r.budgets.listDrawable(WS2).map((b) => b.tokenAccount)).toEqual([ATA2]);
    // stale price → headroom_micro 0, stalled 'price' (tokens kept)
    nowMs += 3601 * 1000;
    await s.refresh();
    expect(r.budgets.get(ATA2)).toMatchObject({ stalledReason: 'price', headroomTokens: 200_000_000n, headroomMicro: 0n });
    price.set(PRICE);
    await s.refresh();
    expect(r.budgets.get(ATA2)?.stalledReason).toBeNull();
    // account closed entirely
    rpc.accounts.set(ATA2, null);
    await s.refresh();
    expect(r.budgets.get(ATA2)).toMatchObject({ closed: true, stalledReason: 'revoked' });
    // Drawn to the end: the Token program clears the delegate itself and the balance drops by exactly the cap → `exhausted`, not `revoked`.
    rpc.accounts.set(ATA2, makeTokenAccount({ owner: WS2, amount: 100_000_000_000n, delegate: OPERATOR, delegatedAmount: 200_000_000n }));
    await s.scan();
    expect(r.budgets.get(ATA2)).toMatchObject({ closed: false, cap: 200_000_000n, balance: 100_000_000_000n });
    rpc.accounts.set(ATA2, makeTokenAccount({ owner: WS2, amount: 100_000_000_000n - 200_000_000n }));
    await s.refresh();
    expect(r.budgets.get(ATA2)).toMatchObject({ closed: true, stalledReason: 'exhausted', delegate: null, headroomMicro: 0n });
    expect(r.ledger.budgetHeadroom(WS2)).toBe(0n);
    // pure rule
    expect(computeHeadroom({ delegate: OPERATOR, delegatedAmount: 10n, amount: 4n }, OPERATOR, { id: 1, priceE18: PRICE, source: 'manual', observedAt: 0, stale: false }, 6)).toEqual({ closed: false, headroomTokens: 4n, headroomMicro: 0n, stalledReason: null });
    expect(computeHeadroom({ delegate: OPERATOR, delegatedAmount: 10n ** 9n, amount: 10n ** 12n }, OPERATOR, { id: 1, priceE18: PRICE, source: 'manual', observedAt: 0, stale: false }, 6)).toEqual({ closed: false, headroomTokens: 10n ** 9n, headroomMicro: 10_000_000n, stalledReason: null });
    expect(computeHeadroom({ delegate: null, delegatedAmount: 0n, amount: 5n }, OPERATOR, undefined, 6)).toEqual({ closed: true, headroomTokens: 0n, headroomMicro: 0n, stalledReason: 'revoked' });
    expect(computeHeadroom({ delegate: OPERATOR, delegatedAmount: 5n, amount: 5n }, undefined, undefined, 6).closed).toBe(true);
  });

  it('register validates the account and lets the owner fund another workspace; scans keep the registration', async () => {
    const r = repos();
    const rpc = new FakeRpc();
    const price = priceService(r, () => T0);
    const s = scanner(r, rpc, price);
    await expect(s.register(ATA2)).rejects.toMatchObject({ code: 'not_found' });
    rpc.accounts.set(ATA2, fixture<{ value: RpcParsedAccount }>('mint-account').value);
    await expect(s.register(ATA2)).rejects.toMatchObject({ code: 'not_token_account' });
    rpc.accounts.set(ATA2, makeTokenAccount({ owner: WS2, amount: 1n, mint: testPubkey(9), delegate: OPERATOR, delegatedAmount: 1n }));
    await expect(s.register(ATA2)).rejects.toMatchObject({ code: 'wrong_mint' });
    rpc.accounts.set(ATA2, makeTokenAccount({ owner: WS2, amount: 1n }));
    await expect(s.register(ATA2)).rejects.toBeInstanceOf(BudgetRegisterError);
    await expect(s.register(ATA2)).rejects.toMatchObject({ code: 'not_delegated' });
    rpc.accounts.set(ATA2, makeTokenAccount({ owner: WS2, amount: 100_000_000_000n, delegate: OPERATOR, delegatedAmount: 500_000_000n }));
    const row = await s.register(ATA2, WS1);
    expect(row).toMatchObject({ tokenAccount: ATA2, owner: WS2, workspace: WS1, cap: 500_000_000n, headroomMicro: 5_000_000n, stalledReason: null, registeredAt: T0 });
    expect(r.ledger.budgetHeadroom(WS1)).toBe(5_000_000n);
    expect(r.ledger.budgetHeadroom(WS2)).toBe(0n);
    await s.scan();
    expect(r.budgets.get(ATA2)).toMatchObject({ workspace: WS1, registeredAt: T0 });
    expect((await s.register(ATA2)).workspace).toBe(WS1); // re-register without a workspace keeps it
    const noOperator = new BudgetScanner(r, rpc, price, { mint: MINT, operator: undefined, tokenProgram: TOKEN_PROGRAM_ID, decimals: 6, now: () => T0 }, silentLogger);
    await expect(noOperator.register(ATA2)).rejects.toMatchObject({ code: 'not_delegated' });
    expect(await noOperator.scan()).toBe(0);
  });
});

describe('budget drawer', () => {
  it('selectBatch takes oldest rows until the deficit is covered, capped by headroom', () => {
    const rows = [usageRow('a', 3n, 1), usageRow('b', 4n, 2), usageRow('c', 5n, 3)];
    expect(selectBatch(rows, 6n, 100n)).toEqual({ usageIds: ['a', 'b'], amountMicro: 7n });
    expect(selectBatch(rows, 100n, 100n)).toEqual({ usageIds: ['a', 'b', 'c'], amountMicro: 12n });
    expect(selectBatch(rows, 100n, 8n)).toEqual({ usageIds: ['a', 'b'], amountMicro: 7n });
    expect(selectBatch(rows, 100n, 2n)).toBeUndefined();
    expect(selectBatch([], 1n, 100n)).toBeUndefined();
    const oversize = [usageRow('big', 10n, 1), usageRow('b', 2n, 2), usageRow('c', 3n, 3)];
    expect(selectBatch(oversize, 100n, 5n)).toEqual({ usageIds: ['b', 'c'], amountMicro: 5n });
    expect(selectBatch(oversize, 100n, 4n)).toEqual({ usageIds: ['b'], amountMicro: 2n });
  });

  it('builds [ComputeBudget?, BurnChecked(delegate = operator), Memo] with the operator as memo signer', () => {
    const memo = encodeDrawMemo({ workspace: WS2, receiptHash: META.hash });
    const base = { tokenAccount: ATA2, mint: MINT, operator: OPERATOR, amount: 7_000_000n, decimals: 6, tokenProgram: TOKEN_PROGRAM_ID, memoProgram: MEMO_PROGRAM_ID, memo };
    const plain = buildDrawInstructions({ ...base, priorityFeeMicrolamports: 0 });
    expect(plain.map((ix) => ix.programId.toBase58())).toEqual([TOKEN_PROGRAM_ID, MEMO_PROGRAM_ID]);
    const burn = plain[0]!;
    expect(burn.keys.map((k) => [k.pubkey.toBase58(), k.isSigner, k.isWritable])).toEqual([
      [ATA2, false, true],
      [MINT, false, true],
      [OPERATOR, true, false],
    ]);
    expect(burn.data[0]).toBe(15); // BurnChecked
    expect(burn.data.readBigUInt64LE(1)).toBe(7_000_000n);
    expect(burn.data[9]).toBe(6);
    const memoIx = plain[1]!;
    expect(memoIx.keys).toHaveLength(1);
    expect(memoIx.keys[0]!.pubkey.toBase58()).toBe(OPERATOR);
    expect(memoIx.keys[0]!.isSigner).toBe(true);
    expect(memoIx.data.toString('utf8')).toBe(memo);
    const withFee = buildDrawInstructions({ ...base, priorityFeeMicrolamports: 1000 });
    expect(withFee.map((ix) => ix.programId.toBase58())).toEqual([COMPUTE_BUDGET_PROGRAM_ID, TOKEN_PROGRAM_ID, MEMO_PROGRAM_ID]);
    expect(withFee[0]!.data[0]).toBe(3); // SetComputeUnitPrice
  });

  it('draws for a workspace in deficit: pending → sent with signature and block height; the indexer confirms it by memo hash', async () => {
    const r = repos();
    const rpc = new FakeRpc();
    const price = priceService(r, () => T0);
    openBudget(r, ATA2, WS2, 500_000_000n, 100_000_000_000n, 5_000_000n);
    debt(r, WS2, [
      { id: 'u1', charged: 2n },
      { id: 'u2', charged: 1n },
    ]);
    const d = drawer(r, rpc, price);
    const attempts = await d.tick();
    expect(attempts).toHaveLength(1);
    const a = attempts[0]!;
    expect(a).toMatchObject({ workspace: WS2, tokenAccount: ATA2, status: 'sent', amountMicro: 3n, tokens: tokensForUsdMicro(3n, PRICE, 6) });
    expect(a.tokens).toBe(300n);
    expect(rpc.sent).toHaveLength(1);
    expect(rpc.sent[0]!.signature).toBe(a.signature);
    expect(rpc.sent[0]!.recent).toEqual(rpc.blockhash);
    const draw = r.budgetDraws.get(a.drawId!)!;
    expect(draw).toMatchObject({ status: 'sent', signature: a.signature, lastValidBlockHeight: 400, usageIds: ['u1', 'u2'], tokenAmount: 300n, usdMicro: 3n });
    const batch = DrawBatchSchema.parse(JSON.parse(draw.batchJson));
    expect(batch).toEqual({ v: 1, cluster: 'localnet', mint: MINT, tokenAccount: ATA2, workspace: WS2, usageIds: ['u1', 'u2'], amountMicro: 3n, priceE18: PRICE, pricePointId: 1 });
    expect(receiptHash(JSON.parse(draw.batchJson))).toBe(draw.receiptHash);
    expect(receiptHash(batch)).toBe(draw.receiptHash);
    const memoIx = rpc.sent[0]!.instructions[1]!;
    expect(memoIx.data.toString('utf8')).toBe(encodeDrawMemo({ workspace: WS2, receiptHash: draw.receiptHash }));
    expect(r.usage.get('u1')?.drawId).toBe(draw.id);
    // A second tick does not double-draw while the first is in flight.
    expect(await d.tick()).toEqual([]);
    // The indexer sees the delegate burn with the memo → confirmed + ledger credit (≥ the deficit).
    rpc.addTransaction(makeBurnTx({ signature: a.signature!, slot: 300, tokenAccount: ATA2, owner: WS2, authority: OPERATOR, amount: a.tokens, memo: encodeDrawMemo({ workspace: WS2, receiptHash: draw.receiptHash }) }));
    const ix = indexer(r, rpc, price);
    await ix.step();
    expect(r.budgetDraws.get(draw.id)).toMatchObject({ status: 'confirmed', signature: a.signature });
    expect(r.ledger.balance(WS2)).toBe(0n);
    expect(await d.tick()).toEqual([]);
    expect(r.creditEvents.get(a.signature!, 0)).toMatchObject({ kind: 'draw', usdMicro: 3n, receiptHash: draw.receiptHash });
  });

  it('skips below the threshold, in dry run, without an operator key, on a stale price, and when the headroom tokens lag', async () => {
    const r = repos();
    const rpc = new FakeRpc();
    let nowMs = T0;
    const price = priceService(r, () => nowMs);
    openBudget(r, ATA2, WS2, 500_000_000n, 100_000_000_000n, 5_000_000n);
    debt(r, WS2, [{ id: 'u1', charged: 5n }]);
    expect(await drawer(r, rpc, price, () => nowMs, { thresholdMicro: 1_000_000n }).tick()).toEqual([]);
    expect((await drawer(r, rpc, price, () => nowMs, { dryRun: true }).tick())[0]?.status).toBe('dry_run');
    expect((await drawer(r, rpc, price, () => nowMs, { writer: false }).tick())[0]?.status).toBe('dry_run');
    expect(rpc.sent).toEqual([]);
    expect(r.budgetDraws.listInFlight()).toEqual([]);
    nowMs += 3601 * 1000;
    expect(await drawer(r, rpc, price, () => nowMs).tick()).toEqual([]); // stale price
    price.set(PRICE);
    r.budgets.setHeadroom(ATA2, 100n, 5_000_000n, null, nowMs); // tokens below the batch → wait for the refresh
    expect(await drawer(r, rpc, price, () => nowMs).tick()).toEqual([]);
    r.budgets.setHeadroom(ATA2, 500_000_000n, 5_000_000n, null, nowMs);
    expect((await drawer(r, rpc, price, () => nowMs).tick())[0]?.status).toBe('sent');
  });

  it('a rejected send or an on-chain error fail the draw and release the rows; an ambiguous send error, web3 `expired` or a timeout keep it sent for reconcile', async () => {
    const r = repos();
    const rpc = new FakeRpc();
    const price = priceService(r, () => T0);
    openBudget(r, ATA2, WS2, 500_000_000n, 100_000_000_000n, 5_000_000n);
    debt(r, WS2, [{ id: 'u1', charged: 5n }]);
    // The node rejected the transaction (preflight): never forwarded → failed, signature dropped.
    rpc.failSend = new TransactionRejectedError('Transaction simulation failed: insufficient funds for fee', undefined);
    const d = drawer(r, rpc, price);
    const [a] = await d.tick();
    expect(a?.status).toBe('failed');
    expect(a?.error).toContain('insufficient funds');
    expect(r.budgetDraws.get(a!.drawId!)).toMatchObject({ status: 'failed', signature: null, lastValidBlockHeight: null });
    expect(r.usage.get('u1')?.drawId).toBeNull();
    expect(r.budgets.get(ATA2)?.stalledReason).toBe('draw_failed');
    expect(rpc.sent).toEqual([]);
    expect(await d.tick()).toEqual([]); // stalled budgets are skipped
    // A network error after signing is ambiguous (the node may have forwarded it): the signature was persisted before
    // the send, so the row stays `sent` with its rows marked until reconcile() can ask the chain.
    rpc.failSend = new Error('fetch failed');
    r.budgets.setStalled(ATA2, null, T0);
    const [n] = await d.tick();
    expect(n?.status).toBe('sent');
    expect(n?.error).toContain('fetch failed');
    expect(r.budgetDraws.get(n!.drawId!)).toMatchObject({ status: 'sent', signature: n!.signature, lastValidBlockHeight: 400 });
    expect(r.usage.get('u1')?.drawId).toBe(n!.drawId);
    expect(await d.tick()).toEqual([]); // in flight: neither re-sent nor failed while the blockhash is alive
    expect(r.budgetDraws.get(n!.drawId!)?.status).toBe('sent');
    rpc.blockHeight = 401; // expired and unknown by every route → reconcile fails it
    expect(await d.tick()).toEqual([]);
    expect(r.budgetDraws.get(n!.drawId!)?.status).toBe('failed');
    expect(r.budgetDraws.get(n!.drawId!)?.error).toContain('never landed');
    expect(r.usage.get('u1')?.drawId).toBeNull();
    expect(r.budgets.get(ATA2)?.stalledReason).toBe('draw_failed');
    rpc.blockHeight = 200;
    rpc.failSend = undefined;
    // Landed with an error: failed (signature kept for the record).
    rpc.confirmOutcome = { status: 'failed', err: { InstructionError: [0, { Custom: 1 }] } };
    r.budgets.setStalled(ATA2, null, T0);
    const [b] = await d.tick();
    expect(b?.status).toBe('failed');
    expect(b?.error).toContain('failed on chain');
    expect(b?.signature).toBe(rpc.sent[0]!.signature);
    expect(r.budgetDraws.get(b!.drawId!)?.signature).toBe(b!.signature);
    // web3's `expired` is not the chain's verdict: the draw stays sent (rows marked) until reconcile sees the blockhash expired.
    rpc.confirmOutcome = { status: 'expired' };
    r.budgets.setStalled(ATA2, null, T0);
    const [c] = await d.tick();
    expect(c?.status).toBe('sent');
    expect(r.budgetDraws.get(c!.drawId!)?.status).toBe('sent');
    expect(r.usage.get('u1')?.drawId).toBe(c!.drawId);
    expect(await d.tick()).toEqual([]);
    rpc.blockHeight = 401;
    await d.tick();
    expect(r.budgetDraws.get(c!.drawId!)?.status).toBe('failed');
    rpc.blockHeight = 200;
    // A confirmation timeout keeps the draw sent (the chain decides later).
    rpc.confirmOutcome = { status: 'timeout' };
    r.budgets.setStalled(ATA2, null, T0);
    const [t] = await d.tick();
    expect(t?.status).toBe('sent');
    expect(r.budgetDraws.get(t!.drawId!)?.status).toBe('sent');
    expect(r.usage.get('u1')?.drawId).toBe(t!.drawId);
    expect(rpc.sent).toHaveLength(3);
    // The same batch (same hash) is re-used after a failure instead of inserting a duplicate.
    expect(r.budgetDraws.listByTokenAccount(ATA2)).toHaveLength(1);
  });

  it('a draw confirmed by the indexer while the drawer still waits is never flipped to failed', async () => {
    const r = repos();
    const price = priceService(r, () => T0);
    const ixRef = { current: undefined as Indexer | undefined };
    class RacyRpc extends FakeRpc {
      override async confirm(): Promise<{ status: 'failed'; err: unknown }> {
        const d = r.budgetDraws.listInFlight()[0]!;
        this.addTransaction(makeBurnTx({ signature: d.signature!, slot: 300, tokenAccount: ATA2, owner: WS2, authority: OPERATOR, amount: d.tokenAmount, memo: encodeDrawMemo({ workspace: WS2, receiptHash: d.receiptHash }) }));
        await ixRef.current!.step();
        return { status: 'failed', err: 'bogus' };
      }
    }
    const rpc = new RacyRpc();
    ixRef.current = indexer(r, rpc, price);
    openBudget(r, ATA2, WS2, 500_000_000n, 100_000_000_000n, 5_000_000n);
    debt(r, WS2, [{ id: 'u1', charged: 3n }]);
    const [a] = await drawer(r, rpc, price).tick();
    expect(a?.status).toBe('failed'); // what the drawer saw…
    expect(r.budgetDraws.get(a!.drawId!)?.status).toBe('confirmed'); // …but the row stays confirmed
    expect(r.usage.get('u1')?.drawId).toBe(a!.drawId);
    expect(r.ledger.balance(WS2)).toBe(0n);
    expect(r.budgets.get(ATA2)?.stalledReason).toBeNull();
  });

  it('never burns a batch twice: an expired-then-landed draw is confirmed by the indexer; a failed draw whose signature landed is restored, not re-sent', async () => {
    const r = repos();
    const rpc = new FakeRpc();
    const price = priceService(r, () => T0);
    openBudget(r, ATA2, WS2, 500_000_000n, 100_000_000_000n, 5_000_000n);
    debt(r, WS2, [{ id: 'u1', charged: 5_000n }]);
    rpc.confirmOutcome = { status: 'expired' };
    const d = drawer(r, rpc, price);
    const [a] = await d.tick();
    expect(a?.status).toBe('sent');
    const hashA = r.budgetDraws.get(a!.drawId!)!.receiptHash;
    // The transaction lands after all (web3 missed the notification) while the indexer is still behind; the blockhash expires.
    rpc.addTransaction(makeBurnTx({ signature: a!.signature!, slot: 300, tokenAccount: ATA2, owner: WS2, authority: OPERATOR, amount: a!.tokens, memo: encodeDrawMemo({ workspace: WS2, receiptHash: hashA }) }));
    rpc.blockHeight = 401;
    expect(await d.tick()).toEqual([]); // reconcile sees it on chain: nothing is re-sent
    expect(rpc.sent).toHaveLength(1);
    expect(r.budgetDraws.get(a!.drawId!)?.status).toBe('sent');
    expect(r.budgets.get(ATA2)?.stalledReason).toBeNull();
    const ix = indexer(r, rpc, price);
    await ix.step();
    expect(r.budgetDraws.get(a!.drawId!)).toMatchObject({ status: 'confirmed', signature: a!.signature });
    expect(r.ledger.balance(WS2)).toBe(0n);
    expect(r.creditEvents.list(WS2, 10)).toHaveLength(1);
    expect(await d.tick()).toEqual([]);

    // A draw this process had given up on (failed, signature kept, rows released) whose transaction is on chain:
    // restored to `sent` with its rows re-marked; nothing is sent again, the indexer confirms it.
    debt(r, WS2, [{ id: 'u2', charged: 7_000n }]);
    const landedSig = testSignature(77);
    const batch = { v: 1, cluster: 'localnet', mint: MINT, tokenAccount: ATA2, workspace: WS2, usageIds: ['u2'], amountMicro: '7000', priceE18: PRICE.toString(), pricePointId: 1 };
    const hash = receiptHash(batch);
    const ghost = r.budgetDraws.insert({ tokenAccount: ATA2, workspace: WS2, tokenAmount: 700_000n, usdMicro: 7_000n, receiptHash: hash, usageIds: ['u2'], batchJson: JSON.stringify(batch), signature: landedSig, lastValidBlockHeight: 350, status: 'failed', error: 'blockhash expired', createdAt: T0 - 1000, updatedAt: T0 - 1000 });
    rpc.addTransaction(makeBurnTx({ signature: landedSig, slot: 301, tokenAccount: ATA2, owner: WS2, authority: OPERATOR, amount: 700_000n, memo: encodeDrawMemo({ workspace: WS2, receiptHash: hash }) }));
    expect(await d.tick()).toEqual([]);
    expect(rpc.sent).toHaveLength(1);
    expect(r.budgetDraws.get(ghost)).toMatchObject({ status: 'sent', signature: landedSig, error: null });
    expect(r.usage.get('u2')?.drawId).toBe(ghost);
    await ix.step();
    expect(r.budgetDraws.get(ghost)?.status).toBe('confirmed');
    expect(r.ledger.balance(WS2)).toBe(0n);
    expect(await d.tick()).toEqual([]);
  });

  it('reconciles in-flight rows: stale pending → failed; sent unknown → failed once the blockhash expired; on-chain error → failed; landed → kept', async () => {
    const r = repos();
    const rpc = new FakeRpc();
    let nowMs = T0;
    const price = priceService(r, () => nowMs);
    openBudget(r, ATA2, WS2, 500_000_000n, 100_000_000_000n, 5_000_000n);
    debt(r, WS2, [{ id: 'u1', charged: 5n }]);
    const orphan = r.budgetDraws.insert({ tokenAccount: ATA2, workspace: WS2, tokenAmount: 500n, usdMicro: 5n, receiptHash: `0x${'01'.repeat(32)}`, usageIds: ['u1'], batchJson: '{}', signature: null, lastValidBlockHeight: null, status: 'pending', error: null, createdAt: nowMs - 1000, updatedAt: nowMs - 1000 });
    r.usage.setDrawId(['u1'], orphan);
    const d = drawer(r, rpc, price, () => nowMs, { pendingGraceMs: 60_000 });
    expect(await d.tick()).toEqual([]); // blocked while the orphan is young
    nowMs += 61_000;
    expect(await d.tick()).toEqual([]); // orphan fails, the budget is stalled until the next refresh
    expect(r.budgetDraws.get(orphan)).toMatchObject({ status: 'failed' });
    expect(r.budgetDraws.get(orphan)?.error).toContain('no transaction signed');
    expect(r.budgets.get(ATA2)?.stalledReason).toBe('draw_failed');
    expect(r.usage.get('u1')?.drawId).toBeNull();
    r.budgets.setStalled(ATA2, null, nowMs);
    const [fresh] = await d.tick();
    expect(fresh?.status).toBe('sent');
    expect(r.usage.get('u1')?.drawId).toBe(fresh!.drawId);

    // Sent rows of another workspace.
    openBudget(r, ATA1, WS1, 10n ** 9n, 10n ** 9n, 10_000_000n);
    const mk = (n: number, lastValid: number) =>
      r.budgetDraws.insert({ tokenAccount: ATA1, workspace: WS1, tokenAmount: 1n, usdMicro: 1n, receiptHash: `0x${n.toString(16).padStart(64, '0')}`, usageIds: [`x${n}`], batchJson: '{}', signature: testSignature(500 + n), lastValidBlockHeight: lastValid, status: 'sent', error: null, createdAt: nowMs, updatedAt: nowMs });
    const unknownAlive = mk(2, 1000);
    const unknownExpired = mk(3, 150);
    const errored = mk(4, 1000);
    const landed = mk(5, 1000);
    const statusMissingButFetchable = mk(6, 150);
    rpc.statuses.set(testSignature(504), { slot: 199, confirmations: null, err: { InstructionError: [1, 'Custom'] }, confirmationStatus: 'confirmed' });
    rpc.statuses.set(testSignature(505), { slot: 199, confirmations: 3, err: null, confirmationStatus: 'confirmed' });
    rpc.statuses.set(testSignature(506), null); // a node without that history…
    rpc.transactions.set(testSignature(506), makeBurnTx({ signature: testSignature(506), slot: 199, tokenAccount: ATA1, owner: WS1, authority: OPERATOR, amount: 1n })); // …while getTransaction knows it
    rpc.blockHeight = 200;
    await d.reconcile();
    expect(r.budgetDraws.get(unknownAlive)?.status).toBe('sent');
    expect(r.budgetDraws.get(unknownExpired)?.status).toBe('failed');
    expect(r.budgetDraws.get(unknownExpired)?.error).toContain('blockhash expired');
    expect(r.budgetDraws.get(errored)?.status).toBe('failed');
    expect(r.budgetDraws.get(landed)?.status).toBe('sent');
    expect(r.budgetDraws.get(statusMissingButFetchable)?.status).toBe('sent'); // one missing status never fails a draw that getTransaction can see
    expect(rpc.calls.filter((c) => c.method === 'getSignatureStatuses').at(-1)?.args[0]).toEqual([fresh!.signature, testSignature(502), testSignature(503), testSignature(504), testSignature(505), testSignature(506)]);
    rpc.blockHeight = 1001;
    await d.reconcile();
    expect(r.budgetDraws.get(unknownAlive)?.status).toBe('failed');
    expect(r.budgetDraws.get(landed)?.status).toBe('sent');
    expect(r.budgetDraws.get(statusMissingButFetchable)?.status).toBe('sent');
  });
});

describe('price service', () => {
  it('bootstraps the manual price, reports staleness, quotes both ways and serves the history', () => {
    const r = repos();
    let nowMs = T0;
    const svc = priceService(r, () => nowMs);
    expect(svc.current()).toEqual({ id: 1, priceE18: PRICE, source: 'manual', observedAt: Math.floor(T0 / 1000), stale: false });
    expect(svc.priceDto()).toEqual({ pricePointId: 1, priceE18: PRICE.toString(), observedAt: Math.floor(T0 / 1000), stale: false, source: 'manual', maxAgeS: 3600, usdPerToken: '0.01', tokensPerUsd: '100' });
    expect(svc.quote({ tokens: 1_000_000_000n })).toEqual({ tokens: '1000000000', usdMicro: '10000000', priceE18: PRICE.toString(), pricePointId: 1, stale: false });
    expect(svc.quote({ usdMicro: 2_500_000n })).toEqual({ tokens: '250000000', usdMicro: '2500000', priceE18: PRICE.toString(), pricePointId: 1, stale: false });
    expect(() => svc.quote({})).toThrow();
    expect(() => svc.quote({ tokens: 1n, usdMicro: 1n })).toThrow();
    nowMs += 3601 * 1000;
    expect(svc.current()?.stale).toBe(true);
    expect(svc.isStale()).toBe(true);
    expect(svc.quote({ tokens: 1n }).stale).toBe(true); // quotes keep working while stale
    const p2 = svc.set(2n * PRICE);
    expect(p2.id).toBe(2);
    expect(svc.current()?.stale).toBe(false);
    expect(svc.history(10).map((p) => p.id)).toEqual([2, 1]);
    expect(svc.historyDto(1)[0]).toMatchObject({ pricePointId: 2, priceE18: (2n * PRICE).toString(), stale: false });
    // A second instance over the same database starts from the last point without re-bootstrapping.
    const again = priceService(r, () => nowMs);
    expect(again.current()?.id).toBe(2);
    // No point yet: zero DTO, 503 on quotes.
    const empty = priceService(repos(), () => nowMs, { source: 'feed', feedUrl: 'https://feed.test/p' });
    expect(empty.current()).toBeUndefined();
    expect(empty.priceDto()).toEqual({ pricePointId: 0, priceE18: '0', observedAt: 0, stale: true, source: 'feed', maxAgeS: 3600, usdPerToken: '0', tokensPerUsd: '0' });
    expect(() => empty.quote({ tokens: 1n })).toThrow(expect.objectContaining({ status: 503, code: 'price_unavailable' }));
  });

  it('observe applies the step bound, the min-change band and the keep-alive; set bypasses the bound', () => {
    const r = repos();
    let nowMs = T0;
    const lines: string[] = [];
    const svc = new PriceService(
      r,
      { source: 'manual', initialPriceE18: PRICE, jupiterUrl: 'x', minChangeBps: 50, maxStepBps: 2500, maxAgeS: 3600, decimals: 6, now: () => nowMs },
      createLogger({ level: 'info', write: (l) => lines.push(l) }),
    );
    svc.init();
    expect(svc.observe((PRICE * 10_010n) / 10_000n, 'feed')).toEqual({ action: 'skipped', reason: 'change below PRICE_MIN_CHANGE_BPS' });
    expect(svc.observe((PRICE * 13_000n) / 10_000n, 'feed')).toEqual({ action: 'rejected', priceE18: (PRICE * 13_000n) / 10_000n, lastPriceE18: PRICE });
    expect(lines.some((l) => l.includes('price_rejected'))).toBe(true);
    expect(svc.current()?.id).toBe(1);
    const up = svc.observe((PRICE * 11_000n) / 10_000n, 'feed');
    expect(up).toMatchObject({ action: 'appended', keepAlive: false, point: { id: 2, source: 'feed' } });
    expect(svc.current()?.priceE18).toBe((PRICE * 11_000n) / 10_000n);
    // Keep-alive: the same price is re-appended once the last point is older than PRICE_MAX_AGE_S / 2.
    nowMs += 1801 * 1000;
    expect(svc.observe((PRICE * 11_000n) / 10_000n, 'feed')).toMatchObject({ action: 'appended', keepAlive: true, point: { id: 3 } });
    expect(svc.observe(0n, 'feed')).toEqual({ action: 'failed', error: 'price must be positive' });
    // set() ignores the step bound (admin / CLI).
    expect(svc.set(10n * PRICE).id).toBe(4);
    expect(lines.some((l) => l.includes('price_set'))).toBe(true);
    expect(() => svc.set(0n)).toThrow();
  });

  it('refreshes from the manual keep-alive, a JSON feed and the Jupiter price API through the injected fetch', async () => {
    const r = repos();
    let nowMs = T0;
    const manual = priceService(r, () => nowMs);
    expect(await manual.refresh()).toEqual({ action: 'skipped', reason: 'change below PRICE_MIN_CHANGE_BPS' });
    nowMs += 1801 * 1000;
    expect(await manual.refresh()).toMatchObject({ action: 'appended', keepAlive: true });
    const unset = new PriceService(repos(), { source: 'manual', jupiterUrl: 'x', minChangeBps: 50, maxStepBps: 2500, maxAgeS: 3600, decimals: 6, now: () => nowMs }, silentLogger);
    unset.init();
    expect(await unset.refresh()).toEqual({ action: 'skipped', reason: 'no manual price set yet' });

    const requests: string[] = [];
    let feedBody: unknown = { priceUsd: 0.02 };
    let status = 200;
    const fetchImpl = async (input: string): Promise<Response> => {
      requests.push(input);
      return new Response(JSON.stringify(feedBody), { status });
    };
    const feed = priceService(repos(), () => nowMs, { source: 'feed', feedUrl: 'https://feed.test/price', fetch: fetchImpl });
    expect(await feed.refresh()).toMatchObject({ action: 'appended', point: { priceE18: 2n * PRICE, source: 'feed' } });
    expect(requests).toEqual(['https://feed.test/price']);
    feedBody = { priceUsd: '0.0201' }; // strings are accepted; +0.5 % → appended
    expect(await feed.refresh()).toMatchObject({ action: 'appended' });
    feedBody = { nope: 1 };
    expect(await feed.refresh()).toMatchObject({ action: 'failed', error: expect.stringContaining('priceUsd') });
    status = 502;
    expect(await feed.refresh()).toMatchObject({ action: 'failed', error: 'price feed HTTP 502' });
    expect(feed.current()?.priceE18).toBe(20_100_000_000_000_000n);

    status = 200;
    feedBody = { [MINT]: { usdPrice: 0.03, blockId: 1 } }; // v3 layout
    const jup = priceService(repos(), () => nowMs, { source: 'jupiter', jupiterUrl: 'https://lite-api.jup.ag/price/v3', fetch: fetchImpl });
    expect(await jup.refresh()).toMatchObject({ action: 'appended', point: { priceE18: 3n * PRICE, source: 'jupiter' } });
    expect(requests.at(-1)).toBe(`https://lite-api.jup.ag/price/v3?ids=${MINT}`);
    feedBody = { data: { [MINT]: { usdPrice: 0.0305 } } }; // v2 layout (`data` wrapper)
    expect(await jup.refresh()).toMatchObject({ action: 'appended' });
    feedBody = { data: {} };
    expect(await jup.refresh()).toMatchObject({ action: 'failed' });

    expect(usdToPriceE18(0.01)).toBe(PRICE);
    expect(usdToPriceE18(1e-9)).toBe(10n ** 9n);
    expect(usdToPriceE18(1234.5)).toBe(1234_500_000_000_000_000_000n);
    expect(() => usdToPriceE18(0)).toThrow();
    expect(() => usdToPriceE18(Number.NaN)).toThrow();
  });
});
