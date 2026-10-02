/**
 * Runtime configuration derived from `VITE_*` variables (see `.env.example`).
 *
 * The pure `resolve*` functions take the env object explicitly so they can be unit-tested;
 * the exported constants bind them to `import.meta.env`.
 *
 * @module config
 */
import { chainById, launchpadAddress, registryAddress, robinhoodChainTestnet, withMulticall3 } from '@www-rh/shared';
import { isAddress, zeroAddress, type Address, type Chain } from 'viem';

/** The subset of `import.meta.env` the app reads. */
export interface WebEnv {
  DEV: boolean;
  VITE_CHAIN_ID?: string | undefined;
  VITE_LAUNCHPAD_ADDRESS?: string | undefined;
  VITE_RPC_URL?: string | undefined;
  VITE_RUNNER_URL?: string | undefined;
  VITE_RUNNER_WS?: string | undefined;
  VITE_WALLETCONNECT_PROJECT_ID?: string | undefined;
  VITE_MULTICALL?: string | undefined;
  VITE_VENUE?: string | undefined;
  VITE_REGISTRY_ADDRESS?: string | undefined;
}

/** Where coins live (SPEC §9): Pons V2 (`pons`, default) or the in-house `MindLaunchpad` curve (`curve`). */
export type Venue = 'pons' | 'curve';

function clean(value: string | undefined): string {
  return (value ?? '').trim();
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * HTTP API base (directive W1): `''` (same origin, Vite proxy) in dev; `VITE_RUNNER_URL` in prod.
 * Paths are appended as `/api/...`.
 */
export function resolveApiBase(env: WebEnv): string {
  if (env.DEV) return '';
  return stripSlash(clean(env.VITE_RUNNER_URL));
}

/**
 * WebSocket endpoint (directive W1 / SPEC §7). Dev: same-origin `/ws` through the Vite proxy.
 * Prod: `VITE_RUNNER_WS` when set, else the same-origin `/ws` URL.
 */
export function resolveWsBase(env: WebEnv, location: { protocol: string; host: string }): string {
  const sameOrigin = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
  if (env.DEV) return sameOrigin;
  const explicit = clean(env.VITE_RUNNER_WS);
  return explicit !== '' ? stripSlash(explicit) : sameOrigin;
}

/** Optional RPC override for the wagmi transport (`VITE_RPC_URL`); `undefined` = the chain's rpc url. */
export function resolveRpcUrl(env: WebEnv): string | undefined {
  const rpc = clean(env.VITE_RPC_URL);
  return rpc === '' ? undefined : rpc;
}

/**
 * The chain the app targets: `VITE_CHAIN_ID` resolved through `@www-rh/shared` chains
 * (default: Robinhood Chain Testnet). Multicall3 is declared only when `VITE_MULTICALL=1`
 * (`withMulticall3`, SPEC §7 / W5); any multicall3 entry of the base definition is removed
 * otherwise. The chain's public rpc urls are kept as-is (they are what "Add Robinhood Chain"
 * hands to the wallet); `VITE_RPC_URL` only affects the app's own transport.
 */
export function resolveChain(env: WebEnv): Chain {
  const id = Number(clean(env.VITE_CHAIN_ID) || robinhoodChainTestnet.id);
  const base = chainById(id) ?? robinhoodChainTestnet;
  const { contracts, ...rest } = base;
  const { multicall3: _unverified, ...otherContracts } = contracts ?? {};
  const chain: Chain = { ...rest, ...(Object.keys(otherContracts).length > 0 ? { contracts: otherContracts } : {}) };
  return clean(env.VITE_MULTICALL) === '1' ? withMulticall3(chain) : chain;
}

/**
 * The `MindLaunchpad` address: `VITE_LAUNCHPAD_ADDRESS` when set to a non-zero address, else the
 * generated deployment map in `@www-rh/shared` (`launchpadAddress(chainId)`), else `null`.
 */
export function resolveLaunchpad(env: WebEnv, chainId: number): Address | null {
  const fromEnv = clean(env.VITE_LAUNCHPAD_ADDRESS);
  if (fromEnv !== '' && isAddress(fromEnv, { strict: false }) && fromEnv.toLowerCase() !== zeroAddress) {
    return fromEnv as Address;
  }
  try {
    const fromShared = launchpadAddress(chainId);
    return fromShared !== undefined && fromShared.toLowerCase() !== zeroAddress ? fromShared : null;
  } catch {
    return null;
  }
}

/** `VITE_VENUE`: `curve` selects the in-house launchpad; anything else (default) is Pons mode (SPEC §9.5). */
export function resolveVenue(env: WebEnv): Venue {
  return clean(env.VITE_VENUE).toLowerCase() === 'curve' ? 'curve' : 'pons';
}

function nonZeroAddress(value: unknown): Address | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text !== '' && isAddress(text, { strict: false }) && text.toLowerCase() !== zeroAddress ? (text as Address) : null;
}

