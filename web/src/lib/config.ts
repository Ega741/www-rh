/**
 * Pure configuration loader for the web app (SPEC §7 env). `loadConfig` reads a plain record so
 * it can be unit-tested; `src/config.ts` evaluates it against `import.meta.env`.
 */
import type { Chain } from 'viem';
import { anvilChain, chainById, withMulticall3 } from '@beagle/shared/chains';
import { resolveDeployment, type ResolvedDeployment } from '@beagle/shared/addresses';

/** The `VITE_*` keys the app reads. */
export interface WebEnv {
  VITE_CHAIN_ID?: string | undefined;
  VITE_GATEWAY_URL?: string | undefined;
  VITE_CREDIT_DESK_ADDRESS?: string | undefined;
  VITE_RPC_URL?: string | undefined;
  VITE_WALLETCONNECT_PROJECT_ID?: string | undefined;
  VITE_MULTICALL?: string | undefined;
}

/** Resolved, validated app configuration. */
export interface AppConfig {
  /** Chain id the app is bound to (default 31337). */
  chainId: number;
  /** viem chain definition (with Multicall3 declared when `VITE_MULTICALL` is on). */
  chain: Chain;
  /** Committed deployment with `VITE_CREDIT_DESK_ADDRESS` applied. */
  deployment: ResolvedDeployment;
  /** RPC override for the wallet transport; `undefined` = chain default. */
  rpcUrl: string | undefined;
  /** Public gateway URL (`VITE_GATEWAY_URL`), without trailing slash; `''` = same origin. */
  gatewayUrl: string;
  /** Prefix for `fetch` calls: `''` in development (Vite proxy) or when the gateway is same-origin. */
  apiBase: string;
  walletConnectProjectId: string | undefined;
  /** Aggregate `eth_call`s through Multicall3. */
  multicall: boolean;
  /** Human-readable configuration problems to surface in the UI (the app still boots). */
  errors: string[];
}

const DEFAULT_CHAIN_ID = 31337;

function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v === undefined || v === '' ? undefined : v;
}

/** Strips a trailing slash from a URL-ish string. */
export function stripSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** `true` for `1`, `true`, `yes`, `on` (case-insensitive). */
export function envFlag(value: string | undefined): boolean {
  const v = clean(value)?.toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * Builds the {@link AppConfig} from `env`. Never throws: unknown chain ids fall back to anvil and
 * bad overrides are reported in `errors`.
 */
export function loadConfig(env: WebEnv, opts: { dev: boolean }): AppConfig {
  const errors: string[] = [];
  const rawChainId = clean(env.VITE_CHAIN_ID);
  let chainId = DEFAULT_CHAIN_ID;
  if (rawChainId !== undefined) {
    const n = Number(rawChainId);
    if (Number.isInteger(n) && n > 0) chainId = n;
    else errors.push(`VITE_CHAIN_ID is not a chain id: ${JSON.stringify(rawChainId)}`);
  }
  let chain = chainById(chainId);
  if (chain === undefined) {
    errors.push(`VITE_CHAIN_ID ${chainId} is not a supported chain (4663, 46630, 31337); using anvil`);
    chainId = anvilChain.id;
    chain = anvilChain;
  }
  const multicall = envFlag(env.VITE_MULTICALL);
  if (multicall) chain = withMulticall3(chain);

  let deployment: ResolvedDeployment;
  try {
    deployment = resolveDeployment(chainId, { creditDesk: clean(env.VITE_CREDIT_DESK_ADDRESS) });
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
    deployment = resolveDeployment(chainId);
  }
  if (deployment.creditDesk === undefined) {
    errors.push(`No CreditDesk deployment is known for chain ${chainId}; set VITE_CREDIT_DESK_ADDRESS`);
  }

  const gatewayUrl = stripSlash(clean(env.VITE_GATEWAY_URL) ?? '');
  const apiBase = opts.dev ? '' : gatewayUrl;

  return {
    chainId,
    chain,
    deployment,
    rpcUrl: clean(env.VITE_RPC_URL),
    gatewayUrl,
    apiBase,
    walletConnectProjectId: clean(env.VITE_WALLETCONNECT_PROJECT_ID),
    multicall,
    errors,
  };
}

/** The gateway URL users should call directly: `gatewayUrl` when set, else the page origin. */
export function publicGatewayUrl(cfg: Pick<AppConfig, 'gatewayUrl'>, pageOrigin: string): string {
  return cfg.gatewayUrl !== '' ? cfg.gatewayUrl : stripSlash(pageOrigin);
}
