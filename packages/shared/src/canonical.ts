/**
 * Canonical JSON (RFC 8785 style) and the receipt hash (SPEC §4.7).
 *
 * Rules: object keys sorted by code point, no whitespace, `undefined` members omitted, `bigint`
 * serialized as a decimal **string** (so a parsed DTO with bigint fields and its wire form with
 * decimal strings hash identically), numbers must be finite safe integers (throw otherwise:
 * monetary values are bigint), arrays preserved in order (`undefined` elements become `null`,
 * like `JSON.stringify`). Only `null`, booleans, numbers, strings, bigints, arrays and plain
 * objects are accepted.
 *
 * @module canonical
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/** A `0x`-prefixed hex string (receipt hashes are `0x` + 64 lowercase hex characters). */
export type Hex = `0x${string}`;

const encoder = new TextEncoder();

/** UTF-8 bytes of `input`. */
export function utf8Bytes(input: string): Uint8Array {
  return encoder.encode(input);
}

/** Primitive values {@link canonicalJson} accepts. */
export type CanonicalPrimitive = null | boolean | number | string | bigint;
/** Values {@link canonicalJson} accepts. */
export type CanonicalValue =
  | CanonicalPrimitive
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue | undefined };

/** Compares two strings by Unicode code points (not UTF-16 code units). */
export function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const na = ia.next();
    const nb = ib.next();
    if (na.done && nb.done) return 0;
    if (na.done) return -1;
    if (nb.done) return 1;
    const ca = na.value.codePointAt(0) as number;
    const cb = nb.value.codePointAt(0) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
  }
}

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v) as object | null;
  return proto === null || proto === Object.prototype;
}

function serialize(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(value)) {
        throw new TypeError(
          `canonicalJson: number at ${path} must be a finite safe integer (got ${String(value)}); use bigint for money`,
        );
      }
      return value === 0 ? '0' : String(value);
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      return `"${value.toString()}"`;
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item, i) => serialize(item, `${path}[${i}]`) ?? 'null').join(',')}]`;
      }
      if (!isPlainObject(value)) {
        throw new TypeError(`canonicalJson: unsupported object at ${path} (only plain objects and arrays)`);
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort(compareCodePoints);
      const members: string[] = [];
      for (const key of keys) {
        const member = serialize(record[key], `${path}.${key}`);
        if (member !== undefined) members.push(`${JSON.stringify(key)}:${member}`);
      }
      return `{${members.join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}`);
  }
}

/** Serializes `value` canonically (see the module description). Throws on unsupported input. */
export function canonicalJson(value: unknown): string {
  const out = serialize(value, '$');
  if (out === undefined) throw new TypeError('canonicalJson: top-level value must not be undefined');
  return out;
}

/** SHA-256 of the UTF-8 bytes of `input`, as 64 lowercase hex characters without `0x`. */
export function sha256Hex(input: string): string {
  return bytesToHex(sha256(utf8Bytes(input)));
}

/** `'0x' + sha256Hex(canonicalJson(obj))`: the 32-byte receipt hash of SPEC §4.7 (memo `h=`). */
export function receiptHash(obj: unknown): Hex {
  return `0x${sha256Hex(canonicalJson(obj))}`;
}
