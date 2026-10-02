/**
 * Human-readable ABIs (viem `parseAbi`) for the www-rh contracts, mirroring `docs/SPEC.md` §2 as
 * amended by the contract directives D1–D10 (no `creditMind` / `retireMind` / `graduateFor`;
 * ETH returns from graduators through gated `receive()`; compute draws go to `computeTreasury`;
 * `MindStatus { Alive, Dormant, Paused }`).
 *
 * Enums (`CurvePhase`, `MindStatus`) are `uint8` at the ABI level; the numeric values are
 * exported as `CurvePhase` / `MindStatus` below. Constructors are intentionally omitted (these
 * ABIs describe the deployed interface only). A vitest test compares every function selector,
 * event topic and error selector against the Foundry artifacts when they are present and current.
 *
 * @module abi
 */
import { parseAbi } from 'viem';

/** `enum CurvePhase { Bonding, Complete, Graduated }` */
export const CurvePhase = {
  Bonding: 0,
  Complete: 1,
  Graduated: 2,
} as const;
export type CurvePhase = (typeof CurvePhase)[keyof typeof CurvePhase];

/**
 * `enum MindStatus { Alive, Dormant, Paused }` (D4). `Paused` is set/unset only by the creator via
 * `setCreatorPaused`; the operator's `setMindStatus` toggles `Alive <-> Dormant` only.
 */
export const MindStatus = {
  Alive: 0,
  Dormant: 1,
  Paused: 2,
} as const;
export type MindStatus = (typeof MindStatus)[keyof typeof MindStatus];

/** Struct declarations shared by the launchpad ABI (human-readable ABI syntax). */
const launchpadStructs = [
  'struct MindInfo { address creator; bytes32 modelId; bytes32 personaHash; string metadataURI; uint64 createdAt; uint8 status; }',
  'struct CurveState { uint128 realEthReserve; uint128 tokensSold; uint8 phase; address pool; uint256 positionId; }',
  'struct FeeParams { uint16 tradeFeeBps; uint16 mindShareBps; uint16 graduationFeeBps; }',
] as const;

/**
 * `MindLaunchpad` functions (SPEC §2.3 + D1–D10) plus the public surface inherited from
 * OpenZeppelin `Ownable2Step` and `Pausable`.
 */
const launchpadFunctions = [
  // --- user ---
  'function createMind(string name, string symbol, string metadataURI, bytes32 modelId, bytes32 personaHash, uint256 minTokensOut) payable returns (address token)',
  'function buy(address token, uint256 minTokensOut, uint256 deadline) payable returns (uint256 tokensOut)',
  'function sell(address token, uint256 tokensIn, uint256 minEthOut, uint256 deadline) returns (uint256 ethOut)',
  'function graduate(address token)',
  'function harvest(address token)',
  'function fundMind(address token) payable',
  // Accepts ETH only from addresses with isGraduator == true (D1); reverts DirectEthNotAccepted otherwise.
  'receive() external payable',
  // --- views ---
  'function quoteBuy(address token, uint256 ethIn) view returns (uint256 tokensOut, uint256 ethUsed, uint256 fee)',
  'function quoteSell(address token, uint256 tokensIn) view returns (uint256 ethOut, uint256 fee)',
  'function currentPrice(address token) view returns (uint256 weiPer1e18Tokens)',
  'function getMind(address token) view returns (MindInfo info)',
  'function getCurve(address token) view returns (CurveState curve)',
  'function mindBalance(address token) view returns (uint256)',
  'function protocolBalance() view returns (uint256)',
  'function mindsLength() view returns (uint256)',
  'function mindAt(uint256 index) view returns (address)',
  'function isMind(address token) view returns (bool)',
  'function feeParams() view returns (FeeParams params)',
  'function creationFee() view returns (uint256)',
  'function drawLimit() view returns (uint256 maxPerEpoch, uint32 epochSeconds)',
  'function drawnInEpoch(address token) view returns (uint256 drawn, uint64 epochStart)',
  'function operator() view returns (address)',
  'function treasury() view returns (address)',
  'function computeTreasury() view returns (address)',
  'function graduator() view returns (address)',
  'function graduatorOf(address token) view returns (address)',
  'function isGraduator(address account) view returns (bool)',
  'function VIRTUAL_ETH() view returns (uint256)',
  'function VIRTUAL_TOKENS() view returns (uint256)',
  'function CURVE_SUPPLY() view returns (uint256)',
  'function LP_SUPPLY() view returns (uint256)',
  'function TOTAL_SUPPLY() view returns (uint256)',
  // --- creator ---
  'function setMindConfig(address token, bytes32 modelId, bytes32 personaHash, string metadataURI)',
  'function setCreatorPaused(address token, bool paused)',
  // --- operator ---
  'function drawCompute(address token, uint256 amount, bytes32 receiptHash)',
  'function anchorMemory(address token, uint64 seq, bytes32 contentHash, string uri)',
  'function setMindStatus(address token, uint8 status)',
  // --- owner ---
  'function setOperator(address newOperator)',
  'function setTreasury(address newTreasury)',
  'function setComputeTreasury(address newComputeTreasury)',
  'function setGraduator(address newGraduator)',
  'function setFeeParams(FeeParams params)',
  'function setCreationFee(uint256 newCreationFee)',
  'function setDrawLimit(uint256 maxPerEpoch, uint32 epochSeconds)',
  'function pause()',
  'function unpause()',
  'function withdrawProtocolFees(address to)',
  // --- Ownable2Step / Pausable (OpenZeppelin 5.x) ---
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function transferOwnership(address newOwner)',
  'function acceptOwnership()',
  'function renounceOwnership()',
  'function paused() view returns (bool)',
] as const;

