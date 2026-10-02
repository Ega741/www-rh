/**
 * "Adopt an existing Pons coin" (SPEC §9.7, adoption v2) as a pure state machine over on-chain
 * reads. Every preparation is bound to its preparer:
 *
 * 1. `prepareAdoption(token, modelId, personaHash, metadataURI)` — anyone; creates (or updates) the
 *    caller's own preparation `pendingAdoptions[token][caller]` and deploys its account
 *    (`predictAdoptionAccount(token, caller)`); nothing is registered yet;
 * 2. `factory.transferCreatorFeeRecipient(token, account)` — by the launch's current recipient;
 * 3. `activateAdoption(token, preparer)` — anyone, once the factory's recipient is that
 *    preparation's account; registers the mind, or **takes over** an existing mind whose account no
 *    longer receives the fees (its creator left, or the recipient was moved).
 *
 * {@link adoptionStep} derives the current step from the launch record, the connected wallet's
 * pending preparation, whether the token is a mind (and whether its creator left) and whether the
 * mind's account is still the recipient, so the UI resumes after a reload or across wallets. Other
 * people's pending preparations (served by the runner, verified on chain) only matter when their
 * account already is the recipient: activation is permissionless, so anyone may finish it.
 *
 * @module lib/pons/adoption
 */
import { zeroAddress, type Address, type Hex } from 'viem';
import type { PendingAdoption } from '../types';

/** The fields of `factory.getLaunchedToken(token)` the adoption flow needs. */
export interface LaunchRecord {
  exists: boolean;
  curve: Address;
  deployer: Address;
  creatorFeeRecipient: Address;
  /** Quote asset of the launch; minds need native ETH (`0x0`), else `prepareAdoption` reverts `NotPonsLaunch`. */
  pairToken: Address;
  /** Launches with buyback enabled are rejected (`BuybackEnabledLaunch`). */
  buybackEnabled: boolean;
}

/**
 * One pending preparation `pendingAdoptions[token][preparer]` (chain read or runner list entry);
 * `account == 0` means none.
 */
export type PendingPreparation = PendingAdoption;

/** The registry's view of the token as a mind. */
export interface MindState {
  /** `registry.isMind(token)`. */
  isMind: boolean;
  /** `registry.ponsMind(token).account` (zero when not a mind). */
  account: Address;
  launchedHere: boolean;
  /** `registry.hasLeft(token)` / `MindDetail.pons.left`; `null` = unknown. */
  left: boolean | null;
}

/** Inputs of {@link adoptionStep}. `undefined` = still loading, `null` = the read failed. */
export interface AdoptionInput {
  /** Connected wallet, if any. */
  wallet: Address | undefined;
  launch: LaunchRecord | null | undefined;
  mind: MindState | null | undefined;
  /** `registry.pendingAdoption(token, wallet)`; ignored without a wallet. */
  mine: PendingPreparation | null | undefined;
  /** Everybody's pending preparations (runner list, verified on chain); may include `mine`. */
  pending?: readonly PendingPreparation[] | null | undefined;
  /** `registry.predictAdoptionAccount(token, wallet)`, shown before step 1. */
  predictedAccount?: Address | undefined;
}

/** Why an existing mind can be adopted again (SPEC §9.7 takeover). */
export type TakeoverReason = 'left' | 'recipient-moved';

/** Where the adoption of one token stands. */
export type AdoptionStep =
  | { kind: 'loading' }
  | { kind: 'error' }
  /** The factory has no launch for this address. */
  | { kind: 'not-pons' }
  /** A Pons launch quoted in an ERC-20: not supported by the registry (native quote only). */
  | { kind: 'unsupported-quote'; pairToken: Address }
  /** A launch with buyback enabled (`BuybackEnabledLaunch`). */
  | { kind: 'buyback-enabled' }
  /** The token is a mind whose account still receives the fees: nothing to adopt (`AlreadyAdopted`). */
  | { kind: 'active'; account: Address; launchedHere: boolean; left: boolean }
  /** Adoption is open but no wallet is connected (and no preparation is ready to activate). */
  | { kind: 'connect'; takeover: TakeoverReason | null }
  /** Step 1: the wallet has no preparation yet. */
  | { kind: 'prepare'; predictedAccount: Address | null; recipient: Address; walletIsRecipient: boolean; takeover: TakeoverReason | null }
  /** Step 2: the wallet prepared; the current recipient must hand the creator fees to its account. */
  | { kind: 'transfer'; account: Address; recipient: Address; walletIsRecipient: boolean; takeover: TakeoverReason | null }
  /** Step 3: a preparation's account is the recipient; anyone may call `activateAdoption(token, preparer)`. */
  | { kind: 'activate'; preparer: Address; account: Address; mine: boolean; takeover: TakeoverReason | null };

