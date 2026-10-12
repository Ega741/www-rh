/**
 * Solana primitives shared by every package (SPEC §1, §4.1): base58 public-key / signature
 * validation (zod + predicates), the classic SPL Token account layout offsets the budget scanner
 * filters on, the burn instruction names the indexer matches, and small display helpers.
 *
 * Browser-safe: `bs58` and zod only, no `@solana/web3.js`.
 *
 * @module solana
 */
import bs58 from 'bs58';
import { z } from 'zod';
import { CLUSTER_NAMES } from './clusters.js';
import { DEFAULT_DECIMALS } from './credit.js';

export { DEFAULT_DECIMALS };

/** Bytes of an Ed25519 public key. */
export const PUBKEY_BYTES = 32;
/** Bytes of an Ed25519 signature (a transaction signature). */
export const SIGNATURE_BYTES = 64;
/** Base58 text length of a 32-byte key (SPEC §1). */
export const PUBKEY_MIN_CHARS = 32;
export const PUBKEY_MAX_CHARS = 44;
/**
 * Base58 text length bounds of a 64-byte signature. Real signatures are 87–88 characters (SPEC §1);
 * about 0.3 % come out at 86 and a leading zero byte adds a `1`, so the lower bound is loose and
 * the 64-byte decode check is what decides.
 */
export const SIGNATURE_MIN_CHARS = 64;
export const SIGNATURE_MAX_CHARS = 88;

/** The Bitcoin base58 alphabet (no `0`, `O`, `I`, `l`). */
export const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

/** Decodes base58 text; `undefined` when `text` is empty or has a character outside the alphabet. */
export function decodeBase58(text: string): Uint8Array | undefined {
  if (typeof text !== 'string' || text === '' || !BASE58_RE.test(text)) return undefined;
  return bs58.decode(text);
}

/** Encodes bytes as base58. */
export function encodeBase58(bytes: Uint8Array | readonly number[]): string {
  return bs58.encode(bytes as Uint8Array | number[]);
}

function decodesTo(text: unknown, bytes: number, minChars: number, maxChars: number): text is string {
  if (typeof text !== 'string' || text.length < minChars || text.length > maxChars) return false;
  const decoded = decodeBase58(text);
  return decoded !== undefined && decoded.length === bytes;
}

/** `true` when `value` is base58 text that decodes to exactly 32 bytes (a public key / address). */
export function isBase58Pubkey(value: unknown): value is string {
  return decodesTo(value, PUBKEY_BYTES, PUBKEY_MIN_CHARS, PUBKEY_MAX_CHARS);
}

/** `true` when `value` is base58 text that decodes to exactly 64 bytes (a transaction signature). */
export function isBase58Signature(value: unknown): value is string {
  return decodesTo(value, SIGNATURE_BYTES, SIGNATURE_MIN_CHARS, SIGNATURE_MAX_CHARS);
}

/** Base58 public key (32-byte decode check; case-sensitive, 32–44 chars). */
export const Base58PubkeySchema = z
  .string()
  .min(PUBKEY_MIN_CHARS)
  .max(PUBKEY_MAX_CHARS)
  .refine(isBase58Pubkey, { message: 'expected a base58 Solana public key (32 bytes)' });
export type Base58Pubkey = z.output<typeof Base58PubkeySchema>;

/** Base58 transaction signature (64-byte decode check; 87–88 chars). */
export const SignatureSchema = z
  .string()
  .min(SIGNATURE_MIN_CHARS)
  .max(SIGNATURE_MAX_CHARS)
  .refine(isBase58Signature, { message: 'expected a base58 transaction signature (64 bytes)' });

/** One of {@link CLUSTER_NAMES}. */
export const ClusterSchema = z.enum(CLUSTER_NAMES);

/**
 * Normalizes a public key given by a user (env var, form field): trims whitespace and validates.
 * Throws `TypeError` with `label` when the value is not a 32-byte base58 key.
 */
