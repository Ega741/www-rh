import { mindLaunchpadAbi } from '@www-rh/shared';
import { ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult, erc20Abi, type Abi, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { decodeKnownRevert, decodeLaunchpadRevert, describeError, hasRevertMessage, isRetryLaterRevert, revertErrorName, revertMessage } from './errors';
import { ponsCurveAbi, ponsFactoryAbi, ponsMindRegistryAbi } from './pons/abi';

const LAUNCHPAD = '0x1111111111111111111111111111111111111111';
const TOKEN = '0x2222222222222222222222222222222222222222';
const EXPECTED = 1n << 96n;
const ACTUAL = 3n << 96n;

/** What wagmi's `writeContract` throws when the wallet's gas estimation hits a revert. */
function writeRevert(data: Hex, abi: Abi = mindLaunchpadAbi, functionName = 'graduate'): ContractFunctionExecutionError {
  const revert = new ContractFunctionRevertedError({ abi, data, functionName });
  return new ContractFunctionExecutionError(revert, { abi, functionName, args: [TOKEN], contractAddress: LAUNCHPAD });
}

const skewed = encodeErrorResult({ abi: mindLaunchpadAbi, errorName: 'PoolPriceSkewed', args: [EXPECTED, ACTUAL] });

describe('PoolPriceSkewed on graduate (SPEC §2.3 rule 4)', () => {
  it('decodes against the shared launchpad ABI with its sqrt prices', () => {
    expect(decodeLaunchpadRevert(skewed)).toEqual({ errorName: 'PoolPriceSkewed', args: [EXPECTED, ACTUAL] });
  });

  it('is named from the call ABI and described as a non-fatal "retry later"', () => {
    const err = writeRevert(skewed);
    expect(revertErrorName(err)).toBe('PoolPriceSkewed');
    expect(isRetryLaterRevert(revertErrorName(err))).toBe(true);
    expect(describeError(err)).toBe('Pool price is skewed, graduation will be retried; you can try again later.');
    expect(revertMessage('PoolPriceSkewed')).toMatch(/try again later/);
  });

  it('falls back to the shared ABI when the call ABI does not declare the error', () => {
    const err = writeRevert(skewed, erc20Abi, 'approve');
    expect(err.walk((e) => e instanceof ContractFunctionRevertedError)).toMatchObject({ data: undefined, raw: skewed });
    expect(revertErrorName(err)).toBe('PoolPriceSkewed');
  });

  it('other graduate reverts are not "retry later"', () => {
    expect(isRetryLaterRevert('WrongPhase')).toBe(false);
    expect(isRetryLaterRevert('GraduatorNotSet')).toBe(false);
    expect(isRetryLaterRevert(null)).toBe(false);
  });
});

describe('launchpad error map', () => {
  it('has copy for the grace / graduator / ownership errors', () => {
    for (const name of ['InvalidGraduationGrace', 'InvalidGraduator', 'RenounceDisabled', 'PoolPriceSkewed']) {
      expect(hasRevertMessage(name)).toBe(true);
      expect(revertMessage(name)).not.toMatch(/^Reverted:/);
    }
    expect(describeError(writeRevert(encodeErrorResult({ abi: mindLaunchpadAbi, errorName: 'InvalidGraduationGrace' }), mindLaunchpadAbi, 'setGraduationGrace'))).toMatch(
      /1 hour and 30 days/,
    );
    expect(describeError(writeRevert(encodeErrorResult({ abi: mindLaunchpadAbi, errorName: 'RenounceDisabled' }), mindLaunchpadAbi, 'renounceOwnership'))).toMatch(
      /cannot be renounced/,
    );
  });

  it('covers every error declared in the shared launchpad ABI', () => {
    const names = mindLaunchpadAbi.filter((item) => item.type === 'error').map((item) => item.name);
    expect(names).toContain('InvalidGraduator');
    expect(names.filter((name) => !hasRevertMessage(name))).toEqual([]);
  });

  it('names reverts unknown to the call ABI via the shared ABI, then the 4-byte selector', () => {
    const data = encodeErrorResult({ abi: mindLaunchpadAbi, errorName: 'InvalidGraduator' });
    expect(revertErrorName(writeRevert(data, erc20Abi, 'approve'))).toBe('InvalidGraduator');
    const erc20 = encodeErrorResult({
      abi: [{ type: 'error', name: 'ERC20InsufficientBalance', inputs: [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }] }],
      errorName: 'ERC20InsufficientBalance',
      args: [TOKEN, 1n, 2n],
    });
    expect(revertErrorName(writeRevert(erc20, mindLaunchpadAbi, 'sell'))).toBe('ERC20InsufficientBalance');
  });

  it('returns null for non-revert errors and unknown names fall back to the raw name', () => {
    expect(revertErrorName(new Error('boom'))).toBeNull();
    expect(revertMessage('SomethingNew')).toBe('Reverted: SomethingNew');
    expect(decodeLaunchpadRevert('0x')).toBeNull();
    expect(decodeLaunchpadRevert('0xdeadbeef')).toBeNull();
  });
});

