/**
 * Hash helpers on top of the shared canonical JSON (SPEC §3.2).
 *
 * `canonicalJson` comes from `@www-rh/shared`. `keccakCanonical` hashes an arbitrary served JSON
 * object (used when a receipt does not match the shared schema, so the typed `drawReceiptHash`
 * cannot be applied); `utf8ByteLength` sizes the `data:` URI fallback.
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
