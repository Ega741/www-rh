/**
 * "Adopt an existing Pons coin" (SPEC §9.2 / §9.5) as a pure state machine over on-chain reads:
 *
 * 1. `prepareAdoption(token, modelId, personaHash, metadataURI)` — by the launch's current
 *    `creatorFeeRecipient` or its `deployer`; registers a Dormant mind and clones its account;
 * 2. `factory.transferCreatorFeeRecipient(token, account)` — by the current recipient (Pons);
 * 3. `activateAdoption(token)` — anyone, once the recipient is the mind account.
 *
 * {@link adoptionStep} derives the current step from `factory.getLaunchedToken(token)`,
 * `registry.ponsMind(token)` and the connected wallet, so the UI resumes correctly after a reload
 * or when the steps are sent from different wallets.
 *
 * @module lib/pons/adoption
 */
import { zeroAddress, type Address } from 'viem';

/** The fields of `factory.getLaunchedToken(token)` the adoption flow needs. */
export interface LaunchRecord {
  exists: boolean;
  curve: Address;
  deployer: Address;
  creatorFeeRecipient: Address;
}

/** `registry.ponsMind(token)`; `account == 0` means the token is not registered. */
export interface RegistryMindRecord {
  curve: Address;
  account: Address;
  launchedHere: boolean;
  adopted: boolean;
}

/** Inputs of {@link adoptionStep}. `undefined` = still loading, `null` = the read failed. */
export interface AdoptionInput {
  /** Connected wallet, if any. */
  wallet: Address | undefined;
  launch: LaunchRecord | null | undefined;
  mind: RegistryMindRecord | null | undefined;
  /** `registry.predictAdoptionAccount(token)` (shown before step 1), when known. */
  predictedAccount?: Address | undefined;
}

/** Where the adoption of one token stands. */
export type AdoptionStep =
  | { kind: 'loading' }
  | { kind: 'error' }
  /** The factory has no launch for this address. */
  | { kind: 'not-pons' }
  /** Already a mind launched through the registry. */
  | { kind: 'launched-here'; account: Address }
  /** Adoption complete; `receivingFees` is false after the creator left. */
  | { kind: 'adopted'; account: Address; receivingFees: boolean }
  /** Not registered and no wallet connected. */
  | { kind: 'connect' }
  /** Not registered; the wallet is neither the fee recipient nor the deployer. */
  | { kind: 'not-authorized'; recipient: Address; deployer: Address }
  /** Step 1: the wallet may call `prepareAdoption`. */
  | { kind: 'prepare'; predictedAccount: Address | null; walletIsRecipient: boolean }
  /** Step 2: the current recipient must hand the creator fees to the mind account. */
  | { kind: 'transfer'; account: Address; recipient: Address; walletIsRecipient: boolean }
  /** Step 3: anyone may call `activateAdoption`. */
  | { kind: 'activate'; account: Address };

function same(a: Address | undefined | null, b: Address | undefined | null): boolean {
  return a !== undefined && a !== null && b !== undefined && b !== null && a.toLowerCase() === b.toLowerCase();
}

/** Derives the adoption step (see module docs). */
export function adoptionStep(input: AdoptionInput): AdoptionStep {
  const { wallet, launch, mind } = input;
  if (launch === null || mind === null) return { kind: 'error' };
  if (launch === undefined) return { kind: 'loading' };
  if (!launch.exists) return { kind: 'not-pons' };
  if (mind === undefined) return { kind: 'loading' };
  const registered = mind.account.toLowerCase() !== zeroAddress;
  if (registered) {
    if (mind.launchedHere) return { kind: 'launched-here', account: mind.account };
    const receivingFees = same(launch.creatorFeeRecipient, mind.account);
    if (mind.adopted) return { kind: 'adopted', account: mind.account, receivingFees };
    if (receivingFees) return { kind: 'activate', account: mind.account };
    return { kind: 'transfer', account: mind.account, recipient: launch.creatorFeeRecipient, walletIsRecipient: same(wallet, launch.creatorFeeRecipient) };
  }
  if (wallet === undefined) return { kind: 'connect' };
  const walletIsRecipient = same(wallet, launch.creatorFeeRecipient);
  if (walletIsRecipient || same(wallet, launch.deployer)) {
    return { kind: 'prepare', predictedAccount: input.predictedAccount ?? null, walletIsRecipient };
  }
  return { kind: 'not-authorized', recipient: launch.creatorFeeRecipient, deployer: launch.deployer };
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
    case 'adopted':
    case 'launched-here':
      return 4;
    default:
      return 0;
  }
}
