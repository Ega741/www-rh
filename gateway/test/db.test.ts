import { describe, expect, it } from 'vitest';
import { Repos } from '../src/db/repos.js';
import { MIGRATIONS, migrate } from '../src/db/schema.js';
import { Db } from '../src/db/sqlite.js';
import { LedgerService } from '../src/metering/ledger.js';
import { ATA1, ATA2, OPERATOR, testPubkey, testSignature, WS1, WS2 } from './helpers.js';

function open(): { db: Db; repos: Repos } {
  const db = new Db(':memory:');
  migrate(db);
  return { db, repos: new Repos(db) };
}

describe('database', () => {
  it('migrates idempotently and tracks user_version', () => {
    const db = new Db(':memory:');
    expect(migrate(db)).toEqual({ from: 0, to: MIGRATIONS.length });
    expect(migrate(db)).toEqual({ from: MIGRATIONS.length, to: MIGRATIONS.length });
    expect(db.userVersion).toBe(MIGRATIONS.length);
    const tables = db.all(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).map((r) => r['name']);
    for (const t of ['workspaces', 'api_keys', 'sessions', 'siws_nonces', 'ledger', 'credit_events', 'price_points', 'reservations', 'usage', 'provider_keys', 'budgets', 'budget_draws', 'upgrades', 'provider_health', 'indexer_state', 'settings', 'rate_limits']) {
      expect(tables).toContain(t);
    }
    expect(tables).not.toContain('price_posts');
    const indices = db.all(`SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name`).map((r) => r['name']);
    for (const i of ['ledger_workspace', 'ledger_ref', 'usage_workspace_created', 'credit_events_workspace', 'credit_events_slot', 'reservations_workspace', 'budgets_workspace', 'budgets_owner', 'siws_nonces_expires']) {
      expect(indices).toContain(i);
    }
    db.close();
  });

  it('keeps ledger math exact above 2^53 and workspaces verbatim (base58 is case-sensitive)', () => {
    const { db, repos } = open();
    const now = 1_000;
    repos.workspaces.ensure(WS1, now);
    const huge = 2n ** 60n;
    repos.ledger.insert({ workspace: WS1, kind: 'credit', amountMicro: huge, refType: 'credit_event', refId: 'a:0', memo: null, createdAt: now });
    repos.ledger.insert({ workspace: WS1, kind: 'debit', amountMicro: -3n, refType: 'usage', refId: 'req_1', memo: null, createdAt: now });
    expect(repos.ledger.balance(WS1)).toBe(huge - 3n);
    expect(repos.ledger.balance(` ${WS1} `)).toBe(huge - 3n);
    expect(repos.ledger.balance(WS1.toLowerCase())).toBe(0n);
    db.close();
  });

  it('computes balance, reserved, headroom and available (closed and stalled budgets excluded)', () => {
    const { db, repos } = open();
    const now = 10_000;
    repos.workspaces.ensure(WS1, now);
    repos.ledger.insert({ workspace: WS1, kind: 'credit', amountMicro: 1_000_000n, refType: null, refId: null, memo: null, createdAt: now });
    repos.reservations.insert({ id: 'r1', workspace: WS1, amountMicro: 200_000n, createdAt: now, expiresAt: now + 1000 });
    repos.reservations.insert({ id: 'r2', workspace: WS1, amountMicro: 999n, createdAt: now - 5000, expiresAt: now - 1 }); // expired
    repos.budgets.upsert({ tokenAccount: ATA1, owner: WS1, delegate: OPERATOR, cap: 10n ** 9n, balance: 10n ** 9n, now });
    repos.budgets.setHeadroom(ATA1, 10n ** 9n, 5_000_000n, null, now);
    repos.budgets.upsert({ tokenAccount: ATA2, owner: WS2, workspace: WS1, delegate: OPERATOR, cap: 10n ** 9n, balance: 10n ** 9n, now });
    repos.budgets.setHeadroom(ATA2, 10n ** 9n, 7_000_000n, 'exhausted', now); // stalled: excluded
    repos.budgets.upsert({ tokenAccount: testPubkey(3), owner: WS1, delegate: null, cap: 0n, balance: 1n, now });
    repos.budgets.setHeadroom(testPubkey(3), 10n ** 9n, 9_000_000n, null, now);
    repos.budgets.setClosed(testPubkey(3), true, 'revoked', now); // closed: excluded and zeroed
    const snap = repos.ledger.snapshot(WS1, now);
    expect(snap).toEqual({ balance: 1_000_000n, reserved: 200_000n, budgetHeadroom: 5_000_000n, available: 5_800_000n });
    expect(repos.reservations.purgeExpired(now)).toBe(1);
    expect(repos.budgets.get(testPubkey(3))).toMatchObject({ closed: true, stalledReason: 'revoked', headroomMicro: 0n, headroomTokens: 0n });
    expect(repos.budgets.list(WS1).map((b) => b.tokenAccount).sort()).toEqual([ATA1, ATA2, testPubkey(3)].sort());
    expect(repos.budgets.listByOwner(WS2).map((b) => b.tokenAccount)).toEqual([ATA2]);
    expect(repos.budgets.listOpen().map((b) => b.tokenAccount).sort()).toEqual([ATA1, ATA2].sort());
    expect(repos.budgets.listDrawable(WS1).map((b) => b.tokenAccount)).toEqual([ATA1]);
    expect(repos.budgets.openOwners()).toEqual([WS1, WS2].sort());
    // upsert keeps the workspace and registration of an existing row unless given
    repos.budgets.upsert({ tokenAccount: ATA2, owner: WS2, delegate: OPERATOR, cap: 5n, balance: 5n, now: now + 1, lastSeenSlot: 9 });
    expect(repos.budgets.get(ATA2)).toMatchObject({ workspace: WS1, cap: 5n, lastSeenSlot: 9, registeredAt: null });
    repos.budgets.upsert({ tokenAccount: ATA2, owner: WS2, workspace: WS2, delegate: OPERATOR, cap: 5n, balance: 5n, now: now + 2, registeredAt: now + 2 });
    expect(repos.budgets.get(ATA2)).toMatchObject({ workspace: WS2, registeredAt: now + 2, lastSeenSlot: 9 });
    db.close();
  });

  it('rejects duplicate ledger refs and unknown kinds', () => {
    const { db, repos } = open();
    repos.workspaces.ensure(WS1, 1);
    repos.ledger.insert({ workspace: WS1, kind: 'credit', amountMicro: 1n, refType: 'credit_event', refId: 'x:1', memo: null, createdAt: 1 });
    expect(() => repos.ledger.insert({ workspace: WS1, kind: 'credit', amountMicro: 1n, refType: 'credit_event', refId: 'x:1', memo: null, createdAt: 1 })).toThrow();
    expect(() => db.run(`INSERT INTO ledger(workspace, kind, amount_micro, created_at) VALUES (?, 'bonus', 1, 1)`, [WS1])).toThrow();
    db.close();
  });

  it('credit events: primary key, list with cursor, by signature, sweep candidates, delete', () => {
    const { db, repos } = open();
    repos.workspaces.ensure(WS1, 1);
    const base = { kind: 'purchase' as const, workspace: WS1, payer: WS1, tokenAccount: ATA1, authority: WS1, tokenAmount: 1n, usdMicro: 1n, priceE18: 10n ** 16n, pricePointId: 1, priceStale: false, memo: null, receiptHash: null, blockTime: 1 };
    repos.creditEvents.insert({ ...base, signature: testSignature(1), ixIndex: 0, slot: 10, createdAt: 100 });
    repos.creditEvents.insert({ ...base, signature: testSignature(1), ixIndex: 2, slot: 10, createdAt: 100 });
    repos.creditEvents.insert({ ...base, signature: testSignature(2), ixIndex: 0, slot: 11, createdAt: 200 });
    expect(() => repos.creditEvents.insert({ ...base, signature: testSignature(1), ixIndex: 0, slot: 10, createdAt: 100 })).toThrow();
    expect(repos.creditEvents.exists(testSignature(1), 2)).toBe(true);
    expect(repos.creditEvents.exists(testSignature(1), 1)).toBe(false);
    expect(repos.creditEvents.list(WS1, 10).map((e) => [e.signature, e.ixIndex])).toEqual([
      [testSignature(2), 0],
      [testSignature(1), 2],
      [testSignature(1), 0],
    ]);
    expect(repos.creditEvents.list(WS1, 10, 200).map((e) => e.signature)).toEqual([testSignature(1), testSignature(1)]);
    expect(repos.creditEvents.listBySignature(testSignature(1)).map((e) => e.ixIndex)).toEqual([0, 2]);
    expect(repos.creditEvents.signaturesForSweep(0, 150, 10)).toEqual([{ signature: testSignature(1), slot: 10 }]);
    expect(repos.creditEvents.signaturesForSweep(11, 300, 10)).toEqual([{ signature: testSignature(2), slot: 11 }]);
    expect(repos.creditEvents.lastBlockTime()).toBe(1);
    expect(repos.creditEvents.deleteBySignature(testSignature(1))).toBe(2);
    expect(repos.creditEvents.list(WS1, 10)).toHaveLength(1);
    db.close();
  });

  it('price points: insert, latest, list newest first', () => {
    const { db, repos } = open();
    expect(repos.pricePoints.latest()).toBeUndefined();
    const a = repos.pricePoints.insert({ priceE18: 10n ** 16n, source: 'manual', observedAt: 1, createdAt: 1000 });
    const b = repos.pricePoints.insert({ priceE18: 2n * 10n ** 16n, source: 'feed', observedAt: 2, createdAt: 2000 });
    expect(a.id).toBe(1);
    expect(repos.pricePoints.latest()).toEqual({ ...b, id: 2 });
    expect(repos.pricePoints.list(5).map((p) => p.id)).toEqual([2, 1]);
    expect(repos.pricePoints.get(1)?.priceE18).toBe(10n ** 16n);
    db.close();
  });

  it('usage list, filters, cursor and summary', () => {
    const { db, repos } = open();
    const base = 1_700_000_000_000;
    for (let i = 0; i < 5; i++) {
      repos.usage.insert({
        id: `req_${i}`,
        workspace: WS1,
        apiKeyId: 'k',
        endpoint: 'chat.completions',
        requestedModel: 'beagle/auto',
        servedModel: i % 2 === 0 ? 'house/gpt-oss-20b' : 'openai/gpt-5.4-mini',
        provider: i % 2 === 0 ? 'house' : 'openai',
        tier: 'house',
        paidBy: 'credit',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        upstreamCostMicro: 2n,
        chargedMicro: 3n,
        status: i === 4 ? 'error' : 'ok',
        httpStatus: 200,
        errorCode: null,
        latencyMs: 12,
        routeReasons: ['r'],
        stream: false,
        difficulty: 0.3,
        drawId: null,
        priceJson: null,
        markupBps: 1000,
        createdAt: base + i * 1000,
      });
    }
    const page = repos.usage.list(WS1, { limit: 2 });
    expect(page.map((r) => r.id)).toEqual(['req_4', 'req_3']);
    const next = repos.usage.list(WS1, { limit: 2, before: page[1]!.createdAt });
    expect(next.map((r) => r.id)).toEqual(['req_2', 'req_1']);
    expect(repos.usage.list(WS1, { limit: 10, status: 'error' })).toHaveLength(1);
    expect(repos.usage.list(WS1, { limit: 10, model: 'openai/gpt-5.4-mini' })).toHaveLength(2);
    const s = repos.usage.summary(WS1, base);
    expect(s.requests).toBe(5);
    expect(s.chargedMicro).toBe(15n);
    expect(s.inputTokens).toBe(50);
    expect(s.byModel.map((m) => m.model).sort()).toEqual(['house/gpt-oss-20b', 'openai/gpt-5.4-mini']);
    expect(s.byDay).toHaveLength(1);
    expect(s.byDay[0]!.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(repos.usage.unsettled(WS1).map((r) => r.id)).toEqual(['req_0', 'req_1', 'req_2', 'req_3', 'req_4']);
    repos.usage.setDrawId(['req_0', 'req_1'], 7);
    expect(repos.usage.unsettled(WS1)).toHaveLength(3);
    db.close();
  });

  it('budget draws: insert, by hash / signature, in flight, status updates keep untouched fields', () => {
    const { db, repos } = open();
    const id = repos.budgetDraws.insert({ tokenAccount: ATA2, workspace: WS2, tokenAmount: 300n, usdMicro: 3n, receiptHash: `0x${'AB'.repeat(32)}`, usageIds: ['u1'], batchJson: '{}', signature: null, lastValidBlockHeight: null, status: 'pending', error: null, createdAt: 1, updatedAt: 1 });
    expect(repos.budgetDraws.byReceiptHash(`0x${'ab'.repeat(32)}`)?.id).toBe(id);
    expect(repos.budgetDraws.listInFlight().map((d) => d.id)).toEqual([id]);
    repos.budgetDraws.setStatus(id, 'sent', 2, { signature: testSignature(5), lastValidBlockHeight: 400 });
    expect(repos.budgetDraws.get(id)).toMatchObject({ status: 'sent', signature: testSignature(5), lastValidBlockHeight: 400, updatedAt: 2 });
    expect(repos.budgetDraws.bySignature(testSignature(5))?.id).toBe(id);
    repos.budgetDraws.setStatus(id, 'confirmed', 3, { error: null });
    expect(repos.budgetDraws.get(id)).toMatchObject({ status: 'confirmed', signature: testSignature(5), lastValidBlockHeight: 400 });
    expect(repos.budgetDraws.listInFlight()).toEqual([]);
    expect(repos.budgetDraws.listByTokenAccount(ATA2)).toHaveLength(1);
    db.close();
  });

  it('LedgerService.adjust creates the workspace and credits it', () => {
    const { db, repos } = open();
    const ledger = new LedgerService(repos, () => 5);
    ledger.adjust(WS2, 2_500_000n, 'promo');
    expect(ledger.balance(WS2)).toBe(2_500_000n);
    expect(repos.workspaces.get(WS2)?.plan).toBe('free');
    db.close();
  });

  it('SIWS nonces: peek without consuming, single use, housekeeping purge', () => {
    const { db, repos } = open();
    repos.nonces.insert('fresh', 1_000, 601_000);
    repos.nonces.insert('old', 0, 500);
    expect(repos.nonces.peek('fresh', 1_000)).toBe(true);
    expect(repos.nonces.peek('old', 1_000)).toBe(false);
    expect(repos.nonces.purgeExpired(1_000)).toBe(1);
    expect(repos.nonces.consume('old', 1_000)).toBe(false);
    expect(repos.nonces.consume('fresh', 1_000)).toBe(true);
    expect(repos.nonces.consume('fresh', 1_000)).toBe(false); // single use
    expect(repos.nonces.peek('fresh', 1_000)).toBe(false);
    db.close();
  });

  it('rate limit windows roll over', () => {
    const { db, repos } = open();
    expect(repos.rateLimits.hit('k', 60_000, 60_000)).toEqual({ count: 1, windowStart: 60_000 });
    expect(repos.rateLimits.hit('k', 61_000, 60_000).count).toBe(2);
    expect(repos.rateLimits.hit('k', 120_000, 60_000).count).toBe(1);
    db.close();
  });

  it('transactions roll back on throw and nest', () => {
    const { db, repos } = open();
    repos.workspaces.ensure(WS1, 1);
    expect(() =>
      db.transaction(() => {
        repos.ledger.insert({ workspace: WS1, kind: 'credit', amountMicro: 5n, refType: null, refId: null, memo: null, createdAt: 1 });
        db.transaction(() => {
          repos.ledger.insert({ workspace: WS1, kind: 'credit', amountMicro: 5n, refType: null, refId: null, memo: null, createdAt: 1 });
        });
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(repos.ledger.balance(WS1)).toBe(0n);
    db.close();
  });
});
