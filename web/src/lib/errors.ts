/**
 * Human-readable messages for wallet, contract and API errors.
 *
 * Reverts are decoded with viem (`BaseError.walk` → `ContractFunctionRevertedError.data.errorName`)
 * against the ABI of the call. When that ABI does not know the error, the raw revert data is
 * decoded against the shared launchpad ABI (`mindLaunchpadAbi`, which also declares the
 * graduator's `PoolPriceSkewed`), and finally the 4-byte selector is matched against the table
 * below (e.g. an ERC-20 error bubbling up from the token).
 *
 * @module lib/errors
 */
import { mindLaunchpadAbi } from '@www-rh/shared';
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, decodeErrorResult, keccak256, toBytes, type Hex } from 'viem';
import { ApiError } from '../api';

/** Copy for every custom error of SPEC §2.3 plus the OZ / ERC-20 errors a user can hit. */
const REVERT_MESSAGES: Record<string, { signature: string; message: string }> = {
  NotAMind: { signature: 'NotAMind()', message: 'This address is not a coin of this launchpad.' },
  WrongPhase: {
    signature: 'WrongPhase()',
    message: 'The curve is not in the right phase for that (it may have completed or graduated, or its graduation window has not ended yet).',
  },
  Slippage: { signature: 'Slippage()', message: 'Price moved beyond your slippage tolerance. Try again or raise the slippage.' },
  Expired: { signature: 'Expired()', message: 'The transaction deadline passed before it was mined.' },
  ZeroAmount: { signature: 'ZeroAmount()', message: 'Amount must be greater than zero (or the trade rounds to nothing).' },
  ExceedsTokensSold: { signature: 'ExceedsTokensSold()', message: 'You can sell at most the amount sold on the curve.' },
  NotCreator: { signature: 'NotCreator()', message: 'Only the creator of this coin can do that.' },
  NotOperator: { signature: 'NotOperator()', message: 'Only the runner operator can do that.' },
  InvalidStatus: { signature: 'InvalidStatus()', message: 'The mind is in a status that does not allow this change.' },
  InvalidName: { signature: 'InvalidName()', message: 'The name must be 1 to 64 bytes.' },
  InvalidSymbol: { signature: 'InvalidSymbol()', message: 'The ticker must be 1 to 16 bytes.' },
  MetadataTooLong: { signature: 'MetadataTooLong()', message: 'The metadata URI is longer than 2048 bytes.' },
  InvalidModel: { signature: 'InvalidModel()', message: 'No model was selected (modelId is zero).' },
  InsufficientCreationFee: { signature: 'InsufficientCreationFee()', message: 'The value sent does not cover the creation fee (it may have just changed).' },
  InsufficientMindBalance: { signature: 'InsufficientMindBalance()', message: 'The mind vault does not hold enough ETH.' },
  DrawLimitExceeded: { signature: 'DrawLimitExceeded()', message: 'The per-epoch compute draw limit is reached.' },
  InvalidDrawLimit: { signature: 'InvalidDrawLimit()', message: 'Invalid draw limit.' },
  FeeTooHigh: { signature: 'FeeTooHigh()', message: 'Fee parameters out of bounds.' },
  ZeroAddress: { signature: 'ZeroAddress()', message: 'Zero address not allowed.' },
  EthTransferFailed: { signature: 'EthTransferFailed()', message: 'An ETH transfer inside the transaction failed.' },
  GraduatorNotSet: { signature: 'GraduatorNotSet()', message: 'No graduator is configured on the launchpad yet, so graduation is not possible right now.' },
  EthReturnMismatch: { signature: 'EthReturnMismatch()', message: 'The graduator returned an unexpected amount of ETH; graduation was rolled back.' },
  DirectEthNotAccepted: { signature: 'DirectEthNotAccepted()', message: 'The launchpad does not accept plain ETH transfers. Use "feed the mind" instead.' },
  InvalidGraduationGrace: { signature: 'InvalidGraduationGrace()', message: 'The graduation grace period must be between 1 hour and 30 days.' },
  InvalidGraduator: { signature: 'InvalidGraduator()', message: 'That graduator is not a contract wired to this launchpad (its launchpad() does not match).' },
  RenounceDisabled: { signature: 'RenounceDisabled()', message: 'Ownership of the launchpad cannot be renounced.' },
  PoolPriceSkewed: {
    signature: 'PoolPriceSkewed(uint160,uint160)',
    message: 'Pool price is skewed, graduation will be retried; you can try again later.',
  },
  EnforcedPause: { signature: 'EnforcedPause()', message: 'The launchpad is paused: creating coins and buying are disabled (selling still works).' },
  ReentrancyGuardReentrantCall: { signature: 'ReentrancyGuardReentrantCall()', message: 'Re-entrant call rejected.' },
  ExpectedPause: { signature: 'ExpectedPause()', message: 'The launchpad is not paused.' },
  OwnableUnauthorizedAccount: { signature: 'OwnableUnauthorizedAccount(address)', message: 'Only the launchpad owner can do that.' },
  OwnableInvalidOwner: { signature: 'OwnableInvalidOwner(address)', message: 'Invalid owner address.' },
  SafeCastOverflowedUintDowncast: { signature: 'SafeCastOverflowedUintDowncast(uint8,uint256)', message: 'A value is too large for the contract to store.' },
  SafeERC20FailedOperation: { signature: 'SafeERC20FailedOperation(address)', message: 'The token transfer failed.' },
  ERC20InsufficientAllowance: { signature: 'ERC20InsufficientAllowance(address,uint256,uint256)', message: 'Approve the launchpad to spend your tokens first.' },
  ERC20InsufficientBalance: { signature: 'ERC20InsufficientBalance(address,uint256,uint256)', message: 'You do not hold that many tokens.' },
};

