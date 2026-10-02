/**
 * Draw-receipt lifecycle (review finding 1, 4, 5): no double compute draw after an unknown send
 * outcome, reconciliation by hash / nonce / indexed ComputeDrawn, dry-run spend re-settled in live
 * mode. No network: fake sender and chain view.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { keccak256, toHex, type Hex } from 'viem';
import { drawReceiptHash } from '@www-rh/shared';
import { drawReceiptDto } from '../src/api/dto.js';
import type { DrawChainView, LaunchpadSender, LaunchpadWrite, SignedTx } from '../src/chain/launchpad.js';
import { TxQueue, type TxOutcome } from '../src/chain/txQueue.js';
import { Repos } from '../src/db/repos.js';
import { SCHEMA_VERSION } from '../src/db/schema.js';
import { Db } from '../src/db/sqlite.js';
import { weiOfUsdMicro } from '../src/economics/budget.js';
import { FixedEthUsd } from '../src/economics/ethUsd.js';
import { EconomicsService } from '../src/economics/service.js';
import { Settler } from '../src/economics/settle.js';
import { applyLogs, decodeLaunchpadLogs } from '../src/indexer/apply.js';
import { MemoryService } from '../src/memory/memory.js';
import { StreamBus } from '../src/stream/bus.js';
import { encodeLog, FakeClock, FakeQueue, memoryRepos, mindCreatedLog, silentLogger, TOKEN } from './helpers.js';

const ETH = 10n ** 18n;
const PRICE = 3_000_000_000;
const policy = { tickIntervalMs: 20_000, targetRunwayDays: 14, minDailySpendUsd: 0.5, maxTickCostUsd: 0.25, minTickBudgetUsd: 0.05 };
const tmp = mkdtempSync(join(tmpdir(), 'www-rh-settle-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Scriptable sender: records every broadcast of raw bytes. */
class FakeSender implements LaunchpadSender {
  readonly account = '0x9999999999999999999999999999999999999999' as const;
  nonce = 7;
  signed: SignedTx[] = [];
  broadcasts: Hex[] = [];
  events: string[] = [];
  simulate: (w: LaunchpadWrite) => void = () => undefined;
  broadcastScript: ((raw: Hex, attempt: number) => void)[] = [];
  receipt: (hash: Hex) => Promise<'success' | 'reverted'> = async () => 'success';

  async sign(write: LaunchpadWrite): Promise<SignedTx> {
    this.simulate(write);
    const raw = toHex(`signed:${write.functionName}:${write.args.map(String).join(',')}:${this.nonce}`);
    const s = { hash: keccak256(raw), nonce: this.nonce++, raw };
    this.signed.push(s);
    this.events.push('sign');
    return s;
  }

  async broadcast(raw: Hex): Promise<Hex> {
    const attempt = this.broadcasts.filter((r) => r === raw).length;
    this.broadcasts.push(raw);
    this.events.push('broadcast');
    this.broadcastScript.shift()?.(raw, attempt);
    return keccak256(raw);
  }

  waitForReceipt(hash: Hex): Promise<'success' | 'reverted'> {
    return this.receipt(hash);
  }
}

/** Scriptable chain view. */
class FakeChain implements DrawChainView {
  readonly account = '0x9999999999999999999999999999999999999999' as const;
  receipts = new Map<string, { status: 'success' | 'reverted'; blockNumber: bigint }>();
  txNonces = new Map<string, number>();
  minedNonce = 0;
  pendingNonce = 0;
  head = 100n;
  async transactionReceipt(hash: Hex) {
    return this.receipts.get(hash.toLowerCase()) ?? null;
  }
  async transactionNonce(hash: Hex) {
    return this.txNonces.get(hash.toLowerCase()) ?? null;
  }
  async nonce(tag: 'latest' | 'pending') {
    return tag === 'latest' ? this.minedNonce : this.pendingNonce;
  }
  async blockNumber() {
    return this.head;
  }
}

function seed(repos: Repos, balance = ETH): void {
  repos.tx(() => applyLogs(repos, decodeLaunchpadLogs([mindCreatedLog(TOKEN, 1n)]), () => 1_790_000_000n));
  repos.minds.addBalance(TOKEN, balance);
}

