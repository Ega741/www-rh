/**
 * Lifecycle of a Pons mind after launch / adoption (SPEC §9.7): whether its account still receives
 * the coin's creator fees, and if not, why (the creator left, or the recipient was moved). A mind
 * in either non-receiving state can be taken over with `activateAdoption`.
 *
 * @module lib/pons/lifecycle
 */
import type { Address } from 'viem';
import type { PonsInfo } from '../types';
import { sameAddress } from './adoption';

/** `left` / `recipient-moved` = takeover possible; `receiving` = the account gets the fees; `unknown` = recipient not read. */
export type PonsLifecycle = 'receiving' | 'left' | 'recipient-moved' | 'unknown';

/**
 * Lifecycle from the mind's Pons info, the live `hasLeft` read (`null` = unknown, falls back to
 * `pons.left`) and the factory's current `creatorFeeRecipient` (`null` = not read).
 */
export function ponsLifecycle(pons: Pick<PonsInfo, 'account' | 'left' | 'adopted' | 'launchedHere'>, left: boolean | null, recipient: Address | null): PonsLifecycle {
  if (left ?? pons.left) return 'left';
  if (recipient === null) return 'unknown';
  if (sameAddress(recipient, pons.account)) return 'receiving';
  // a pre-§9.7 preparation registered before activation never received the fees: not a takeover
  return pons.adopted || pons.launchedHere ? 'recipient-moved' : 'unknown';
}
