/**
 * "Recover tokens" input validation (SPEC §9.7 `registry.recoverAccountTokens(token, erc20)`:
 * creator only; moves the mind account's whole balance of `erc20` to the creator; ETH never leaves
 * this way).
 *
 * @module lib/pons/recover
 */
import { zeroAddress, type Address } from 'viem';
import { parseRecipient } from './leave';

/** Outcome of {@link checkRecoverToken}; `message: null` = nothing typed yet. */
export type RecoverTokenCheck = { ok: true; erc20: Address } | { ok: false; message: string | null };

/** Validates the ERC-20 address to recover from the mind account. */
export function checkRecoverToken(input: string): RecoverTokenCheck {
  if (input.trim() === '') return { ok: false, message: null };
  const erc20 = parseRecipient(input);
  if (erc20 === null) return { ok: false, message: 'Not an address.' };
  if (erc20 === zeroAddress) return { ok: false, message: 'The zero address is not a token. ETH cannot be recovered: it only pays for compute.' };
  return { ok: true, erc20 };
}

/** Whether there is something to recover: `true` while the balance is unknown (let the registry decide). */
export function canRecover(balance: bigint | null | undefined): boolean {
  return balance === null || balance === undefined || balance > 0n;
}
