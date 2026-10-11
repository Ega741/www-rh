/**
 * Turns thrown values (viem, wagmi, the API client, plain errors) into short English messages for
 * toasts and inline notes. Contract custom errors of `CreditDesk` (SPEC §3.4, contracts/README.md
 * "Refinements") get specific text; `SlippageExceeded` includes the decoded amounts.
 */
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from 'viem';
import { formatUsdMicro } from '@beagle/shared/credit';
import { ApiError } from './apiError.js';

/** Human text for the `CreditDesk` custom errors without arguments worth showing. */
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
  BadMaxPriceAge: 'The maximum price age must be greater than zero',
  RenounceDisabled: 'Ownership of the desk cannot be renounced; use the two-step transfer',
  TokenNotBurnable: 'The token has no working burn(); the desk cannot be deployed in native-burn mode against it',
  SafeERC20FailedOperation: 'Token transfer failed (check balance and allowance)',
  ERC20InsufficientAllowance: 'Token allowance is too low; approve first',
  ERC20InsufficientBalance: 'Insufficient token balance',
};

/** Decoded custom error of a viem contract error: its name and (when the ABI decoded them) its arguments. */
export interface RevertInfo {
  name: string;
  args: readonly unknown[] | undefined;
}

/** The custom error a viem contract error carries (name + decoded args), or `undefined`. */
export function revertInfo(err: unknown): RevertInfo | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(reverted instanceof ContractFunctionRevertedError)) return undefined;
  const name = reverted.data?.errorName ?? reverted.reason;
  if (name === undefined) return undefined;
  const args = reverted.data?.args;
  return { name, args: Array.isArray(args) ? (args as readonly unknown[]) : undefined };
}

/** Name of the custom error a viem contract error carries, or `undefined`. */
export function revertName(err: unknown): string | undefined {
  return revertInfo(err)?.name;
}

/** `true` when the user dismissed the wallet prompt. */
export function isUserRejection(err: unknown): boolean {
  if (!(err instanceof BaseError)) return false;
  return err.walk((e) => e instanceof UserRejectedRequestError) instanceof UserRejectedRequestError;
}

/**
 * Text for `SlippageExceeded(usdMicro, minUsdMicro)`: the burn would have credited `usdMicro`,
 * below the floor `minUsdMicro` the client passed to `burnForCreditMin`. Falls back to a generic
 * sentence when the arguments were not decoded.
 */
export function describeSlippage(args: readonly unknown[] | undefined): string {
  const [usdMicro, minUsdMicro] = args ?? [];
  if (typeof usdMicro === 'bigint' && typeof minUsdMicro === 'bigint') {
    return `Price moved against you: this burn would credit ${formatUsdMicro(usdMicro)}, below your floor of ${formatUsdMicro(minUsdMicro)}. Nothing was burned; re-quote and try again.`;
  }
  return 'Price moved against you: this burn would credit less than your floor. Nothing was burned; re-quote and try again.';
}

/** Text for a decoded custom error. */
export function describeRevert(info: RevertInfo): string {
  if (info.name === 'SlippageExceeded') return describeSlippage(info.args);
  return REVERT_TEXT[info.name] ?? `Contract reverted: ${info.name}`;
}

/** Short, user-facing description of `err`. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    return err.code === `http_${err.status}` ? err.message : `${err.message} (${err.code})`;
  }
  if (isUserRejection(err)) return 'Request rejected in the wallet';
  const info = revertInfo(err);
  if (info !== undefined) return describeRevert(info);
  if (err instanceof BaseError) return err.shortMessage;
  if (err instanceof Error) return err.message === '' ? err.name : err.message;
  if (typeof err === 'string') return err;
  return 'Something went wrong';
}
