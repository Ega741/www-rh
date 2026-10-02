/**
 * Human-readable messages for wallet, contract and API errors.
 *
 * Reverts are decoded with viem (`BaseError.walk` → `ContractFunctionRevertedError.data.errorName`)
 * against the ABI of the call. When that ABI does not know the error, the raw revert data is
 * decoded against the shared launchpad ABI (`mindLaunchpadAbi`, which also declares the
 * graduator's `PoolPriceSkewed`), then against the Pons ABIs (registry, curve, factory — errors
 * bubble up from Pons through `launchMind` / `leave`), and finally the 4-byte selector is matched
 * against the table below (e.g. an ERC-20 error bubbling up from the token).
 *
 * @module lib/errors
 */
import { mindLaunchpadAbi } from '@www-rh/shared';
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, decodeErrorResult, keccak256, toBytes, type Abi, type Hex } from 'viem';
import { ApiError } from '../api';
import { VENUE } from '../config';
import { ponsCurveAbi, ponsFactoryAbi, ponsMindRegistryAbi } from './pons/abi';

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

/** Copy for the `PonsMindRegistry` errors (SPEC §9.2 / §9.7) and the Pons curve / factory errors that bubble up. */
const PONS_REVERT_MESSAGES: Record<string, { signature: string; message: string }> = {
  // PonsMindRegistry
  AccountExists: {
    signature: 'AccountExists()',
    message: 'A mind account already exists here: this coin may already have a mind, or (for a new launch) the salt was reused. Submit again; every launch attempt uses a fresh salt.',
  },
  NotPonsLaunch: {
    signature: 'NotPonsLaunch()',
    message: 'That token is not a native-ETH Pons V2 launch (unknown to the factory, or quoted in an ERC-20), so it cannot get a mind here.',
  },
  NotRecipientOrDeployer: {
    signature: 'NotRecipientOrDeployer()',
    message: "Only the Pons launch's current creator-fee recipient or its deployer can do that.",
  },
  AdoptionNotReady: {
    signature: 'AdoptionNotReady()',
    message:
      "The coin's creator-fee recipient is not this preparation's account (or the preparation no longer exists): transfer it to the account first (step 2), then activate.",
  },
  AlreadyAdopted: {
    signature: 'AlreadyAdopted()',
    message: "This coin's mind still receives its creator fees, so it cannot be adopted or taken over.",
  },
  BuybackEnabledLaunch: {
    signature: 'BuybackEnabledLaunch()',
    message: 'This Pons launch has buyback enabled, so part of its fees is spent on buybacks: it cannot get a mind here.',
  },
  InvalidRecipient: {
    signature: 'InvalidRecipient()',
    message: 'The new fee recipient cannot be the zero address, the registry or a mind account. Use a wallet you control.',
  },
  WrongValue: {
    signature: 'WrongValue()',
    message: 'The ETH sent does not equal launch fee + initial buy + creation fee (one of the fees may have just changed). Try again.',
  },
  LaunchFailed: {
    signature: 'LaunchFailed()',
    message: 'The Pons factory rejected the launch (public launches may be closed to this registry, or the launch terms changed).',
  },
  FailedDeployment: { signature: 'FailedDeployment()', message: 'Deploying the mind account failed (its address may already be taken). Try again.' },
  InsufficientBalance: { signature: 'InsufficientBalance(uint256,uint256)', message: 'The registry does not hold enough ETH for this operation.' },
  // PonsV2BondingCurve
  CurveGraduated: {
    signature: 'CurveGraduated()',
    message: 'The Pons curve has graduated (or its sellable supply is exhausted): trade the coin on Pons or Uniswap instead.',
  },
  SlippageExceeded: { signature: 'SlippageExceeded(uint256,uint256)', message: 'Price moved beyond your slippage tolerance. Try again or raise the slippage.' },
  NotFactory: { signature: 'NotFactory()', message: 'Only the Pons factory can do that.' },
  TransferFailed: { signature: 'TransferFailed()', message: 'An ETH transfer inside the Pons curve failed.' },
  AlreadyGraduated: { signature: 'AlreadyGraduated()', message: 'The Pons curve already graduated.' },
  NotInitialized: { signature: 'NotInitialized()', message: 'The Pons curve is not initialized yet.' },
  NotReadyToGraduate: { signature: 'NotReadyToGraduate()', message: 'The Pons curve is not ready to graduate yet.' },
  NotFeeSweepOperator: { signature: 'NotFeeSweepOperator()', message: 'Only the Pons fee-sweep operator or the launch deployer can sweep these fees.' },
  InternalSwapRequiresOperator: {
    signature: 'InternalSwapRequiresOperator()',
    message: 'This fee sweep needs an internal buyback swap, which only the Pons operator can run.',
  },
  MinimumOutputRequired: { signature: 'MinimumOutputRequired()', message: 'A minimum output is required for this trade.' },
  NativeValueMismatch: { signature: 'NativeValueMismatch(uint256,uint256)', message: 'The ETH sent does not equal the amount of the buy.' },
  UnexpectedNativeValue: { signature: 'UnexpectedNativeValue()', message: 'This Pons curve does not accept ETH.' },
  InsufficientInputAmount: { signature: 'InsufficientInputAmount()', message: 'The amount is too small for the curve to price.' },
  InsufficientOutputAmount: { signature: 'InsufficientOutputAmount()', message: 'The trade rounds to zero output; use a larger amount.' },
  InsufficientLiquidity: { signature: 'InsufficientLiquidity()', message: 'The curve does not have enough liquidity for that trade.' },
  // PonsV2LaunchFactory
  InvalidLaunchConfigId: { signature: 'InvalidLaunchConfigId()', message: 'That Pons launch configuration does not exist.' },
  LaunchConfigDisabled: { signature: 'LaunchConfigDisabled()', message: 'That launch configuration is disabled by Pons. Pick another one.' },
  CreatorTaxTooHigh: { signature: 'CreatorTaxTooHigh()', message: 'The creator tax is above the Pons maximum (it may have just been lowered).' },
  CombinedFeeTooHigh: { signature: 'CombinedFeeTooHigh()', message: 'Curve fee plus creator tax is above the Pons limit of 20%.' },
  LaunchFeeNotPaid: { signature: 'LaunchFeeNotPaid()', message: 'The Pons launch fee changed while you were signing. Try again.' },
  NotWhitelisted: { signature: 'NotWhitelisted()', message: 'Pons has not opened public launches and has not whitelisted this registry yet.' },
  InvalidTokenParams: { signature: 'InvalidTokenParams()', message: 'Pons rejected the token name or ticker.' },
  TokenNotFound: { signature: 'TokenNotFound()', message: 'That token was not launched by the Pons factory.' },
  WrongGraduationPhase: { signature: 'WrongGraduationPhase()', message: 'The coin is not in the right graduation phase for that (the pool may already exist).' },
  NothingToGraduate: { signature: 'NothingToGraduate()', message: 'There is nothing to graduate yet.' },
  NotCreatorFeeRecipient: {
    signature: 'NotCreatorFeeRecipient()',
    message: 'Only the current creator-fee recipient of this Pons coin can hand it over. Connect that wallet.',
  },
  LaunchEconomicsMismatch: {
    signature: 'LaunchEconomicsMismatch(bytes32,bytes32)',
    message: 'The Pons launch terms changed between the preview and your transaction. Review the new terms and try again.',
  },
  ExemptionListTooLong: { signature: 'ExemptionListTooLong()', message: 'Too many snipe-tax exemptions for Pons.' },
  PairTokenNotApproved: { signature: 'PairTokenNotApproved()', message: 'Pons does not accept that quote token (only native ETH is supported here).' },
  GraduationSeedNotViable: { signature: 'GraduationSeedNotViable()', message: 'Pons cannot seed the graduated pool with these terms yet; try again later.' },
};

