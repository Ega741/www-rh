/**
 * Known per-chain addresses (SPEC §3 `addresses.ts`, from `docs/ROBINHOOD_CHAIN.md`) and the
 * deployed launchpad lookup (directive R13).
 *
 * This module never reads files at runtime: deployments come from `deployments.generated.ts`,
 * which `scripts/sync-deployments.mjs` generates from `contracts/deployments/*.json`. Environment
 * overrides (`LAUNCHPAD_ADDRESS`, `VITE_LAUNCHPAD_ADDRESS`) are handled by the consumer, optionally
 * via the `override` option of {@link launchpadAddress}.
 *
 * @module addresses
 */
import { getAddress, isAddress, type Address } from 'viem';
import { ANVIL_CHAIN_ID, ROBINHOOD_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID } from './chains.js';
import { DEPLOYMENTS } from './deployments.generated.js';

/** Protocol addresses known for a chain. */
export interface ChainAddresses {
  weth9?: Address;
  uniswapV3Factory?: Address;
  uniswapV3PositionManager?: Address;
  uniswapV3SwapRouter02?: Address;
  uniswapV3QuoterV2?: Address;
  uniswapV3TickLens?: Address;
  uniswapV3PoolInitCodeHash?: `0x${string}`;
  uniswapV2Factory?: Address;
  uniswapV2Router02?: Address;
  uniswapV4PoolManager?: Address;
  uniswapV4PositionManager?: Address;
  universalRouter?: Address;
  permit2?: Address;
  /** Uniswap v3 fee tier used by `UniswapV3Graduator` (10000 = 1 %). */
  uniswapV3FeeTier: number;
}

/** Default Uniswap v3 fee tier for graduation pools (1 %). */
export const DEFAULT_UNIV3_FEE_TIER = 10_000;

/** Robinhood Chain mainnet (4663) protocol addresses. */
export const ROBINHOOD_ADDRESSES: Readonly<ChainAddresses> = Object.freeze({
  weth9: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
  uniswapV3Factory: '0x1f7d7550B1b028f7571E69A784071F0205FD2EfA',
  uniswapV3PositionManager: '0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3',
  uniswapV3SwapRouter02: getAddress('0xcaf681a66d020601342297493863e78c959e5cb2'),
  uniswapV3QuoterV2: getAddress('0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7'),
  uniswapV3TickLens: getAddress('0x7dfd4f31be6814d2906bde155c3e1b146eac1468'),
  uniswapV3PoolInitCodeHash: '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54',
  uniswapV2Factory: '0x8bcEaA40B9AcdfAedF85AdF4FF01F5Ad6517937f',
  uniswapV2Router02: getAddress('0x89e5db8b5aa49aa85ac63f691524311aeb649eba'),
  uniswapV4PoolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
  uniswapV4PositionManager: '0x58daec3116aae6D93017bAAea7749052E8a04fA7',
  universalRouter: '0x204FAca1764B154221e35c0d20aBb3c525710498',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  uniswapV3FeeTier: DEFAULT_UNIV3_FEE_TIER,
} satisfies ChainAddresses);

/** Robinhood Chain testnet (46630). No public Uniswap v3 deployment is known: use `MockGraduator`. */
export const ROBINHOOD_TESTNET_ADDRESSES: Readonly<ChainAddresses> = Object.freeze({
  weth9: '0x7943e237c7F95DA44E0301572D358911207852Fa',
  uniswapV3FeeTier: DEFAULT_UNIV3_FEE_TIER,
} satisfies ChainAddresses);

/** Local anvil: nothing pre-deployed. */
export const ANVIL_ADDRESSES: Readonly<ChainAddresses> = Object.freeze({
  uniswapV3FeeTier: DEFAULT_UNIV3_FEE_TIER,
} satisfies ChainAddresses);

/** Known addresses keyed by chain id. */
export const ADDRESSES: Readonly<Record<number, Readonly<ChainAddresses>>> = Object.freeze({
  [ROBINHOOD_CHAIN_ID]: ROBINHOOD_ADDRESSES,
  [ROBINHOOD_TESTNET_CHAIN_ID]: ROBINHOOD_TESTNET_ADDRESSES,
  [ANVIL_CHAIN_ID]: ANVIL_ADDRESSES,
});

/** Returns the known addresses for `chainId`, or `undefined`. */
export function addressesFor(chainId: number): Readonly<ChainAddresses> | undefined {
  return ADDRESSES[chainId];
}

/**
 * One entry of {@link DEPLOYMENTS}, generated from `contracts/deployments/<chainId>.json`
 * (written by `script/Deploy.s.sol`; keys per D11).
 */
export interface DeploymentRecord {
  chainId: number;
  launchpad: Address;
  graduator?: Address;
  /** `uniswapv3` | `mock` (free-form for forward compatibility). */
  graduatorKind?: string;
  /** As written by the deploy script (timestamp or ISO string). */
  deployedAt?: string | number;
  /** Deployment block, when the deploy script records it (used as the indexer's default start block). */
  blockNumber?: number;
}

export { DEPLOYMENTS };

/** The generated deployment record for `chainId`, or `undefined`. */
export function deploymentFor(chainId: number): DeploymentRecord | undefined {
  return DEPLOYMENTS[chainId];
}

/**
 * Extracts and checksums the launchpad address from a parsed deployment JSON. Accepts the
 * keys `launchpad`, `MindLaunchpad` or `launchpadAddress` for robustness against the deploy script.
 */
export function launchpadAddressFromDeployment(deployment: unknown): Address | undefined {
  if (deployment === null || typeof deployment !== 'object') return undefined;
  const rec = deployment as Record<string, unknown>;
  const candidate = rec['launchpad'] ?? rec['MindLaunchpad'] ?? rec['launchpadAddress'];
  return typeof candidate === 'string' && isAddress(candidate, { strict: false }) ? getAddress(candidate) : undefined;
}

/** Options for {@link launchpadAddress}. */
export interface LaunchpadAddressOptions {
  /**
   * Explicit override supplied by the consumer (e.g. from `LAUNCHPAD_ADDRESS` /
   * `VITE_LAUNCHPAD_ADDRESS`); returned when it is a non-zero address.
   */
  override?: string | undefined;
}

const ZERO = '0x0000000000000000000000000000000000000000';

/**
 * Returns the deployed `MindLaunchpad` address for `chainId`.
 *
 * Resolution order: `options.override` (if a non-zero address) → {@link DEPLOYMENTS}`[chainId]`
 * → `undefined`. Pure: never touches the filesystem or the environment.
 */
export function launchpadAddress(chainId: number, options: LaunchpadAddressOptions = {}): Address | undefined {
  const override = options.override;
  if (typeof override === 'string' && isAddress(override, { strict: false }) && override.toLowerCase() !== ZERO) {
    return getAddress(override);
  }
  const record = DEPLOYMENTS[chainId];
  return record === undefined ? undefined : launchpadAddressFromDeployment(record);
}
