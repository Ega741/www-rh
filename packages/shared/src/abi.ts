/**
 * Human-readable ABIs (viem `parseAbi`) for the www-rh contracts — `docs/SPEC.md` §2 and §3.3.
 *
 * Enums (`CurvePhase`, `MindStatus`) are `uint8` at the ABI level; their numeric values are
 * exported as const objects below. Event parameter names, struct field names and named outputs
 * match §2 exactly because viem decodes by name. A vitest test compares selectors / topics with
 * the compiled artifacts copied by `pnpm abi:sync` (`packages/shared/abi/*.json`).
 *
 * Pons mode (§9): `ponsMindRegistryAbi`, `mindAccountAbi` and the minimal Pons V2 ABIs
 * (`ponsFactoryAbi`, `ponsCurveAbi`, `ponsFeeEscrowAbi`, `ponsMemeHookAbi`) derived from the verified
 * mainnet contracts, with exactly the members `docs/SPEC.md` §9.1 lists.
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

// =====================================================================================================
// Pons mode (docs/SPEC.md §9)
// =====================================================================================================

/**
 * `enum GraduationPhase { NotGraduated, Swept, PoolCreated, Rescued }` of `PonsV2LaunchFactory`
 * (`getLaunchedToken(token).phase`). Wire mapping (§9.3): `NotGraduated` → `bonding`, `Swept` →
 * `complete`, `PoolCreated` / `Rescued` → `graduated`.
 */
export const PonsGraduationPhase = {
  NotGraduated: 0,
  Swept: 1,
  PoolCreated: 2,
  Rescued: 3,
} as const;
export type PonsGraduationPhase = (typeof PonsGraduationPhase)[keyof typeof PonsGraduationPhase];

/**
 * Venue-independent `MindCore` surface (§9.2, = `IMindCore` + the inherited OpenZeppelin surface):
 * roles, mind registry, vault, compute draws, memory anchors, status and config. Shared verbatim by
 * {@link ponsMindRegistryAbiSignatures}; every entry has the same selector / topic as on
 * `MindLaunchpad`.
 */
const mindCoreAbiSignatures = [
  'struct MindInfo { address creator; bytes32 modelId; bytes32 personaHash; string metadataURI; uint64 createdAt; uint8 status; }',
  // ---------------------------------------------------------------- events
  'event MindCreated(address indexed token, address indexed creator, string name, string symbol, string metadataURI, bytes32 modelId, bytes32 personaHash)',
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
  'event CreationFeeUpdated(uint256 newCreationFee)',
  'event DrawLimitUpdated(uint256 maxPerEpoch, uint32 epochSeconds)',
  'event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)',
  'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
  'event Paused(address account)',
  'event Unpaused(address account)',
  // ---------------------------------------------------------------- errors
  'error NotAMind()',
  'error ZeroAmount()',
  'error NotCreator()',
  'error NotOperator()',
  'error InvalidStatus()',
  'error InvalidName()',
  'error InvalidSymbol()',
  'error MetadataTooLong()',
  'error InvalidModel()',
  'error InsufficientMindBalance()',
  'error DrawLimitExceeded()',
  'error InvalidDrawLimit()',
  'error RenounceDisabled()',
  'error FeeTooHigh()',
  'error ZeroAddress()',
  'error EthTransferFailed()',
  'error EthReturnMismatch()',
  'error DirectEthNotAccepted()',
  'error OwnableUnauthorizedAccount(address account)',
  'error OwnableInvalidOwner(address owner)',
  'error EnforcedPause()',
  'error ExpectedPause()',
  'error ReentrancyGuardReentrantCall()',
  // ---------------------------------------------------------------- user / creator / operator / owner
  'function fundMind(address token) payable',
  'function setMindConfig(address token, bytes32 modelId, bytes32 personaHash, string metadataURI)',
  'function setCreatorPaused(address token, bool paused)',
  'function drawCompute(address token, uint256 amount, bytes32 receiptHash)',
  'function anchorMemory(address token, uint64 seq, bytes32 contentHash, string uri)',
  'function setMindStatus(address token, uint8 status)',
  'function setOperator(address newOperator)',
  'function setTreasury(address newTreasury)',
  'function setComputeTreasury(address newComputeTreasury)',
  'function setCreationFee(uint256 newCreationFee)',
  'function setDrawLimit(uint256 maxPerEpoch, uint32 epochSeconds)',
  'function pause()',
  'function unpause()',
  'function withdrawProtocolFees(address to)',
  // ---------------------------------------------------------------- views
  'function getMind(address token) view returns (MindInfo)',
  'function mindBalance(address token) view returns (uint256)',
  'function protocolBalance() view returns (uint256)',
  'function mindsLength() view returns (uint256)',
  'function mindAt(uint256 index) view returns (address)',
  'function isMind(address token) view returns (bool)',
  'function creationFee() view returns (uint256)',
  'function drawLimit() view returns (uint256 maxPerEpoch, uint32 epochSeconds)',
  'function drawnInEpoch(address token) view returns (uint256 drawn, uint64 epochStart)',
  'function operator() view returns (address)',
  'function treasury() view returns (address)',
  'function computeTreasury() view returns (address)',
  // inherited (Ownable2Step, Pausable)
  'function owner() view returns (address)',
  'function pendingOwner() view returns (address)',
  'function transferOwnership(address newOwner)',
  'function acceptOwnership()',
  // always reverts RenounceDisabled()
  'function renounceOwnership() pure',
  'function paused() view returns (bool)',
] as const;

