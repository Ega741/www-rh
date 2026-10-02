/**
 * Client-side verification of compute draw receipts (R2 / W6): re-hash the canonical receipt
 * object served by the runner and compare with the `receiptHash` that was anchored on-chain
 * in `ComputeDrawn`.
 *
 * @module lib/receipts
 */
import { keccakCanonical } from './canonical';
import type { ComputeReceipt } from './types';

/** Outcome of {@link verifyReceipt}. */
export type ReceiptVerification = 'verified' | 'mismatch' | 'unverifiable';

/** `keccak256(canonicalJSON(receipt.object)) === receiptHash`? */
export function verifyReceipt(receipt: ComputeReceipt): ReceiptVerification {
  if (receipt.object === null) return 'unverifiable';
  try {
    return keccakCanonical(receipt.object).toLowerCase() === receipt.receiptHash.toLowerCase() ? 'verified' : 'mismatch';
  } catch {
    return 'unverifiable';
  }
}