/** Pons-mode wording for errors shared with the launchpad (the registry is MindCore + Pons, SPEC §9.2). */
const PONS_MODE_OVERRIDES: Record<string, string> = {
  NotAMind: 'This address is not a mind of this registry.',
  EnforcedPause: 'The registry is paused by its owner: launching and adopting minds are disabled (trading on Pons is unaffected).',
  EthReturnMismatch: "The mind account returned an unexpected amount of ETH; the harvest was rolled back.",
  DirectEthNotAccepted: 'The registry does not accept plain ETH transfers. Use "feed the mind" instead.',
  RenounceDisabled: 'Ownership of the registry cannot be renounced.',
  ZeroAmount: 'Amount must be greater than zero.',
};

const ALL_REVERT_MESSAGES: Record<string, { signature: string; message: string }> = { ...REVERT_MESSAGES, ...PONS_REVERT_MESSAGES };

const NAME_BY_SELECTOR: ReadonlyMap<string, string> = new Map(
  Object.entries(ALL_REVERT_MESSAGES).map(([name, { signature }]) => [keccak256(toBytes(signature)).slice(0, 10), name]),
);

/** ABIs tried, in order, for revert data the call's ABI does not know. */
const FALLBACK_ABIS: readonly Abi[] = [mindLaunchpadAbi, ponsMindRegistryAbi, ponsCurveAbi, ponsFactoryAbi];

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

/**
 * Decodes raw revert data against the launchpad ABI, then the Pons registry, curve and factory
 * ABIs: `{ errorName, args }`, or `null`.
 */
export function decodeKnownRevert(data: Hex | undefined): { errorName: string; args: readonly unknown[] } | null {
  if (data === undefined || data.length < 10) return null;
  for (const abi of FALLBACK_ABIS) {
    try {
      const decoded = decodeErrorResult({ abi, data });
      return { errorName: decoded.errorName, args: decoded.args ?? [] };
    } catch {
      // try the next ABI
    }
  }
  return null;
}

/** Custom error name of a contract revert (by the call's ABI, then the known ABIs, then by selector), or `null`. */
export function revertErrorName(error: unknown): string | null {
  if (!(error instanceof BaseError)) return null;
  const revert = error.walk((e) => e instanceof ContractFunctionRevertedError);
  if (!(revert instanceof ContractFunctionRevertedError)) return null;
  const byAbi = revert.data?.errorName;
  if (byAbi !== undefined) return byAbi;
  const byShared = decodeKnownRevert(revert.raw)?.errorName;
  if (byShared !== undefined) return byShared;
  const selector = (revert.signature ?? revert.raw?.slice(0, 10))?.toLowerCase();
  return selector !== undefined ? (NAME_BY_SELECTOR.get(selector) ?? null) : null;
}

/** Message for a custom error name (Pons-mode wording where the registry differs from the launchpad). */
export function revertMessage(name: string): string {
  const override = VENUE === 'pons' ? PONS_MODE_OVERRIDES[name] : undefined;
  return override ?? ALL_REVERT_MESSAGES[name]?.message ?? `Reverted: ${name}`;
}

/** Whether a copy entry exists for `name` (tests check the shared and Pons ABIs are fully covered). */
export function hasRevertMessage(name: string): boolean {
  return Object.hasOwn(ALL_REVERT_MESSAGES, name);
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
