/**
 * Human-readable messages for wallet, contract and API errors.
 *
 * @module lib/errors
 */
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from 'viem';
import { ApiError } from '../api';

const REVERT_MESSAGES: Record<string, string> = {
  Slippage: 'Price moved beyond your slippage tolerance. Try again or raise the slippage.',
  Expired: 'The transaction deadline passed before it was mined.',
  WrongPhase: 'This curve is no longer trading in that phase (it may have completed or graduated).',
  ZeroAmount: 'Amount must be greater than zero.',
  NotAMind: 'This address is not a coin of this launchpad.',
  NotCreator: 'Only the creator of this coin can do that.',
  InvalidStatus: 'The mind is in a status that does not allow this change.',
  InsufficientCreationFee: 'The value sent does not cover the creation fee.',
  InsufficientMindBalance: 'The mind vault does not hold enough ETH.',
  GraduatorNotSet: 'No graduator is configured on the launchpad yet, so graduation is not possible right now.',
  EnforcedPause: 'The launchpad is paused: creating coins and buying are disabled (selling still works).',
  EthTransferFailed: 'An ETH transfer inside the transaction failed.',
  ERC20InsufficientAllowance: 'Approve the launchpad to spend your tokens first.',
  ERC20InsufficientBalance: 'You do not hold that many tokens.',
  ReentrancyGuardReentrantCall: 'Re-entrant call rejected.',
};

/** Whether `error` is the user rejecting a wallet request. */
export function isUserRejection(error: unknown): boolean {
  if (error instanceof BaseError) {
    return error.walk((e) => e instanceof UserRejectedRequestError) !== null;
  }
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 4001;
}

/** Best-effort one-line description of any error thrown by wagmi / viem / the API client. */
export function describeError(error: unknown): string {
  if (error === null || error === undefined) return 'Unknown error.';
  if (isUserRejection(error)) return 'Request rejected in the wallet.';
  if (error instanceof ApiError) {
    return error.unavailable ? `The runner is unavailable: ${error.message}` : error.message;
  }
  if (error instanceof BaseError) {
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName;
      if (name !== undefined) return REVERT_MESSAGES[name] ?? `Reverted: ${name}`;
      if (revert.reason) return `Reverted: ${revert.reason}`;
    }
    return error.shortMessage || error.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}
