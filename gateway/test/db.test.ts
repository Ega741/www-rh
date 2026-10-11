import { describe, expect, it } from 'vitest';
import { Repos } from '../src/db/repos.js';
import { MIGRATIONS, migrate } from '../src/db/schema.js';
import { Db } from '../src/db/sqlite.js';
import { LedgerService } from '../src/metering/ledger.js';
import { WS1 } from './helpers.js';

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
    for (const t of ['workspaces', 'api_keys', 'sessions', 'siwe_nonces', 'ledger', 'credit_events', 'reservations', 'usage', 'provider_keys', 'budgets', 'budget_draws', 'upgrades', 'provider_health', 'indexer_state', 'price_posts', 'rate_limits']) {
      expect(tables).toContain(t);
    }
    db.close();
  });

  it('keeps ledger math exact above 2^53', () => {
    const { db, repos } = open();
    const now = 1_000;
    repos.workspaces.ensure(WS1, now);
    const huge = 2n ** 60n;
    repos.ledger.insert({ workspace: WS1, kind: 'credit', amountMicro: huge, refType: 'credit_event', refId: 'a:0', memo: null, createdAt: now });
    repos.ledger.insert({ workspace: WS1, kind: 'debit', amountMicro: -3n, refType: 'usage', refId: 'req_1', memo: null, createdAt: now });
    expect(repos.ledger.balance(WS1)).toBe(huge - 3n);
    expect(repos.ledger.balance(WS1.toUpperCase())).toBe(huge - 3n);
    db.close();
  });

  it('computes balance, reserved, headroom and available', () => {
    const { db, repos } = open();
    const now = 10_000;
    repos.workspaces.ensure(WS1, now);
    repos.ledger.insert({ workspace: WS1, kind: 'credit', amountMicro: 1_000_000n, refType: null, refId: null, memo: null, createdAt: now });
    repos.reservations.insert({ id: 'r1', workspace: WS1, amountMicro: 200_000n, createdAt: now, expiresAt: now + 1000 });
    repos.reservations.insert({ id: 'r2', workspace: WS1, amountMicro: 999n, createdAt: now - 5000, expiresAt: now - 1 }); // expired
    repos.budgets.upsertOpened({ budgetId: 1, owner: WS1, workspace: WS1, cap: 10n ** 21n, deadline: Math.floor(now / 1000) + 3600, openedBlock: 1, now });
    repos.budgets.setHeadroom(1, 10n ** 21n, 5_000_000n, null, now);
    repos.budgets.upsertOpened({ budgetId: 2, owner: WS1, workspace: WS1, cap: 10n ** 21n, deadline: Math.floor(now / 1000) + 3600, openedBlock: 1, now });
    repos.budgets.setHeadroom(2, 10n ** 21n, 7_000_000n, 'allowance', now); // stalled: excluded
    const snap = repos.ledger.snapshot(WS1, now);
    expect(snap).toEqual({ balance: 1_000_000n, reserved: 200_000n, budgetHeadroom: 5_000_000n, available: 5_800_000n });
    expect(repos.reservations.purgeExpired(now)).toBe(1);
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

  it('LedgerService.adjust creates the workspace and credits it', () => {
    const { db, repos } = open();
    const ledger = new LedgerService(repos, () => 5);
    ledger.adjust(WS2(), 2_500_000n, 'promo');
    expect(ledger.balance(WS2())).toBe(2_500_000n);
    expect(repos.workspaces.get(WS2())?.plan).toBe('free');
    db.close();
  });

  it('expired SIWE nonces are purged by housekeeping, not only on verify', () => {
    const { db, repos } = open();
    repos.nonces.insert('fresh', 1_000, 601_000);
    repos.nonces.insert('old', 0, 500);
    expect(repos.nonces.purgeExpired(1_000)).toBe(1);
    expect(repos.nonces.consume('old', 1_000)).toBe(false);
    expect(repos.nonces.consume('fresh', 1_000)).toBe(true);
    expect(repos.nonces.consume('fresh', 1_000)).toBe(false); // single use
    expect(db.all(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'siwe_nonces_expires'`)).toHaveLength(1);
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

function WS2(): string {
  return '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
}
