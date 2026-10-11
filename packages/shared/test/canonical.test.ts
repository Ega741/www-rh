import { describe, expect, it } from 'vitest';
import { canonicalJson, compareCodePoints, receiptHash, sha256Hex } from '../src/canonical.js';

describe('canonicalJson (SPEC §4.7)', () => {
  it('sorts keys and strips whitespace', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ z: { y: [1, { x: true, w: null }], a: 'q' } })).toBe('{"z":{"a":"q","y":[1,{"w":null,"x":true}]}}');
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson('s')).toBe('"s"');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(Object.create(null))).toBe('{}');
  });

  it('sorts keys by code point, not UTF-16 code unit', () => {
    const emoji = '\u{1F600}'; // surrogate pair D83D DE00
    const high = '￿';
    expect(canonicalJson({ [emoji]: 1, [high]: 2 })).toBe(`{"${high}":2,"${emoji}":1}`);
    expect([emoji, high].sort()[0]).toBe(emoji); // the default sort would put the emoji first
    expect(compareCodePoints('a', 'b')).toBeLessThan(0);
    expect(compareCodePoints('b', 'a')).toBeGreaterThan(0);
    expect(compareCodePoints('ab', 'ab')).toBe(0);
    expect(compareCodePoints('a', 'ab')).toBeLessThan(0);
    expect(compareCodePoints(high, emoji)).toBeLessThan(0);
  });

  it('serializes bigint as a decimal string', () => {
    expect(canonicalJson({ amountMicro: 2_500_000n })).toBe('{"amountMicro":"2500000"}');
    expect(canonicalJson(-5n)).toBe('"-5"');
    expect(canonicalJson([10n ** 30n])).toBe('["1000000000000000000000000000000"]');
    // a parsed DTO (bigint) and its wire form (string) serialize identically
    expect(canonicalJson({ a: 1n, b: 'x' })).toBe(canonicalJson({ b: 'x', a: '1' }));
  });

  it('omits undefined members and nulls undefined array items', () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([1, undefined, 2])).toBe('[1,null,2]');
    expect(canonicalJson({ a: [undefined] })).toBe('{"a":[null]}');
  });

  it('accepts integers only', () => {
    expect(canonicalJson(42)).toBe('42');
    expect(canonicalJson(-42)).toBe('-42');
    expect(canonicalJson(-0)).toBe('0');
    expect(canonicalJson(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
    expect(() => canonicalJson(1.5)).toThrow(/finite safe integer/);
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(/\$\.x/);
    expect(() => canonicalJson([Number.POSITIVE_INFINITY])).toThrow(/\$\[0\]/);
    expect(() => canonicalJson(1e21)).toThrow(/finite safe integer/);
    expect(() => canonicalJson(2 ** 53)).toThrow(/finite safe integer/);
  });

  it('escapes strings like JSON.stringify', () => {
    const s = 'a"b\\c\n\t\u0001é ';
    expect(canonicalJson(s)).toBe(JSON.stringify(s));
    expect(canonicalJson({ 'k"ey': 1 })).toBe('{"k\\"ey":1}');
  });

  it('rejects unsupported values', () => {
    expect(() => canonicalJson(undefined)).toThrow(/top-level/);
    expect(() => canonicalJson(() => 1)).toThrow(/unsupported function/);
    expect(() => canonicalJson(Symbol('x'))).toThrow(/unsupported symbol/);
    expect(() => canonicalJson(new Date(0))).toThrow(/unsupported object/);
    expect(() => canonicalJson(new Map())).toThrow(/unsupported object/);
    expect(() => canonicalJson({ a: new Uint8Array(1) })).toThrow(/\$\.a/);
    class C {
      x = 1;
    }
    expect(() => canonicalJson(new C())).toThrow(/unsupported object/);
  });
});

describe('sha256Hex / receiptHash', () => {
  it('hashes UTF-8 input to lowercase hex without 0x', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('é')).toBe('4a99557e4033c3539de2eb65472017cad5f9557f7a0625a09f1c3f6e2ba69c4c');
    expect(sha256Hex('é')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('receiptHash is 0x + sha256(canonicalJson)', () => {
    const obj = { v: 1, requestId: 'req_1', chargedMicro: 1234n, usage: { inputTokens: 1, outputTokens: 2 } };
    const h = receiptHash(obj);
    expect(h).toBe(`0x${sha256Hex(canonicalJson(obj))}`);
    expect(h).toMatch(/^0x[0-9a-f]{64}$/);
    expect(receiptHash({ usage: { outputTokens: 2, inputTokens: 1 }, chargedMicro: '1234', requestId: 'req_1', v: 1 })).toBe(h);
    expect(receiptHash({ ...obj, chargedMicro: 1235n })).not.toBe(h);
    expect(receiptHash({ ...obj, extra: undefined })).toBe(h);
  });

  it('matches a known digest', () => {
    expect(receiptHash({ a: 1 })).toBe(`0x${sha256Hex('{"a":1}')}`);
    expect(sha256Hex('{"a":1}')).toBe('015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862');
  });
});