function addTick(repos: Repos, cost: number): number {
  const id = repos.ticks.start(TOKEN, 'claude-opus-5-5', 1);
  repos.ticks.finish(id, { endedAt: 2, servedModel: 'claude-opus-5-5', iterations: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdMicro: cost, stopReason: 'end_turn', status: 'ok', error: null });
  return id;
}

const noSleep = async (): Promise<void> => undefined;

function world(opts: { chain?: FakeChain | null; queue?: 'real' | FakeQueue; price?: { v: number } } = {}) {
  const repos = memoryRepos();
  seed(repos);
  const clock = new FakeClock();
  const price = opts.price ?? { v: PRICE };
  const econ = new EconomicsService(repos, { ethUsdMicro: async () => price.v }, null, policy, silentLogger, clock.now);
  const sender = new FakeSender();
  const queue = opts.queue === undefined || opts.queue === 'real' ? new TxQueue(sender, silentLogger, null, { sleep: noSleep, receiptTimeoutMs: 50 }) : opts.queue;
  const chain = opts.chain === undefined ? new FakeChain() : opts.chain;
  const settler = new Settler(repos, econ, queue as TxQueue, { drawThresholdUsd: 2 }, silentLogger, () => undefined, clock.now, { chain, proofSpacingMs: 30_000, rebroadcastAfterMs: 120_000 });
  const draws = (): number => sender.signed.length;
  const index = (write: LaunchpadWrite | { args: readonly unknown[] }, block: bigint, logIndex = 0) => {
    const [token, amount, receiptHash] = write.args as [string, bigint, Hex];
    repos.tx(() => applyLogs(repos, decodeLaunchpadLogs([encodeLog('ComputeDrawn', { token, amount, receiptHash }, { block, logIndex, timestamp: 1_790_000_100n })]), () => 0n));
    repos.state.setLastBlock(block);
  };
  return { repos, clock, sender, queue, chain, settler, econ, price, draws, index };
}

describe('TxQueue: proven vs unknown outcomes (finding 1)', () => {
  const write: LaunchpadWrite = { functionName: 'drawCompute', args: [TOKEN, 1n, `0x${'01'.repeat(32)}`] };

  it('a simulation revert is `failed` and nothing is broadcast', async () => {
    const sender = new FakeSender();
    sender.simulate = () => {
      throw new Error('execution reverted: DrawLimitExceeded');
    };
    const q = new TxQueue(sender, silentLogger, null, { sleep: noSleep });
    expect(await q.enqueue(write, 'w')).toMatchObject({ kind: 'failed', hash: null });
    expect(sender.broadcasts).toEqual([]);
  });

  it('persists the signed hash BEFORE broadcasting; transport errors re-send the SAME bytes and end `unknown` with the hash', async () => {
    const sender = new FakeSender();
    const fail = (): void => {
      throw new Error('fetch failed: ECONNRESET');
    };
    sender.broadcastScript = [fail, fail, fail];
    const q = new TxQueue(sender, silentLogger, null, { sleep: noSleep });
    const persisted: string[] = [];
    const out = await q.enqueue(write, 'w', { beforeBroadcast: (s) => void persisted.push(`${s.hash}@${sender.broadcasts.length}`) });
    expect(out).toMatchObject({ kind: 'unknown', hash: sender.signed[0]?.hash });
    expect(persisted).toEqual([`${sender.signed[0]?.hash}@0`]); // hook ran before the first broadcast
    expect(new Set(sender.broadcasts)).toEqual(new Set([sender.signed[0]?.raw])); // 3 attempts, identical bytes
    expect(sender.broadcasts).toHaveLength(3);
    expect(sender.signed).toHaveLength(1);
  });

  it('"already known" on a retry counts as broadcast; "nonce too low" and receipt timeouts are `unknown` (may be mined)', async () => {
    const a = new FakeSender();
    a.broadcastScript = [
      () => {
        throw new Error('request timed out');
      },
      () => {
        throw new Error('already known');
      },
    ];
    expect(await new TxQueue(a, silentLogger, null, { sleep: noSleep }).enqueue(write, 'w')).toMatchObject({ kind: 'confirmed', hash: a.signed[0]?.hash });

    const b = new FakeSender();
    b.broadcastScript = [
      () => {
        throw new Error('nonce too low: next nonce 8, tx nonce 7');
      },
    ];
    expect(await new TxQueue(b, silentLogger, null, { sleep: noSleep }).enqueue(write, 'w')).toMatchObject({ kind: 'unknown', hash: b.signed[0]?.hash });
    expect(b.broadcasts).toHaveLength(1);

    const c = new FakeSender();
    c.receipt = () => Promise.reject(new Error('Timed out while waiting for transaction'));
    expect(await new TxQueue(c, silentLogger, null, { sleep: noSleep }).enqueue(write, 'w')).toMatchObject({ kind: 'unknown', hash: c.signed[0]?.hash });
  });

  it('a throwing beforeBroadcast hook cancels the broadcast (`failed`)', async () => {
    const sender = new FakeSender();
    const out = await new TxQueue(sender, silentLogger, null, { sleep: noSleep }).enqueue(write, 'w', {
      beforeBroadcast: () => {
        throw new Error('disk full');
      },
    });
    expect(out).toMatchObject({ kind: 'failed', hash: null });
    expect(sender.broadcasts).toEqual([]);
  });

  it('rebroadcast re-sends the exact signed bytes; closed queues refuse new work', async () => {
    const sender = new FakeSender();
    const q = new TxQueue(sender, silentLogger, null, { sleep: noSleep });
    expect(await q.rebroadcast('0xabcd', 'r')).toBe('sent');
    expect(sender.broadcasts).toEqual(['0xabcd']);
    q.close();
    expect(await q.enqueue(write, 'w')).toMatchObject({ kind: 'failed' });
    expect(sender.signed).toHaveLength(0);
  });
});

