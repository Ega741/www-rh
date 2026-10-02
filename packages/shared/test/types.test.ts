import { describe, expect, it } from 'vitest';
import { MODEL_IDS } from '../src/models.js';
import {
  addressSchema,
  bigintStringSchema,
  computeResponseSchema,
  curvePhaseName,
  curvePhaseValue,
  drawReceiptSchema,
  fromBigintString,
  healthResponseSchema,
  memoryBatchSchema,
  memoryBatchUri,
  memorySchema,
  metadataUri,
  mindDetailSchema,
  mindMetadataSchema,
  mindStatusName,
  mindStatusValue,
  mindSummarySchema,
  mindsQuerySchema,
  modelIdSchema,
  redactActionInput,
  roundUsd,
  thoughtSchema,
  toBigintString,
  tradeSchema,
  utf8ByteLength,
  wsClientMessageSchema,
  wsServerMessageSchema,
  type MindSummary,
} from '../src/types.js';

const token = '0x' + 'ab'.repeat(20);
const hash = '0x' + 'cd'.repeat(32);
const at = '2026-10-02T10:00:00.000Z';

const summary: MindSummary = {
  token,
  name: 'Mind',
  symbol: 'MIND',
  creator: token,
  metadataURI: 'runner://metadata/abc',
  image: null,
  modelId: hash,
  model: 'claude-opus-5-5',
  status: 'alive',
  phase: 'bonding',
  priceWei: '1272134203168685',
  marketCapWei: '1272134203168685000000000',
  progressBps: 1234,
  realEthReserveWei: '0',
  tokensSold: '0',
  mindBalanceWei: '0',
  lastTickAt: null,
  currentUrl: null,
  createdAt: at,
  trades24h: 0,
  volume24hWei: '0',
  cooling: false,
};

