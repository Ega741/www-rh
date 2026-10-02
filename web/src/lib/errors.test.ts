import { mindLaunchpadAbi } from '@www-rh/shared';
import { ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult, erc20Abi, type Abi, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { decodeLaunchpadRevert, describeError, hasRevertMessage, isRetryLaterRevert, revertErrorName, revertMessage } from './errors';

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