/**
 * The `PonsMindRegistry` address: `VITE_REGISTRY_ADDRESS` when set to a non-zero address, else the
 * generated deployment map in `@www-rh/shared` (`registryAddress(chainId)`, SPEC §9.3), else `null`.
 */
export function resolveRegistry(env: WebEnv, chainId: number): Address | null {
  const fromEnv = nonZeroAddress(env.VITE_REGISTRY_ADDRESS);
  if (fromEnv !== null) return fromEnv;
  try {
    return nonZeroAddress(registryAddress(chainId));
  } catch {
    return null;
  }
}

const env: WebEnv = import.meta.env;

/** Chain the app reads from and writes to. */
export const TARGET_CHAIN: Chain = resolveChain(env);
/** Venue of this build (SPEC §9.5). */
export const VENUE: Venue = resolveVenue(env);
/** Launchpad address, or `null` when not configured (curve mode: writes and reads are disabled). */
export const LAUNCHPAD_ADDRESS: Address | null = resolveLaunchpad(env, TARGET_CHAIN.id);
/** `PonsMindRegistry` address, or `null` when not configured (Pons mode: writes and reads are disabled). */
export const REGISTRY_ADDRESS: Address | null = resolveRegistry(env, TARGET_CHAIN.id);
/**
 * The contract holding the venue-independent MindCore surface (`getMind`, `mindBalance`,
 * `fundMind`, `setMindConfig`, `setCreatorPaused`, `creationFee`, `paused`): the registry in Pons
 * mode, the launchpad in curve mode. Both expose it with identical selectors (SPEC §9.2).
 */
export const CORE_ADDRESS: Address | null = VENUE === 'pons' ? REGISTRY_ADDRESS : LAUNCHPAD_ADDRESS;
/** Human name of {@link CORE_ADDRESS} for copy. */
export const CORE_LABEL: string = VENUE === 'pons' ? 'registry' : 'launchpad';
/** The env variable that configures {@link CORE_ADDRESS}. */
export const CORE_ENV_VAR: string = VENUE === 'pons' ? 'VITE_REGISTRY_ADDRESS' : 'VITE_LAUNCHPAD_ADDRESS';
/** Runner HTTP base ('' = same origin). */
export const API_BASE: string = resolveApiBase(env);
/** Runner WebSocket base URL. */
export const WS_BASE: string = resolveWsBase(
  env,
  typeof window === 'undefined' ? { protocol: 'http:', host: 'localhost' } : window.location,
);
/** RPC override for the wagmi transport (`undefined` = chain default). */
export const RPC_URL: string | undefined = resolveRpcUrl(env);
/** WalletConnect project id ('' = WalletConnect disabled). */
export const WALLETCONNECT_PROJECT_ID: string = clean(env.VITE_WALLETCONNECT_PROJECT_ID);
/** Whether viem may batch reads through Multicall3. */
export const MULTICALL_ENABLED: boolean = clean(env.VITE_MULTICALL) === '1';
/** Human label of where the runner lives (for error copy). */
export const RUNNER_LABEL: string = API_BASE === '' ? 'the runner (via the dev proxy)' : API_BASE;
/** Target runway shown on the compute meter (runner default `TARGET_RUNWAY_DAYS`, R5). */
export const TARGET_RUNWAY_DAYS = 14;
