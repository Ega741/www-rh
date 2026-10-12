/**
 * The SPL Memo grammar Beagle attaches to burns (SPEC §1, §3.2, §3.4, §4.1):
 *
 * - purchase: `beagle:v1 ws=<base58>` — credit another workspace than the token account owner;
 * - draw: `beagle:draw v1 ws=<base58> h=0x<64 hex>` — an operator budget draw, `h` is the
 *   `receiptHash` of the settled {@link DrawBatch}.
 *
 * Parsing is strict (exact token count, known version, valid 32-byte key, 32-byte hash) but
 * whitespace-tolerant (any whitespace run between tokens, leading / trailing whitespace); the
 * memo must be ≤ {@link MEMO_MAX_BYTES} UTF-8 bytes. Unknown versions and malformed memos parse
 * to `undefined`, which the indexer treats as "no memo" (credit goes to the owner).
 *
 * @module memo
 */
import { isBase58Pubkey } from './solana.js';

/** Maximum UTF-8 size of a memo Beagle honours (the Memo program itself allows more). */
export const MEMO_MAX_BYTES = 256;
/** Every Beagle memo starts with this. */
export const MEMO_PREFIX = 'beagle:';
/** First token of a purchase memo. */
export const PURCHASE_MEMO_TAG = 'beagle:v1';
/** First two tokens of a draw memo. */
export const DRAW_MEMO_TAG = 'beagle:draw';
export const MEMO_VERSION = 'v1';

/** `0x` + 64 lowercase hex characters (a `receiptHash`). */
export type HexHash32 = `0x${string}`;

/** A purchase memo: credit `workspace` instead of the token account owner. */
export interface PurchaseMemo {
  kind: 'purchase';
  workspace: string;
}
/** A draw memo: the operator settled `receiptHash` for `workspace`. */
export interface DrawMemo {
  kind: 'draw';
  workspace: string;
  receiptHash: HexHash32;
}
export type ParsedMemo = PurchaseMemo | DrawMemo;

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const encoder = new TextEncoder();

/** UTF-8 byte length of `text`. */
export function memoByteLength(text: string): number {
  return encoder.encode(text).length;
}

/** `true` when `text` (trimmed) starts with `beagle:` — the indexer honours the first such memo. */
export function isBeagleMemo(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.trimStart().startsWith(MEMO_PREFIX);
}

function assertWorkspace(workspace: string): string {
  if (!isBase58Pubkey(workspace)) throw new TypeError(`memo: workspace is not a base58 public key: ${JSON.stringify(workspace)}`);
  return workspace;
}

/** `beagle:v1 ws=<workspace>`. Throws when `workspace` is not a 32-byte base58 key. */
export function encodePurchaseMemo(input: { workspace: string }): string {
  return `${PURCHASE_MEMO_TAG} ws=${assertWorkspace(input.workspace)}`;
}

/**
 * `beagle:draw v1 ws=<workspace> h=0x<64 hex>` (hash lowercased). Throws when `workspace` is not
 * a 32-byte base58 key or `receiptHash` is not `0x` + 64 hex characters.
 */
export function encodeDrawMemo(input: { workspace: string; receiptHash: string }): string {
  const ws = assertWorkspace(input.workspace);
  if (!HASH_RE.test(input.receiptHash)) {
    throw new TypeError(`memo: receiptHash is not 0x + 64 hex characters: ${JSON.stringify(input.receiptHash)}`);
  }
  return `${DRAW_MEMO_TAG} ${MEMO_VERSION} ws=${ws} h=${input.receiptHash.toLowerCase()}`;
}

function keyValue(token: string, key: string): string | undefined {
  return token.startsWith(`${key}=`) ? token.slice(key.length + 1) : undefined;
}

/**
 * Parses a memo string. Returns `undefined` for anything that is not exactly a purchase or a draw
 * memo (wrong prefix, unknown version, extra / missing tokens, invalid key or hash, > 256 bytes).
 */
export function parseMemo(text: string | null | undefined): ParsedMemo | undefined {
  if (typeof text !== 'string') return undefined;
  if (memoByteLength(text) > MEMO_MAX_BYTES) return undefined;
  const tokens = text.trim().split(/\s+/);
  if (tokens[0] === PURCHASE_MEMO_TAG) {
    if (tokens.length !== 2) return undefined;
    const workspace = keyValue(tokens[1] as string, 'ws');
    if (workspace === undefined || !isBase58Pubkey(workspace)) return undefined;
    return { kind: 'purchase', workspace };
  }
  if (tokens[0] === DRAW_MEMO_TAG) {
    if (tokens.length !== 4 || tokens[1] !== MEMO_VERSION) return undefined;
    const workspace = keyValue(tokens[2] as string, 'ws');
    const hash = keyValue(tokens[3] as string, 'h');
    if (workspace === undefined || !isBase58Pubkey(workspace)) return undefined;
    if (hash === undefined || !HASH_RE.test(hash)) return undefined;
    return { kind: 'draw', workspace, receiptHash: hash.toLowerCase() as HexHash32 };
  }
  return undefined;
}
