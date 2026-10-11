import { describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, encodeErrorResult } from 'viem';
import { CREDIT_DESK_ABI } from '@beagle/shared/abi';
import { ApiError } from './apiError.js';
import { describeError, describeRevert, describeSlippage, isUserRejection, revertInfo, revertName } from './errors.js';

type DeskError = 'PriceStale' | 'BurnTooSmall' | 'EnforcedPause' | 'SlippageExceeded' | 'RenounceDisabled' | 'BadMaxPriceAge';

function reverted(errorName: DeskError, args: readonly unknown[]): ContractFunctionRevertedError {
  const data = encodeErrorResult({ abi: CREDIT_DESK_ABI, errorName, args: args as never });
  return new ContractFunctionRevertedError({ abi: CREDIT_DESK_ABI, functionName: 'burnForCreditMin', data });
}

describe('describeError', () => {
  it('decodes CreditDesk custom errors', () => {
    const err = reverted('PriceStale', [1n, 3600]);
    expect(revertName(err)).toBe('PriceStale');
    expect(describeError(err)).toMatch(/stale/);
    expect(describeError(reverted('BurnTooSmall', [1n, 2n]))).toBe('Amount is below the minimum burn');
    expect(describeError(reverted('EnforcedPause', []))).toBe('The credit desk is paused');
  });
  it('decodes SlippageExceeded with both amounts', () => {
    const err = reverted('SlippageExceeded', [2_400_000n, 2_475_000n]);
    expect(revertName(err)).toBe('SlippageExceeded');
    expect(revertInfo(err)).toEqual({ name: 'SlippageExceeded', args: [2_400_000n, 2_475_000n] });
    const text = describeError(err);
    expect(text).toContain('$2.40');
    expect(text).toContain('$2.475');
    expect(text).toMatch(/price moved/i);
    expect(text).toMatch(/re-quote/i);
    expect(text).toMatch(/nothing was burned/i);
    // wrapped by a wallet / wagmi layer: still decoded
    expect(describeError(new BaseError('wrapped', { cause: err }))).toBe(text);
  });
  it('falls back to a generic slippage sentence without decoded arguments', () => {
    expect(describeSlippage(undefined)).toMatch(/less than your floor/);
    expect(describeSlippage([])).toMatch(/less than your floor/);
    expect(describeSlippage(['1', 2])).toMatch(/less than your floor/);
    expect(describeRevert({ name: 'SlippageExceeded', args: undefined })).toBe(describeSlippage(undefined));
  });
  it('has text for the refinement errors (RenounceDisabled, BadMaxPriceAge, TokenNotBurnable)', () => {
    expect(describeError(reverted('RenounceDisabled', []))).toMatch(/renounce/i);
    expect(describeError(reverted('BadMaxPriceAge', []))).toMatch(/price age/i);
    // TokenNotBurnable is raised by the deploy script, not by the desk ABI, so it is matched by name
    expect(describeRevert({ name: 'TokenNotBurnable', args: undefined })).toMatch(/burn\(\)/);
    expect(describeRevert({ name: 'SomethingNew', args: undefined })).toBe('Contract reverted: SomethingNew');
  });
  it('walks wrapped errors', () => {
    const inner = reverted('PriceStale', [1n, 3600]);
    const outer = new BaseError('wrapped', { cause: inner });
    expect(revertName(outer)).toBe('PriceStale');
    expect(revertInfo(outer)?.args).toEqual([1n, 3600]);
    expect(revertInfo(new Error('plain'))).toBeUndefined();
    expect(revertName(new BaseError('no revert inside'))).toBeUndefined();
  });
  it('user rejection', () => {
    const err = new UserRejectedRequestError(new Error('denied'));
    expect(isUserRejection(err)).toBe(true);
    expect(describeError(err)).toBe('Request rejected in the wallet');
  });
  it('api and plain errors', () => {
    expect(describeError(new ApiError(402, 'insufficient_credit', 'Insufficient credit'))).toBe('Insufficient credit (insufficient_credit)');
    expect(describeError(new ApiError(500, 'http_500', 'Internal Server Error'))).toBe('Internal Server Error');
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError('text')).toBe('text');
    expect(describeError(42)).toBe('Something went wrong');
  });
});