/**
 * Human-readable signatures of `PonsMindRegistry` (§9.2): the `MindCore` surface plus the Pons
 * integration (launch, adoption, leave, harvest, pool id, views, events, errors).
 */
export const ponsMindRegistryAbiSignatures = [
  ...mindCoreAbiSignatures,
  'struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }',
  'struct LaunchParams { string name; string symbol; string logo; string description; Socials socials; uint16 creatorTaxBps; bytes32 expectedEconomics; bytes32 salt; uint256 launchConfigId; }',
  'struct PonsMind { address curve; address account; uint256 launchConfigId; bool launchedHere; bool adopted; }',
  'constructor(address initialOwner, address treasury, address computeTreasury, address operator, address factory, address feeEscrow, address memeHook)',
  // accepts ETH only from the Pons curve (buy refunds) / mind account (claims) the registry is calling
  'receive() external payable',
  // ---------------------------------------------------------------- events
  'event MindLaunched(address indexed token, address indexed curve, address indexed account, address creator, uint256 launchConfigId)',
  'event AdoptionPrepared(address indexed token, address indexed account, address indexed creator)',
  'event MindAdopted(address indexed token, address indexed account)',
  'event MindLeft(address indexed token, address newRecipient)',
  'event SweepAttempted(address indexed token, bool curveSwept, bool poolSwept)',
  'event PoolIdSet(address indexed token, bytes32 poolId)',
  'event MindFeeUpdated(uint16 bps)',
  // ---------------------------------------------------------------- errors
  'error AccountExists()',
  'error NotPonsLaunch()',
  'error NotRecipientOrDeployer()',
  'error AdoptionNotReady()',
  'error AlreadyAdopted()',
  'error WrongValue()',
  'error LaunchFailed()',
  // OpenZeppelin Clones / Errors and SafeCast, present in the compiled ABI
  'error FailedDeployment()',
  'error InsufficientBalance(uint256 balance, uint256 needed)',
  'error SafeCastOverflowedUintDowncast(uint8 bits, uint256 value)',
  // ---------------------------------------------------------------- creator
  // msg.value == factory.launchFee() + quoteIn + creationFee()
  'function launchMind(LaunchParams p, uint256 quoteIn, uint256 minTokensOut, bytes32 modelId, bytes32 personaHash, string metadataURI) payable returns (address token, address curve, address account)',
  'function prepareAdoption(address token, bytes32 modelId, bytes32 personaHash, string metadataURI) returns (address account)',
  'function activateAdoption(address token)',
  'function leave(address token, address newRecipient)',
  // ---------------------------------------------------------------- permissionless / operator / owner
  'function harvest(address token)',
  'function createGraduatedPool(address token)',
  'function setPoolId(address token, bytes32 poolId)',
  'function setMindFeeBps(uint16 bps)',
  // ---------------------------------------------------------------- views
  'function ponsMind(address token) view returns (PonsMind)',
  'function accountOf(address token) view returns (address)',
  'function tokenOf(address account) view returns (address)',
  'function predictAccount(address creator, bytes32 salt) view returns (address)',
  'function predictAdoptionAccount(address token) view returns (address)',
  'function claimable(address token) view returns (uint256)',
  // pool id recorded with setPoolId (0 before)
  'function poolIdOf(address token) view returns (bytes32)',
  'function launchQuote(uint256 launchConfigId, uint256 quoteIn) view returns (uint256 launchFee, uint256 total, bytes32 economics)',
  'function factory() view returns (address)',
  'function feeEscrow() view returns (address)',
  'function memeHook() view returns (address)',
  'function accountImplementation() view returns (address)',
  'function mindFeeBps() view returns (uint16)',
] as const;

