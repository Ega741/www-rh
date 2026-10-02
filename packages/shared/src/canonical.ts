/**
 * Canonical JSON (directive R2, RFC 8785-style) and the hashes built on it.
 *
 * Rules: object keys sorted by Unicode code point; no whitespace; strings JSON-escaped exactly as
 * `JSON.stringify` does (RFC 8785 uses the same escaping); bigints serialised as decimal
 * **strings**; finite numbers in ECMAScript shortest form (`-0` → `0`); arrays keep their order;
 * `undefined` object members are omitted; the result is hashed as UTF-8 bytes.
 *
 * Used for: metadata (`sha256`, R1), memory anchor batches and draw receipts (`keccak256`, R2).
 * Browser-safe (no Node built-ins).
 *
 * @module canonical
 */
import { keccak256, sha256, toBytes, type Hex } from 'viem';
import type { DrawReceipt, MemoryBatch, MemoryBatchItem, MindMetadata } from './types.js';

/** Values accepted by {@link canonicalJson}. */
export type CanonicalValue =
  | null
  | boolean
  | number
  | bigint
  | string
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
    const x = (ca.value as string).codePointAt(0) as number;
    const y = (cb.value as string).codePointAt(0) as number;
    if (x !== y) return x < y ? -1 : 1;
  }
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function serialize(value: unknown, path: string, out: string[]): void {
  if (value === null) {
    out.push('null');
    return;
  }
  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'string':
      out.push(JSON.stringify(value));
      return;
    case 'bigint':
      out.push(`"${value.toString(10)}"`);
      return;
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonicalJson: non-finite number at ${path}`);
      out.push(Object.is(value, -0) ? '0' : String(value));
      return;
    case 'object': {
      if (Array.isArray(value)) {
        out.push('[');
        value.forEach((item: unknown, i) => {
          if (i > 0) out.push(',');
          if (item === undefined) throw new TypeError(`canonicalJson: undefined array element at ${path}[${i}]`);
          serialize(item, `${path}[${i}]`, out);
        });
        out.push(']');
        return;
      }
      if (!isPlainObject(value)) throw new TypeError(`canonicalJson: unsupported object at ${path}`);
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((k) => record[k] !== undefined)
        .sort(compareCodePoints);
      out.push('{');
      keys.forEach((key, i) => {
        if (i > 0) out.push(',');
        out.push(JSON.stringify(key), ':');
        serialize(record[key], `${path}.${key}`, out);
      });
      out.push('}');
      return;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported ${typeof value} at ${path}`);
  }
}

/**
 * Serialises `value` as canonical JSON (R2).
 *
 * @throws TypeError on non-finite numbers, functions, symbols, class instances or `undefined`
 *   array elements.
 */
export function canonicalJson(value: CanonicalValue): string {
  const out: string[] = [];
  serialize(value, '$', out);
  return out.join('');
}

/** UTF-8 bytes of the canonical JSON of `value`. */
export function canonicalBytes(value: CanonicalValue): Uint8Array {
  return toBytes(canonicalJson(value));
}

/** `keccak256(utf8(canonicalJSON(value)))` */
export function keccakCanonical(value: CanonicalValue): Hex {
  return keccak256(canonicalBytes(value));
}

/** `sha256(utf8(canonicalJSON(value)))` */
export function sha256Canonical(value: CanonicalValue): Hex {
  return sha256(canonicalBytes(value));
}

/** `keccak256(utf8Bytes(persona))` — the on-chain `personaHash` (R1). */
export function personaHashOf(persona: string): Hex {
  return keccak256(toBytes(persona));
}

/** sha256 of the canonical metadata JSON — the `<hash>` of `runner://metadata/<hash>` (R1). */
export function hashMetadata(metadata: MindMetadata): Hex {
  return sha256Canonical(metadata);
}

/** Per-memory content hash: `keccak256(canonicalJSON({ seq, kind, content, url, createdAt }))`. */
export function hashMemoryItem(item: MemoryBatchItem): Hex {
  return keccakCanonical({ seq: item.seq, kind: item.kind, content: item.content, url: item.url, createdAt: item.createdAt });
}

/** Anchor batch hash passed to `anchorMemory` (R2). */
export function hashMemoryBatch(batch: MemoryBatch): Hex {
  return keccakCanonical({
    token: batch.token,
    fromSeq: batch.fromSeq,
    toSeq: batch.toSeq,
    memories: batch.memories.map((m) => ({ seq: m.seq, kind: m.kind, content: m.content, url: m.url, createdAt: m.createdAt })),
  });
}

/** Draw receipt hash passed to `drawCompute` (R2). */
export function hashDrawReceipt(receipt: DrawReceipt): Hex {
  return keccakCanonical({
    token: receipt.token,
    fromTickId: receipt.fromTickId,
    toTickId: receipt.toTickId,
    ticks: receipt.ticks.map((t) => ({
      tickId: t.tickId,
      model: t.model,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens,
      costUsdMicro: t.costUsdMicro,
    })),
    ethUsdPriceMicro: receipt.ethUsdPriceMicro,
    amountWei: receipt.amountWei,
  });
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 (with padding) of `bytes`; environment-independent. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += B64[(n >> 18) & 63];
    out += B64[(n >> 12) & 63];
    out += b === undefined ? '=' : B64[(n >> 6) & 63];
    out += c === undefined ? '=' : B64[n & 63];
  }
  return out;
}

/**
 * `data:application/json;base64,<canonical JSON>` — the metadata URI fallback used by the web app
 * when the runner is unreachable (W2). Resolves to the same JSON the runner would serve.
 */
export function metadataDataUri(metadata: MindMetadata): string {
  return `data:application/json;base64,${bytesToBase64(canonicalBytes(metadata))}`;
}
