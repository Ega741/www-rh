/**
 * Receipt decoding for Pons mode (viem `parseEventLogs`): `MindLaunched` from a `launchMind`
 * receipt (SPEC §9.5), with `MindCreated` as a fallback for the token address.
 *
 * @module lib/pons/events
 */
import { parseEventLogs, type Address, type Log } from 'viem';
import { ponsMindRegistryAbi } from './abi';

/** Decoded `MindLaunched` event. */
export interface MindLaunchedEvent {
  token: Address;
  curve: Address;
  account: Address;
  creator: Address;
  launchConfigId: bigint;
}

function lower(a: Address): Address {
  return a.toLowerCase() as Address;
}

/** `MindLaunched` emitted by `registry` in `logs`, or `null`. */
export function mindLaunchedFromLogs(logs: readonly Log[], registry: Address): MindLaunchedEvent | null {
  const events = parseEventLogs({ abi: ponsMindRegistryAbi, eventName: 'MindLaunched', logs: [...logs], strict: true });
  const match = events.find((e) => e.address.toLowerCase() === registry.toLowerCase());
  if (match === undefined) return null;
  const { token, curve, account, creator, launchConfigId } = match.args;
  return { token: lower(token), curve: lower(curve), account: lower(account), creator: lower(creator), launchConfigId };
}

/** Token of the launched mind: `MindLaunched.token`, else `MindCreated.token` from `registry`, else `null`. */
export function launchedTokenFromLogs(logs: readonly Log[], registry: Address): Address | null {
  const launched = mindLaunchedFromLogs(logs, registry);
  if (launched !== null) return launched.token;
  const created = parseEventLogs({ abi: ponsMindRegistryAbi, eventName: 'MindCreated', logs: [...logs], strict: true }).find(
    (e) => e.address.toLowerCase() === registry.toLowerCase(),
  );
  return created !== undefined ? lower(created.args.token) : null;
}
