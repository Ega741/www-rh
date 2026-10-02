/**
 * Client-side verification of compute draw receipts (R2 / W6, SPEC §3.2): re-hash the receipt
 * object served by the runner and compare it with the `receiptHash` passed to `drawCompute`.
 *
 * @module lib/receipts
 */
import { drawReceiptHash, drawReceiptObjectSchema } from '@www-rh/shared';
import { keccakCanonical } from './canonical';
import type { ComputeReceipt } from './types';

/** Outcome of {@link verifyReceipt}. */
export type ReceiptVerification = 'verified' | 'mismatch' | 'unverifiable';

/**
 * `drawReceiptHash(receipt.object) === receiptHash`? Objects that do not match the shared
 * `DrawReceiptObject` schema are hashed as served (canonical JSON), which is what the runner
 * hashes for a well-formed object as well.
 */
export function verifyReceipt(receipt: ComputeReceipt): ReceiptVerification {
  if (receipt.object === null) return 'unverifiable';
  try {
    const parsed = drawReceiptObjectSchema.safeParse(receipt.object);
    const hash = parsed.success ? drawReceiptHash(parsed.data) : keccakCanonical(receipt.object);
    return hash.toLowerCase() === receipt.receiptHash.toLowerCase() ? 'verified' : 'mismatch';
  } catch {
    return 'unverifiable';
  }
}
