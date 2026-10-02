/**
 * "Leave" input validation (SPEC §9.2 `registry.leave(token, newRecipient)`).
 *
 * @module lib/pons/leave
 */
import { isAddress, zeroAddress, type Address } from 'viem';

/** Validation message for the new creator-fee recipient, or `null` when it is acceptable. */
export function leaveRecipientError(input: string, account: Address | null): string | null {
  const text = input.trim();
  if (text === '') return 'Enter the address that should receive the creator fees from now on.';
  if (!isAddress(text, { strict: false })) return 'Not an address.';
  if (text.toLowerCase() === zeroAddress) return 'The zero address cannot receive fees.';
  if (account !== null && text.toLowerCase() === account.toLowerCase()) return 'That is the mind account itself.';
  return null;
}
