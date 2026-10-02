/**
 * Launchpad ABI subset used by the web app, aligned with the contract directives D1-D10
 * (`setCreatorPaused`, `graduatorOf`, `MindStatus { Alive, Dormant, Paused }`, no
 * `retireMind` / `withdrawRetiredMind` / `creditMind` / `graduateFor`).
 *
 * LOCAL FALLBACK: `@www-rh/shared` exports the full `mindLaunchpadAbi`; this subset exists
 * because the shared ABI is being updated to the directives concurrently. Once shared ships
 * `setCreatorPaused` and the new errors, replace this module with a re-export.
 *
 * @module lib/abi
 */
import { parseAbi } from 'viem';

/** Human-readable signatures for the launchpad functions, events and errors the UI touches. */
export const launchpadAbiSignatures = [
  'struct MindInfo { address creator; bytes32 modelId; bytes32 personaHash; string metadataURI; uint64 createdAt; uint8 status; }',
  'struct CurveState { uint128 realEthReserve; uint128 tokensSold; uint8 phase; address pool; uint256 positionId; }',
  'struct FeeParams { uint16 tradeFeeBps; uint16 mindShareBps; uint16 graduationFeeBps; }',
  // --- user ---
  'function createMind(string name, string symbol, string metadataURI, bytes32 modelId, bytes32 personaHash, uint256 minTokensOut) payable returns (address token)',
  'function buy(address token, uint256 minTokensOut, uint256 deadline) payable returns (uint256 tokensOut)',
  'function sell(address token, uint256 tokensIn, uint256 minEthOut, uint256 deadline) returns (uint256 ethOut)',
  'function graduate(address token)',
  'function harvest(address token)',
  'function fundMind(address token) payable',
  // --- creator ---
  'function setMindConfig(address token, bytes32 modelId, bytes32 personaHash, string metadataURI)',
  'function setCreatorPaused(address token, bool paused)',
  // --- views ---
  'function quoteBuy(address token, uint256 ethIn) view returns (uint256 tokensOut, uint256 ethUsed, uint256 fee)',
  'function quoteSell(address token, uint256 tokensIn) view returns (uint256 ethOut, uint256 fee)',
  'function currentPrice(address token) view returns (uint256 weiPer1e18Tokens)',
  'function getMind(address token) view returns (MindInfo info)',
  'function getCurve(address token) view returns (CurveState curve)',
  'function mindBalance(address token) view returns (uint256)',
  'function feeParams() view returns (FeeParams params)',
  'function creationFee() view returns (uint256)',
  'function graduator() view returns (address)',
  'function graduatorOf(address token) view returns (address)',
  'function paused() view returns (bool)',
  // --- events ---
  'event MindCreated(address indexed token, address indexed creator, string name, string symbol, string metadataURI, bytes32 modelId, bytes32 personaHash)',
  'event Trade(address indexed token, address indexed trader, bool isBuy, uint256 ethAmount, uint256 tokenAmount, uint256 fee, uint256 realEthReserve, uint256 tokensSold)',
  'event MindFunded(address indexed token, address indexed from, uint256 amount)',
  'event Graduated(address indexed token, address pool, uint256 positionId, uint256 ethLiquidity, uint256 tokenLiquidity, uint256 graduationFee)',
  'event MindConfigUpdated(address indexed token, bytes32 modelId, bytes32 personaHash, string metadataURI)',
  'event MindStatusChanged(address indexed token, uint8 status)',
  // --- errors (decoded into readable messages by lib/errors.ts) ---
  'error NotAMind()',
  'error WrongPhase()',
  'error Slippage()',
  'error Expired()',
  'error ZeroAmount()',
  'error NotCreator()',
  'error NotOperator()',
  'error NotGraduator()',
  'error InvalidStatus()',
  'error InsufficientMindBalance()',
  'error InsufficientCreationFee()',
  'error GraduatorNotSet()',
  'error DirectEthNotAccepted()',
  'error ZeroAddress()',
  'error EthTransferFailed()',
  'error EnforcedPause()',
  'error ReentrancyGuardReentrantCall()',
  'error SafeERC20FailedOperation(address token)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
] as const;

/** Parsed launchpad ABI (typed for viem / wagmi). */
export const launchpadAbi = parseAbi(launchpadAbiSignatures);

/** On-chain `MindStatus` enum values (D4). */
export const MIND_STATUS = { Alive: 0, Dormant: 1, Paused: 2 } as const;

/** On-chain `CurvePhase` enum values. */
export const CURVE_PHASE = { Bonding: 0, Complete: 1, Graduated: 2 } as const;
