/**
 * "Leave" input validation (SPEC §9.7 `registry.leave(token, newRecipient)`): the new creator-fee
 * recipient must not be zero, the registry, or any mind account (`InvalidRecipient()`). The last
 * check needs `registry.tokenOf(recipient)` (non-zero = the address is a mind account), read by
 * the caller and passed in.
 *
 * @module lib/pons/leave
 */
import { isAddress, zeroAddress, type Address } from 'viem';

/** What the caller knows about the candidate recipient. */
export interface LeaveRecipientContext {
  /** This mind's account. */
  account: Address | null;
  /** The `PonsMindRegistry`. */
  registry: Address | null;
  /**
   * `registry.tokenOf(recipient)` for the candidate: zero = not a mind account, another address =
   * the account of that mind, `undefined` = not read yet, `null` = the read failed.
   */
  recipientTokenOf: Address | null | undefined;
}

/** Outcome of {@link checkLeaveRecipient}. */
export type LeaveRecipientCheck =
  | { status: 'ok'; recipient: Address; /** Set when the mind-account check could not be read. */ warning: string | null }
  | { status: 'invalid'; message: string }
  /** The address is well-formed; waiting for `tokenOf`. */
  | { status: 'checking'; recipient: Address };

/** The address `input` names, lower-cased, when it is syntactically valid; else `null`. */
export function parseRecipient(input: string): Address | null {
  const text = input.trim();
  return isAddress(text, { strict: false }) ? (text.toLowerCase() as Address) : null;
}

/** Validates the new creator-fee recipient (see module docs). */
export function checkLeaveRecipient(input: string, ctx: LeaveRecipientContext): LeaveRecipientCheck {
  const text = input.trim();
  if (text === '') return { status: 'invalid', message: 'Enter the address that should receive the creator fees from now on.' };
  const recipient = parseRecipient(text);
  if (recipient === null) return { status: 'invalid', message: 'Not an address.' };
  if (recipient === zeroAddress) return { status: 'invalid', message: 'The zero address cannot receive fees.' };
  if (ctx.account !== null && recipient === ctx.account.toLowerCase()) return { status: 'invalid', message: 'That is the mind account itself.' };
  if (ctx.registry !== null && recipient === ctx.registry.toLowerCase()) {
    return { status: 'invalid', message: 'That is the registry: fees sent there would be stuck. Use a wallet you control.' };
  }
  if (ctx.recipientTokenOf === undefined) return { status: 'checking', recipient };
  if (ctx.recipientTokenOf === null) {
    return { status: 'ok', recipient, warning: 'Could not check whether this address is a mind account; the registry rejects mind accounts.' };
  }
  if (ctx.recipientTokenOf.toLowerCase() !== zeroAddress) {
    return { status: 'invalid', message: `That address is the account of another mind (${ctx.recipientTokenOf}). Use a wallet you control.` };
  }
  return { status: 'ok', recipient, warning: null };
}
