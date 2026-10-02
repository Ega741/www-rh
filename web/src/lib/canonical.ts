/**
 * Hash helpers on top of the shared canonical JSON (SPEC §3.2).
 *
 * `canonicalJson` comes from `@www-rh/shared`. LOCAL FALLBACKS (to be replaced by the SPEC-named
 * shared exports once published): `keccakCanonical` (≙ `drawReceiptHash` / `anchorBatchHash`)
 * and `utf8ByteLength`.
 *
 * @module lib/canonical
 */
import { canonicalJson, type CanonicalValue } from '@www-rh/shared';
import { keccak256, toBytes, type Hex } from 'viem';

export { canonicalJson, type CanonicalValue };

/** UTF-8 byte length of `text`. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** `keccak256(utf8(canonicalJson(value)))`. */
export function keccakCanonical(value: CanonicalValue): Hex {
  return keccak256(toBytes(canonicalJson(value)));
}
