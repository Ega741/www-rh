import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { MEMO_PROGRAM_ID, TOKEN_PROGRAM_ID } from '../src/addresses.js';
import { receiptHash } from '../src/canonical.js';
import {
  AddressSchema,
  AdminCreditRequestSchema,
  AdminPriceRequestSchema,
  AdminWorkspaceDtoSchema,
  ApiKeyDtoSchema,
  ApiKeyListDtoSchema,
  BalanceDtoSchema,
  BudgetDrawListDtoSchema,
  BudgetDtoSchema,
  BudgetListDtoSchema,
  Bytes32Schema,
  ConfigDtoSchema,
  CreateApiKeyRequestSchema,
  CreditEventDtoSchema,
  CreditEventListDtoSchema,
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
  PriceHistoryDtoSchema,
  PriceHistoryQuerySchema,
  ProviderKeyDtoSchema,
  ProviderKeyListDtoSchema,
  PutProviderKeyRequestSchema,
  QuoteDtoSchema,
  QuoteQuerySchema,
  ReceiptDtoSchema,
  RegisterBudgetRequestSchema,
  SignatureInputSchema,
  SignatureSchema,
  StatusDtoSchema,
  UintStringSchema,
  UpgradeDtoSchema,
  UpgradeListDtoSchema,
  UpgradePricesDtoSchema,
  UpgradeRequestSchema,
  UsageListDtoSchema,
  UsageQuerySchema,
  UsageReceiptSchema,
  UsageRowDtoSchema,
  UsageSummaryDtoSchema,
  VerifyDtoSchema,
  VerifyRequestSchema,
  isSignatureInput,
  serializeMicro,
  type BalanceDtoWire,
  type BudgetDtoWire,
  type ConfigDtoWire,
  type CreditEventDtoWire,
  type DrawBatchWire,
  type MeDtoWire,
  type PriceDtoWire,
  type QuoteDtoWire,
  type ReceiptDtoWire,
  type StatusDtoWire,
  type UsageReceiptWire,
  type UsageRowDtoWire,
  type UsageSummaryDtoWire,
} from '../src/api.js';
import { DEFAULT_CATALOG } from '../src/models.js';
import { Base58PubkeySchema } from '../src/solana.js';

const WS = bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1)); // 4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw
const OWNER = bs58.encode(new Uint8Array(32).fill(1));
const MINT = bs58.encode(new Uint8Array(32).fill(2));
const ATA = bs58.encode(new Uint8Array(32).fill(3));
const OPERATOR = bs58.encode(new Uint8Array(32).fill(4));
const SIG = bs58.encode(new Uint8Array(64).fill(7)); // 87 chars
const SIG_B64 = Buffer.from(new Uint8Array(64).fill(7)).toString('base64'); // 88 chars, "=="
const HASH = `0x${'ab'.repeat(32)}`;

const price: PriceDtoWire = {
  pricePointId: 7,
  priceE18: '2500000000000000',
  observedAt: 1_760_000_000,
  stale: false,
  source: 'manual',
  maxAgeS: 3600,
  usdPerToken: '0.0025',
  tokensPerUsd: '400',
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
  it('AddressSchema is the base58 public key schema', () => {
    expect(AddressSchema).toBe(Base58PubkeySchema);
    expect(AddressSchema.parse(WS)).toBe(WS);
    expect(AddressSchema.safeParse('0x0bd7d308f8e1639fab988df18a8011f41eacad73').success).toBe(false);
    expect(AddressSchema.safeParse(`1${bs58.encode(new Uint8Array(32).fill(255))}`).success).toBe(false); // 33 bytes
    expect(SignatureSchema.parse(SIG)).toBe(SIG);
    expect(SignatureSchema.safeParse(SIG_B64).success).toBe(false);
    expect(Bytes32Schema.parse(HASH)).toBe(HASH);
    expect(Bytes32Schema.safeParse(HASH.slice(2)).success).toBe(false);
  });
  it('SignatureInputSchema accepts base58 and base64 64-byte signatures', () => {
    expect(isSignatureInput(SIG)).toBe(true);
    expect(isSignatureInput(SIG_B64)).toBe(true);
    expect(isSignatureInput(bs58.encode(new Uint8Array(64).fill(255)))).toBe(true);
    expect(isSignatureInput(`0x${'00'.repeat(64)}`)).toBe(false);
    expect(isSignatureInput(Buffer.from(new Uint8Array(63).fill(7)).toString('base64'))).toBe(false);
    expect(isSignatureInput(Buffer.from(new Uint8Array(65).fill(7)).toString('base64'))).toBe(false);
    expect(isSignatureInput(SIG_B64.replace('==', 'AA'))).toBe(false);
    expect(isSignatureInput(WS)).toBe(false);
    expect(isSignatureInput(7)).toBe(false);
    expect(SignatureInputSchema.parse(SIG_B64)).toBe(SIG_B64);
    expect(SignatureInputSchema.safeParse('').success).toBe(false);
  });
});

