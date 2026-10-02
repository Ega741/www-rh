import { zeroAddress, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  activatablePreparation,
  adoptionStep,
  adoptionStepNumber,
  hasPreparation,
  mergePendingPreparations,
  pendingFromChain,
  sameAddress,
  type AdoptionInput,
  type LaunchRecord,
  type MindState,
  type PendingPreparation,
} from './adoption';

const CURVE = '0x1111111111111111111111111111111111111111' as Address;
const DEPLOYER = '0x22222222222222222222222222222222222222ab' as Address;
const RECIPIENT = '0x3333333333333333333333333333333333333333' as Address;
const MY_ACCOUNT = '0x4444444444444444444444444444444444444444' as Address;
const STRANGER = '0x5555555555555555555555555555555555555555' as Address;
const OTHER = '0x6666666666666666666666666666666666666666' as Address;
const OTHER_ACCOUNT = '0x7777777777777777777777777777777777777777' as Address;
const OLD_ACCOUNT = '0x8888888888888888888888888888888888888888' as Address;
const HASH = `0x${'ab'.repeat(32)}` as Hex;

const launch: LaunchRecord = { exists: true, curve: CURVE, deployer: DEPLOYER, creatorFeeRecipient: RECIPIENT, pairToken: zeroAddress, buybackEnabled: false };
const notMind: MindState = { isMind: false, account: zeroAddress, launchedHere: false, left: false };
const none = (preparer: Address): PendingPreparation => ({ preparer, account: zeroAddress, modelId: null, personaHash: null, metadataURI: null });
const prep = (preparer: Address, account: Address): PendingPreparation => ({ preparer, account, modelId: HASH, personaHash: HASH, metadataURI: 'runner://metadata/x' });
const to = (recipient: Address): LaunchRecord => ({ ...launch, creatorFeeRecipient: recipient });

/** `wallet` = the recipient, nothing prepared, not a mind. */
function input(over: Partial<AdoptionInput> = {}): AdoptionInput {
  return { wallet: RECIPIENT, launch, mind: notMind, mine: none(RECIPIENT), pending: [], ...over };
}