describe('Settler: no double compute draw (finding 1)', () => {
  it('reviewer PoC: a receipt-wait timeout keeps the receipt pending with its hash; a price change never produces a second draw', async () => {
    const w = world();
    addTick(w.repos, 3_000_000);
    w.sender.receipt = () => Promise.reject(new Error('Timed out while waiting for transaction'));
    const r1 = await w.settler.settle(TOKEN);
    expect(r1).toMatchObject({ kind: 'settled', status: 'pending' });
    if (r1.kind !== 'settled') return;
    const row = w.repos.ticks.receiptByHash(r1.receiptHash)!;
    expect([row.status, row.tx_hash, row.tx_nonce, row.raw_tx]).toEqual(['pending', w.sender.signed[0]?.hash.toLowerCase(), 7, w.sender.signed[0]?.raw]);
    expect(w.repos.ticks.eligibleForSettlement(TOKEN, 10)).toHaveLength(0);
    w.price.v = 3_000_100_000; // ETH moved: a new receipt would have a different hash
    w.sender.receipt = async () => 'success';
    expect(await w.settler.settle(TOKEN, { force: true })).toEqual({ kind: 'skipped', reason: 'nothing' });
    expect(w.draws()).toBe(1);
    // the first transaction is mined after all: exactly one draw for the tick
    w.index({ args: [TOKEN, BigInt(row.amount_wei), r1.receiptHash] }, 5n);
    expect(w.repos.ticks.receiptByHash(r1.receiptHash)?.status).toBe('confirmed');
    expect(ETH - BigInt(w.repos.minds.get(TOKEN)!.mind_balance)).toBe(weiOfUsdMicro(3_000_000, PRICE));
  });

  it('a `failed` outcome that carries a tx hash (broadcast) is kept live too; `unknown` without a hash is stored as unknown (served as pending)', async () => {
    const q = new FakeQueue();
    const w = world({ queue: q });
    addTick(w.repos, 3_000_000);
    q.outcome = () => ({ kind: 'failed', error: 'Timed out while waiting for transaction', revert: null, hash: `0x${'aa'.repeat(32)}` });
    const r = await w.settler.settle(TOKEN);
    expect(r).toMatchObject({ status: 'pending', txHash: `0x${'aa'.repeat(32)}` });
    expect(w.repos.ticks.eligibleForSettlement(TOKEN, 10)).toHaveLength(0);

    const q2 = new FakeQueue();
    const w2 = world({ queue: q2 });
    addTick(w2.repos, 3_000_000);
    q2.outcome = (): TxOutcome => ({ kind: 'unknown', error: 'socket hang up', hash: null });
    const r2 = await w2.settler.settle(TOKEN);
    if (r2.kind !== 'settled') throw new Error('expected a receipt');
    const row = w2.repos.ticks.receiptByHash(r2.receiptHash)!;
    expect(row.status).toBe('unknown');
    expect(drawReceiptDto(row).status).toBe('pending'); // §5 contract unchanged
    expect(w2.repos.ticks.eligibleForSettlement(TOKEN, 10)).toHaveLength(0);
    expect(w2.repos.ticks.unsettledMicro(TOKEN)).toBe(3_000_000);
  });

  it('one tick never gets two live receipts (repository guard)', () => {
    const w = world();
    const t = addTick(w.repos, 3_000_000);
    const base = { token: TOKEN, receipt_json: '{}', amount_wei: '1', tx_hash: null, error: null, created_at: 1, updated_at: 1 };
    w.repos.ticks.insertReceipt({ ...base, receipt_hash: `0x${'01'.repeat(32)}`, status: 'pending' }, [t]);
    expect(() => w.repos.ticks.insertReceipt({ ...base, receipt_hash: `0x${'02'.repeat(32)}`, status: 'pending' }, [t])).toThrow(/live receipt/);
  });

  it('live receipt amounts are subtracted from the drawable cap', async () => {
    const w = world();
    w.repos.minds.setBalance(TOKEN, weiOfUsdMicro(4_000_000, PRICE)); // $4 in the vault
    addTick(w.repos, 3_000_000);
    w.sender.receipt = () => Promise.reject(new Error('timeout'));
    await w.settler.settle(TOKEN); // $3 live, not yet indexed
    addTick(w.repos, 2_500_000);
    const r = await w.settler.settle(TOKEN);
    // only $1 left: the balance-limited branch draws what is left, never the full $2.50
    expect(r.kind === 'settled' && r.amountWei).toBe(weiOfUsdMicro(4_000_000, PRICE) - weiOfUsdMicro(3_000_000, PRICE));
  });
});

