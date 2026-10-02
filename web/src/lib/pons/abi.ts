/**
 * Pons-mode ABIs: the `@www-rh/shared` ABIs (SPEC §9.3: `ponsMindRegistryAbi`, `ponsFactoryAbi`,
 * `ponsCurveAbi`) extended with what the web app needs and shared does not declare.
 *
 * LOCAL FALLBACKS (candidates for `@www-rh/shared`):
 * - the custom errors of `PonsV2BondingCurve` and `PonsV2LaunchFactory` (from the Pons V2 sources /
 *   Sourcify ABIs, chain 4663), appended so viem names reverts of curve / factory calls directly;
 * - `PonsV2LaunchFactory.graduate(address)` (permissionless settle when the crossing buy could not
 *   auto-graduate) and `PonsV2BondingCurve.token()`;
 * - `FailedDeployment()` (OpenZeppelin `Clones`) on the registry;
 * - {@link ponsCurveExtrasAbi}: deployed curve views not in SPEC §9.1 (`launchedAt`,
 *   `snipeTaxSeconds`, `currentSnipeTaxBps`).
 *
 * @module lib/pons/abi
 */
import {
  PonsGraduationPhase,
  ponsCurveAbi as sharedPonsCurveAbi,
  ponsFactoryAbi as sharedPonsFactoryAbi,
  ponsMindRegistryAbi as sharedPonsMindRegistryAbi,
} from '@www-rh/shared';
import { parseAbi } from 'viem';

export { PonsGraduationPhase };

/** Custom errors of `PonsV2BondingCurve` (+ the math library and SafeERC20). */
export const ponsCurveErrorsAbi = parseAbi([
  'function token() view returns (address)',
  'error CurveGraduated()',
  'error ZeroAmount()',
  'error ZeroAddress()',
  'error SlippageExceeded(uint256 actual, uint256 minimum)',
  'error NotFactory()',
  'error TransferFailed()',
  'error AlreadyGraduated()',
  'error NotInitialized()',
  'error NotReadyToGraduate()',
  'error NotFeeSweepOperator()',
  'error InternalSwapRequiresOperator()',
  'error MinimumOutputRequired()',
  'error NativeValueMismatch(uint256 supplied, uint256 expected)',
  'error UnexpectedNativeValue()',
  'error InsufficientInputAmount()',
  'error InsufficientOutputAmount()',
  'error InsufficientLiquidity()',
  'error SafeERC20FailedOperation(address token)',
]);

/** `PonsV2LaunchFactory.graduate(address)` + the factory errors a launch / adoption can hit. */
export const ponsFactoryExtrasAbi = parseAbi([
  // permissionless settle of a launch whose crossing buy could not auto-graduate (sweep + drain → Swept)
  'function graduate(address token)',
  'error InvalidLaunchConfigId()',
  'error LaunchConfigDisabled()',
  'error CreatorTaxTooHigh()',
  'error CombinedFeeTooHigh()',
  'error LaunchFeeNotPaid()',
  'error NotWhitelisted()',
  'error InvalidTokenParams()',
  'error TokenNotFound()',
  'error WrongGraduationPhase()',
  'error NothingToGraduate()',
  'error NotCreatorFeeRecipient()',
  'error LaunchEconomicsMismatch(bytes32 expected, bytes32 actual)',
  'error ExemptionListTooLong()',
  'error PairTokenNotApproved()',
  'error GraduationSeedNotViable()',
]);

/** Registry errors not in the shared ABI. */
export const ponsMindRegistryExtrasAbi = parseAbi(['error FailedDeployment()']);

/** `PonsMindRegistry` (shared) + {@link ponsMindRegistryExtrasAbi}. */
export const ponsMindRegistryAbi = [...sharedPonsMindRegistryAbi, ...ponsMindRegistryExtrasAbi] as const;
/** `PonsV2LaunchFactory` subset (shared) + {@link ponsFactoryExtrasAbi}. */
export const ponsFactoryAbi = [...sharedPonsFactoryAbi, ...ponsFactoryExtrasAbi] as const;
/** `PonsV2BondingCurve` subset (shared) + {@link ponsCurveErrorsAbi}. */
export const ponsCurveAbi = [...sharedPonsCurveAbi, ...ponsCurveErrorsAbi] as const;

/**
 * Members of the deployed `PonsV2BondingCurve` (Sourcify, chain 4663) that SPEC §9.1 does not
 * list: the launch timestamp, the per-launch snipe window and the per-recipient snipe tax. Reads of
 * these are best-effort (mocks may not implement them); the snipe-tax warning falls back to the
 * mind's `createdAt` and the factory's `snipeTaxSeconds`.
 */
export const ponsCurveExtrasAbi = parseAbi([
  'function launchedAt() view returns (uint256)',
  'function snipeTaxSeconds() view returns (uint256)',
  'function currentSnipeTaxBps(address recipient) view returns (uint256)',
]);
