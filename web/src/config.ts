/**
 * Runtime configuration derived from `VITE_*` variables (see `.env.example`).
 *
 * The pure `resolve*` functions take the env object explicitly so they can be unit-tested;
 * the exported constants bind them to `import.meta.env`.
 *
 * @module config
 */
import { chainById, launchpadAddress, robinhoodChainTestnet } from '@www-rh/shared';
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
}

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
 * WebSocket endpoint (directive W1). Dev: same-origin `/ws` through the Vite proxy. Prod:
 * `VITE_RUNNER_WS`, else `VITE_RUNNER_URL` with http→ws and `/ws`, else same-origin `/ws`.
 */
export function resolveWsBase(env: WebEnv, location: { protocol: string; host: string }): string {
  const sameOrigin = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
  if (env.DEV) return sameOrigin;
  const explicit = clean(env.VITE_RUNNER_WS);
  if (explicit !== '') return stripSlash(explicit);
  const http = clean(env.VITE_RUNNER_URL);
  if (http !== '') return `${stripSlash(http).replace(/^http/i, 'ws')}/ws`;
  return sameOrigin;
}

/**
 * The chain the app targets: `VITE_CHAIN_ID` resolved through `@www-rh/shared` chains
 * (default: Robinhood Chain Testnet), with an optional `VITE_RPC_URL` override. Multicall3 is
 * removed from the chain object unless `VITE_MULTICALL=1` (directive W5).
 */
export function resolveChain(env: WebEnv): Chain {
  const id = Number(clean(env.VITE_CHAIN_ID) || robinhoodChainTestnet.id);
  const base = chainById(id) ?? robinhoodChainTestnet;
  const rpc = clean(env.VITE_RPC_URL);
  const multicall = clean(env.VITE_MULTICALL) === '1';
  const { contracts, ...rest } = base;
  const chain: Chain = {
    ...rest,
    rpcUrls: rpc === '' ? base.rpcUrls : { ...base.rpcUrls, default: { http: [rpc] } },
  };
  if (multicall && contracts !== undefined) chain.contracts = contracts;
  return chain;
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

const env: WebEnv = import.meta.env;

/** Chain the app reads from and writes to. */
export const TARGET_CHAIN: Chain = resolveChain(env);
/** Launchpad address, or `null` when not configured (writes and reads are disabled). */
export const LAUNCHPAD_ADDRESS: Address | null = resolveLaunchpad(env, TARGET_CHAIN.id);
/** Runner HTTP base ('' = same origin). */
export const API_BASE: string = resolveApiBase(env);
/** Runner WebSocket base URL. */
export const WS_BASE: string = resolveWsBase(
  env,
  typeof window === 'undefined' ? { protocol: 'http:', host: 'localhost' } : window.location,
);
/** WalletConnect project id ('' = WalletConnect disabled). */
export const WALLETCONNECT_PROJECT_ID: string = clean(env.VITE_WALLETCONNECT_PROJECT_ID);
/** Whether viem may batch reads through Multicall3. */
export const MULTICALL_ENABLED: boolean = clean(env.VITE_MULTICALL) === '1';
/** Human label of where the runner lives (for error copy). */
export const RUNNER_LABEL: string = API_BASE === '' ? 'the runner (via the dev proxy)' : API_BASE;
/** Target runway shown on the compute meter (runner default `TARGET_RUNWAY_DAYS`, R5). */
export const TARGET_RUNWAY_DAYS = 14;
