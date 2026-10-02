/**
 * Tolerant, typed readers for JSON received from the runner (HTTP and WebSocket).
 *
 * Each reader accepts a list of candidate keys so the UI keeps working across the
 * SPEC §5 -> R11 field renames (e.g. `realEthReserve` -> `realEthReserveWei`).
 *
 * @module lib/json
 */
import { isAddress, type Address, type Hex } from 'viem';

/** Any JSON value. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
/** A JSON object. */
export type JsonObject = { [key: string]: JsonValue };

/** Thrown when a required field is missing or malformed. */
export class ShapeError extends Error {
  override readonly name = 'ShapeError';
}

/** Narrowing guard for plain objects. */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function first(obj: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = obj[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

/** First string value among `keys`, or `null`. */
export function readString(obj: Record<string, unknown>, ...keys: string[]): string | null {
  const value = first(obj, keys);
  return typeof value === 'string' ? value : null;
}

/** First non-empty string value among `keys`, or `null`. */
export function readText(obj: Record<string, unknown>, ...keys: string[]): string | null {
  const value = readString(obj, ...keys);
  return value !== null && value.trim() !== '' ? value : null;
}

/** First finite number among `keys` (numeric strings accepted), or `null`. */
export function readNumber(obj: Record<string, unknown>, ...keys: string[]): number | null {
  const value = first(obj, keys);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** First boolean among `keys`, or `null`. */
export function readBoolean(obj: Record<string, unknown>, ...keys: string[]): boolean | null {
  const value = first(obj, keys);
  return typeof value === 'boolean' ? value : null;
}

/** Parses a bigint from a decimal string, a safe integer number or a bigint. */
export function toBigint(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isSafeInteger(value) ? BigInt(value) : null;
  if (typeof value === 'string' && /^-?[0-9]+$/.test(value.trim())) return BigInt(value.trim());
  return null;
}

/** First bigint-compatible value among `keys`, or `null`. */
export function readBigint(obj: Record<string, unknown>, ...keys: string[]): bigint | null {
  for (const key of keys) {
    const parsed = toBigint(obj[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

/**
 * Parses a timestamp into epoch milliseconds. Accepts ISO-8601 strings, epoch milliseconds and
 * epoch seconds (numbers below 1e11 are treated as seconds).
 */
export function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e11 ? value * 1000 : value;
  if (typeof value === 'string' && value.trim() !== '') {
    if (/^[0-9]+$/.test(value.trim())) return toEpochMs(Number(value));
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

/** First timestamp among `keys` as epoch ms, or `null`. */
export function readTime(obj: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const ms = toEpochMs(obj[key]);
    if (ms !== null) return ms;
  }
  return null;
}

/** First valid address among `keys` (lowercased), or `null`. */
export function readAddress(obj: Record<string, unknown>, ...keys: string[]): Address | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && isAddress(value, { strict: false })) return value.toLowerCase() as Address;
  }
  return null;
}

/** First 0x-prefixed 32-byte hex among `keys` (lowercased), or `null`. */
export function readHash(obj: Record<string, unknown>, ...keys: string[]): Hex | null {
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)) return value.toLowerCase() as Hex;
  }
  return null;
}

/** Like {@link readString} but throws {@link ShapeError} when absent. */
export function requireString(obj: Record<string, unknown>, label: string, ...keys: string[]): string {
  const value = readString(obj, ...keys);
  if (value === null) throw new ShapeError(`missing ${label}`);
  return value;
}

/** Like {@link readAddress} but throws {@link ShapeError} when absent. */
export function requireAddress(obj: Record<string, unknown>, label: string, ...keys: string[]): Address {
  const value = readAddress(obj, ...keys);
  if (value === null) throw new ShapeError(`missing or invalid ${label}`);
  return value;
}

/** Like {@link readBigint} but returns `fallback` when absent. */
export function readBigintOr(obj: Record<string, unknown>, fallback: bigint, ...keys: string[]): bigint {
  return readBigint(obj, ...keys) ?? fallback;
}

/** Extracts an array from a bare array response or from `{ [key]: [...] }`. */
export function readList(raw: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (isObject(raw)) {
    for (const key of keys) {
      const value = raw[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

/** Maps `items` with `fn`, dropping (and logging) entries that fail validation. */
export function mapValid<T>(items: readonly unknown[], fn: (item: unknown) => T, what: string): T[] {
  const out: T[] = [];
  for (const item of items) {
    try {
      out.push(fn(item));
    } catch (error) {
      console.warn(`[www-rh] dropped malformed ${what}:`, error);
    }
  }
  return out;
}

/** Returns `value` if it is a JSON value (deep check), else `null`. */
export function asJson(value: unknown, depth = 0): JsonValue | undefined {
  if (depth > 32) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) {
    const out: JsonValue[] = [];
    for (const item of value) {
      const json = asJson(item, depth + 1);
      if (json === undefined) return undefined;
      out.push(json);
    }
    return out;
  }
  if (isObject(value)) {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      const json = asJson(item, depth + 1);
      if (json === undefined) return undefined;
      out[key] = json;
    }
    return out;
  }
  return undefined;
}
