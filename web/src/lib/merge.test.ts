import { memoryContentHash } from '@www-rh/shared';
import { describe, expect, it } from 'vitest';
import { mergeMemories, memoryHashMatches } from '../components/MemoryList';
import { mergeThoughts } from '../components/ThoughtsTicker';
import { mergeTrades } from '../components/TradesTable';
import type { Memory, Trade } from './types';

const HASH = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;

function memory(seq: number, extra: Partial<Memory> = {}): Memory {
  return { seq, kind: 'note', content: `m${seq}`, url: null, createdAt: Date.parse('2026-10-02T10:00:00.000Z'), contentHash: null, anchorTx: null, anchorUri: null, ...extra };
}

function trade(block: number, logIndex: number): Trade {
  return {
    txHash: HASH(block * 100 + logIndex),
    logIndex,
    blockNumber: block,
    timestamp: block * 1000,
    trader: '0x00000000000000000000000000000000000000aa',
    isBuy: true,
    ethAmountWei: 1n,
    tokenAmount: 1n,
    feeWei: 0n,
    priceWei: 1n,
  };
}

describe('merging live and fetched lists', () => {
  it('merges memories newest first and keeps a known anchor', () => {
    const fetched = [memory(1, { anchorTx: HASH(9) }), memory(2)];
    const merged = mergeMemories([memory(3), memory(1)], fetched);
    expect(merged.map((m) => m.seq)).toEqual([3, 2, 1]);
    expect(merged[2]?.anchorTx).toBe(HASH(9));
  });

  it('merges trades by (txHash, logIndex), newest block first', () => {
    const merged = mergeTrades([trade(5, 0), trade(3, 1)], [trade(3, 1), trade(4, 0)]);
    expect(merged.map((t) => [t.blockNumber, t.logIndex])).toEqual([
      [5, 0],
      [4, 0],
      [3, 1],
    ]);
  });

  it('merges persisted thoughts oldest first without duplicates', () => {
    const t = (id: number, at: number) => ({ id, tickId: 1, kind: 'aloud' as const, text: `t${id}`, createdAt: at });
    expect(mergeThoughts([t(1, 10), t(2, 20)], [t(3, 30), t(2, 20)]).map((x) => x.id)).toEqual([1, 2, 3]);
  });
});

describe('memoryHashMatches (SPEC §3.2 memoryContentHash)', () => {
  it('recomputes contentHash from the served fields', () => {
    const base = memory(7, { kind: 'finding', url: 'https://arxiv.org/abs/2401.00001' });
    const contentHash = memoryContentHash({ seq: 7, kind: 'finding', content: 'm7', url: 'https://arxiv.org/abs/2401.00001', createdAt: '2026-10-02T10:00:00.000Z' });
    expect(memoryHashMatches({ ...base, contentHash })).toBe(true);
    expect(memoryHashMatches({ ...base, content: 'tampered', contentHash })).toBe(false);
    expect(memoryHashMatches(base)).toBe(false);
  });
});
