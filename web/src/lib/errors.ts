/**
 * Turns thrown values (viem, wagmi, the API client, plain errors) into short English messages for
 * toasts and inline notes. Contract custom errors of `CreditDesk` (SPEC §3.4) get specific text.
 */
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from 'viem';
import { ApiError } from './apiError.js';

/** Human text for the `CreditDesk` custom errors. */
const REVERT_TEXT: Record<string, string> = {
  BurnTooSmall: 'Amount is below the minimum burn',
  QuoteTooSmall: 'Amount is too small to credit even 1 µUSD',
  PriceUnavailable: 'Token price is unavailable on chain',
  PriceStale: 'Token price is stale; wait for a fresh price post',
  EnforcedPause: 'The credit desk is paused',
  ZeroAddress: 'Workspace address must not be zero',
  BadBudgetParams: 'Invalid budget: cap must be > 0 and the deadline at most 30 days after the block timestamp; try a shorter duration',
  UnknownBudget: 'Unknown budget id',
  BudgetIsClosed: 'This budget is already closed',
  BudgetExpired: 'This budget has expired',
  BudgetExceeded: 'Draw exceeds the remaining budget cap',
  NotBudgetOwner: 'Only the budget owner or the operator may close it now',
  NotOperator: 'Only the operator may draw from budgets',
  SafeERC20FailedOperation: 'Token transfer failed (check balance and allowance)',
  ERC20InsufficientAllowance: 'Token allowance is too low; approve first',
  ERC20InsufficientBalance: 'Insufficient token balance',
};

/** Name of the custom error a viem contract error carries, or `undefined`. */
export function revertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (reverted instanceof ContractFunctionRevertedError) {
    return reverted.data?.errorName ?? reverted.reason ?? undefined;
  }
  return undefined;
}

/** `true` when the user dismissed the wallet prompt. */
export function isUserRejection(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  return err.walk((e) => e instanceof UserRejectedRequestError) instanceof UserRejectedRequestError;
}

/** Short, user-facing description of `err`. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    return err.code === `http_${err.status}` ? err.message : `${err.message} (${err.code})`;
  }
  if (isUserRejection(err)) return 'Request rejected in the wallet';
  const name = revertName(err);
  if (name !== undefined) return REVERT_TEXT[name] ?? `Contract reverted: ${name}`;
  if (err instanceof BaseError) return err.shortMessage;
  if (err instanceof Error) return err.message === '' ? err.name : err.message;
  if (typeof err === 'string') return err;
  return 'Something went wrong';
}
