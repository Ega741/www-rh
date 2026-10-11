import { describe, expect, it } from 'vitest';
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, encodeErrorResult } from 'viem';
import { CREDIT_DESK_ABI } from '@beagle/shared/abi';
import { ApiError } from './apiError.js';
import { describeError, isUserRejection, revertName } from './errors.js';

function reverted(errorName: 'PriceStale' | 'BurnTooSmall' | 'EnforcedPause', args: readonly unknown[]): ContractFunctionRevertedError {
  const data = encodeErrorResult({ abi: CREDIT_DESK_ABI, errorName, args: args as never });
  return new ContractFunctionRevertedError({ abi: CREDIT_DESK_ABI, functionName: 'quote', data });
}

describe('describeError', () => {
  it('decodes CreditDesk custom errors', () => {
    const err = reverted('PriceStale', [1n, 3600]);
    expect(revertName(err)).toBe('PriceStale');
    expect(describeError(err)).toMatch(/stale/);
    expect(describeError(reverted('BurnTooSmall', [1n, 2n]))).toBe('Amount is below the minimum burn');
    expect(describeError(reverted('EnforcedPause', []))).toBe('The credit desk is paused');
  });
  it('walks wrapped errors', () => {
    const inner = reverted('PriceStale', [1n, 3600]);
    const outer = new BaseError('wrapped', { cause: inner });
    expect(revertName(outer)).toBe('PriceStale');
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
