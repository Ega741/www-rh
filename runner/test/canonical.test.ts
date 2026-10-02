import { describe, expect, it } from 'vitest';
import { anchorBatchHash, anchorBatchUri, canonicalJson, drawReceiptHash, memoryContentHash, type AnchorBatch } from '@www-rh/shared';
import type { MemoryRow, TickRow } from '../src/db/repos.js';
import { buildReceipt } from '../src/economics/settle.js';
import { buildAnchorBatch, memoryItem } from '../src/memory/memory.js';

// Golden values computed independently with `cast keccak '<canonical string>'` (see packages/shared/test/canonical.test.ts).
const token = '0x' + 'ab'.repeat(20);

function memRow(seq: number, kind: 'note' | 'finding', content: string, url: string | null, iso: string): MemoryRow {
  return { id: seq, token, seq, kind, content, url, created_at: Date.parse(iso), content_hash: '', tick_id: null, anchor_id: null };
}

function tickRow(id: number, model: string, tokens: [number, number, number, number], cost: number): TickRow {
  return {
    id, token, started_at: 0, ended_at: 1, requested_model: 'claude-opus-5-5', served_model: model, iterations: 1,
    input_tokens: tokens[0], output_tokens: tokens[1], cache_read_tokens: tokens[2], cache_write_tokens: tokens[3],
    cost_usd_micro: cost, stop_reason: 'end_turn', status: 'ok', error: null, receipt_id: null, receipt_hash: null, receipt_status: null,
  };
}

describe('runner builders produce the §3.2 hashed objects (golden values)', () => {
  const rows = [
    memRow(2, 'note', 'Note to self: check Blockscout.', null, '2026-10-02T10:01:00.000Z'),
    memRow(1, 'finding', 'Found a paper on L2 sequencers.', 'https://example.com/paper', '2026-10-02T10:00:00.000Z'),
  ];

  it('memory items: ISO createdAt from unix ms, content hash', () => {
    expect(memoryItem(rows[1]!)).toEqual({ seq: 1, kind: 'finding', content: 'Found a paper on L2 sequencers.', url: 'https://example.com/paper', createdAt: '2026-10-02T10:00:00.000Z' });
    expect(memoryContentHash(memoryItem(rows[1]!))).toBe('0xde8de28588a8d71d96af3b75bda84b7bac30fb3661ee5ec042bd84683ba6e424');
  });

  it('anchor batch (sorted, contiguous) → keccak256 and URI', () => {
    const batch: AnchorBatch = buildAnchorBatch(token.toUpperCase().replace('0X', '0x'), rows);
    expect(batch.fromSeq).toBe(1);
    expect(batch.toSeq).toBe(2);
    expect(anchorBatchHash(batch)).toBe('0x036c2d015c75100433ea5b97cc94b81e1fc240987314c6f571aa9c6d9d789c99');
    expect(anchorBatchUri(batch.token, batch.fromSeq, batch.toSeq)).toBe(`runner://memories/${token}/1-2`);
    expect(() => buildAnchorBatch(token, [rows[1]!, memRow(3, 'note', 'x', null, '2026-10-02T10:02:00.000Z')])).toThrow(RangeError);
  });

  it('draw receipt → keccak256 (drawCompute receiptHash)', () => {
    const receipt = buildReceipt(token, [tickRow(7, 'claude-opus-5-5', [100, 20, 2000, 300], 2700)], 3_000_000_000, 900_000_000_000n);
    expect(receipt).toEqual({
      token,
      fromTickId: 7,
      toTickId: 7,
      ticks: [{ tickId: 7, model: 'claude-opus-5-5', inputTokens: 100, outputTokens: 20, cacheReadTokens: 2000, cacheWriteTokens: 300, costUsdMicro: 2700 }],
      ethUsdPriceMicro: 3_000_000_000,
      amountWei: '900000000000',
    });
    expect(drawReceiptHash(receipt)).toBe('0x9dff4ce82cc06cab3eb712ae69d94008bf9b58953bd9f43d8cb2cd389ee62e56');
    expect(canonicalJson(receipt)).toBe(
      '{"amountWei":"900000000000","ethUsdPriceMicro":3000000000,"fromTickId":7,"ticks":[{"cacheReadTokens":2000,"cacheWriteTokens":300,"costUsdMicro":2700,"inputTokens":100,"model":"claude-opus-5-5","outputTokens":20,"tickId":7}],"toTickId":7,"token":"0xabababababababababababababababababababab"}',
    );
  });

  it('receipt ticks are ordered by tickId and min/max bound the range', () => {
    const r = buildReceipt(token, [tickRow(9, 'claude-opus-4-8', [1, 1, 0, 0], 30), tickRow(4, 'claude-opus-5-5', [1, 1, 0, 0], 24)], 3_000_000_000, 1n);
    expect(r.ticks.map((t) => t.tickId)).toEqual([4, 9]);
    expect([r.fromTickId, r.toTickId]).toEqual([4, 9]);
    expect(r.ticks[1]?.model).toBe('claude-opus-4-8');
  });
});