describe('public DTOs', () => {
  it('PriceDto / PriceHistoryDto / QuoteDto', () => {
    const p = PriceDtoSchema.parse(price);
    expect(p.priceE18).toBe(2_500_000_000_000_000n);
    expect(p.pricePointId).toBe(7);
    expect(p.source).toBe('manual');
    expect(PriceDtoSchema.parse({ ...price, source: 'jupiter' }).source).toBe('jupiter');
    expect(PriceDtoSchema.safeParse({ ...price, source: 'chainlink' }).success).toBe(false);
    expect(PriceDtoSchema.safeParse({ ...price, pricePointId: '7' }).success).toBe(false);
    expect(PriceHistoryDtoSchema.parse([price, { ...price, pricePointId: 6, stale: true }])).toHaveLength(2);
    expect(PriceHistoryDtoSchema.safeParse({ rows: [price] }).success).toBe(false);
    expect(PriceHistoryQuerySchema.parse({})).toEqual({ limit: 100 });
    expect(PriceHistoryQuerySchema.parse({ limit: '5' })).toEqual({ limit: 5 });
    expect(PriceHistoryQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    const quote: QuoteDtoWire = { tokens: '1000000000', usdMicro: '2500000', priceE18: price.priceE18, pricePointId: 7, stale: false };
    expect(QuoteDtoSchema.parse(quote)).toEqual({ tokens: 1_000_000_000n, usdMicro: 2_500_000n, priceE18: 2_500_000_000_000_000n, pricePointId: 7, stale: false });
    expect(QuoteDtoSchema.safeParse({ ...quote, stale: 'no' }).success).toBe(false);
  });

  it('QuoteQuerySchema requires exactly one of tokens / usdMicro', () => {
    expect(QuoteQuerySchema.parse({ tokens: '5' })).toEqual({ tokens: 5n });
    expect(QuoteQuerySchema.parse({ usdMicro: '5' })).toEqual({ usdMicro: 5n });
    expect(QuoteQuerySchema.safeParse({}).success).toBe(false);
    expect(QuoteQuerySchema.safeParse({ tokens: '1', usdMicro: '1' }).success).toBe(false);
  });

  it('StatusDto requires every provider', () => {
    const status: StatusDtoWire = {
      cluster: 'localnet',
      mint: MINT,
      token: { mint: MINT, symbol: 'BEAGLE', decimals: 6, tokenProgram: TOKEN_PROGRAM_ID },
      indexer: { lastSignature: SIG, lastSlot: 10, headSlot: 12, lagSlots: 2, lastEventAt: null },
      price,
      providers: {
        anthropic: { state: 'ok', configured: true },
        openai: { state: 'down', configured: false },
        google: { state: 'degraded', configured: true },
        house: { state: 'ok', configured: true },
      },
      house: { enabled: true, warmUntil: null, largeModel: 'openai/gpt-oss-120b' },
      operator: { address: OPERATOR, enabled: false, dryRun: true, solBalance: '1500000000' },
      version: '0.1.0',
    };
    const parsed = StatusDtoSchema.parse(status);
    expect(parsed.operator.solBalance).toBe(1_500_000_000n);
    expect(parsed.price.priceE18).toBe(2_500_000_000_000_000n);
    const { house: _h, ...missing } = status.providers;
    expect(StatusDtoSchema.safeParse({ ...status, providers: missing }).success).toBe(false);
    expect(StatusDtoSchema.safeParse({ ...status, mint: 'abc' }).success).toBe(false);
    expect(StatusDtoSchema.safeParse({ ...status, cluster: 'testnet' }).success).toBe(false);
    const fresh = StatusDtoSchema.parse({
      ...status,
      indexer: { lastSignature: null, lastSlot: null, headSlot: 0, lagSlots: 0, lastEventAt: null },
      operator: { address: null, enabled: false, dryRun: true },
    });
    expect(fresh.indexer.lastSignature).toBeNull();
    expect(fresh.operator.address).toBeNull();
    expect(fresh.operator.solBalance).toBeUndefined();
    expect(StatusDtoSchema.safeParse({ ...status, indexer: { ...status.indexer, lastSignature: 'short' } }).success).toBe(false);
  });

  it('ConfigDto', () => {
    const config: ConfigDtoWire = {
      cluster: 'devnet',
      rpcUrl: 'https://api.devnet.solana.com',
      mint: MINT,
      decimals: 6,
      symbol: 'BEAGLE',
      tokenProgram: TOKEN_PROGRAM_ID,
      memoProgram: MEMO_PROGRAM_ID,
      operator: OPERATOR,
      explorer: 'https://explorer.solana.com',
      aliases: ['beagle/auto', 'beagle/best', 'beagle/cheap', 'beagle/house'],
      markupBps: 1000,
      byokFeeBps: 0,
      minCreditMicro: '1000',
      pro: { priceMicro: '20000000', days: 30 },
      warmHourPriceMicro: '2000000',
    };
    const parsed = ConfigDtoSchema.parse(config);
    expect(parsed.pro.priceMicro).toBe(20_000_000n);
    expect(parsed.warmHourPriceMicro).toBe(2_000_000n);
    expect(parsed.minCreditMicro).toBe(1000n);
    expect(ConfigDtoSchema.parse({ ...config, operator: null }).operator).toBeNull();
    expect(ConfigDtoSchema.safeParse({ ...config, memoProgram: '0xabc' }).success).toBe(false);
    expect(ConfigDtoSchema.safeParse({ ...config, decimals: -1 }).success).toBe(false);
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
    expect(VerifyDtoSchema.safeParse({ token: 't', workspace: '0x12' }).success).toBe(false);
  });

  it('VerifyRequest carries the signed text, a base58 or base64 signature and the signer', () => {
    const body = { message: `localhost wants you to sign in with your Solana account:\n${WS}`, signature: SIG, publicKey: WS };
    expect(VerifyRequestSchema.parse(body)).toEqual(body);
    expect(VerifyRequestSchema.parse({ ...body, signature: SIG_B64 }).signature).toBe(SIG_B64);
    expect(VerifyRequestSchema.safeParse({ ...body, signature: `0x${'00'.repeat(64)}` }).success).toBe(false);
    expect(VerifyRequestSchema.safeParse({ ...body, publicKey: 'me' }).success).toBe(false);
    expect(VerifyRequestSchema.safeParse({ ...body, message: '' }).success).toBe(false);
    expect(VerifyRequestSchema.safeParse({ ...body, message: 'x'.repeat(4097) }).success).toBe(false);
    expect(VerifyRequestSchema.safeParse({ message: body.message, signature: SIG }).success).toBe(false);
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
    expect(MeDtoSchema.safeParse({ ...me, workspace: '0x0bd7d308f8e1639fab988df18a8011f41eacad73' }).success).toBe(false);
    const balance: BalanceDtoWire = { balanceMicro: '-5', reservedMicro: '0', budgetHeadroomMicro: '100', availableMicro: '95', plan: 'pro', planUntil: 1, price };
    const parsedBalance = BalanceDtoSchema.parse(balance);
    expect(parsedBalance.balanceMicro).toBe(-5n);
    expect(parsedBalance.price.pricePointId).toBe(7);
    expect(BalanceDtoSchema.safeParse({ ...balance, plan: 'gold' }).success).toBe(false);
  });

  it('ApiKeyDto with and without the key', () => {
    const row = ApiKeyDtoSchema.parse({ id: 'k1', prefix: 'bgl_abcdefgh', name: 'ci', createdAt: 1, lastUsedAt: null });
    expect(row.key).toBeUndefined();
    const created = ApiKeyDtoSchema.parse({ id: 'k1', prefix: 'bgl_abcdefgh', name: 'ci', createdAt: 1, lastUsedAt: null, key: 'bgl_' + 'x'.repeat(43) });
    expect(created.key).toHaveLength(47);
    expect(ApiKeyListDtoSchema.parse([])).toEqual([]);
    expect(ApiKeyListDtoSchema.parse([row, created])).toHaveLength(2);
    expect(ApiKeyListDtoSchema.safeParse({ keys: [row] }).success).toBe(false);
    expect(CreateApiKeyRequestSchema.parse({ name: '  ci  ' })).toEqual({ name: 'ci' });
    expect(CreateApiKeyRequestSchema.parse({})).toEqual({ name: 'default' });
    expect(CreateApiKeyRequestSchema.safeParse({ name: 'x'.repeat(65) }).success).toBe(false);
  });

  it('ProviderKeyDto and PUT body (https only)', () => {
    const key = { provider: 'openai', last4: 'abcd', baseUrl: null, createdAt: 1, lastError: null };
    expect(ProviderKeyDtoSchema.parse(key).provider).toBe('openai');
    expect(ProviderKeyDtoSchema.safeParse({ ...key, provider: 'house' }).success).toBe(false);
    expect(ProviderKeyListDtoSchema.parse([key, { ...key, provider: 'google', lastError: 'invalid key' }])).toHaveLength(2);
    expect(ProviderKeyListDtoSchema.safeParse([{ ...key, provider: 'house' }]).success).toBe(false);
    expect(ProviderKeyListDtoSchema.safeParse({ providers: [] }).success).toBe(false);
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

  it('CreditEventDto (purchase and draw rows of credit_events)', () => {
    const purchase: CreditEventDtoWire = {
      signature: SIG,
      ixIndex: 0,
      slot: 4242,
      blockTime: 1_760_000_000,
      kind: 'purchase',
      workspace: WS,
      payer: OWNER,
      tokenAccount: ATA,
      tokenAmount: '1000000000',
      usdMicro: '2500000',
      priceE18: '2500000000000000',
      pricePointId: 7,
      priceStale: false,
      memo: `beagle:v1 ws=${WS}`,
      receiptHash: null,
      explorerUrl: `https://explorer.solana.com/tx/${SIG}?cluster=devnet`,
    };
    const parsed = CreditEventDtoSchema.parse(purchase);
    expect(parsed.tokenAmount).toBe(1_000_000_000n);
    expect(parsed.usdMicro).toBe(2_500_000n);
    expect(parsed.priceE18).toBe(2_500_000_000_000_000n);
    const draw = CreditEventDtoSchema.parse({ ...purchase, ixIndex: 1, kind: 'draw', receiptHash: HASH, memo: `beagle:draw v1 ws=${WS} h=${HASH}`, priceStale: true, blockTime: null, pricePointId: null, payer: null, explorerUrl: null });
    expect(draw.receiptHash).toBe(HASH);
    expect(draw.blockTime).toBeNull();
    expect(CreditEventDtoSchema.safeParse({ ...purchase, signature: '0x12' }).success).toBe(false);
    expect(CreditEventDtoSchema.safeParse({ ...purchase, kind: 'refund' }).success).toBe(false);
    expect(CreditEventDtoSchema.safeParse({ ...purchase, tokenAccount: '0xabc' }).success).toBe(false);
    expect(CreditEventDtoSchema.safeParse({ ...purchase, ixIndex: -1 }).success).toBe(false);
    const list = CreditEventListDtoSchema.parse({ rows: [purchase], nextBefore: 1_759_999_999_000 });
    expect(list.rows[0]?.usdMicro).toBe(2_500_000n);
    expect(list.nextBefore).toBe(1_759_999_999_000);
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
    expect(UsageReceiptSchema.safeParse({ ...receipt, v: 2 }).success).toBe(false);
    expect(UsageReceiptSchema.safeParse({ ...receipt, workspace: '0x0bd7d308f8e1639fab988df18a8011f41eacad73' }).success).toBe(false);
  });

  it('ReceiptDto is the nested { receipt, hash } envelope of SPEC §5.7 / §5.9', () => {
    const hash = receiptHash(receipt);
    const wire: ReceiptDtoWire = { receipt, hash };
    const dto = ReceiptDtoSchema.parse(wire);
    expect(Object.keys(dto).sort()).toEqual(['hash', 'receipt']);
    expect(dto.hash).toBe(hash);
    expect(dto.receipt.chargedMicro).toBe(6n);
    expect(receiptHash(dto.receipt)).toBe(hash);
    expect(receiptHash(wire.receipt)).toBe(hash);
    expect(ReceiptDtoSchema.safeParse({ ...receipt, hash }).success).toBe(false);
    expect(ReceiptDtoSchema.parse({ receipt, hash, ...receipt })).toEqual(dto);
    expect(ReceiptDtoSchema.safeParse({ receipt, hash: '0x12' }).success).toBe(false);
    expect(ReceiptDtoSchema.safeParse({ receipt: { ...receipt, v: 2 }, hash }).success).toBe(false);
  });

  it('DrawBatch (SPEC §5.4) hashes into the draw memo', () => {
    const batch: DrawBatchWire = {
      v: 1,
      cluster: 'localnet',
      mint: MINT,
      tokenAccount: ATA,
      workspace: WS,
      usageIds: ['req_1', 'req_2'],
      amountMicro: '12',
      priceE18: '2500000000000000',
      pricePointId: 7,
    };
    const parsed = DrawBatchSchema.parse(batch);
    expect(parsed.amountMicro).toBe(12n);
    expect(parsed.priceE18).toBe(2_500_000_000_000_000n);
    expect(receiptHash(parsed)).toBe(receiptHash(batch));
    expect(receiptHash(parsed)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(DrawBatchSchema.safeParse({ ...batch, usageIds: 'req_1' }).success).toBe(false);
    expect(DrawBatchSchema.safeParse({ ...batch, cluster: 'anvil' }).success).toBe(false);
    expect(DrawBatchSchema.safeParse({ ...batch, mint: '0xabc' }).success).toBe(false);
    const { pricePointId: _p, ...noPoint } = batch;
    expect(DrawBatchSchema.safeParse(noPoint).success).toBe(false);
  });
});

describe('budgets and upgrades', () => {
  it('BudgetDto with draws (SPL delegation)', () => {
    const budget: BudgetDtoWire = {
      tokenAccount: ATA,
      owner: OWNER,
      workspace: WS,
      delegate: OPERATOR,
      cap: '500000000',
      balance: '750000000',
      headroomTokens: '500000000',
      headroomMicro: '1250000',
      closed: false,
      stalledReason: null,
      registeredAt: 1_760_000_000_000,
      lastSeenSlot: 4242,
      draws: [
        {
          id: 1,
          tokenAccount: ATA,
          workspace: WS,
          tokenAmount: '1000000',
          usdMicro: '2500',
          receiptHash: HASH,
          usageIds: ['req_1'],
          signature: SIG,
          status: 'confirmed',
          error: null,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    };
    const parsed = BudgetDtoSchema.parse(budget);
    expect(parsed.cap).toBe(500_000_000n);
    expect(parsed.balance).toBe(750_000_000n);
    expect(parsed.headroomMicro).toBe(1_250_000n);
    expect(parsed.draws[0]?.usdMicro).toBe(2500n);
    expect(parsed.draws[0]?.signature).toBe(SIG);
    expect(BudgetDtoSchema.safeParse({ ...budget, stalledReason: 'allowance' }).success).toBe(false);
    for (const reason of ['price', 'revoked', 'exhausted', 'draw_failed'] as const) {
      expect(BudgetDtoSchema.parse({ ...budget, stalledReason: reason }).stalledReason).toBe(reason);
    }
    const revoked = BudgetDtoSchema.parse({ ...budget, delegate: null, closed: true, stalledReason: 'revoked', registeredAt: null, lastSeenSlot: null, draws: [] });
    expect(revoked.delegate).toBeNull();
    expect(BudgetDtoSchema.safeParse({ ...budget, tokenAccount: '0xabc' }).success).toBe(false);
    expect(BudgetDtoSchema.safeParse({ ...budget, cap: '-1' }).success).toBe(false);
    const budgets = BudgetListDtoSchema.parse([budget, { ...budget, tokenAccount: OWNER, draws: [] }]);
    expect(budgets.map((b) => b.tokenAccount)).toEqual([ATA, OWNER]);
    expect(BudgetListDtoSchema.safeParse({ budgets: [budget] }).success).toBe(false);
    const draws = BudgetDrawListDtoSchema.parse(budget.draws);
    expect(draws).toHaveLength(1);
    expect(BudgetDrawListDtoSchema.parse([{ ...budget.draws[0], signature: null, status: 'pending' }])[0]?.signature).toBeNull();
    expect(BudgetDrawListDtoSchema.safeParse([{ ...budget.draws[0], status: 'lost' }]).success).toBe(false);
    expect(BudgetDrawListDtoSchema.safeParse([{ ...budget.draws[0], signature: HASH }]).success).toBe(false);
  });

  it('RegisterBudgetRequest', () => {
    expect(RegisterBudgetRequestSchema.parse({ tokenAccount: ATA })).toEqual({ tokenAccount: ATA });
    expect(RegisterBudgetRequestSchema.parse({ tokenAccount: ATA, workspace: WS })).toEqual({ tokenAccount: ATA, workspace: WS });
    expect(RegisterBudgetRequestSchema.safeParse({ tokenAccount: 'ata' }).success).toBe(false);
    expect(RegisterBudgetRequestSchema.safeParse({ tokenAccount: ATA, workspace: '' }).success).toBe(false);
    expect(RegisterBudgetRequestSchema.safeParse({}).success).toBe(false);
  });

  it('UpgradeDto, prices and request', () => {
    const upgrade = { id: 'u1', workspace: WS, kind: 'warm', quantity: 3, amountMicro: '6000000', startsAt: 1, endsAt: 2, createdAt: 1 };
    const parsed = UpgradeDtoSchema.parse(upgrade);
    expect(parsed.amountMicro).toBe(6_000_000n);
    const list = UpgradeListDtoSchema.parse([upgrade, { ...upgrade, id: 'u2', kind: 'pro', quantity: 1, amountMicro: '20000000' }]);
    expect(list.map((u) => u.amountMicro)).toEqual([6_000_000n, 20_000_000n]);
    expect(UpgradeListDtoSchema.safeParse({ rows: [upgrade] }).success).toBe(false);
    expect(UpgradeListDtoSchema.safeParse([{ ...upgrade, kind: 'gold' }]).success).toBe(false);
    expect(UpgradePricesDtoSchema.parse({ pro: { priceMicro: '20000000', days: 30 }, warmHourPriceMicro: '2000000' }).pro.priceMicro).toBe(20_000_000n);
    expect(UpgradeRequestSchema.parse({ kind: 'pro' })).toEqual({ kind: 'pro', quantity: 1 });
    expect(UpgradeRequestSchema.parse({ kind: 'warm', quantity: 168 }).quantity).toBe(168);
    expect(UpgradeRequestSchema.safeParse({ kind: 'warm', quantity: 169 }).success).toBe(false);
    expect(UpgradeRequestSchema.safeParse({ kind: 'gold' }).success).toBe(false);
  });

  it('admin requests and rows', () => {
    expect(AdminCreditRequestSchema.parse({ workspace: WS, amountMicro: '-100', memo: 'refund' }).amountMicro).toBe(-100n);
    expect(AdminCreditRequestSchema.safeParse({ workspace: 'x', amountMicro: '1' }).success).toBe(false);
    expect(AdminPriceRequestSchema.parse({ priceE18: '10000000000000000' }).priceE18).toBe(10n ** 16n);
    expect(AdminPriceRequestSchema.safeParse({ priceE18: '-1' }).success).toBe(false);
    expect(AdminWorkspaceDtoSchema.parse({ workspace: WS, plan: 'free', planUntil: null, balanceMicro: '5', createdAt: 1, keys: 2 }).balanceMicro).toBe(5n);
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
