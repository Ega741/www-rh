import { describe, expect, it } from 'vitest';
import {
  addressSchema,
  anchorBatchSchema,
  bigintStringSchema,
  computeResponseSchema,
  curvePhaseName,
  curvePhaseValue,
  drawReceiptSchema,
  fromBigintString,
  hash32Schema,
  healthResponseSchema,
  ledgerEntrySchema,
  memorySchema,
  metadataUploadResponseSchema,
  mindDetailSchema,
  mindMetadataSchema,
  mindStatusName,
  mindStatusValue,
  mindSummarySchema,
  mindsResponseSchema,
  redactActionInput,
  statsResponseSchema,
  thoughtSchema,
  toBigintString,
  tradeSchema,
  wsClientMessageSchema,
  wsServerMessageSchema,
  type MindSummary,
} from '../src/types.js';

const token = `0x${'ab'.repeat(20)}` as const;
const hash = `0x${'cd'.repeat(32)}` as const;
const at = '2026-10-02T10:00:00.000Z';

const summary: MindSummary = {
  token,
  name: 'Mind',
  symbol: 'MIND',
  creator: token,
  metadataURI: 'runner://metadata/' + 'ab'.repeat(32),
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
};

const detail = {
  ...summary,
  personaHash: hash,
  persona: null,
  personaVerified: false,
  description: null,
  links: { x: null, website: null, telegram: null },
  pool: null,
  positionId: null,
  lastFrameAt: null,
};

const receiptObject = {
  token,
  fromTickId: 1,
  toTickId: 2,
  ticks: [{ tickId: 1, model: 'claude-opus-5-5', inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdMicro: 140 }],
  ethUsdPriceMicro: 3_000_000_000,
  amountWei: '46666666667',
};