const NAME_BY_SELECTOR: ReadonlyMap<string, string> = new Map(
  Object.entries(REVERT_MESSAGES).map(([name, { signature }]) => [keccak256(toBytes(signature)).slice(0, 10), name]),
);

/** Whether `error` is the user rejecting a wallet request. */
export function isUserRejection(error: unknown): boolean {
  if (error instanceof BaseError) {
    return error.walk((e) => e instanceof UserRejectedRequestError) !== null;
  }
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 4001;
}

/** Decodes raw revert data against the shared launchpad ABI: `{ errorName, args }`, or `null`. */
export function decodeLaunchpadRevert(data: Hex | undefined): { errorName: string; args: readonly unknown[] } | null {
  if (data === undefined || data.length < 10) return null;
  try {
    const decoded = decodeErrorResult({ abi: mindLaunchpadAbi, data });
    return { errorName: decoded.errorName, args: decoded.args ?? [] };
  } catch {
    return null;
  }
}

/** Custom error name of a contract revert (by the call's ABI, then the shared ABI, then by selector), or `null`. */
export function revertErrorName(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return null;
  const byAbi = revert.data?.errorName;
  if (byAbi !== undefined) return byAbi;
  const byShared = decodeLaunchpadRevert(revert.raw)?.errorName;
  if (byShared !== undefined) return byShared;
  const selector = (revert.signature ?? revert.raw?.slice(0, 10))?.toLowerCase();
  return selector !== undefined ? (NAME_BY_SELECTOR.get(selector) ?? null) : null;
}

/** Message for a custom error name. */
export function revertMessage(name: string): string {
  return REVERT_MESSAGES[name]?.message ?? `Reverted: ${name}`;
}

/** Whether a copy entry exists for `name` (tests check the shared ABI is fully covered). */
export function hasRevertMessage(name: string): boolean {
  return Object.hasOwn(REVERT_MESSAGES, name);
}

/**
 * `graduate(token)` reverts that leave the coin `Complete` and only mean "retry later"
 * (SPEC §2.3 rule 4: the graduator found the pool price skewed). Shown as a non-fatal notice.
 */
export function isRetryLaterRevert(name: string | null): boolean {
  return name === 'PoolPriceSkewed';
}

/** Best-effort one-line description of any error thrown by wagmi / viem / the API client. */
export function describeError(error: unknown): string {
  if (error === null || error === undefined) return 'Unknown error.';
  if (isUserRejection(error)) return 'Request rejected in the wallet.';
  if (error instanceof ApiError) {
    return error.unavailable ? `The runner is unavailable: ${error.message}` : error.message;
  }
  if (error instanceof BaseError) {
    const name = revertErrorName(error);
    if (name !== null) return revertMessage(name);
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.reason) return `Reverted: ${revert.reason}`;
    return error.shortMessage || error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
