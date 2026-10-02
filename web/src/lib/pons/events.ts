/**
 * Receipt decoding for Pons mode (viem `parseEventLogs`): `MindLaunched` from a `launchMind`
 * receipt (SPEC §9.5), with `MindCreated` as a fallback for the token address, and `MindAdopted`
 * from an `activateAdoption` receipt (SPEC §9.7; a takeover emits it without `MindCreated`).
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

/** Decoded `MindAdopted` (SPEC §9.7) plus whether the same receipt registered the mind (`MindCreated`). */
export interface MindAdoptedEvent {
  token: Address;
  account: Address;
  creator: Address;
  /** `false` = takeover of an existing mind (no `MindCreated` in the receipt). */
  created: boolean;
}

/** `MindAdopted` emitted by `registry` in `logs`, or `null`. */
export function mindAdoptedFromLogs(logs: readonly Log[], registry: Address): MindAdoptedEvent | null {
  const fromRegistry = (e: { address: Address }) => e.address.toLowerCase() === registry.toLowerCase();
  const adopted = parseEventLogs({ abi: ponsMindRegistryAbi, eventName: 'MindAdopted', logs: [...logs], strict: true }).find(fromRegistry);
  if (adopted === undefined) return null;
  const { token, account, creator } = adopted.args;
  const created = parseEventLogs({ abi: ponsMindRegistryAbi, eventName: 'MindCreated', logs: [...logs], strict: true }).some(
    (e) => fromRegistry(e) && e.args.token.toLowerCase() === token.toLowerCase(),
  );
  return { token: lower(token), account: lower(account), creator: lower(creator), created };
}