describe('primitives', () => {
  it('addresses and hashes are lowercased; malformed values rejected', () => {
    expect(addressSchema.parse(token.toUpperCase().replace('0X', '0x'))).toBe(token);
    expect(addressSchema.safeParse('0x123').success).toBe(false);
    expect(hash32Schema.parse(hash.toUpperCase().replace('0X', '0x'))).toBe(hash);
  });

  it('bigint strings round-trip', () => {
    expect(toBigintString(123n)).toBe('123');
    expect(fromBigintString('123')).toBe(123n);
    expect(bigintStringSchema.safeParse('0').success).toBe(true);
    expect(bigintStringSchema.safeParse('007').success).toBe(false);
    expect(bigintStringSchema.safeParse('-1').success).toBe(false);
    expect(() => toBigintString(-1n)).toThrow(RangeError);
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
});

describe('§5 DTOs', () => {
  it('MindSummary / MindDetail accept the §5 shape', () => {
    expect(mindSummarySchema.parse(summary)).toEqual(summary);
    expect(mindDetailSchema.parse(detail)).toEqual(detail);
    expect(mindSummarySchema.safeParse({ ...summary, status: 'retired' }).success).toBe(false);
    expect(mindSummarySchema.safeParse({ ...summary, progressBps: 10001 }).success).toBe(false);
    expect(mindSummarySchema.safeParse({ ...summary, model: 'gpt-5' }).success).toBe(false);
  });

  it('nullable fields must be present (undefined is rejected)', () => {
    for (const key of ['image', 'model', 'lastTickAt', 'currentUrl'] as const) {
      expect(mindSummarySchema.safeParse({ ...summary, [key]: undefined }).success, key).toBe(false);
    }
    for (const key of ['persona', 'description', 'pool', 'positionId', 'lastFrameAt'] as const) {
      expect(mindDetailSchema.safeParse({ ...detail, [key]: undefined }).success, key).toBe(false);
    }
    expect(mindDetailSchema.safeParse({ ...detail, links: { x: null, website: null } }).success).toBe(false);
  });

  it('Trade / Memory / Thought / LedgerEntry / receipts / draws', () => {
    expect(
      tradeSchema.parse({
        txHash: hash, logIndex: 0, blockNumber: 10, timestamp: at, trader: token, isBuy: true, ethAmountWei: '1000', tokenAmount: '5',
        feeWei: '10', priceWei: '1', realEthReserveWei: '990', tokensSold: '5',
      }).isBuy,
    ).toBe(true);
    expect(memorySchema.safeParse({ seq: 1, kind: 'finding', content: 'x', url: null, createdAt: at, contentHash: hash, anchorTx: null }).success).toBe(true);
    expect(memorySchema.safeParse({ seq: 1, kind: 'thought', content: 'x', url: null, createdAt: at, contentHash: hash, anchorTx: null }).success).toBe(false);
    expect(thoughtSchema.safeParse({ id: 1, tickId: 1, kind: 'aloud', text: 'hi', createdAt: at }).success).toBe(true);
    expect(thoughtSchema.safeParse({ id: 1, tickId: 1, kind: 'thought', text: 'hi', createdAt: at }).success).toBe(false);
    expect(
      ledgerEntrySchema.parse({
        tickId: 1, startedAt: at, model: 'claude-opus-4-8', iterations: 3, inputTokens: 1, outputTokens: 2, cacheReadTokens: 3,
        cacheWriteTokens: 4, costUsd: 0.012345, stopReason: 'end_turn', error: null, receiptHash: null,
      }).model,
    ).toBe('claude-opus-4-8');
    expect(drawReceiptSchema.parse({ receiptHash: hash, status: 'dry_run', txHash: null, createdAt: at, receipt: receiptObject }).receipt).toEqual(receiptObject);
    expect(drawReceiptSchema.safeParse({ receiptHash: hash, status: 'submitted', txHash: null, createdAt: at, receipt: receiptObject }).success).toBe(false);
  });

  it('ComputeResponse with null runway and interval', () => {
    const r = computeResponseSchema.parse({
      balanceWei: '1', balanceUsd: 0.003, unsettledUsd: 0, availableUsd: 0.003, burnUsdPerHour: 0, runwayHours: null,
      tickIntervalMs: null, ledger: [], receipts: [], draws: [{ txHash: hash, blockNumber: 1, timestamp: at, amountWei: '5', receiptHash: hash }],
    });
    expect(r.runwayHours).toBeNull();
    expect(r.draws[0]?.amountWei).toBe('5');
  });

  it('Health / Minds / Stats / AnchorBatch / metadata upload', () => {
    expect(healthResponseSchema.parse({ ok: false, chainId: 46630, launchpad: token, lastIndexedBlock: 0, headBlock: 0, activeMinds: 0, dryRun: true }).ok).toBe(false);
    expect(mindsResponseSchema.parse({ items: [summary], nextCursor: null }).items).toHaveLength(1);
    expect(statsResponseSchema.parse({ minds: 1, alive: 1, graduated: 0, totalVolumeWei: '0', totalFeesToMindsWei: '0' }).minds).toBe(1);
    expect(anchorBatchSchema.parse({ token, fromSeq: 1, toSeq: 1, memories: [{ seq: 1, kind: 'note', content: 'a', url: null, createdAt: at }] }).toSeq).toBe(1);
    expect(metadataUploadResponseSchema.safeParse({ uri: 'runner://metadata/x', hash: 'ab'.repeat(32), personaHash: hash }).success).toBe(true);
    expect(metadataUploadResponseSchema.safeParse({ uri: 'runner://metadata/x', hash: '0x' + 'ab'.repeat(32), personaHash: hash }).success).toBe(false);
  });

  it('MindMetadata: strict, byte-bounded name/symbol, catalog model, http(s)/ipfs image, no empty strings', () => {
    const base = { name: 'Mind', symbol: 'MIND', persona: 'curious', model: 'claude-opus-5-5' };
    expect(mindMetadataSchema.parse(base)).toEqual(base);
    expect(mindMetadataSchema.safeParse({ ...base, name: '' }).success).toBe(false);
    expect(mindMetadataSchema.safeParse({ ...base, description: '' }).success).toBe(false);
    expect(mindMetadataSchema.safeParse({ ...base, model: 'gpt-5' }).success).toBe(false);
    expect(mindMetadataSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(mindMetadataSchema.safeParse({ ...base, image: 'ipfs://bafy/img.png' }).success).toBe(true);
    expect(mindMetadataSchema.safeParse({ ...base, image: 'javascript:alert(1)' }).success).toBe(false);
    expect(mindMetadataSchema.safeParse({ ...base, links: { x: 'https://x.com/a' } }).success).toBe(true);
    expect(mindMetadataSchema.safeParse({ ...base, links: { x: 'x.com/a' } }).success).toBe(false);
    expect(mindMetadataSchema.safeParse({ ...base, links: { discord: 'https://d.gg' } }).success).toBe(false);
    expect(mindMetadataSchema.safeParse({ ...base, symbol: '€€€€€' }).success).toBe(true); // 15 bytes
    expect(mindMetadataSchema.safeParse({ ...base, symbol: '€€€€€€' }).success).toBe(false); // 18 bytes
    expect(mindMetadataSchema.safeParse({ ...base, persona: 'p'.repeat(8001) }).success).toBe(false);
  });
});

describe('§6 WebSocket schemas', () => {
  it('server messages are discriminated by type', () => {
    const frame = { jpegBase64: 'AAAA', url: 'https://example.com', at };
    expect(wsServerMessageSchema.parse({ type: 'hello', token, status: 'alive', phase: 'bonding', frame: null, at }).type).toBe('hello');
    expect(wsServerMessageSchema.parse({ type: 'hello', token, status: 'alive', phase: 'bonding', frame, at }).type).toBe('hello');
    expect(wsServerMessageSchema.safeParse({ type: 'hello', token, status: 'alive', phase: 'bonding', at }).success).toBe(false);
    expect(wsServerMessageSchema.parse({ type: 'frame', ...frame }).type).toBe('frame');
    expect(wsServerMessageSchema.parse({ type: 'thought', tickId: 1, kind: 'thinking', text: 'hi', delta: true, at }).type).toBe('thought');
    expect(wsServerMessageSchema.safeParse({ type: 'thought', tickId: 1, kind: 'aloud', text: 'hi', delta: true, at }).success).toBe(false);
    expect(wsServerMessageSchema.parse({ type: 'thoughtSaved', thought: { id: 1, tickId: 1, kind: 'summary', text: 's', createdAt: at } }).type).toBe('thoughtSaved');
    expect(wsServerMessageSchema.parse({ type: 'action', tickId: 1, tool: 'browse_navigate', input: '{"url":"x"}', at }).type).toBe('action');
    expect(wsServerMessageSchema.parse({ type: 'status', status: 'paused', phase: 'complete', at }).type).toBe('status');
    expect(wsServerMessageSchema.parse({ type: 'budget', balanceWei: '1', balanceUsd: 1, burnUsdPerHour: 0.1, runwayHours: 10, at }).type).toBe('budget');
    expect(wsServerMessageSchema.parse({ type: 'pong' }).type).toBe('pong');
    expect(wsServerMessageSchema.parse({ type: 'error', message: 'unknown token' }).type).toBe('error');
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