/** Parsed ABI of `PonsMindRegistry` (§9.2). */
export const ponsMindRegistryAbi = parseAbi(ponsMindRegistryAbiSignatures);

/**
 * Human-readable signatures of `MindAccount` (§9.2): the per-mind creator-fee recipient (EIP-1167
 * clone). `sweepCurve` (the account sweeps the curve as its creator fee recipient) is part of the
 * compiled contract in addition to the §9.2 list.
 */
export const mindAccountAbiSignatures = [
  'function initialize(address registry)',
  'function registry() view returns (address)',
  // accepts ETH from anyone (escrow payouts)
  'receive() external payable',
  // registry only: escrow.claim(), then forwards the whole balance to the registry; returns the amount sent
  'function claim(address escrow) returns (uint256 amount)',
  // registry only: curve.sweepFees as the curve's creator fee recipient
  'function sweepCurve(address curve, uint256 minBuybackTokensOut)',
  'function sweepPool(address hook, bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut)',
  'function transferFeeRecipient(address factory, address token, address to)',
  'error AlreadyInitialized()',
  'error NotRegistry()',
  'error ZeroAddress()',
  'error EthTransferFailed()',
] as const;

/** Parsed ABI of `MindAccount` (§9.2). */
export const mindAccountAbi = parseAbi(mindAccountAbiSignatures);

/**
 * `PonsV2LaunchFactory` members used by www-rh (§9.1; signatures from the verified mainnet
 * contract). `launchConfigCount()` is added for `GET /api/launch-config` (§9.4).
 */
export const ponsFactoryAbiSignatures = [
  'struct Socials { string twitter; string telegram; string discord; string website; string farcaster; }',
  'struct TokenParams { string name; string symbol; string logo; string description; Socials socials; address creatorFeeRecipient; uint16 creatorTaxBps; bool buybackEnabled; bytes32 expectedEconomics; bytes32 salt; }',
  'struct LaunchConfig { uint256 supply; uint256 curveFeeBps; uint256 phantomQuote; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; bool enabled; }',
  'struct LaunchedToken { address token; address curve; address deployer; address creatorFeeRecipient; address pairToken; uint256 graduationThreshold; uint24 poolFee; int24 tickSpacing; uint16 creatorTaxBps; bool buybackEnabled; uint8 phase; uint256 sweptQuote; uint256 sweptTokens; uint256 sweptAt; bool exists; }',
  // msg.value == launchFee(); salt namespaced as keccak256(deployer, salt)
  'function launchToken(TokenParams params, uint256 launchConfigId, address pairToken, address[] snipeTaxExemptions) payable returns (address token, address curve)',
  'function launchFee() view returns (uint256)',
  // launchEnabled || whitelistedLaunchers[launcher]
  'function canLaunch(address launcher) view returns (bool)',
  'function launchEnabled() view returns (bool)',
  'function whitelistedLaunchers(address launcher) view returns (bool enabled)',
  'function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)',
  'function launchConfigCount() view returns (uint256)',
  'function getLaunchConfig(uint256 id) view returns (LaunchConfig)',
  'function maxCreatorTaxBps() view returns (uint256)',
  'function snipeTaxSeconds() view returns (uint256)',
  'function getLaunchedToken(address token) view returns (LaunchedToken)',
  // permissionless once the launch is Swept: seeds the locked full-range Uniswap v4 pool (phase PoolCreated)
  'function createGraduatedPool(address token) returns (uint256 positionId)',
  // by the current creatorFeeRecipient (also after graduation)
  'function transferCreatorFeeRecipient(address token, address newRecipient)',
  'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
  'event LaunchSwept(address indexed token, uint256 quoteOut, uint256 tokenOut)',
  'event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)',
  'event CreatorFeeRecipientUpdated(address indexed token, address indexed previousRecipient, address indexed newRecipient)',
] as const;