export function assertPubkey(value: unknown, label = 'public key'): string {
  const v = typeof value === 'string' ? value.trim() : value;
  if (!isBase58Pubkey(v)) throw new TypeError(`${label} is not a base58 Solana public key: ${JSON.stringify(value)}`);
  return v;
}

// ---------------------------------------------------------------------------------------------
// SPL Token account layout (classic Token program; Token-2022 accounts carry extensions and vary)

/** Byte size of a classic SPL Token account (`gPA` `dataSize` filter, SPEC §3.4). */
export const TOKEN_ACCOUNT_SIZE = 165;
/** `mint: Pubkey` at 0–32. */
export const TOKEN_ACCOUNT_MINT_OFFSET = 0;
/** `owner: Pubkey` at 32–64. */
export const TOKEN_ACCOUNT_OWNER_OFFSET = 32;
/** `amount: u64` at 64–72. */
export const TOKEN_ACCOUNT_AMOUNT_OFFSET = 64;
/** `delegate: COption<Pubkey>` tag (u32) at 72–76. */
export const TOKEN_ACCOUNT_DELEGATE_OPTION_OFFSET = 72;
/** `delegate` pubkey at 76–108 (the `memcmp` filter of the budget scan). */
export const TOKEN_ACCOUNT_DELEGATE_OFFSET = 76;
/** `state: u8` at 108. */
export const TOKEN_ACCOUNT_STATE_OFFSET = 108;
/** `is_native: COption<u64>` at 109–121. */
export const TOKEN_ACCOUNT_IS_NATIVE_OFFSET = 109;
/** `delegated_amount: u64` at 121–129. */
export const TOKEN_ACCOUNT_DELEGATED_AMOUNT_OFFSET = 121;
/** `close_authority: COption<Pubkey>` at 129–165. */
export const TOKEN_ACCOUNT_CLOSE_AUTHORITY_OFFSET = 129;

/** `parsed.type` values of a jsonParsed SPL Token burn (SPEC §5.4). */
export const BURN_INSTRUCTION_TYPES = ['burn', 'burnChecked'] as const;
export type BurnInstructionType = (typeof BURN_INSTRUCTION_TYPES)[number];
/** `true` for `'burn'` / `'burnChecked'`. */
export function isBurnInstructionType(value: unknown): value is BurnInstructionType {
  return typeof value === 'string' && (BURN_INSTRUCTION_TYPES as readonly string[]).includes(value);
}

/** jsonParsed `program` names of the two token programs. */
export const TOKEN_PROGRAM_PARSED_NAMES = ['spl-token', 'spl-token-2022'] as const;
/** jsonParsed `program` name of the Memo program. */
export const MEMO_PROGRAM_PARSED_NAME = 'spl-memo';

// ---------------------------------------------------------------------------------------------
// Display and ids

/**
 * `Abcd…wxyz`: the first and last `chars` (4) characters joined by an ellipsis (SPEC §1).
 * Strings no longer than `2 · chars + 1` are returned unchanged.
 */
export function shortAddress(address: string, chars = 4): string {
  if (!Number.isInteger(chars) || chars < 1) throw new RangeError('chars must be a positive integer');
  if (address.length <= chars * 2 + 1) return address;
  return `${address.slice(0, chars)}…${address.slice(-chars)}`;
}

/** Credit event id `<signature>:<ixIndex>` (SPEC §1). */
export function creditEventId(signature: string, ixIndex: number): string {
  if (!Number.isInteger(ixIndex) || ixIndex < 0) throw new RangeError(`ixIndex must be a non-negative integer (got ${ixIndex})`);
  return `${signature}:${ixIndex}`;
}

/** Splits a credit event id; `undefined` when it is not `<base58 signature>:<n>`. */
export function parseCreditEventId(id: string): { signature: string; ixIndex: number } | undefined {
  const m = /^([1-9A-HJ-NP-Za-km-z]{87,88}):(0|[1-9]\d*)$/.exec(id);
  if (!m || !isBase58Signature(m[1])) return undefined;
  const ixIndex = Number(m[2]);
  if (!Number.isSafeInteger(ixIndex)) return undefined;
  return { signature: m[1], ixIndex };
}
