import { describe, expect, it } from 'vitest';
import {
  addressSchema,
  bigintStringSchema,
  computeResponseSchema,
  curvePhaseName,
  curvePhaseValue,
  fromBigintString,
  mindDetailSchema,
  mindMetadataSchema,
  mindStatusName,
  mindStatusValue,
  mindSummarySchema,
  mindsQuerySchema,
  redactActionInput,
  toBigintString,
  wsClientMessageSchema,
  wsServerMessageSchema,
  type MindSummary,
} from '../src/types.js';

const token = '0x' + 'ab'.repeat(20);
const hash = '0x' + 'cd'.repeat(32);

const summary: MindSummary = {
  token,
  name: 'Mind',
  symbol: 'MIND',
  creator: token,
  metadataURI: 'runner://metadata/abc',
  modelId: hash,
  model: 'claude-opus-5-5',
  status: 'alive',
  phase: 'bonding',
  priceWei: '1272134203168685',
  marketCapWei: '1272134203168685000000000',
  progressBps: 1234,
  realEthReserve: '0',
  tokensSold: '0',
  mindBalanceWei: '0',
  createdAt: '2026-10-02T10:00:00.000Z',
  trades24h: 0,
  volume24hWei: '0',
};

describe('API DTO schemas', () => {
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

  it('MindSummary / MindDetail validate', () => {
    expect(mindSummarySchema.parse(summary)).toEqual(summary);
    const detail = mindDetailSchema.parse({ ...summary, personaHash: hash, pool: token, positionId: '7' });
    expect(detail.pool).toBe(token);
    expect(mindSummarySchema.safeParse({ ...summary, status: 'dead' }).success).toBe(false);
    expect(mindSummarySchema.safeParse({ ...summary, progressBps: 10001 }).success).toBe(false);
  });

  it('enum name/value helpers', () => {
    expect(mindStatusName(0)).toBe('alive');
    expect(mindStatusName(1)).toBe('dormant');
    expect(mindStatusName(2)).toBe('retired');
    expect(() => mindStatusName(3)).toThrow(RangeError);
    expect(curvePhaseName(2)).toBe('graduated');
    expect(mindStatusValue('dormant')).toBe(1);
    expect(curvePhaseValue('complete')).toBe(1);
  });

  it('minds query applies defaults and coerces', () => {
    expect(mindsQuerySchema.parse({})).toEqual({ sort: 'created', limit: 50 });
    expect(mindsQuerySchema.parse({ sort: 'mcap', limit: '10', cursor: 'x' })).toEqual({ sort: 'mcap', limit: 10, cursor: 'x' });
    expect(mindsQuerySchema.safeParse({ sort: 'nope' }).success).toBe(false);
  });

  it('compute response accepts null runway', () => {
    const r = computeResponseSchema.parse({ balanceWei: '1', balanceUsd: 0.003, burnUsdPerHour: 0, runwayHours: null, ledger: [], draws: [] });
    expect(r.runwayHours).toBeNull();
  });

  it('metadata JSON', () => {
    const meta = mindMetadataSchema.parse({ name: 'Mind', symbol: 'MIND', persona: 'curious', model: 'claude-opus-5-5' });
    expect(meta.description).toBe('');
    expect(mindMetadataSchema.safeParse({ name: '', symbol: 'MIND', persona: '', model: '' }).success).toBe(false);
  });
});

describe('WebSocket schemas', () => {
  it('server messages are discriminated by type', () => {
    const at = '2026-10-02T10:00:00Z';
    expect(wsServerMessageSchema.parse({ type: 'hello', token, status: 'alive', phase: 'bonding' }).type).toBe('hello');
    expect(wsServerMessageSchema.parse({ type: 'frame', jpegBase64: 'AAAA', url: 'https://example.com', at }).type).toBe('frame');
    expect(wsServerMessageSchema.parse({ type: 'thought', text: 'hi', delta: true, tickId: 1, at }).type).toBe('thought');
    expect(wsServerMessageSchema.parse({ type: 'action', tool: 'browse_navigate', input: '{"url":"x"}', at }).type).toBe('action');
    expect(wsServerMessageSchema.parse({ type: 'status', status: 'dormant', phase: 'complete', at }).type).toBe('status');
    expect(wsServerMessageSchema.parse({ type: 'budget', balanceWei: '1', balanceUsd: 1, burnUsdPerHour: 0.1, at }).type).toBe('budget');
    expect(wsServerMessageSchema.safeParse({ type: 'nope' }).success).toBe(false);
    expect(wsServerMessageSchema.safeParse({ type: 'action', tool: 't', input: 'x'.repeat(301), at }).success).toBe(false);
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
