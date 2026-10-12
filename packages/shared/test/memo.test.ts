import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import {
  DRAW_MEMO_TAG,
  MEMO_MAX_BYTES,
  MEMO_PREFIX,
  PURCHASE_MEMO_TAG,
  encodeDrawMemo,
  encodePurchaseMemo,
  isBeagleMemo,
  memoByteLength,
  parseMemo,
} from '../src/memo.js';
import { receiptHash } from '../src/canonical.js';

const WS = bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => i + 1)); // 4wBqpZM9xaSheZzJSMawUKKwhdpChKbZ5eu5ky4Vigw
const WS2 = bs58.encode(new Uint8Array(32).fill(255));
const HASH = `0x${'ab'.repeat(32)}`;
const HASH_UPPER = `0x${'AB'.repeat(32)}`;

describe('memo grammar (SPEC §1, §4.1)', () => {
  it('constants', () => {
    expect(MEMO_MAX_BYTES).toBe(256);
    expect(MEMO_PREFIX).toBe('beagle:');
    expect(PURCHASE_MEMO_TAG).toBe('beagle:v1');
    expect(DRAW_MEMO_TAG).toBe('beagle:draw');
  });

  it('encodes purchase memos', () => {
    expect(encodePurchaseMemo({ workspace: WS })).toBe(`beagle:v1 ws=${WS}`);
    expect(() => encodePurchaseMemo({ workspace: 'nope' })).toThrow(/not a base58 public key/);
    expect(() => encodePurchaseMemo({ workspace: `${WS} ` })).toThrow(TypeError);
  });

  it('encodes draw memos with a lowercase hash', () => {
    expect(encodeDrawMemo({ workspace: WS, receiptHash: HASH })).toBe(`beagle:draw v1 ws=${WS} h=${HASH}`);
    expect(encodeDrawMemo({ workspace: WS, receiptHash: HASH_UPPER })).toBe(`beagle:draw v1 ws=${WS} h=${HASH}`);
    const real = receiptHash({ v: 1, usageIds: ['req_1'], amountMicro: 12n });
    expect(parseMemo(encodeDrawMemo({ workspace: WS, receiptHash: real }))).toEqual({ kind: 'draw', workspace: WS, receiptHash: real });
    expect(() => encodeDrawMemo({ workspace: WS, receiptHash: HASH.slice(0, -1) })).toThrow(/0x \+ 64 hex/);
    expect(() => encodeDrawMemo({ workspace: WS, receiptHash: 'ab'.repeat(32) })).toThrow(TypeError);
    expect(() => encodeDrawMemo({ workspace: 'x', receiptHash: HASH })).toThrow(TypeError);
  });

  it('parses what it encodes', () => {
    expect(parseMemo(encodePurchaseMemo({ workspace: WS }))).toEqual({ kind: 'purchase', workspace: WS });
    expect(parseMemo(encodeDrawMemo({ workspace: WS2, receiptHash: HASH }))).toEqual({ kind: 'draw', workspace: WS2, receiptHash: HASH });
  });

  it('tolerates whitespace', () => {
    expect(parseMemo(`  beagle:v1   ws=${WS}\n`)).toEqual({ kind: 'purchase', workspace: WS });
    expect(parseMemo(`\tbeagle:draw\tv1  ws=${WS}\t h=${HASH_UPPER}  `)).toEqual({ kind: 'draw', workspace: WS, receiptHash: HASH });
  });

  it('rejects malformed memos', () => {
    const bad = [
      '',
      '   ',
      'hello',
      'beagle:',
      'beagle:v1',
      `beagle:v2 ws=${WS}`,
      `beagle: v1 ws=${WS}`,
      `Beagle:v1 ws=${WS}`,
      `beagle:v1 ws=${WS} extra`,
      `beagle:v1 ws:${WS}`,
      `beagle:v1 workspace=${WS}`,
      `beagle:v1 ws=`,
      `beagle:v1 ws=${WS.slice(0, -1)}`,
      `beagle:v1 ws=${WS2}1`,
      `beagle:v1 ws=1${WS2}`,
      `beagle:v1 ws=0x0bd7d308f8e1639fab988df18a8011f41eacad73`,
      `beagle:v1 ws=${WS} h=${HASH}`,
      `beagle:draw ws=${WS} h=${HASH}`,
      `beagle:draw v2 ws=${WS} h=${HASH}`,
      `beagle:draw v1 ws=${WS}`,
      `beagle:draw v1 ws=${WS} h=${HASH} extra`,
      `beagle:draw v1 ws=${WS} h=${HASH.slice(0, -1)}`,
      `beagle:draw v1 ws=${WS} h=${HASH}0`,
      `beagle:draw v1 ws=${WS} h=${'ab'.repeat(32)}`,
      `beagle:draw v1 ws=${WS} h=0x${'zz'.repeat(32)}`,
      `beagle:draw v1 h=${HASH} ws=${WS}`,
      `beagle:draw v1 ws=nope h=${HASH}`,
    ];
    for (const m of bad) expect(parseMemo(m), JSON.stringify(m)).toBeUndefined();
    expect(parseMemo(null)).toBeUndefined();
    expect(parseMemo(undefined)).toBeUndefined();
    expect(parseMemo(42 as unknown as string)).toBeUndefined();
  });

  it('rejects memos over 256 UTF-8 bytes (and accepts exactly 256)', () => {
    const base = encodePurchaseMemo({ workspace: WS });
    const at256 = base.padEnd(MEMO_MAX_BYTES, ' ');
    expect(memoByteLength(at256)).toBe(256);
    expect(parseMemo(at256)).toEqual({ kind: 'purchase', workspace: WS });
    const at257 = base.padEnd(MEMO_MAX_BYTES + 1, ' ');
    expect(parseMemo(at257)).toBeUndefined();
    // multibyte whitespace counts in bytes, not characters
    const nbsp = `${base}${' '.repeat(200)}`; // 2 bytes each
    expect(nbsp.length).toBeLessThan(257);
    expect(memoByteLength(nbsp)).toBeGreaterThan(256);
    expect(parseMemo(nbsp)).toBeUndefined();
    expect(memoByteLength('é')).toBe(2);
    expect(memoByteLength('')).toBe(0);
  });

  it('isBeagleMemo picks the first beagle: memo', () => {
    expect(isBeagleMemo(`beagle:v1 ws=${WS}`)).toBe(true);
    expect(isBeagleMemo('  beagle:anything')).toBe(true);
    expect(isBeagleMemo('gm')).toBe(false);
    expect(isBeagleMemo(null)).toBe(false);
    expect(isBeagleMemo(undefined)).toBe(false);
  });
});