describe('Settler.reconcile (finding 1 + 5)', () => {
  async function pendingReceipt(w: ReturnType<typeof world>) {
    addTick(w.repos, 3_000_000);
    w.sender.receipt = () => Promise.reject(new Error('Timed out while waiting for transaction'));
    const r = await w.settler.settle(TOKEN);
    if (r.kind !== 'settled') throw new Error('expected a receipt');
    const row = w.repos.ticks.receiptByHash(r.receiptHash)!;
    return { r, row, hash: row.tx_hash as Hex };
  }

  it('mined + indexed → confirmed; mined (success) but its log missing after the indexer passed the block → confirmed from the receipt', async () => {
    const w = world();
    const { r, row, hash } = await pendingReceipt(w);
    w.chain!.receipts.set(hash, { status: 'success', blockNumber: 50n });
    w.repos.state.setLastBlock(40n);
    await w.settler.reconcile();
    expect(w.repos.ticks.receiptByHash(r.receiptHash)?.status).toBe('pending'); // the indexer will confirm it
    w.repos.state.setLastBlock(60n);
    await w.settler.reconcile();
    expect(w.repos.ticks.receipt(row.id)?.status).toBe('confirmed');
    expect(w.draws()).toBe(1);
  });

  it('a reverted receipt is proof: failed, ticks eligible again', async () => {
    const w = world();
    const { row, hash } = await pendingReceipt(w);
    w.chain!.receipts.set(hash, { status: 'reverted', blockNumber: 50n });
    await w.settler.reconcile();
    expect(w.repos.ticks.receipt(row.id)?.status).toBe('failed');
    expect(w.repos.ticks.eligibleForSettlement(TOKEN, 10)).toHaveLength(1);
  });

  it('not mined + nonce consumed by another tx → released only after two observations and the indexer passing the first one', async () => {
    const w = world();
    const { row } = await pendingReceipt(w);
    w.chain!.minedNonce = 8; // nonce 7 taken by another transaction
    w.chain!.head = 100n;
    w.repos.state.setLastBlock(90n);
    await w.settler.reconcile(); // phase 1
    expect(w.repos.ticks.receipt(row.id)).toMatchObject({ status: 'pending', check_block: 100 });
    w.clock.advance(60_000);
    await w.settler.reconcile(); // indexer still behind block 100
    expect(w.repos.ticks.receipt(row.id)?.status).toBe('pending');
    w.repos.state.setLastBlock(100n);
    await w.settler.reconcile();
    expect(w.repos.ticks.receipt(row.id)?.status).toBe('failed');
    expect(w.repos.ticks.eligibleForSettlement(TOKEN, 10)).toHaveLength(1);
    // re-settlement now sends a new draw (the old tx can never be mined)
    w.sender.receipt = async () => 'success';
    expect(await w.settler.settle(TOKEN, { force: true })).toMatchObject({ status: 'pending' });
    expect(w.draws()).toBe(2);
  });

  it('a mined-later observation cancels the proof; a nonce still free re-broadcasts the SAME signed bytes (no new draw)', async () => {
    const w = world();
    const { row, hash } = await pendingReceipt(w);
    w.chain!.minedNonce = 8;
    await w.settler.reconcile(); // phase 1
    w.chain!.receipts.set(hash, { status: 'success', blockNumber: 101n }); // it was mined after all
    w.clock.advance(60_000);
    w.repos.state.setLastBlock(100n);
    await w.settler.reconcile();
    expect(w.repos.ticks.receipt(row.id)).toMatchObject({ status: 'pending', check_block: null });

    const v = world();
    const p = await pendingReceipt(v);
    v.chain!.minedNonce = 7; // nonce 7 still free: the tx can still be mined
    const before = v.sender.broadcasts.length;
    await v.settler.reconcile();
    expect(v.sender.broadcasts.length).toBe(before); // too early
    v.clock.advance(120_000);
    await v.settler.reconcile();
    expect(v.sender.broadcasts.slice(before)).toEqual([p.row.raw_tx]);
    expect(v.repos.ticks.receipt(p.row.id)).toMatchObject({ status: 'pending', attempts: 2 });
    expect(v.draws()).toBe(1);
  });

  it('unknown (no hash): resolved through the operator nonce floor and the indexed ComputeDrawn', async () => {
    const q = new FakeQueue();
    const w = world({ queue: q });
    addTick(w.repos, 3_000_000);
    q.outcome = (): TxOutcome => ({ kind: 'unknown', error: 'socket hang up', hash: null });
    const r = await w.settler.settle(TOKEN);
    if (r.kind !== 'settled') throw new Error('expected a receipt');
    const id = w.repos.ticks.receiptByHash(r.receiptHash)!.id;
    w.chain!.pendingNonce = 12;
    w.chain!.minedNonce = 10;
    await w.settler.reconcile();
    expect(w.repos.ticks.receipt(id)).toMatchObject({ status: 'unknown', nonce_floor: 12 });
    w.clock.advance(60_000);
    await w.settler.reconcile(); // nonces 10, 11 still pending somewhere: wait
    expect(w.repos.ticks.receipt(id)?.check_block).toBeNull();
    w.chain!.minedNonce = 12;
    w.chain!.head = 200n;
    await w.settler.reconcile(); // phase 1
    w.clock.advance(60_000);
    w.repos.state.setLastBlock(200n);
    await w.settler.reconcile();
    expect(w.repos.ticks.receipt(id)?.status).toBe('failed');

    // …whereas a ComputeDrawn with that receiptHash confirms it at any time
    const q3 = new FakeQueue();
    const w3 = world({ queue: q3 });
    addTick(w3.repos, 3_000_000);
    q3.outcome = (): TxOutcome => ({ kind: 'unknown', error: 'socket hang up', hash: null });
    const r3 = await w3.settler.settle(TOKEN);
    if (r3.kind !== 'settled') throw new Error('expected a receipt');
    w3.index({ args: [TOKEN, r3.amountWei, r3.receiptHash] }, 9n);
    expect(w3.repos.ticks.receiptByHash(r3.receiptHash)?.status).toBe('confirmed');
  });

  it('pending without a hash (stopped before signing) → failed; without a chain view nothing is ever released', async () => {
    const w = world();
    addTick(w.repos, 3_000_000);
    const t = w.repos.ticks.eligibleForSettlement(TOKEN, 10)[0]!;
    w.repos.ticks.insertReceipt({ token: TOKEN, receipt_hash: `0x${'0a'.repeat(32)}`, receipt_json: '{}', amount_wei: '1', status: 'pending', tx_hash: null, error: null, created_at: 1, updated_at: 1 }, [t.id]);
    await w.settler.reconcile();
    expect(w.repos.ticks.receiptByHash(`0x${'0a'.repeat(32)}`)?.status).toBe('failed');

    const blind = world({ chain: null });
    const { row } = await pendingReceipt(blind);
    blind.clock.advance(24 * 3_600_000);
    await blind.settler.reconcile();
    expect(blind.repos.ticks.receipt(row.id)?.status).toBe('pending');
  });

  it('startReconciler runs periodically and stop() waits for the running pass', async () => {
    const w = world();
    await pendingReceipt(w);
    let calls = 0;
    const original = w.chain!.transactionReceipt.bind(w.chain);
    w.chain!.transactionReceipt = async (h) => {
      calls++;
      return original(h);
    };
    w.settler.startReconciler(20);
    await new Promise((r) => setTimeout(r, 90));
    await w.settler.stop();
    const after = calls;
    expect(after).toBeGreaterThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(after);
  });
});

