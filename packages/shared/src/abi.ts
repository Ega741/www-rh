/**
 * Human-readable ABIs (viem `parseAbi`) for the www-rh contracts — `docs/SPEC.md` §2 and §3.3.
 *
 * Enums (`CurvePhase`, `MindStatus`) are `uint8` at the ABI level; their numeric values are
 * exported as const objects below. Event parameter names, struct field names and named outputs
 * match §2 exactly because viem decodes by name. A vitest test compares selectors / topics with
 * the compiled artifacts copied by `pnpm abi:sync` (`packages/shared/abi/*.json`).
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
 * `enum MindStatus { Alive, Dormant, Paused }`. `Paused` is set/unset only by the creator
 * (`setCreatorPaused`); the operator's `setMindStatus` toggles `Alive <-> Dormant` only.
 */
export const MindStatus = {
  Alive: 0,
  Dormant: 1,
  Paused: 2,
} as const;
export type MindStatus = (typeof MindStatus)[keyof typeof MindStatus];

/** Human-readable signatures of `MindLaunchpad` (§2.3 + inherited OpenZeppelin surface). */
export const mindLaunchpadAbiSignatures = [
  // ---------------------------------------------------------------- types
  'struct MindInfo { address creator; bytes32 modelId; bytes32 personaHash; string metadataURI; uint64 createdAt; uint8 status; }',
  'struct CurveState { uint128 realEthReserve; uint128 tokensSold; uint8 phase; address pool; uint256 positionId; }',
  'struct FeeParams { uint16 tradeFeeBps; uint16 mindShareBps; uint16 graduationFeeBps; }',
  'constructor(address initialOwner, address treasury, address computeTreasury, address operator)',
  // accepts ETH only from the graduator being called by graduate()/harvest(), else DirectEthNotAccepted()
  'receive() external payable',
  // ---------------------------------------------------------------- events
  'event MindCreated(address indexed token, address indexed creator, string name, string symbol, string metadataURI, bytes32 modelId, bytes32 personaHash)',
  'event Trade(address indexed token, address indexed trader, bool isBuy, uint256 ethAmount, uint256 tokenAmount, uint256 fee, uint256 realEthReserve, uint256 tokensSold)',
  'event CurveCompleted(address indexed token, uint256 realEthReserve)',
  // a Complete curve not graduated within graduationGrace() was reopened by a sell: phase is Bonding again
  'event CurveReopened(address indexed token)',
  'event Graduated(address indexed token, address pool, uint256 positionId, uint256 ethLiquidity, uint256 tokenLiquidity, uint256 graduationFee)',
  'event FeeAccrued(address indexed token, uint256 mindAmount, uint256 protocolAmount)',
  'event MindFunded(address indexed token, address indexed from, uint256 amount)',
  'event Harvested(address indexed token, uint256 ethOut, uint256 tokensBurned)',
  'event ComputeDrawn(address indexed token, uint256 amount, bytes32 receiptHash)',
  'event MemoryAnchored(address indexed token, uint64 indexed seq, bytes32 contentHash, string uri)',
  'event MindConfigUpdated(address indexed token, bytes32 modelId, bytes32 personaHash, string metadataURI)',
  'event MindStatusChanged(address indexed token, uint8 status)',
  'event ProtocolFeesWithdrawn(address indexed to, uint256 amount)',
  'event OperatorUpdated(address newOperator)',
  'event TreasuryUpdated(address newTreasury)',
  'event ComputeTreasuryUpdated(address newComputeTreasury)',
  'event GraduatorUpdated(address newGraduator)',
  'event FeeParamsUpdated(uint16 tradeFeeBps, uint16 mindShareBps, uint16 graduationFeeBps)',
  'event CreationFeeUpdated(uint256 newCreationFee)',
  'event DrawLimitUpdated(uint256 maxPerEpoch, uint32 epochSeconds)',
  'event GraduationGraceUpdated(uint32 graceSeconds)',
  // inherited (Ownable2Step, Pausable)
  'event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)',
  'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
  'event Paused(address account)',
  'event Unpaused(address account)',
  // ---------------------------------------------------------------- errors
  'error NotAMind()',
  'error WrongPhase()',
  'error Slippage()',
  'error Expired()',
  'error ZeroAmount()',
  'error ExceedsTokensSold()',
  'error NotCreator()',
  'error NotOperator()',
  'error InvalidStatus()',
  'error InvalidName()',
  'error InvalidSymbol()',
  'error MetadataTooLong()',
  'error InvalidModel()',
  'error InsufficientCreationFee()',
  'error InsufficientMindBalance()',
  'error DrawLimitExceeded()',
  'error InvalidDrawLimit()',
  'error InvalidGraduationGrace()',
  'error InvalidGraduator()',
  'error RenounceDisabled()',
  // bubbled up from UniswapV3Graduator.graduate: the coin stays Complete, graduate can be retried later
  'error PoolPriceSkewed(uint160 expectedSqrtPriceX96, uint160 actualSqrtPriceX96)',
  'error FeeTooHigh()',
  'error ZeroAddress()',
  'error EthTransferFailed()',
  'error GraduatorNotSet()',
  'error EthReturnMismatch()',
  'error DirectEthNotAccepted()',
  // inherited / library
  'error OwnableUnauthorizedAccount(address account)',
  'error OwnableInvalidOwner(address owner)',
  'error EnforcedPause()',
  'error ExpectedPause()',
  'error ReentrancyGuardReentrantCall()',
  'error SafeERC20FailedOperation(address token)',
  'error SafeCastOverflowedUintDowncast(uint8 bits, uint256 value)',
  // ---------------------------------------------------------------- user
  'function createMind(string name, string symbol, string metadataURI, bytes32 modelId, bytes32 personaHash, uint256 minTokensOut) payable returns (address token)',
  'function buy(address token, uint256 minTokensOut, uint256 deadline) payable returns (uint256 tokensOut)',
  'function sell(address token, uint256 tokensIn, uint256 minEthOut, uint256 deadline) returns (uint256 ethOut)',
  'function graduate(address token)',
  'function harvest(address token)',
  'function fundMind(address token) payable',
  // ---------------------------------------------------------------- creator
  'function setMindConfig(address token, bytes32 modelId, bytes32 personaHash, string metadataURI)',
  'function setCreatorPaused(address token, bool paused)',
  // ---------------------------------------------------------------- operator
  'function drawCompute(address token, uint256 amount, bytes32 receiptHash)',
  'function anchorMemory(address token, uint64 seq, bytes32 contentHash, string uri)',
  'function setMindStatus(address token, uint8 status)',
  // ---------------------------------------------------------------- owner
  'function setOperator(address newOperator)',
  'function setTreasury(address newTreasury)',
  'function setComputeTreasury(address newComputeTreasury)',
  'function setGraduator(address newGraduator)',
  'function setFeeParams(FeeParams params)',
  'function setCreationFee(uint256 newCreationFee)',
  'function setDrawLimit(uint256 maxPerEpoch, uint32 epochSeconds)',
  'function setGraduationGrace(uint32 graceSeconds)',
  'function pause()',
  'function unpause()',
  // ---------------------------------------------------------------- owner or treasury
  'function withdrawProtocolFees(address to)',
  // ---------------------------------------------------------------- views
  'function quoteBuy(address token, uint256 ethIn) view returns (uint256 tokensOut, uint256 ethUsed, uint256 fee)',
  'function quoteSell(address token, uint256 tokensIn) view returns (uint256 ethOut, uint256 fee)',
  'function currentPrice(address token) view returns (uint256 weiPer1e18Tokens)',
  'function getMind(address token) view returns (MindInfo)',
  'function getCurve(address token) view returns (CurveState)',
  'function mindBalance(address token) view returns (uint256)',
  'function protocolBalance() view returns (uint256)',
  'function mindsLength() view returns (uint256)',
  'function mindAt(uint256 index) view returns (address)',
  'function isMind(address token) view returns (bool)',
  'function feeParams() view returns (FeeParams)',
  'function creationFee() view returns (uint256)',
  'function drawLimit() view returns (uint256 maxPerEpoch, uint32 epochSeconds)',
  'function drawnInEpoch(address token) view returns (uint256 drawn, uint64 epochStart)',
  'function operator() view returns (address)',
  'function treasury() view returns (address)',
  'function computeTreasury() view returns (address)',
  'function graduator() view returns (address)',
  'function graduatorOf(address token) view returns (address)',
  // 0 while never completed or after a post-grace sell reopened the curve; kept after graduation
  'function completedAt(address token) view returns (uint64)',
  'function graduationGrace() view returns (uint32)',
  'function TOTAL_SUPPLY() view returns (uint256)',
  'function CURVE_SUPPLY() view returns (uint256)',
  'function LP_SUPPLY() view returns (uint256)',
  'function VIRTUAL_ETH() view returns (uint256)',
  'function VIRTUAL_TOKENS() view returns (uint256)',
  // inherited (Ownable2Step, Pausable)
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function transferOwnership(address newOwner)',
  'function acceptOwnership()',
  'function renounceOwnership()',
  'function paused() view returns (bool)',
] as const;