describe('Pons registry / curve / factory errors (SPEC §9.2)', () => {
  const REGISTRY_ERRORS = [
    'AccountExists',
    'NotPonsLaunch',
    'NotRecipientOrDeployer',
    'AdoptionNotReady',
    'AlreadyAdopted',
    'WrongValue',
    'LaunchFailed',
    'BuybackEnabledLaunch',
    'InvalidRecipient',
  ] as const;

  it('decodes every new registry error from the call ABI with specific copy', () => {
    for (const name of REGISTRY_ERRORS) {
      const data = encodeErrorResult({ abi: ponsMindRegistryAbi, errorName: name });
      const err = writeRevert(data, ponsMindRegistryAbi, 'launchMind');
      expect(revertErrorName(err)).toBe(name);
      expect(describeError(err)).toBe(revertMessage(name));
      expect(revertMessage(name)).not.toMatch(/^Reverted:/);
    }
    expect(revertMessage('AdoptionNotReady')).toMatch(/transfer it to the account first/);
    expect(revertMessage('WrongValue')).toMatch(/launch fee \+ initial buy \+ creation fee/);
  });

  it('decodes registry errors when the call ABI does not declare them (fallback ABIs, then selector)', () => {
    const data = encodeErrorResult({ abi: ponsMindRegistryAbi, errorName: 'NotRecipientOrDeployer' });
    expect(decodeKnownRevert(data)).toEqual({ errorName: 'NotRecipientOrDeployer', args: [] });
    expect(revertErrorName(writeRevert(data, erc20Abi, 'approve'))).toBe('NotRecipientOrDeployer');
    expect(revertErrorName(writeRevert(data, mindLaunchpadAbi, 'fundMind'))).toBe('NotRecipientOrDeployer');
  });

  it('decodes Pons errors that bubble up through the registry, with their arguments', () => {
    const expected = `0x${'11'.repeat(32)}` as Hex;
    const actual = `0x${'22'.repeat(32)}` as Hex;
    const mismatch = encodeErrorResult({ abi: ponsFactoryAbi, errorName: 'LaunchEconomicsMismatch', args: [expected, actual] });
    expect(decodeKnownRevert(mismatch)).toEqual({ errorName: 'LaunchEconomicsMismatch', args: [expected, actual] });
    expect(describeError(writeRevert(mismatch, ponsMindRegistryAbi, 'launchMind'))).toMatch(/launch terms changed/);
    const slip = encodeErrorResult({ abi: ponsCurveAbi, errorName: 'SlippageExceeded', args: [5n, 9n] });
    expect(revertErrorName(writeRevert(slip, ponsCurveAbi, 'buy'))).toBe('SlippageExceeded');
    expect(describeError(writeRevert(encodeErrorResult({ abi: ponsCurveAbi, errorName: 'CurveGraduated' }), ponsCurveAbi, 'sell'))).toMatch(/graduated/);
    expect(describeError(writeRevert(encodeErrorResult({ abi: ponsFactoryAbi, errorName: 'NotCreatorFeeRecipient' }), ponsFactoryAbi, 'transferCreatorFeeRecipient'))).toMatch(
      /current creator-fee recipient/,
    );
  });

  it('names the §9.7 errors on prepareAdoption / leave, also via the fallback ABIs and the selector', () => {
    const buyback = encodeErrorResult({ abi: ponsMindRegistryAbi, errorName: 'BuybackEnabledLaunch' });
    expect(describeError(writeRevert(buyback, ponsMindRegistryAbi, 'prepareAdoption'))).toMatch(/buyback enabled/);
    expect(revertErrorName(writeRevert(buyback, erc20Abi, 'approve'))).toBe('BuybackEnabledLaunch');
    const invalid = encodeErrorResult({ abi: ponsMindRegistryAbi, errorName: 'InvalidRecipient' });
    expect(decodeKnownRevert(invalid)).toEqual({ errorName: 'InvalidRecipient', args: [] });
    expect(describeError(writeRevert(invalid, ponsMindRegistryAbi, 'leave'))).toMatch(/zero address, the registry or a mind account/);
    // a call ABI that does not declare it: named via the fallback registry ABI
    const bare = new ContractFunctionRevertedError({ abi: [], data: invalid, functionName: 'leave' });
    expect(revertErrorName(new ContractFunctionExecutionError(bare, { abi: [], functionName: 'leave', contractAddress: LAUNCHPAD }))).toBe('InvalidRecipient');
    expect(revertMessage('AlreadyAdopted')).toMatch(/still receives its creator fees/);
  });

  it('covers every error declared in the Pons registry, curve and factory ABIs', () => {
    for (const abi of [ponsMindRegistryAbi, ponsCurveAbi, ponsFactoryAbi] as const) {
      const names = (abi as Abi).filter((item) => item.type === 'error').map((item) => (item as { name: string }).name);
      expect(names.filter((name) => !hasRevertMessage(name))).toEqual([]);
    }
  });
});