describe('API DTO schemas (R11)', () => {
  it('address must be lowercase hex', () => {
    expect(addressSchema.safeParse(token).success).toBe(true);
    expect(addressSchema.safeParse(token.toUpperCase().replace('0X', '0x')).success).toBe(false);
    expect(addressSchema.safeParse('0x123').success).toBe(false);
  });

  it('bigint strings round-trip', () => {
    expect(toBigintString(123n)).toBe('123');
    expect(fromBigintString('123')).toBe(123n);
    expect(bigintStringSchema.safeParse('0').success).toBe(true);
    expect(bigintStringSchema.safeParse('007').success).toBe(false);
    expect(bigintStringSchema.safeParse('-1').success).toBe(false);
    expect(() => toBigintString(-1n)).toThrow(RangeError);
  });

  it('MindSummary / MindDetail validate, nulls instead of omitted fields', () => {
    expect(mindSummarySchema.parse(summary)).toEqual(summary);
    const detail = mindDetailSchema.parse({
      ...summary,
      personaHash: hash,
      personaVerified: true,
      pool: token,
      positionId: '7',
      graduator: null,
      description: null,
      persona: 'curious',
      links: null,
      lastFrameAt: null,
      metadataStatus: 'ok',
    });
    expect(detail.pool).toBe(token);
    expect(mindSummarySchema.safeParse({ ...summary, status: 'retired' }).success).toBe(false);
    expect(mindSummarySchema.safeParse({ ...summary, status: 'paused' }).success).toBe(true);
    expect(mindSummarySchema.safeParse({ ...summary, progressBps: 10001 }).success).toBe(false);
    expect(mindSummarySchema.safeParse({ ...summary, model: null }).success).toBe(true);
    const { image: _image, ...withoutImage } = summary;
    expect(mindSummarySchema.safeParse(withoutImage).success).toBe(false);
  });

  it('every wei field ends in Wei', () => {
    for (const schema of [mindSummarySchema, tradeSchema, computeResponseSchema]) {
      for (const key of Object.keys(schema.shape)) {
        if (/eth|fee|balance|volume|price|reserve|amount|cap/i.test(key) && !/Usd|tokenAmount|ethUsd/.test(key)) {
          expect(key.endsWith('Wei'), key).toBe(true);
        }
      }
    }
  });

  it('enum name/value helpers (MindStatus { Alive, Dormant, Paused })', () => {
    expect(mindStatusName(0)).toBe('alive');
    expect(mindStatusName(1)).toBe('dormant');
    expect(mindStatusName(2)).toBe('paused');
    expect(() => mindStatusName(3)).toThrow(RangeError);
    expect(curvePhaseName(2)).toBe('graduated');
    expect(mindStatusValue('paused')).toBe(2);
    expect(curvePhaseValue('complete')).toBe(1);
  });

  it('modelIdSchema stays in sync with the catalog', () => {
    expect(modelIdSchema.options).toEqual([...MODEL_IDS]);
  });

  it('minds query applies defaults and coerces', () => {
    expect(mindsQuerySchema.parse({})).toEqual({ sort: 'created', limit: 50 });
    expect(mindsQuerySchema.parse({ sort: 'mcap', limit: '10', cursor: 'x' })).toEqual({ sort: 'mcap', limit: 10, cursor: 'x' });
    expect(mindsQuerySchema.safeParse({ sort: 'nope' }).success).toBe(false);
  });

  it('compute response with receipts', () => {
    const receipt = {
      token,
      fromTickId: 1,
      toTickId: 2,
      ticks: [{ tickId: 1, model: 'claude-opus-5-5', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdMicro: 140 }],
      ethUsdPriceMicro: 3_000_000_000,
      amountWei: '46666666666',
    };
    expect(drawReceiptSchema.parse(receipt)).toEqual(receipt);
    const r = computeResponseSchema.parse({
      balanceWei: '1',
      balanceUsd: 0.003,
      unsettledUsd: 0,
      availableUsd: 0.003,
      ethUsd: 3000,
      burnUsdPerHour: 0,
      runwayHours: null,
      dailyBudgetUsd: 0.5,
      tickIntervalMs: 20000,
      ledger: [],
      receipts: [{ receiptHash: hash, receipt, status: 'dry_run', txHash: null, createdAt: at, error: null }],
      draws: [],
    });
    expect(r.runwayHours).toBeNull();
    expect(r.receipts[0]?.receipt.ticks[0]?.costUsdMicro).toBe(140);
  });

  it('memories, thoughts and batches (R2, R7)', () => {
    expect(memorySchema.safeParse({ seq: 1, kind: 'thought', content: 'x', url: null, createdAt: at, contentHash: hash, anchorTx: null, anchorUri: null }).success).toBe(false);
    expect(memorySchema.parse({ seq: 1, kind: 'finding', content: 'x', url: null, createdAt: at, contentHash: hash, anchorTx: null, anchorUri: null }).kind).toBe('finding');
    expect(thoughtSchema.safeParse({ id: 1, tickId: 1, kind: 'aloud', text: 'hi', createdAt: at }).success).toBe(true);
    expect(thoughtSchema.safeParse({ id: 1, tickId: 1, kind: 'thought', text: 'hi', createdAt: at }).success).toBe(false);
    expect(memoryBatchSchema.parse({ token, fromSeq: 1, toSeq: 1, memories: [{ seq: 1, kind: 'note', content: 'a', url: null, createdAt: at }] }).toSeq).toBe(1);
    expect(memoryBatchUri(token.toUpperCase().replace('0X', '0x'), 1, 5)).toBe(`runner://memories/${token}/1-5`);
    expect(metadataUri(hash.toUpperCase().replace('0X', '0x'))).toBe(`runner://metadata/${hash}`);
  });

  it('health allows null launchpad and head', () => {
    expect(
      healthResponseSchema.parse({
        ok: true,
        chainId: 46630,
        launchpad: null,
        lastIndexedBlock: null,
        headBlock: null,
        activeMinds: 0,
        dryRun: true,
        indexer: { status: 'error', lastError: 'connect ECONNREFUSED' },
        anthropic: false,
        operator: null,
        version: '0.1.0',
      }).ok,
    ).toBe(true);
  });

  it('metadata JSON (R1): strict, byte-bounded name/symbol, catalog model', () => {
    const meta = mindMetadataSchema.parse({ name: 'Mind', symbol: 'MIND', persona: 'curious', model: 'claude-opus-5-5' });
    expect(meta).toEqual({ name: 'Mind', symbol: 'MIND', persona: 'curious', model: 'claude-opus-5-5' });
    expect(mindMetadataSchema.safeParse({ name: '', symbol: 'MIND', persona: 'x', model: 'claude-opus-5-5' }).success).toBe(false);
    expect(mindMetadataSchema.safeParse({ name: 'M', symbol: 'MIND', persona: 'x', model: 'gpt-5' }).success).toBe(false);
    expect(mindMetadataSchema.safeParse({ name: 'M', symbol: 'MIND', persona: 'x', model: 'claude-opus-5-5', extra: 1 }).success).toBe(false);
    expect(mindMetadataSchema.safeParse({ name: 'M', symbol: 'MIND', persona: 'x', model: 'claude-opus-5-5', links: { x: 'https://x.com/a' } }).success).toBe(true);
    expect(mindMetadataSchema.safeParse({ name: 'M', symbol: 'MIND', persona: 'x', model: 'claude-opus-5-5', links: { discord: 'x' } }).success).toBe(false);
    // 16 bytes max: 5 three-byte characters = 15 bytes ok, 6 = 18 bytes rejected
    expect(utf8ByteLength('€€€€€')).toBe(15);
    expect(mindMetadataSchema.safeParse({ name: 'M', symbol: '€€€€€', persona: 'x', model: 'claude-opus-5-5' }).success).toBe(true);
    expect(mindMetadataSchema.safeParse({ name: 'M', symbol: '€€€€€€', persona: 'x', model: 'claude-opus-5-5' }).success).toBe(false);
  });

  it('roundUsd keeps 6 decimals', () => {
    expect(roundUsd(0.1234564)).toBe(0.123456);
    expect(roundUsd(0.1234565)).toBe(0.123457);
  });
});