describe('schema v2 migration', () => {
  it('receipts left pending without a tx hash by an older runner become `unknown` (they may have been broadcast)', () => {
    const file = join(tmp, 'v1.sqlite');
    const v1 = Db.open(file, { schemaVersion: 1 });
    expect(v1.userVersion).toBe(1);
    v1.run("INSERT INTO receipts (token, receipt_hash, receipt_json, amount_wei, status, tx_hash, error, created_at, updated_at) VALUES (?, ?, '{}', '1', 'pending', NULL, NULL, 1, 1)", TOKEN, `0x${'0b'.repeat(32)}`);
    v1.run("INSERT INTO receipts (token, receipt_hash, receipt_json, amount_wei, status, tx_hash, error, created_at, updated_at) VALUES (?, ?, '{}', '1', 'pending', ?, NULL, 1, 1)", TOKEN, `0x${'0c'.repeat(32)}`, `0x${'cc'.repeat(32)}`);
    v1.close();
    const repos = new Repos(Db.open(file));
    expect(repos.db.userVersion).toBe(SCHEMA_VERSION); // v2 (receipt lifecycle) and later migrations applied
    expect(repos.ticks.receiptByHash(`0x${'0b'.repeat(32)}`)?.status).toBe('unknown');
    expect(repos.ticks.receiptByHash(`0x${'0c'.repeat(32)}`)?.status).toBe('pending');
    repos.db.close();
  });
});