/** Parsed ABI of `MindLaunchpad`. Fully typed for viem / wagmi. */
export const mindLaunchpadAbi = parseAbi(mindLaunchpadAbiSignatures);

/** Human-readable signatures of `MindToken` (ERC20 + ERC20Permit + `launchpad()` / `creator()`, §2.1). */
export const mindTokenAbiSignatures = [
  'constructor(string name, string symbol, address launchpad, address creator)',
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
  // OpenZeppelin ShortStrings (EIP712 name/version), present in the compiled ABI
  'error InvalidShortString()',
  'error StringTooLong(string str)',
] as const;

/** Parsed ABI of `MindToken` (§2.1). */
export const mindTokenAbi = parseAbi(mindTokenAbiSignatures);

/**
 * Human-readable signatures of `IGraduator` (§2.2) plus the `UniswapV3Graduator` event and the
 * errors of both implementations (§2.4, §2.5), so clients can decode graduation reverts.
 */
export const graduatorAbiSignatures = [
  'function launchpad() view returns (address)',
  // the graduator sends `ethReturned` back to the launchpad (plain call → gated receive()) before returning
  'function graduate(address token, uint256 tokenAmount) payable returns (address pool, uint256 positionId, uint256 ethReturned)',
  'function harvest(address token) returns (uint256 ethOut, uint256 tokensBurned)',
  'event GraduatedAtSkewedPrice(address indexed token, uint160 expectedSqrtPriceX96, uint160 actualSqrtPriceX96)',
  'error NotLaunchpad()',
  'error AlreadyGraduated()',
  'error NoPosition()',
  'error UnexpectedEthSender()',
  'error UnsupportedFeeTier()',
  'error ZeroAddress()',
  'error EthTransferFailed()',
  'error PoolPriceSkewed(uint160 expectedSqrtPriceX96, uint160 actualSqrtPriceX96)',
  'error UnauthorizedCallback()',
  'error InvalidPriceTolerance()',
] as const;

/** Parsed ABI of `IGraduator` (+ `GraduatedAtSkewedPrice` and implementation errors). */
export const graduatorAbi = parseAbi(graduatorAbiSignatures);

/** The address tokens are "burned" to by the graduator (§2.0). */
export const BURN_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const;