/** `MindLaunchpad` events (SPEC §2.3 + D1–D10) plus OpenZeppelin `Ownable2Step` / `Pausable` events. */
const launchpadEvents = [
  'event MindCreated(address indexed token, address indexed creator, string name, string symbol, string metadataURI, bytes32 modelId, bytes32 personaHash)',
  'event Trade(address indexed token, address indexed trader, bool isBuy, uint256 ethAmount, uint256 tokenAmount, uint256 fee, uint256 realEthReserve, uint256 tokensSold)',
  'event CurveCompleted(address indexed token, uint256 realEthReserve)',
  'event Graduated(address indexed token, address pool, uint256 positionId, uint256 ethLiquidity, uint256 tokenLiquidity, uint256 graduationFee)',
  // fundMind, graduator ETH returns and harvest proceeds (from = graduator); fee shares emit FeeAccrued (D8).
  'event MindFunded(address indexed token, address indexed from, uint256 amount)',
  'event FeeAccrued(address indexed token, uint256 mindAmount, uint256 protocolAmount)',
  'event ComputeDrawn(address indexed token, uint256 amount, bytes32 receiptHash)',
  'event MemoryAnchored(address indexed token, uint64 indexed seq, bytes32 contentHash, string uri)',
  'event MindConfigUpdated(address indexed token, bytes32 modelId, bytes32 personaHash, string metadataURI)',
  'event MindStatusChanged(address indexed token, uint8 status)',
  'event Harvested(address indexed token, uint256 ethOut, uint256 tokensBurned)',
  'event ProtocolFeesWithdrawn(address indexed to, uint256 amount)',
  'event OperatorUpdated(address operator)',
  'event TreasuryUpdated(address treasury)',
  'event ComputeTreasuryUpdated(address computeTreasury)',
  'event GraduatorUpdated(address graduator)',
  'event FeeParamsUpdated(uint16 tradeFeeBps, uint16 mindShareBps, uint16 graduationFeeBps)',
  'event CreationFeeUpdated(uint256 creationFee)',
  'event DrawLimitUpdated(uint256 maxPerEpoch, uint32 epochSeconds)',
  // --- OpenZeppelin ---
  'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
  'event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)',
  'event Paused(address account)',
  'event Unpaused(address account)',
] as const;

/**
 * `MindLaunchpad` errors: SPEC §2.3 / D1–D10, input validation (D10), the graduator balance check
 * (D1), and the OpenZeppelin / library errors the contract can revert with.
 */
const launchpadErrors = [
  'error NotAMind()',
  'error WrongPhase()',
  'error Slippage()',
  'error Expired()',
  'error ZeroAmount()',
  'error NotCreator()',
  'error NotOperator()',
  'error InvalidStatus()',
  'error DrawLimitExceeded()',
  'error InsufficientMindBalance()',
  'error FeeTooHigh()',
  'error InsufficientCreationFee()',
  'error ZeroAddress()',
  'error EthTransferFailed()',
  'error DirectEthNotAccepted()',
  'error GraduatorNotSet()',
  // balance after a graduator call != balBefore - ethSent + ethReturned (D1)
  'error BalanceMismatch()',
  // createMind / setMindConfig input validation (D10)
  'error InvalidName()',
  'error InvalidSymbol()',
  'error InvalidMetadataURI()',
  'error InvalidModelId()',
  'error ExceedsTokensSold()',
  // --- OpenZeppelin ---
  'error OwnableUnauthorizedAccount(address account)',
  'error OwnableInvalidOwner(address owner)',
  'error EnforcedPause()',
  'error ExpectedPause()',
  'error ReentrancyGuardReentrantCall()',
  'error SafeERC20FailedOperation(address token)',
  'error SafeCastOverflowedUintDowncast(uint8 bits, uint256 value)',
] as const;

