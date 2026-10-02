/**
 * Pons-mode ABIs: the `@www-rh/shared` ABIs (SPEC §9.3: `ponsMindRegistryAbi`, `ponsFactoryAbi`,
 * `ponsCurveAbi`) extended with what the web app needs and shared does not declare.
 *
 * LOCAL FALLBACKS (candidates for `@www-rh/shared`):
 * - {@link ponsMindRegistryV2Abi}: the adoption v2 / lifecycle members of SPEC §9.7
 *   (`activateAdoption(token, preparer)`, `predictAdoptionAccount(token, preparer)`,
 *   `pendingAdoption`, `hasLeft`, `derivedPoolId`, `recoverAccountTokens`, the 3-topic
 *   `MindAdopted`, `BuybackEnabledLaunch()`, `InvalidRecipient()`). They are merged by signature:
 *   a member shared already declares is taken from shared, and the §9.2 signatures §9.7 replaced
 *   (`activateAdoption(address)`, `predictAdoptionAccount(address)`, 2-topic `MindAdopted`) are
 *   dropped, so the merged ABI is the same before and after shared is updated;
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
import { parseAbi, type Abi, type AbiParameter } from 'viem';

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

/**
 * Adoption v2 and lifecycle members of `PonsMindRegistry` (SPEC §9.7). Local fallback until
 * `@www-rh/shared` declares them; see {@link ponsMindRegistryAbi} for how they are merged.
 */
export const ponsMindRegistryV2Abi = parseAbi([
  // anyone; requires factory recipient == pendingAdoptions[token][preparer].account; registers or takes over
  'function activateAdoption(address token, address preparer)',
  'function predictAdoptionAccount(address token, address preparer) view returns (address)',
  'function pendingAdoption(address token, address preparer) view returns (address account, bytes32 modelId, bytes32 personaHash, string metadataURI)',
  'function hasLeft(address token) view returns (bool)',
  'function derivedPoolId(address token) view returns (bytes32)',
  // creator only: moves the account's whole ERC-20 balance to the creator (never ETH)
  'function recoverAccountTokens(address token, address erc20)',
  'event MindAdopted(address indexed token, address indexed account, address indexed creator)',
  'error BuybackEnabledLaunch()',
  'error InvalidRecipient()',
]);

/** Names whose §9.2 signature §9.7 replaced; shared items with these names and another signature are dropped. */
export const SUPERSEDED_REGISTRY_MEMBERS = ['activateAdoption', 'predictAdoptionAccount', 'MindAdopted'] as const;
type SupersededRegistryMember = (typeof SUPERSEDED_REGISTRY_MEMBERS)[number];

function parameterKey(p: AbiParameter): string {
  if (p.type.startsWith('tuple') && 'components' in p) return `(${p.components.map(parameterKey).join(',')})${p.type.slice('tuple'.length)}`;
  return p.type;
}

/** `type name(inputTypes)` of an ABI item: the identity used to merge ABIs. */
export function abiItemKey(item: Abi[number]): string {
  const name = 'name' in item ? item.name : '';
  const inputs = 'inputs' in item ? item.inputs.map(parameterKey).join(',') : '';
  return `${item.type} ${name}(${inputs})`;
}

/**
 * `base` without its items named in `superseded` whose signature `extra` does not declare, plus
 * the items of `extra` that `base` does not already declare (same {@link abiItemKey}).
 */
export function mergeAbi(base: Abi, extra: Abi, superseded: readonly string[] = []): Abi {
  const extraKeys = new Set(extra.map(abiItemKey));
  const kept = base.filter((item) => !('name' in item && superseded.includes(item.name) && !extraKeys.has(abiItemKey(item))));
  const keptKeys = new Set(kept.map(abiItemKey));
  return [...kept, ...extra.filter((item) => !keptKeys.has(abiItemKey(item)))];
}

type SharedRegistryItem = Exclude<(typeof sharedPonsMindRegistryAbi)[number], { readonly name: SupersededRegistryMember }>;
type RegistryItem = SharedRegistryItem | (typeof ponsMindRegistryV2Abi)[number] | (typeof ponsMindRegistryExtrasAbi)[number];

/**
 * `PonsMindRegistry`: shared (§9.2 + MindCore) merged with {@link ponsMindRegistryV2Abi} (§9.7) and
 * {@link ponsMindRegistryExtrasAbi} via {@link mergeAbi}.
 */
export const ponsMindRegistryAbi = mergeAbi(
  sharedPonsMindRegistryAbi,
  [...ponsMindRegistryV2Abi, ...ponsMindRegistryExtrasAbi],
  SUPERSEDED_REGISTRY_MEMBERS,
) as readonly RegistryItem[];
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