describe('dry-run spend after switching to live (finding 4)', () => {
  it('ticks of dry_run receipts are settled on-chain in live mode (same receipt revived when identical)', async () => {
    const repos = memoryRepos();
    seed(repos);
    const econ = new EconomicsService(repos, new FixedEthUsd(PRICE), null, policy, silentLogger);
    addTick(repos, 3_000_000);
    const dry = new Settler(repos, econ, new FakeQueue(true) as unknown as TxQueue, { drawThresholdUsd: 2 }, silentLogger);
    const r1 = await dry.settle(TOKEN);
    expect(r1).toMatchObject({ status: 'dry_run' });
    const liveQueue = new FakeQueue(false);
    const live = new Settler(repos, econ, liveQueue as unknown as TxQueue, { drawThresholdUsd: 2 }, silentLogger);
    expect(live.releaseDryRunForLive()).toEqual({ ticks: 1, receipts: 1, costUsdMicro: 3_000_000 });
    const r2 = await live.settle(TOKEN, { force: true });
    expect(r2).toMatchObject({ kind: 'settled', status: 'pending' });
    expect(liveQueue.writes).toHaveLength(1);
    if (r2.kind !== 'settled' || r1.kind !== 'settled') return;
    expect(r2.receiptHash).toBe(r1.receiptHash); // identical ticks + price: the dry_run receipt is revived
    expect(drawReceiptHash(JSON.parse(repos.ticks.receiptByHash(r2.receiptHash)!.receipt_json))).toBe(r2.receiptHash);
    repos.tx(() => applyLogs(repos, decodeLaunchpadLogs([encodeLog('ComputeDrawn', { token: TOKEN, amount: r2.amountWei, receiptHash: r2.receiptHash }, { block: 3n, logIndex: 0, timestamp: 1n })]), () => 0n));
    expect(repos.ticks.unsettledMicro(TOKEN)).toBe(0);
    // a dry-run settler still never draws them
    addTick(repos, 2_500_000);
    expect(await dry.settle(TOKEN)).toMatchObject({ status: 'dry_run' });
    expect(await dry.settle(TOKEN, { force: true })).toEqual({ kind: 'skipped', reason: 'nothing' });
  });

  it('memories of dry_run anchors are released and anchored for real in live mode', async () => {
    const repos = memoryRepos();
    seed(repos);
    const bus = new StreamBus();
    const dry = new MemoryService(repos, bus, new FakeQueue(true) as unknown as TxQueue, { anchorEvery: 2 }, silentLogger);
    dry.remember(TOKEN, 'note', 'one', null, null);
    dry.remember(TOKEN, 'note', 'two', null, null);
    await dry.stop();
    expect(repos.memories.anchorsWithStatus('dry_run')).toHaveLength(1);
    const q = new FakeQueue(false);
    const live = new MemoryService(repos, bus, q as unknown as TxQueue, { anchorEvery: 2 }, silentLogger);
    expect(live.releaseDryRunForLive()).toEqual([TOKEN.toLowerCase()]);
    await live.stop();
    expect(q.writes.map((w) => w.write.functionName)).toEqual(['anchorMemory']);
    expect(repos.memories.anchorsWithStatus('confirmed')).toHaveLength(1);
    expect(repos.memories.anchorsWithStatus('dry_run')).toHaveLength(1); // history kept
  });
});