describe('WebSocket schemas (R7, R10)', () => {
  it('server messages are discriminated by type', () => {
    expect(wsServerMessageSchema.parse({ type: 'hello', token, status: 'alive', phase: 'bonding', cooling: false, currentUrl: null, lastFrame: null, at }).type).toBe('hello');
    expect(wsServerMessageSchema.parse({ type: 'frame', jpegBase64: 'AAAA', url: 'https://example.com', at }).type).toBe('frame');
    expect(wsServerMessageSchema.parse({ type: 'thought', tickId: 1, kind: 'thinking', text: 'hi', delta: true, at }).type).toBe('thought');
    expect(wsServerMessageSchema.safeParse({ type: 'thought', tickId: 1, kind: 'aloud', text: 'hi', delta: true, at }).success).toBe(false);
    expect(wsServerMessageSchema.parse({ type: 'action', tickId: 1, tool: 'browse_navigate', input: '{"url":"x"}', at }).type).toBe('action');
    expect(wsServerMessageSchema.parse({ type: 'status', status: 'paused', phase: 'complete', cooling: false, at }).type).toBe('status');
    expect(wsServerMessageSchema.parse({ type: 'budget', balanceWei: '1', balanceUsd: 1, availableUsd: 1, burnUsdPerHour: 0.1, tickIntervalMs: 20000, at }).type).toBe('budget');
    expect(wsServerMessageSchema.parse({ type: 'pong', at }).type).toBe('pong');
    expect(wsServerMessageSchema.parse({ type: 'error', message: 'bad token' }).type).toBe('error');
    expect(wsServerMessageSchema.parse({ type: 'tick', tickId: 3, state: 'finished', model: 'claude-opus-5-5', costUsd: 0.01, stopReason: 'end_turn', at }).type).toBe('tick');
    expect(wsServerMessageSchema.safeParse({ type: 'nope' }).success).toBe(false);
    expect(wsServerMessageSchema.safeParse({ type: 'action', tickId: 1, tool: 't', input: 'x'.repeat(301), at }).success).toBe(false);
  });

  it('client messages', () => {
    expect(wsClientMessageSchema.parse({ type: 'subscribe', token })).toEqual({ type: 'subscribe', token });
    expect(wsClientMessageSchema.parse({ type: 'ping' })).toEqual({ type: 'ping' });
    expect(wsClientMessageSchema.safeParse({ type: 'subscribe', token: 'bad' }).success).toBe(false);
  });

  it('redactActionInput truncates to 300 chars', () => {
    expect(redactActionInput({ a: 1 })).toBe('{"a":1}');
    const long = redactActionInput('x'.repeat(1000));
    expect(long.length).toBe(300);
    expect(long.endsWith('…')).toBe(true);
  });
});
