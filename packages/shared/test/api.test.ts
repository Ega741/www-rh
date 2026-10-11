import { describe, expect, it } from 'vitest';
import { receiptHash } from '../src/canonical.js';
import {
  AdminCreditRequestSchema,
  ApiKeyDtoSchema,
  BalanceDtoSchema,
  BudgetDtoSchema,
  ConfigDtoSchema,
  CreateApiKeyRequestSchema,
  CreditEventDtoSchema,
  CursorQuerySchema,
  DrawBatchSchema,
  ErrorDtoSchema,
  HealthzDtoSchema,
  LedgerRowDtoSchema,
  MeDtoSchema,
  MicroSchema,
  ModelDtoSchema,
  ModelsDtoSchema,
  NonceDtoSchema,
  PriceDtoSchema,
  ProviderKeyDtoSchema,
  PutProviderKeyRequestSchema,
  QuoteDtoSchema,
  QuoteQuerySchema,
  ReceiptDtoSchema,
  StatusDtoSchema,
  UintStringSchema,
  UpgradeDtoSchema,
  UpgradePricesDtoSchema,
  UpgradeRequestSchema,
  UsageListDtoSchema,
  UsageQuerySchema,
  UsageReceiptSchema,
  UsageRowDtoSchema,
  UsageSummaryDtoSchema,
  VerifyDtoSchema,
  serializeMicro,
  type BalanceDtoWire,
  type BudgetDtoWire,
  type ConfigDtoWire,
  type CreditEventDtoWire,
  type MeDtoWire,
  type PriceDtoWire,
  type StatusDtoWire,
  type UsageReceiptWire,
  type UsageRowDtoWire,
  type UsageSummaryDtoWire,
} from '../src/api.js';
import { DEFAULT_CATALOG } from '../src/models.js';

const WS = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const HASH = `0x${'ab'.repeat(32)}`;

const price: PriceDtoWire = {
  priceE18: '2500000000000000',
  updatedAt: 1_760_000_000,
  stale: false,
  usdPerToken: '0.0025',
  tokensPerUsd: '400',
  source: 'manual',
  maxPriceAge: 3600,
};

describe('primitives', () => {
  it('MicroSchema parses decimal strings to bigint', () => {
    expect(MicroSchema.parse('2500000')).toBe(2_500_000n);
    expect(MicroSchema.parse('-5')).toBe(-5n);
    expect(MicroSchema.parse('0')).toBe(0n);
    expect(MicroSchema.safeParse('1.5').success).toBe(false);
    expect(MicroSchema.safeParse('').success).toBe(false);
    expect(MicroSchema.safeParse(5).success).toBe(false);
    expect(UintStringSchema.parse('10').toString()).toBe('10');
    expect(UintStringSchema.safeParse('-1').success).toBe(false);
  });
  it('serializeMicro', () => {
    expect(serializeMicro(2_500_000n)).toBe('2500000');
    expect(serializeMicro(-1n)).toBe('-1');
    expect(MicroSchema.parse(serializeMicro(123n))).toBe(123n);
  });
});

