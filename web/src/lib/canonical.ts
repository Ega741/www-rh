/**
 * Canonical JSON (directive R2): object keys sorted by Unicode code point, no whitespace,
 * strings JSON-escaped, bigints as decimal strings, arrays in order, UTF-8 encoded.
 *
 * LOCAL FALLBACK: should live in `@www-rh/shared` next to the runner's implementation so both
 * sides hash identical bytes (metadata `data:` URIs, receipt / memory batch verification).
 *
 * @module lib/canonical
 */
import { keccak256, toBytes, type Hex } from 'viem';

/** Values accepted by {@link canonicalJson}. `undefined` object members are omitted. */
export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | bigint
  | readonly CanonicalValue[]
  | { readonly [key: string]: CanonicalValue | undefined };

/** Compares two strings by Unicode code point (not UTF-16 code unit). */
export function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const ca = ia.next();
    const cb = ib.next();
    if (ca.done === true) return cb.done === true ? 0 : -1;
    if (cb.done === true) return 1;
    const pa = ca.value.codePointAt(0) ?? 0;
    const pb = cb.value.codePointAt(0) ?? 0;
    if (pa !== pb) return pa - pb;
  }
}

/** Serialises `value` as canonical JSON. Throws on non-finite numbers. */
export function canonicalJson(value: CanonicalValue): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new RangeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'bigint':
      return JSON.stringify(value.toString(10));
    default:
      break;
  }
  if (Array.isArray(value)) {
    return `[${(value as readonly CanonicalValue[]).map((item) => canonicalJson(item)).join(',')}]`;
  }
  const obj = value as { readonly [key: string]: CanonicalValue | undefined };
  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort(compareCodePoints);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key] as CanonicalValue)}`).join(',')}}`;
}

/** UTF-8 byte length of `text`. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Base64 of the UTF-8 bytes of `text` (browser and Node). */
export function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** `data:application/json;base64,…` URI for a JSON document. */
export function jsonDataUri(json: string): string {
  return `data:application/json;base64,${base64Utf8(json)}`;
}

/** `keccak256(utf8(canonicalJson(value)))`. */
export function keccakCanonical(value: CanonicalValue): Hex {
  return keccak256(toBytes(canonicalJson(value)));
}