describe('adoption v2 state machine (SPEC §9.7)', () => {
  it('waits for reads, reports read errors and non-Pons tokens', () => {
    expect(adoptionStep(input({ launch: undefined })).kind).toBe('loading');
    expect(adoptionStep(input({ mind: undefined })).kind).toBe('loading');
    expect(adoptionStep(input({ mine: undefined })).kind).toBe('loading');
    expect(adoptionStep(input({ launch: null })).kind).toBe('error');
    expect(adoptionStep(input({ mind: null })).kind).toBe('error');
    expect(adoptionStep(input({ mine: null })).kind).toBe('error');
    expect(adoptionStep(input({ launch: { ...launch, exists: false }, mind: undefined })).kind).toBe('not-pons');
  });

  it('refuses ERC-20 quoted launches and launches with buyback enabled', () => {
    expect(adoptionStep(input({ launch: { ...launch, pairToken: STRANGER } }))).toEqual({ kind: 'unsupported-quote', pairToken: STRANGER });
    expect(adoptionStep(input({ launch: { ...launch, buybackEnabled: true } }))).toEqual({ kind: 'buyback-enabled' });
  });

  it('step 1: anyone may prepare their own preparation (the predicted account is shown)', () => {
    expect(adoptionStep(input({ predictedAccount: MY_ACCOUNT }))).toEqual({
      kind: 'prepare',
      predictedAccount: MY_ACCOUNT,
      recipient: RECIPIENT,
      walletIsRecipient: true,
      takeover: null,
    });
    // a wallet that is not the recipient may prepare too; the UI warns that the recipient must send step 2
    expect(adoptionStep(input({ wallet: STRANGER, mine: none(STRANGER) }))).toEqual({
      kind: 'prepare',
      predictedAccount: null,
      recipient: RECIPIENT,
      walletIsRecipient: false,
      takeover: null,
    });
    // the deployer is not special any more
    expect(adoptionStep(input({ wallet: DEPLOYER, mine: none(DEPLOYER) }))).toMatchObject({ kind: 'prepare', walletIsRecipient: false });
  });

  it('asks to connect when adoption is open and no preparation is ready', () => {
    expect(adoptionStep(input({ wallet: undefined, mine: undefined }))).toEqual({ kind: 'connect', takeover: null });
    // mine is ignored without a wallet
    expect(adoptionStep(input({ wallet: undefined, mine: null }))).toEqual({ kind: 'connect', takeover: null });
  });

  it('step 2: after prepareAdoption the current recipient must transfer to my account', () => {
    expect(adoptionStep(input({ mine: prep(RECIPIENT, MY_ACCOUNT) }))).toEqual({
      kind: 'transfer',
      account: MY_ACCOUNT,
      recipient: RECIPIENT,
      walletIsRecipient: true,
      takeover: null,
    });
    // prepared from a wallet that is not the recipient: the transfer button is disabled with a warning
    expect(adoptionStep(input({ wallet: STRANGER, mine: prep(STRANGER, MY_ACCOUNT) }))).toMatchObject({ kind: 'transfer', walletIsRecipient: false });
    expect(adoptionStep(input({ wallet: '0x3333333333333333333333333333333333333333', mine: prep(RECIPIENT, MY_ACCOUNT) }))).toMatchObject({ walletIsRecipient: true });
  });

  it('a pending preparation of someone else does not capture my flow unless it is the recipient', () => {
    const pending = [prep(OTHER, OTHER_ACCOUNT)];
    expect(adoptionStep(input({ pending })).kind).toBe('prepare');
    expect(adoptionStep(input({ pending, mine: prep(RECIPIENT, MY_ACCOUNT) })).kind).toBe('transfer');
  });

  it('step 3: once my account is the recipient anyone may activate it', () => {
    const transferred = to(MY_ACCOUNT);
    expect(adoptionStep(input({ wallet: STRANGER, launch: transferred, mine: prep(STRANGER, MY_ACCOUNT) }))).toEqual({
      kind: 'activate',
      preparer: STRANGER,
      account: MY_ACCOUNT,
      mine: true,
      takeover: null,
    });
  });

  it('step 3: activation is offered for any pending preparation whose account is the recipient (permissionless)', () => {
    const transferred = to(OTHER_ACCOUNT);
    const pending = [prep(OTHER, OTHER_ACCOUNT)];
    const expected = { kind: 'activate', preparer: OTHER, account: OTHER_ACCOUNT, mine: false, takeover: null };
    expect(adoptionStep(input({ wallet: STRANGER, launch: transferred, mine: none(STRANGER), pending }))).toEqual(expected);
    // even while my own preparation is pending, and without a wallet or while mine is loading
    expect(adoptionStep(input({ wallet: STRANGER, launch: transferred, mine: prep(STRANGER, MY_ACCOUNT), pending }))).toEqual(expected);
    expect(adoptionStep(input({ wallet: undefined, launch: transferred, mine: undefined, pending }))).toEqual(expected);
    expect(adoptionStep(input({ wallet: STRANGER, launch: transferred, mine: undefined, pending }))).toEqual(expected);
  });

  it('done: a mind whose account still receives the fees cannot be adopted (AlreadyAdopted)', () => {
    const adopted: MindState = { isMind: true, account: OLD_ACCOUNT, launchedHere: false, left: false };
    expect(adoptionStep(input({ launch: to(OLD_ACCOUNT), mind: adopted }))).toEqual({ kind: 'active', account: OLD_ACCOUNT, launchedHere: false, left: false });
    expect(adoptionStep(input({ launch: to(OLD_ACCOUNT), mind: { ...adopted, launchedHere: true }, mine: undefined }))).toMatchObject({ kind: 'active', launchedHere: true });
    // checked before the quote / buyback guards (an existing mind is shown as such)
    expect(adoptionStep(input({ launch: { ...to(OLD_ACCOUNT), buybackEnabled: true }, mind: adopted })).kind).toBe('active');
    // left, but the new recipient handed the fees back to the old account: still not adoptable
    expect(adoptionStep(input({ launch: to(OLD_ACCOUNT), mind: { ...adopted, left: true } }))).toMatchObject({ kind: 'active', left: true });
  });

  it('takeover: a mind whose creator left can be adopted again (reason "left")', () => {
    const left: MindState = { isMind: true, account: OLD_ACCOUNT, launchedHere: true, left: true };
    expect(adoptionStep(input({ mind: left }))).toMatchObject({ kind: 'prepare', takeover: 'left' });
    expect(adoptionStep(input({ mind: left, mine: prep(RECIPIENT, MY_ACCOUNT) }))).toMatchObject({ kind: 'transfer', takeover: 'left' });
    expect(adoptionStep(input({ mind: left, launch: to(MY_ACCOUNT), mine: prep(RECIPIENT, MY_ACCOUNT) }))).toMatchObject({ kind: 'activate', takeover: 'left', mine: true });
    expect(adoptionStep(input({ mind: left, wallet: undefined }))).toEqual({ kind: 'connect', takeover: 'left' });
  });

  it('takeover: a mind whose recipient was moved elsewhere (not left) can be adopted again', () => {
    const moved: MindState = { isMind: true, account: OLD_ACCOUNT, launchedHere: false, left: false };
    expect(adoptionStep(input({ mind: moved }))).toMatchObject({ kind: 'prepare', takeover: 'recipient-moved' });
    expect(adoptionStep(input({ mind: { ...moved, left: null } }))).toMatchObject({ takeover: 'recipient-moved' });
  });

  it('numbers the stepper', () => {
    expect(adoptionStepNumber({ kind: 'prepare', predictedAccount: null, recipient: RECIPIENT, walletIsRecipient: true, takeover: null })).toBe(1);
    expect(adoptionStepNumber({ kind: 'transfer', account: MY_ACCOUNT, recipient: RECIPIENT, walletIsRecipient: false, takeover: null })).toBe(2);
    expect(adoptionStepNumber({ kind: 'activate', preparer: OTHER, account: MY_ACCOUNT, mine: false, takeover: 'left' })).toBe(3);
    expect(adoptionStepNumber({ kind: 'active', account: MY_ACCOUNT, launchedHere: false, left: false })).toBe(4);
    expect(adoptionStepNumber({ kind: 'not-pons' })).toBe(0);
    expect(adoptionStepNumber({ kind: 'buyback-enabled' })).toBe(0);
  });
});