/** Case-insensitive address equality; `false` when either side is missing. */
export function sameAddress(a: Address | undefined | null, b: Address | undefined | null): boolean {
  return a !== undefined && a !== null && b !== undefined && b !== null && a.toLowerCase() === b.toLowerCase();
}

function isZero(a: Address): boolean {
  return a.toLowerCase() === zeroAddress;
}

/** Whether `p` is a live preparation (non-zero account). */
export function hasPreparation(p: PendingPreparation | null | undefined): p is PendingPreparation {
  return p !== null && p !== undefined && !isZero(p.account);
}

/** Decodes `registry.pendingAdoption(token, preparer)` (`[account, modelId, personaHash, metadataURI]`). */
export function pendingFromChain(preparer: Address, result: readonly [Address, Hex, Hex, string]): PendingPreparation {
  const [account, modelId, personaHash, metadataURI] = result;
  return { preparer: preparer.toLowerCase() as Address, account: account.toLowerCase() as Address, modelId, personaHash, metadataURI };
}

/**
 * The runner's pending list checked against the chain. `chain[i]` is the decoded
 * `pendingAdoption(token, api[i].preparer)`: `undefined` = not read (keep the runner's entry), a
 * record with a zero account = no longer pending (activated or never prepared; dropped), otherwise
 * the chain record wins. `mine` (the wallet's own chain read) is added when missing. Deduplicated by
 * preparer; order: the runner's, then `mine`.
 */
export function mergePendingPreparations(
  api: readonly PendingPreparation[],
  chain: readonly (PendingPreparation | null | undefined)[],
  mine?: PendingPreparation | null,
): PendingPreparation[] {
  const out: PendingPreparation[] = [];
  const seen = new Set<string>();
  const push = (p: PendingPreparation) => {
    const key = p.preparer.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (!isZero(p.account)) out.push(p);
  };
  const own = hasPreparation(mine) ? mine : null;
  api.forEach((entry, i) => {
    const read = chain[i];
    if (own !== null && sameAddress(entry.preparer, own.preparer)) push(own);
    else push(read === undefined || read === null ? entry : read);
  });
  if (own !== null) push(own);
  return out;
}

/** The preparation whose account is `recipient` (the wallet's own first), or `null`. */
export function activatablePreparation(
  pending: readonly PendingPreparation[],
  recipient: Address,
  wallet: Address | undefined,
): PendingPreparation | null {
  const ready = pending.filter((p) => hasPreparation(p) && sameAddress(p.account, recipient));
  return ready.find((p) => sameAddress(p.preparer, wallet)) ?? ready[0] ?? null;
}

/** Derives the adoption step (see module docs). */
export function adoptionStep(input: AdoptionInput): AdoptionStep {
  const { wallet, launch, mind } = input;
  if (launch === null || mind === null) return { kind: 'error' };
  if (launch === undefined) return { kind: 'loading' };
  if (!launch.exists) return { kind: 'not-pons' };
  if (mind === undefined) return { kind: 'loading' };
  const recipient = launch.creatorFeeRecipient;
  if (mind.isMind && sameAddress(mind.account, recipient)) {
    return { kind: 'active', account: mind.account, launchedHere: mind.launchedHere, left: mind.left === true };
  }
  if (!isZero(launch.pairToken)) return { kind: 'unsupported-quote', pairToken: launch.pairToken };
  if (launch.buybackEnabled) return { kind: 'buyback-enabled' };
  const takeover: TakeoverReason | null = mind.isMind ? (mind.left === true ? 'left' : 'recipient-moved') : null;

  const mine = wallet !== undefined ? input.mine : undefined;
  if (wallet !== undefined && mine === null) return { kind: 'error' };
  const candidates = [...(hasPreparation(mine) ? [mine] : []), ...(input.pending ?? [])];
  const ready = activatablePreparation(candidates, recipient, wallet);
  if (ready !== null) return { kind: 'activate', preparer: ready.preparer, account: ready.account, mine: sameAddress(ready.preparer, wallet), takeover };

  if (wallet === undefined) return { kind: 'connect', takeover };
  if (mine === undefined) return { kind: 'loading' };
  const walletIsRecipient = sameAddress(wallet, recipient);
  if (hasPreparation(mine)) return { kind: 'transfer', account: mine.account, recipient, walletIsRecipient, takeover };
  return { kind: 'prepare', predictedAccount: input.predictedAccount ?? null, recipient, walletIsRecipient, takeover };
}

/** 1-based position of a step in the 3-step stepper (4 = done, 0 = not applicable). */
export function adoptionStepNumber(step: AdoptionStep): 0 | 1 | 2 | 3 | 4 {
  switch (step.kind) {
    case 'prepare':
      return 1;
    case 'transfer':
      return 2;
    case 'activate':
      return 3;
    case 'active':
      return 4;
    default:
      return 0;
  }
}
