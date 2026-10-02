/**
 * Known per-chain addresses (SPEC §3 `addresses.ts`, from `docs/ROBINHOOD_CHAIN.md`) and the
 * `launchpadAddress(chainId)` lookup that reads `contracts/deployments/<chainId>.json` when run
 * under Node. The file lookup uses `process.getBuiltinModule` so this module stays
 * browser-safe (no static `node:fs` import).
 *
 * @module addresses
 */
import { getAddress, isAddress, type Address } from 'viem';
import { ANVIL_CHAIN_ID, ROBINHOOD_CHAIN_ID, ROBINHOOD_TESTNET_CHAIN_ID } from './chains.js';

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
 * Shape of `contracts/deployments/<chainId>.json` written by `script/Deploy.s.sol`.
 * Only `launchpad` is required; other fields are informative.
 */
export interface DeploymentRecord {
  chainId?: number;
  launchpad: Address;
  graduator?: Address;
  graduatorKind?: 'uniswapv3' | 'mock' | string;
  owner?: Address;
  treasury?: Address;
  operator?: Address;
  weth9?: Address;
  deployedAt?: string | number;
  blockNumber?: number;
  [extra: string]: unknown;
}

/**
 * Extracts and checksums the launchpad address from a parsed deployment JSON. Accepts the
 * keys `launchpad`, `MindLaunchpad` or `launchpadAddress` for robustness against the deploy script.
 */
export function launchpadAddressFromDeployment(deployment: unknown): Address | undefined {
  if (deployment === null || typeof deployment !== 'object') return undefined;
  const rec = deployment as Record<string, unknown>;
  const candidate = rec['launchpad'] ?? rec['MindLaunchpad'] ?? rec['launchpadAddress'];
  return typeof candidate === 'string' && isAddress(candidate) ? getAddress(candidate) : undefined;
}

/** Options for {@link launchpadAddress}. */
export interface LaunchpadAddressOptions {
  /**
   * Directory containing `<chainId>.json`. Defaults to `<repo>/contracts/deployments`, resolved
   * relative to this module (`packages/shared/{src,dist}/addresses.js`).
   */
  deploymentsDir?: string;
  /** Explicit override (e.g. from `LAUNCHPAD_ADDRESS` env); returned when it is a non-zero address. */
  override?: string | undefined;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

interface MinimalFs {
  existsSync(path: string): boolean;
  readFileSync(path: string, encoding: 'utf8'): string;
}
interface MinimalPath {
  resolve(...segments: string[]): string;
  dirname(path: string): string;
}

/** Lazily loads node builtins without a static import so bundlers keep this module browser-safe. */
function nodeBuiltins(): { fs: MinimalFs; path: MinimalPath } | undefined {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  const get = proc?.getBuiltinModule;
  if (typeof get !== 'function') return undefined;
  const fs = get('node:fs') as MinimalFs | undefined;
  const path = get('node:path') as MinimalPath | undefined;
  return fs && path ? { fs, path } : undefined;
}

/** Default `contracts/deployments` directory, resolved relative to this module. */
export function defaultDeploymentsDir(): string | undefined {
  const node = nodeBuiltins();
  if (!node) return undefined;
  const here = new URL('.', import.meta.url);
  if (here.protocol !== 'file:') return undefined;
  const dir = decodeURIComponent(here.pathname);
  // <repo>/packages/shared/{src|dist}/ -> <repo>/contracts/deployments
  return node.path.resolve(dir, '..', '..', '..', 'contracts', 'deployments');
}

/**
 * Returns the deployed `MindLaunchpad` address for `chainId`.
 *
 * Resolution order: `options.override` (if a non-zero address) → `<deploymentsDir>/<chainId>.json`
 * (if readable under Node) → `undefined`. Never throws on a missing or malformed file.
 */
export function launchpadAddress(chainId: number, options: LaunchpadAddressOptions = {}): Address | undefined {
  const override = options.override;
  if (typeof override === 'string' && isAddress(override) && override.toLowerCase() !== ZERO_ADDRESS) {
    return getAddress(override);
  }
  const node = nodeBuiltins();
  if (!node) return undefined;
  const dir = options.deploymentsDir ?? defaultDeploymentsDir();
  if (dir === undefined) return undefined;
  const file = node.path.resolve(dir, `${chainId}.json`);
  try {
    if (!node.fs.existsSync(file)) return undefined;
    const parsed: unknown = JSON.parse(node.fs.readFileSync(file, 'utf8'));
    return launchpadAddressFromDeployment(parsed);
  } catch {
    return undefined;
  }
}
