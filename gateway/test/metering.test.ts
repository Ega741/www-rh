import { receiptHash } from '@beagle/shared/canonical';
import { applyMarkupBps, costMicroUsd } from '@beagle/shared/credit';
import { DEFAULT_CATALOG } from '@beagle/shared/models';
import { describe, expect, it } from 'vitest';
import { Repos } from '../src/db/repos.js';
import { migrate } from '../src/db/schema.js';
import { Db } from '../src/db/sqlite.js';
import { estimateInputTokens, estimateRequest } from '../src/metering/estimate.js';
import { buildReceipt } from '../src/metering/receipts.js';
import { InsufficientCreditError, ReservationService } from '../src/metering/reserve.js';
import { SettlementService } from '../src/metering/settle.js';
import type { InternalRequestBase } from '../src/translate/internal.js';
import { ATA1, OPERATOR, WS1 } from './helpers.js';

const house = DEFAULT_CATALOG.find((m) => m.id === 'house/gpt-oss-20b')!;
const opus = DEFAULT_CATALOG.find((m) => m.id === 'anthropic/claude-opus-5-5')!;
const LIMITS = { markupBps: 1000, minReserveMicro: 10_000n, maxReserveMicro: 5_000_000n };

function setup(): { repos: Repos; reservations: ReservationService; settlement: SettlementService; now: () => number } {
  const db = new Db(':memory:');
  migrate(db);
  const repos = new Repos(db);
  const now = (): number => 1_700_000_000_000;
  return {
    repos,
    now,
    reservations: new ReservationService(repos, { minReserveMicro: 10_000n, ttlMs: 60_000 }, now),
    settlement: new SettlementService(repos, { markupBps: 1000, byokFeeBps: 0 }, now),
  };
}

describe('estimate', () => {
  const req: InternalRequestBase = {
    messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(400) }] }],
    tools: [{ name: 't', parameters: {} }],
    maxTokens: 1_000_000,
    stream: false,
  };

  it('input tokens = ceil(chars/4) + 50 per tool; output capped at maxOutput; reserve clamped', () => {
    const chars = 400 + 't'.length + JSON.stringify({}).length;
    expect(estimateInputTokens(req)).toBe(Math.ceil(chars / 4) + 50);
    const e = estimateRequest(req, house, LIMITS);
    expect(e.outputTokens).toBe(house.maxOutput);
    const raw = applyMarkupBps(costMicroUsd({ inputTokens: e.inputTokens, outputTokens: e.outputTokens }, house.price), 1000);
    expect(e.estimateMicro).toBe(raw);
    expect(e.reserveMicro).toBe(raw > 5_000_000n ? 5_000_000n : raw < 10_000n ? 10_000n : raw);
    const { tools: _tools, ...noTools } = req;
    const tiny = estimateRequest({ ...noTools, maxTokens: 1, messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }] }] }, house, LIMITS);
    expect(tiny.reserveMicro).toBe(10_000n);
    const big = estimateRequest(req, opus, LIMITS);
    expect(big.reserveMicro).toBe(big.estimateMicro);
    expect(big.estimateMicro).toBeGreaterThan(2_000_000n);
    const huge = estimateRequest({ ...req, messages: [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(2_000_000) }] }] }, opus, LIMITS);
    expect(huge.reserveMicro).toBe(5_000_000n);
  });
});

describe('reserve', () => {
  it('gates on MIN_RESERVE and holds min(reserve, max(available, MIN))', () => {
    const { repos, reservations, now } = setup();
    repos.workspaces.ensure(WS1, now());
    expect(() => reservations.reserve(WS1, 50_000n)).toThrow(InsufficientCreditError);
    repos.ledger.insert({ workspace: WS1, kind: 'credit', amountMicro: 9_999n, refType: null, refId: null, memo: null, createdAt: now() });
    expect(() => reservations.reserve(WS1, 50_000n)).toThrow(InsufficientCreditError);
    repos.ledger.insert({ workspace: WS1, kind: 'credit', amountMicro: 10_001n, refType: null, refId: null, memo: null, createdAt: now() });
    const r1 = reservations.reserve(WS1, 50_000n);
    expect(r1.amountMicro).toBe(20_000n);
    expect(repos.ledger.snapshot(WS1, now()).available).toBe(0n);
    expect(() => reservations.reserve(WS1, 1n)).toThrow(InsufficientCreditError);
    reservations.release(r1.id);
    expect(repos.ledger.snapshot(WS1, now()).available).toBe(20_000n);
    const r2 = reservations.reserve(WS1, 5_000n);
    expect(r2.amountMicro).toBe(5_000n);
  });

  it('budget headroom lets a workspace reserve below zero balance', () => {
    const { repos, reservations, now } = setup();
    repos.workspaces.ensure(WS1, now());
    repos.budgets.upsert({ tokenAccount: ATA1, owner: WS1, delegate: OPERATOR, cap: 10n ** 9n, balance: 10n ** 9n, now: now() });
    repos.budgets.setHeadroom(ATA1, 10n ** 9n, 1_000_000n, null, now());
    const r = reservations.reserve(WS1, 300_000n);
    expect(r.amountMicro).toBe(300_000n);
  });
});

