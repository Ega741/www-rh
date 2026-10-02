/**
 * Canonical JSON and every hash / URI built on it (`docs/SPEC.md` §3.2). Pure and isomorphic
 * (viem only, no Node built-ins) so the runner, the web app and third parties compute byte-identical
 * hashes.
 *
 * `canonicalJson`: object keys sorted by Unicode code point, no whitespace, `undefined` members
 * omitted; arrays in order; strings escaped exactly like `JSON.stringify`; numbers must be safe
 * integers; bigints become decimal JSON strings; the result is hashed as UTF-8 bytes.
 *
 * @module canonical
 */
import { keccak256, sha256, toBytes, type Hex } from 'viem';
import type { AnchorBatch, AnchorMemoryItem, DrawReceiptObject, MindMetadata } from './types.js';

/** Maximum size of a `POST /api/metadata` body. */
export const MAX_METADATA_JSON_BYTES = 32_768;
/** Maximum `metadataURI` length accepted by the contract (`MetadataTooLong()` above). */
export const MAX_METADATA_URI_BYTES = 2_048;

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
function compareCodePoints(a: string, b: string): number {
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
      if (!Number.isSafeInteger(value)) throw new TypeError(`canonicalJson: ${value} at ${path} is not a safe integer`);
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
 * Serialises `value` as canonical JSON — the only serialization used under a hash.
 *
 * @throws TypeError on non-safe-integer numbers, functions, symbols, class instances or
 *   `undefined` array elements.
 */
export function canonicalJson(value: CanonicalValue): string {
  const out: string[] = [];
  serialize(value, '$', out);
  return out.join('');
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 (with padding), environment-independent. */
function base64(bytes: Uint8Array): string {
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
 * `sha256(utf8(canonicalJson(meta)))` as 64 lowercase hex characters **without** `0x` —
 * the `<hash>` of `runner://metadata/<hash>`.
 */
export function metadataHash(meta: MindMetadata): string {
  return sha256(toBytes(canonicalJson(meta))).slice(2);
}

/** `runner://metadata/<hash>` */
export function metadataUri(hash: string): string {
  return `runner://metadata/${hash}`;
}

/**
 * `data:application/json;base64,<base64(utf8(canonicalJson(meta)))>` — the metadata URI fallback
 * when the runner is unreachable.
 */
export function metadataDataUri(meta: MindMetadata): string {
  return `data:application/json;base64,${base64(toBytes(canonicalJson(meta)))}`;
}

/** `keccak256(toBytes(persona))` — UTF-8 bytes of the exact string (no trimming or normalization). */
export function personaHash(persona: string): Hex {
  return keccak256(toBytes(persona));
}

/** `keccak256(utf8(canonicalJson({ seq, kind, content, url, createdAt })))` — `Memory.contentHash`. */
export function memoryContentHash(item: AnchorMemoryItem): Hex {
  return keccak256(toBytes(canonicalJson({ seq: item.seq, kind: item.kind, content: item.content, url: item.url, createdAt: item.createdAt })));
}

/** `keccak256(utf8(canonicalJson(batch)))` — the `contentHash` passed to `anchorMemory`. */
export function anchorBatchHash(batch: AnchorBatch): Hex {
  return keccak256(
    toBytes(
      canonicalJson({
        token: batch.token,
        fromSeq: batch.fromSeq,
        toSeq: batch.toSeq,
        memories: batch.memories.map((m) => ({ seq: m.seq, kind: m.kind, content: m.content, url: m.url, createdAt: m.createdAt })),
      }),
    ),
  );
}

/** `runner://memories/<token>/<fromSeq>-<toSeq>` (token lowercase). */
export function anchorBatchUri(token: string, fromSeq: number, toSeq: number): string {
  return `runner://memories/${token.toLowerCase()}/${fromSeq}-${toSeq}`;
}

/** `keccak256(utf8(canonicalJson(receipt)))` — the `receiptHash` passed to `drawCompute`. */
export function drawReceiptHash(receipt: DrawReceiptObject): Hex {
  return keccak256(
    toBytes(
      canonicalJson({
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
      }),
    ),
  );
}