/** Human-readable signatures of `MindLaunchpad` (structs, functions, events, errors). */
export const mindLaunchpadAbiSignatures = [
  ...launchpadStructs,
  ...launchpadFunctions,
  ...launchpadEvents,
  ...launchpadErrors,
] as const;

/** Parsed ABI of `MindLaunchpad`. Fully typed for viem / wagmi. */
export const mindLaunchpadAbi = parseAbi(mindLaunchpadAbiSignatures);

/** Human-readable signatures of `MindToken` (ERC20 + ERC20Permit + `launchpad()` / `creator()`). */
export const mindTokenAbiSignatures = [
  // --- MindToken ---
  'function launchpad() view returns (address)',
  'function creator() view returns (address)',
  // --- ERC20 ---
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 value) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 value) returns (bool)',
  'function transferFrom(address from, address to, uint256 value) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InvalidSender(address sender)',
  'error ERC20InvalidReceiver(address receiver)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error ERC20InvalidApprover(address approver)',
  'error ERC20InvalidSpender(address spender)',
  // --- ERC20Permit (EIP-2612) / Nonces / EIP712 ---
  'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  'function nonces(address owner) view returns (uint256)',
  'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)',
  'event EIP712DomainChanged()',
  'error ERC2612ExpiredSignature(uint256 deadline)',
  'error ERC2612InvalidSigner(address signer, address owner)',
  'error InvalidAccountNonce(address account, uint256 currentNonce)',
  'error ECDSAInvalidSignature()',
  'error ECDSAInvalidSignatureLength(uint256 length)',
  'error ECDSAInvalidSignatureS(bytes32 s)',
  'error InvalidShortString()',
  'error StringTooLong(string str)',
] as const;

/** Parsed ABI of `MindToken` (SPEC §2.1). */
export const mindTokenAbi = parseAbi(mindTokenAbiSignatures);

/**
 * Human-readable signatures of `IGraduator` (D1) plus the `GraduatedAtSkewedPrice` event emitted
 * by `UniswapV3Graduator` when a pre-created pool is initialized at another price (D3).
 */
export const graduatorAbiSignatures = [
  // The graduator sends `ethReturned` back to the launchpad (plain call → gated receive()) before returning.
  'function graduate(address token, uint256 tokenAmount) payable returns (address pool, uint256 positionId, uint256 ethReturned)',
  'function harvest(address token) returns (uint256 ethOut, uint256 tokensBurned)',
  'event GraduatedAtSkewedPrice(address token, uint160 expectedSqrtPriceX96, uint160 actualSqrtPriceX96)',
] as const;

/** Parsed ABI of `IGraduator` (+ `GraduatedAtSkewedPrice`). */
export const graduatorAbi = parseAbi(graduatorAbiSignatures);

/**
 * Minimal Chainlink `AggregatorV3Interface` (ETH/USD feed read by the runner when `ETH_USD_FEED`
 * is configured).
 */
export const aggregatorV3Abi = parseAbi([
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

/**
 * Names of launchpad functions that the spec marks as optional (may be absent from the artifact).
 * Empty since D7 removed `graduateFor`; kept for API stability.
 */
export const OPTIONAL_LAUNCHPAD_FUNCTIONS: readonly string[] = [];

/**
 * Functions / events / errors removed by the contract directives. The ABI equivalence test treats
 * an artifact that still declares any of them as stale (built from pre-directive sources).
 */
export const REMOVED_LAUNCHPAD_MEMBERS: readonly string[] = [
  'creditMind',
  'retireMind',
  'withdrawRetiredMind',
  'graduateFor',
  'RetiredMindWithdrawn',
  'PoolPriceSkewed',
];

/** The address tokens are "burned" to by the graduator (SPEC §2.4, D3). */
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const;

/** The zero address. */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;