describe('settle', () => {
  it('debits markup(cost) for credit, byok fee for BYOK, writes the usage row and releases the reservation', () => {
    const { repos, reservations, settlement, now } = setup();
    repos.workspaces.ensure(WS1, now());
    repos.ledger.insert({ workspace: WS1, kind: 'credit', amountMicro: 1_000_000n, refType: null, refId: null, memo: null, createdAt: now() });
    const r = reservations.reserve(WS1, 100_000n);
    const usage = { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const s = settlement.settle({
      requestId: 'req_a',
      workspace: WS1,
      apiKeyId: 'k',
      endpoint: 'chat.completions',
      requestedModel: 'beagle/auto',
      model: house,
      paidBy: 'credit',
      tier: 'house',
      usage,
      status: 'ok',
      httpStatus: 200,
      errorCode: null,
      latencyMs: 5,
      routeReasons: ['a', 'b'],
      stream: false,
      difficulty: 0.25,
      reservationId: r.id,
      createdAt: now(),
    });
    const cost = costMicroUsd(usage, house.price); // 50 + 100 = 150
    expect(s.upstreamCostMicro).toBe(cost);
    expect(s.chargedMicro).toBe(applyMarkupBps(cost, 1000));
    expect(s.balanceMicro).toBe(1_000_000n - s.chargedMicro);
    expect(repos.reservations.get(r.id)).toBeUndefined();
    expect(repos.usage.get('req_a')).toMatchObject({ chargedMicro: s.chargedMicro, servedModel: 'house/gpt-oss-20b', routeReasons: ['a', 'b'], markupBps: 1000 });
    expect(repos.ledger.list(WS1, 1)[0]).toMatchObject({ kind: 'debit', amountMicro: -s.chargedMicro, refType: 'usage', refId: 'req_a' });

    const b = settlement.settle({
      requestId: 'req_b',
      workspace: WS1,
      apiKeyId: 'k',
      endpoint: 'chat.completions',
      requestedModel: 'openai/gpt-5.5',
      model: opus,
      paidBy: 'byok',
      tier: 'frontier',
      usage,
      status: 'ok',
      httpStatus: 200,
      errorCode: null,
      latencyMs: 5,
      routeReasons: [],
      stream: false,
      difficulty: null,
      reservationId: undefined,
      createdAt: now(),
    });
    expect(b.chargedMicro).toBe(0n);
    expect(b.balanceMicro).toBe(s.balanceMicro);

    const e = settlement.settle({
      requestId: 'req_c',
      workspace: WS1,
      apiKeyId: null,
      endpoint: 'messages',
      requestedModel: 'nope',
      model: undefined,
      paidBy: undefined,
      tier: undefined,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      status: 'error',
      httpStatus: 404,
      errorCode: 'model_not_found',
      latencyMs: 1,
      routeReasons: ['resolve: unknown'],
      stream: false,
      difficulty: 0.3,
      reservationId: undefined,
      createdAt: now(),
    });
    expect(e.chargedMicro).toBe(0n);
    expect(repos.usage.get('req_c')?.status).toBe('error');
  });

  it('receipt hash recomputes from the wire receipt and is stable across catalog price changes', () => {
    const { repos, settlement, now } = setup();
    repos.workspaces.ensure(WS1, now());
    settlement.settle({
      requestId: 'req_r',
      workspace: WS1,
      apiKeyId: 'k',
      endpoint: 'chat.completions',
      requestedModel: 'beagle/cheap',
      model: house,
      paidBy: 'credit',
      tier: 'house',
      usage: { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
      status: 'ok',
      httpStatus: 200,
      errorCode: null,
      latencyMs: 2,
      routeReasons: ['x'],
      stream: true,
      difficulty: 0.1,
      reservationId: undefined,
      createdAt: now(),
    });
    const row = repos.usage.get('req_r')!;
    const built = buildReceipt(row)!;
    expect(built.hash).toBe(receiptHash(built.receipt));
    expect(built.hash).toBe(receiptHash(JSON.parse(JSON.stringify(built.receipt))));
    expect(built.receipt.price).toEqual(house.price);
    expect(built.receipt.chargedMicro).toBe(row.chargedMicro.toString());
    const unserved = { ...row, servedModel: null };
    expect(buildReceipt(unserved)).toBeUndefined();
  });
});