describe('indexer apply: receipts and anomalies', () => {
  it('ComputeDrawn confirms an unknown receipt; a draw for a released receipt and a negative balance are reported', () => {
    const repos = memoryRepos();
    seed(repos, 10n);
    const t = addTick(repos, 3_000_000);
    repos.ticks.insertReceipt({ token: TOKEN, receipt_hash: `0x${'0d'.repeat(32)}`, receipt_json: '{}', amount_wei: '5', status: 'unknown', tx_hash: null, error: null, created_at: 1, updated_at: 1 }, [t]);
    const anomalies: string[] = [];
    const sink = (m: string): void => void anomalies.push(m);
    repos.tx(() => applyLogs(repos, decodeLaunchpadLogs([encodeLog('ComputeDrawn', { token: TOKEN, amount: 5n, receiptHash: `0x${'0d'.repeat(32)}` }, { block: 3n, logIndex: 0, timestamp: 1n })]), () => 0n, sink));
    expect(repos.ticks.receiptByHash(`0x${'0d'.repeat(32)}`)?.status).toBe('confirmed');
    expect(anomalies).toEqual([]);
    repos.ticks.insertReceipt({ token: TOKEN, receipt_hash: `0x${'0e'.repeat(32)}`, receipt_json: '{}', amount_wei: '50', status: 'failed', tx_hash: null, error: null, created_at: 1, updated_at: 1 }, []);
    repos.tx(() => applyLogs(repos, decodeLaunchpadLogs([encodeLog('ComputeDrawn', { token: TOKEN, amount: 50n, receiptHash: `0x${'0e'.repeat(32)}` }, { block: 4n, logIndex: 0, timestamp: 1n })]), () => 0n, sink));
    expect(anomalies).toEqual(['indexed vault balance would go negative; stored as 0 (missed vault change?)', 'ComputeDrawn for a receipt that was not live (possible double draw)']);
    expect(repos.minds.get(TOKEN)?.mind_balance).toBe('0');
  });
});
