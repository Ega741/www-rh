/**
 * Receipt decoding helpers (viem `parseEventLogs`).
 *
 * @module lib/events
 */
import { parseEventLogs, type Address, type Log } from 'viem';
import { mindLaunchpadAbi as launchpadAbi } from '@www-rh/shared';

/**
 * Token address from the `MindCreated` event emitted by `launchpad` in a `createMind` receipt
 * (directive W2), or `null` when absent.
 */
export function mindCreatedToken(logs: readonly Log[], launchpad: Address): Address | null {
  const events = parseEventLogs({ abi: launchpadAbi, eventName: 'MindCreated', logs: [...logs], strict: true });
  const match = events.find((e) => e.address.toLowerCase() === launchpad.toLowerCase());
  return match !== undefined ? (match.args.token.toLowerCase() as Address) : null;
}