describe('public DTOs', () => {
  it('PriceDto / QuoteDto', () => {
    const p = PriceDtoSchema.parse(price);
    expect(p.priceE18).toBe(2_500_000_000_000_000n);
    expect(p.source).toBe('manual');
    expect(PriceDtoSchema.safeParse({ ...price, source: 'oracle' }).success).toBe(false);
    const q = QuoteDtoSchema.parse({ tokens: '1000000000000000000000', usdMicro: '2500000', priceE18: price.priceE18, updatedAt: 1 });
    expect(q).toEqual({ tokens: 10n ** 21n, usdMicro: 2_500_000n, priceE18: 2_500_000_000_000_000n, updatedAt: 1 });
  });

  it('QuoteQuerySchema requires exactly one of tokens / usdMicro', () => {
    expect(QuoteQuerySchema.parse({ tokens: '5' })).toEqual({ tokens: 5n });
    expect(QuoteQuerySchema.parse({ usdMicro: '5' })).toEqual({ usdMicro: 5n });
    expect(QuoteQuerySchema.safeParse({}).success).toBe(false);
    expect(QuoteQuerySchema.safeParse({ tokens: '1', usdMicro: '1' }).success).toBe(false);
  });

  it('StatusDto requires every provider', () => {
    const status: StatusDtoWire = {
      chainId: 31337,
      creditDesk: WS,
      token: { address: WS, symbol: 'BEAGLE', decimals: 18, nativeBurn: true },
      indexer: { lastBlock: 10, head: 12, lagBlocks: 2, lastEventAt: null },
      providers: {
        anthropic: { state: 'ok', configured: true },
        openai: { state: 'down', configured: false },
        google: { state: 'degraded', configured: true },
        house: { state: 'ok', configured: true },
      },
      house: { enabled: true, warmUntil: null, largeModel: 'openai/gpt-oss-120b' },
      operator: { enabled: false, dryRun: true },
      version: '0.1.0',
    };
    expect(StatusDtoSchema.parse(status)).toEqual(status);
    const { house: _h, ...missing } = status.providers;
    expect(StatusDtoSchema.safeParse({ ...status, providers: missing }).success).toBe(false);
    expect(StatusDtoSchema.safeParse({ ...status, creditDesk: 'abc' }).success).toBe(false);
    expect(StatusDtoSchema.parse({ ...status, creditDesk: null, token: null }).token).toBeNull();
  });

  it('ConfigDto', () => {
    const config: ConfigDtoWire = {
      chainId: 4663,
      creditDesk: WS,
      token: { address: WS, symbol: 'BEAGLE', decimals: 18, nativeBurn: false },
      priceSource: WS,
      explorer: 'https://robinhoodchain.blockscout.com',
      aliases: ['beagle/auto', 'beagle/best', 'beagle/cheap', 'beagle/house'],
      markupBps: 1000,
      byokFeeBps: 0,
      pro: { priceMicro: '20000000', days: 30 },
      warmHourPriceMicro: '2000000',
    };
    const parsed = ConfigDtoSchema.parse(config);
    expect(parsed.pro.priceMicro).toBe(20_000_000n);
    expect(parsed.warmHourPriceMicro).toBe(2_000_000n);
  });

  it('ModelDto / ModelsDto extend the catalog spec', () => {
    const models = DEFAULT_CATALOG.map((m) => ({ ...m, available: m.provider !== 'house', providerState: 'ok' as const }));
    const dto = ModelsDtoSchema.parse({ models, aliases: [{ id: 'beagle/auto', description: 'auto' }] });
    expect(dto.models).toHaveLength(12);
    expect(dto.models[0]?.available).toBe(true);
    expect(ModelDtoSchema.safeParse({ ...models[0], providerState: 'broken' }).success).toBe(false);
    expect(ModelsDtoSchema.safeParse({ models, aliases: [{ id: 'beagle/nope', description: '' }] }).success).toBe(false);
  });

  it('ErrorDto / HealthzDto / NonceDto / VerifyDto', () => {
    expect(ErrorDtoSchema.parse({ error: { code: 'invalid_api_key', message: 'nope' } }).error.code).toBe('invalid_api_key');
    expect(ErrorDtoSchema.safeParse({ error: { code: 'x' } }).success).toBe(false);
    expect(HealthzDtoSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(HealthzDtoSchema.safeParse({ ok: false }).success).toBe(false);
    expect(NonceDtoSchema.parse({ nonce: 'abcdefgh' }).nonce).toBe('abcdefgh');
    expect(NonceDtoSchema.safeParse({ nonce: 'abc' }).success).toBe(false);
    expect(VerifyDtoSchema.parse({ token: 't', workspace: WS }).workspace).toBe(WS);
  });
});

describe('workspace DTOs', () => {
  it('MeDto and BalanceDto', () => {
    const me: MeDtoWire = {
      workspace: WS,
      plan: 'free',
      planUntil: null,
      balanceMicro: '9990000',
      reservedMicro: '10000',
      budgetHeadroomMicro: '0',
      availableMicro: '9980000',
      createdAt: 1_760_000_000_000,
    };
    const parsedMe = MeDtoSchema.parse(me);
    expect(parsedMe.availableMicro).toBe(9_980_000n);
    expect(parsedMe.planUntil).toBeNull();
    const balance: BalanceDtoWire = { balanceMicro: '-5', reservedMicro: '0', budgetHeadroomMicro: '100', availableMicro: '95', plan: 'pro', planUntil: 1, price };
    const parsedBalance = BalanceDtoSchema.parse(balance);
    expect(parsedBalance.balanceMicro).toBe(-5n);
    expect(parsedBalance.price.priceE18).toBe(2_500_000_000_000_000n);
    expect(BalanceDtoSchema.safeParse({ ...balance, plan: 'gold' }).success).toBe(false);
  });

  it('ApiKeyDto with and without the key', () => {
    const row = ApiKeyDtoSchema.parse({ id: 'k1', prefix: 'bgl_abcdefgh', name: 'ci', createdAt: 1, lastUsedAt: null });
    expect(row.key).toBeUndefined();
    const created = ApiKeyDtoSchema.parse({ id: 'k1', prefix: 'bgl_abcdefgh', name: 'ci', createdAt: 1, lastUsedAt: null, key: 'bgl_' + 'x'.repeat(43) });
    expect(created.key).toHaveLength(47);
    expect(CreateApiKeyRequestSchema.parse({ name: '  ci  ' })).toEqual({ name: 'ci' });
    expect(CreateApiKeyRequestSchema.parse({})).toEqual({ name: 'default' });
    expect(CreateApiKeyRequestSchema.safeParse({ name: 'x'.repeat(65) }).success).toBe(false);
  });

  it('ProviderKeyDto and PUT body (https only)', () => {
    expect(ProviderKeyDtoSchema.parse({ provider: 'openai', last4: 'abcd', baseUrl: null, createdAt: 1, lastError: null }).provider).toBe('openai');
    expect(ProviderKeyDtoSchema.safeParse({ provider: 'house', last4: 'abcd', baseUrl: null, createdAt: 1, lastError: null }).success).toBe(false);
    expect(PutProviderKeyRequestSchema.parse({ apiKey: '  sk-12345678  ', baseUrl: 'https://api.example.com/v1' })).toEqual({ apiKey: 'sk-12345678', baseUrl: 'https://api.example.com/v1' });
    expect(PutProviderKeyRequestSchema.safeParse({ apiKey: 'sk-12345678', baseUrl: 'http://api.example.com' }).success).toBe(false);
    expect(PutProviderKeyRequestSchema.safeParse({ apiKey: 'short' }).success).toBe(false);
  });
});

describe('usage, ledger and events', () => {
  const row: UsageRowDtoWire = {
    id: 'req_1',
    workspace: WS,
    apiKeyId: 'k1',
    endpoint: '/v1/chat/completions',
    requestedModel: 'beagle/auto',
    servedModel: 'house/gpt-oss-20b',
    provider: 'house',
    tier: 'house',
    paidBy: 'credit',
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    upstreamCostMicro: '5',
    chargedMicro: '6',
    status: 'ok',
    httpStatus: 200,
    errorCode: null,
    latencyMs: 123,
    routeReasons: ['resolve: alias beagle/auto → tier budget'],
    stream: false,
    difficulty: 0.25,
    drawId: null,
    createdAt: 1_760_000_000_000,
  };

  it('UsageRowDto / UsageListDto', () => {
    const parsed = UsageRowDtoSchema.parse(row);
    expect(parsed.chargedMicro).toBe(6n);
    expect(UsageListDtoSchema.parse({ rows: [row], nextBefore: null }).rows).toHaveLength(1);
    expect(UsageRowDtoSchema.safeParse({ ...row, status: 'maybe' }).success).toBe(false);
    expect(UsageRowDtoSchema.safeParse({ ...row, provider: 'azure' }).success).toBe(false);
  });

  it('UsageSummaryDto', () => {
    const summary: UsageSummaryDtoWire = {
      window: '7d',
      requests: 3,
      chargedMicro: '18',
      upstreamCostMicro: '15',
      inputTokens: 30,
      outputTokens: 60,
      byModel: [{ model: 'house/gpt-oss-20b', requests: 3, chargedMicro: '18' }],
      byDay: [{ day: '2026-10-11', requests: 3, chargedMicro: '18' }],
    };
    const parsed = UsageSummaryDtoSchema.parse(summary);
    expect(parsed.byDay[0]?.chargedMicro).toBe(18n);
    expect(UsageSummaryDtoSchema.safeParse({ ...summary, byDay: [{ day: '11/10/2026', requests: 1, chargedMicro: '1' }] }).success).toBe(false);
    expect(UsageSummaryDtoSchema.safeParse({ ...summary, window: '1h' }).success).toBe(false);
  });

  it('query schemas coerce and bound', () => {
    expect(UsageQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(UsageQuerySchema.parse({ limit: '10', before: '123', model: 'beagle/auto', status: 'error' })).toEqual({ limit: 10, before: 123, model: 'beagle/auto', status: 'error' });
    expect(UsageQuerySchema.safeParse({ limit: '500' }).success).toBe(false);
    expect(UsageQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(CursorQuerySchema.parse({ limit: '5' })).toEqual({ limit: 5 });
  });

  it('LedgerRowDto', () => {
    const parsed = LedgerRowDtoSchema.parse({ id: 1, workspace: WS, kind: 'debit', amountMicro: '-6', refType: 'usage', refId: 'req_1', memo: null, createdAt: 1 });
    expect(parsed.amountMicro).toBe(-6n);
    expect(LedgerRowDtoSchema.safeParse({ id: 1, workspace: WS, kind: 'refund', amountMicro: '1', refType: null, refId: null, memo: null, createdAt: 1 }).success).toBe(false);
  });

  it('CreditEventDto', () => {
    const event: CreditEventDtoWire = {
      txHash: HASH,
      logIndex: 0,
      kind: 'draw',
      receiptId: 3,
      workspace: WS,
      payer: null,
      tokenAmount: '1000000000000000000000',
      usdMicro: '2500000',
      priceE18: '2500000000000000',
      budgetId: 1,
      receiptHash: HASH,
      blockNumber: 42,
      blockHash: HASH,
      blockTime: 1_760_000_000,
      explorerTxUrl: null,
    };
    const parsed = CreditEventDtoSchema.parse(event);
    expect(parsed.tokenAmount).toBe(10n ** 21n);
    expect(parsed.usdMicro).toBe(2_500_000n);
    expect(CreditEventDtoSchema.safeParse({ ...event, txHash: '0x12' }).success).toBe(false);
  });
});

describe('receipts and draw batches', () => {
  const receipt: UsageReceiptWire = {
    v: 1,
    requestId: 'req_1',
    workspace: WS,
    createdAt: 1_760_000_000_000,
    endpoint: '/v1/chat/completions',
    requestedModel: 'beagle/auto',
    servedModel: 'house/gpt-oss-20b',
    provider: 'house',
    paidBy: 'credit',
    usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
    price: { inputPerM: 50_000, outputPerM: 200_000 },
    upstreamCostMicro: '5',
    markupBps: 1000,
    chargedMicro: '6',
    routeReasons: ['resolve: alias beagle/auto → tier budget'],
  };

  it('UsageReceipt parses and hashes identically in wire and parsed form', () => {
    const parsed = UsageReceiptSchema.parse(receipt);
    expect(parsed.chargedMicro).toBe(6n);
    expect(receiptHash(parsed)).toBe(receiptHash(receipt));
    const dto = ReceiptDtoSchema.parse({ ...receipt, hash: receiptHash(receipt) });
    expect(dto.hash).toBe(receiptHash(receipt));
    expect(UsageReceiptSchema.safeParse({ ...receipt, v: 2 }).success).toBe(false);
  });

  it('DrawBatch', () => {
    const batch = { v: 1, chainId: 31337, desk: WS, budgetId: 1, workspace: WS, usageIds: ['req_1', 'req_2'], amountMicro: '12', priceE18: '2500000000000000' };
    const parsed = DrawBatchSchema.parse(batch);
    expect(parsed.amountMicro).toBe(12n);
    expect(parsed.priceE18).toBe(2_500_000_000_000_000n);
    expect(receiptHash(parsed)).toBe(receiptHash(batch));
    expect(DrawBatchSchema.safeParse({ ...batch, usageIds: 'req_1' }).success).toBe(false);
  });
});

describe('budgets and upgrades', () => {
  it('BudgetDto with draws', () => {
    const budget: BudgetDtoWire = {
      budgetId: 1,
      owner: WS,
      workspace: WS,
      cap: '500000000000000000000',
      drawn: '1000000000000000000',
      remainingCap: '499000000000000000000',
      headroomTokens: '499000000000000000000',
      headroomMicro: '1247500',
      deadline: 1_760_003_600,
      closed: false,
      stalledReason: null,
      draws: [
        {
          id: 1,
          budgetId: 1,
          workspace: WS,
          tokenAmount: '1000000000000000000',
          usdMicro: '2500',
          receiptHash: HASH,
          usageIds: ['req_1'],
          txHash: HASH,
          status: 'confirmed',
          error: null,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };
    const parsed = BudgetDtoSchema.parse(budget);
    expect(parsed.cap).toBe(500n * 10n ** 18n);
    expect(parsed.draws[0]?.usdMicro).toBe(2500n);
    expect(BudgetDtoSchema.safeParse({ ...budget, stalledReason: 'other' }).success).toBe(false);
    expect(BudgetDtoSchema.parse({ ...budget, stalledReason: 'allowance' }).stalledReason).toBe('allowance');
  });

  it('UpgradeDto, prices and request', () => {
    const parsed = UpgradeDtoSchema.parse({ id: 'u1', workspace: WS, kind: 'warm', quantity: 3, amountMicro: '6000000', startsAt: 1, endsAt: 2, createdAt: 1 });
    expect(parsed.amountMicro).toBe(6_000_000n);
    expect(UpgradePricesDtoSchema.parse({ pro: { priceMicro: '20000000', days: 30 }, warmHourPriceMicro: '2000000' }).pro.priceMicro).toBe(20_000_000n);
    expect(UpgradeRequestSchema.parse({ kind: 'pro' })).toEqual({ kind: 'pro', quantity: 1 });
    expect(UpgradeRequestSchema.parse({ kind: 'warm', quantity: 168 }).quantity).toBe(168);
    expect(UpgradeRequestSchema.safeParse({ kind: 'warm', quantity: 169 }).success).toBe(false);
    expect(UpgradeRequestSchema.safeParse({ kind: 'gold' }).success).toBe(false);
  });

  it('admin requests', () => {
    expect(AdminCreditRequestSchema.parse({ workspace: WS, amountMicro: '-100', memo: 'refund' }).amountMicro).toBe(-100n);
    expect(AdminCreditRequestSchema.safeParse({ workspace: 'x', amountMicro: '1' }).success).toBe(false);
  });
});

describe('wire round trip', () => {
  it('parse → serialize gives back the wire object', () => {
    const wire: BalanceDtoWire = { balanceMicro: '123', reservedMicro: '4', budgetHeadroomMicro: '5', availableMicro: '124', plan: 'free', planUntil: null, price };
    const parsed = BalanceDtoSchema.parse(wire);
    const back: BalanceDtoWire = {
      ...parsed,
      balanceMicro: serializeMicro(parsed.balanceMicro),
      reservedMicro: serializeMicro(parsed.reservedMicro),
      budgetHeadroomMicro: serializeMicro(parsed.budgetHeadroomMicro),
      availableMicro: serializeMicro(parsed.availableMicro),
      price: { ...parsed.price, priceE18: serializeMicro(parsed.price.priceE18) },
    };
    expect(back).toEqual(wire);
  });
});