/** Parsed ABI of the `PonsV2LaunchFactory` members used by www-rh (§9.1). */
export const ponsFactoryAbi = parseAbi(ponsFactoryAbiSignatures);

/** `PonsV2BondingCurve` members used by www-rh (§9.1; one curve per launch, native quote). */
export const ponsCurveAbiSignatures = [
  // native quote: msg.value == quoteIn; the unspent quote of a capped buy is refunded to msg.sender
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)',
  // quote includes the phantom reserve and excludes pending fees / creator tax
  'function getReserves() view returns (uint256 quoteReserve_, uint256 tokenReserve_)',
  'function sellableTokens() view returns (uint256)',
  'function feeBps() view returns (uint256)',
  'function creatorTaxBps() view returns (uint256)',
  'function graduated() view returns (bool)',
  'function readyToGraduate() view returns (bool)',
  'function graduationThreshold() view returns (uint256)',
  'function realQuoteReserve() view returns (uint256)',
  // Pons feeSweepOperator or the launch deployer
  'function sweepFees(uint256 minBuybackTokensOut)',
  'event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 fee, uint256 tax)',
  'event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 fee, uint256 tax)',
  'event CurveBuyRefunded(address indexed buyer, uint256 refund)',
  'event FeesSwept(uint256 protocolAmount, uint256 buybackAmount, uint256 creatorAmount)',
  'event CurveCompleted(address recipient, uint256 quoteOut, uint256 tokenOut)',
] as const;

/** Parsed ABI of the `PonsV2BondingCurve` members used by www-rh (§9.1). */
export const ponsCurveAbi = parseAbi(ponsCurveAbiSignatures);

/** `IPonsV2FeeEscrow` members used by www-rh (§9.1): native-ETH ledger of claimable creator fees. */
export const ponsFeeEscrowAbiSignatures = [
  'function credit(address recipient) payable',
  // pays msg.sender its whole balance by ETH call
  'function claim() returns (uint256 amount)',
  'function balanceOf(address recipient) view returns (uint256)',
  'event Credited(address indexed recipient, address indexed depositor, uint256 amount)',
  'event Claimed(address indexed recipient, uint256 amount)',
] as const;

/** Parsed ABI of the `IPonsV2FeeEscrow` members used by www-rh (§9.1). */
export const ponsFeeEscrowAbi = parseAbi(ponsFeeEscrowAbiSignatures);

/**
 * `PonsV2MemeHook` members used by www-rh (§9.1). `PoolFeesSwept` is declared as on the verified
 * mainnet contract (`poolId, protocolAmount, buybackAmount, creatorAmount, tokensLocked`).
 */
export const ponsMemeHookAbiSignatures = [
  // Pons feeSweepOperator or the pool's creator (= creatorFeeRecipient at registerPool)
  'function sweepPoolFees(bytes32 poolId, uint256 minConversionQuoteOut, uint256 minBuybackTokensOut)',
  'event PoolRegistered(bytes32 indexed poolId, address memecoin, address quoteToken, address creator)',
  'event PoolFeesSwept(bytes32 indexed poolId, uint256 protocolAmount, uint256 buybackAmount, uint256 creatorAmount, uint256 tokensLocked)',
] as const;

/** Parsed ABI of the `PonsV2MemeHook` members used by www-rh (§9.1). */
export const ponsMemeHookAbi = parseAbi(ponsMemeHookAbiSignatures);
