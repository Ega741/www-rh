import { zeroAddress, type Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { adoptionStep, adoptionStepNumber, type LaunchRecord, type RegistryMindRecord } from './adoption';

const CURVE = '0x1111111111111111111111111111111111111111' as Address;
const DEPLOYER = '0x22222222222222222222222222222222222222ab' as Address;
const RECIPIENT = '0x3333333333333333333333333333333333333333' as Address;
const ACCOUNT = '0x4444444444444444444444444444444444444444' as Address;
const STRANGER = '0x5555555555555555555555555555555555555555' as Address;

const launch: LaunchRecord = { exists: true, curve: CURVE, deployer: DEPLOYER, creatorFeeRecipient: RECIPIENT, pairToken: zeroAddress };
const unregistered: RegistryMindRecord = { curve: zeroAddress, account: zeroAddress, launchedHere: false, adopted: false };
const prepared: RegistryMindRecord = { curve: CURVE, account: ACCOUNT, launchedHere: false, adopted: false };

describe('adoption state machine (SPEC §9.2/§9.5)', () => {
  it('waits for both reads, reports read errors and non-Pons tokens', () => {
    expect(adoptionStep({ wallet: RECIPIENT, launch: undefined, mind: unregistered }).kind).toBe('loading');
    expect(adoptionStep({ wallet: RECIPIENT, launch, mind: undefined }).kind).toBe('loading');
    expect(adoptionStep({ wallet: RECIPIENT, launch: null, mind: unregistered }).kind).toBe('error');
    expect(adoptionStep({ wallet: RECIPIENT, launch: { ...launch, exists: false }, mind: undefined }).kind).toBe('not-pons');
  });

  it('step 1: the fee recipient or the deployer may prepare; others may not', () => {
    expect(adoptionStep({ wallet: undefined, launch, mind: unregistered }).kind).toBe('connect');
    expect(adoptionStep({ wallet: RECIPIENT, launch, mind: unregistered, predictedAccount: ACCOUNT })).toEqual({ kind: 'prepare', predictedAccount: ACCOUNT, walletIsRecipient: true });
    expect(adoptionStep({ wallet: '0x22222222222222222222222222222222222222AB', launch, mind: unregistered })).toEqual({
      kind: 'prepare',
      predictedAccount: null,
      walletIsRecipient: false,
    });
    expect(adoptionStep({ wallet: STRANGER, launch, mind: unregistered })).toEqual({ kind: 'not-authorized', recipient: RECIPIENT, deployer: DEPLOYER });
  });

  it('refuses launches quoted in an ERC-20 (native quote only)', () => {
    expect(adoptionStep({ wallet: RECIPIENT, launch: { ...launch, pairToken: STRANGER }, mind: unregistered })).toEqual({ kind: 'unsupported-quote', pairToken: STRANGER });
  });

  it('step 2: after prepareAdoption the current recipient must transfer to the account', () => {
    expect(adoptionStep({ wallet: RECIPIENT, launch, mind: prepared })).toEqual({ kind: 'transfer', account: ACCOUNT, recipient: RECIPIENT, walletIsRecipient: true });
    // the deployer prepared, but only the recipient can send the transfer
    expect(adoptionStep({ wallet: DEPLOYER, launch, mind: prepared })).toMatchObject({ kind: 'transfer', walletIsRecipient: false });
    expect(adoptionStep({ wallet: undefined, launch, mind: prepared })).toMatchObject({ kind: 'transfer', walletIsRecipient: false });
  });

  it('step 3: once the account is the recipient anyone may activate', () => {
    const transferred = { ...launch, creatorFeeRecipient: ACCOUNT };
    expect(adoptionStep({ wallet: STRANGER, launch: transferred, mind: prepared })).toEqual({ kind: 'activate', account: ACCOUNT });
    expect(adoptionStep({ wallet: undefined, launch: transferred, mind: prepared }).kind).toBe('activate');
  });

  it('done: adopted (still receiving or left) and minds launched here', () => {
    const transferred = { ...launch, creatorFeeRecipient: ACCOUNT };
    expect(adoptionStep({ wallet: STRANGER, launch: transferred, mind: { ...prepared, adopted: true } })).toEqual({ kind: 'adopted', account: ACCOUNT, receivingFees: true });
    expect(adoptionStep({ wallet: STRANGER, launch, mind: { ...prepared, adopted: true } })).toEqual({ kind: 'adopted', account: ACCOUNT, receivingFees: false });
    expect(adoptionStep({ wallet: STRANGER, launch: transferred, mind: { ...prepared, launchedHere: true } })).toEqual({ kind: 'launched-here', account: ACCOUNT });
  });

  it('numbers the stepper', () => {
    expect(adoptionStepNumber({ kind: 'prepare', predictedAccount: null, walletIsRecipient: true })).toBe(1);
    expect(adoptionStepNumber({ kind: 'transfer', account: ACCOUNT, recipient: RECIPIENT, walletIsRecipient: false })).toBe(2);
    expect(adoptionStepNumber({ kind: 'activate', account: ACCOUNT })).toBe(3);
    expect(adoptionStepNumber({ kind: 'adopted', account: ACCOUNT, receivingFees: true })).toBe(4);
    expect(adoptionStepNumber({ kind: 'not-pons' })).toBe(0);
  });
});