describe('pending preparations helpers', () => {
  it('decodes pendingAdoption and detects live preparations', () => {
    const p = pendingFromChain('0x6666666666666666666666666666666666666666', ['0x7777777777777777777777777777777777777777', HASH, HASH, 'uri']);
    expect(p).toEqual({ preparer: OTHER, account: OTHER_ACCOUNT, modelId: HASH, personaHash: HASH, metadataURI: 'uri' });
    expect(hasPreparation(p)).toBe(true);
    expect(hasPreparation(none(OTHER))).toBe(false);
    expect(hasPreparation(undefined)).toBe(false);
    expect(hasPreparation(null)).toBe(false);
    expect(sameAddress(RECIPIENT, '0x3333333333333333333333333333333333333333')).toBe(true);
    expect(sameAddress(RECIPIENT, undefined)).toBe(false);
  });

  it('merges the runner list with chain reads: chain wins, stale entries drop, mine is added once', () => {
    const api = [prep(OTHER, OTHER_ACCOUNT), prep(STRANGER, MY_ACCOUNT), prep(DEPLOYER, OLD_ACCOUNT)];
    const updated = { ...prep(OTHER, OTHER_ACCOUNT), metadataURI: 'runner://metadata/new' };
    // OTHER updated on chain, STRANGER not read yet, DEPLOYER activated / gone
    expect(mergePendingPreparations(api, [updated, undefined, none(DEPLOYER)])).toEqual([updated, prep(STRANGER, MY_ACCOUNT)]);
    const mine = prep(RECIPIENT, '0x9999999999999999999999999999999999999999');
    expect(mergePendingPreparations(api.slice(0, 1), [], mine)).toEqual([prep(OTHER, OTHER_ACCOUNT), mine]);
    // my chain record replaces my (possibly stale) runner entry
    expect(mergePendingPreparations([prep(RECIPIENT, MY_ACCOUNT)], [undefined], mine)).toEqual([mine]);
    expect(mergePendingPreparations([], [], none(RECIPIENT))).toEqual([]);
    // duplicates from the runner are collapsed
    expect(mergePendingPreparations([prep(OTHER, OTHER_ACCOUNT), prep(OTHER, OTHER_ACCOUNT)], [])).toHaveLength(1);
  });

  it('finds the activatable preparation, preferring the wallet', () => {
    const list = [prep(OTHER, RECIPIENT), prep(STRANGER, MY_ACCOUNT)];
    expect(activatablePreparation(list, RECIPIENT, undefined)?.preparer).toBe(OTHER);
    expect(activatablePreparation(list, MY_ACCOUNT, STRANGER)?.preparer).toBe(STRANGER);
    expect(activatablePreparation(list, OLD_ACCOUNT, STRANGER)).toBeNull();
    expect(activatablePreparation([none(OTHER)], zeroAddress, undefined)).toBeNull();
  });
});
