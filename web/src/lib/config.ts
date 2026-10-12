/**
 * Pure configuration loader for the web app (SPEC §7 env): `VITE_CLUSTER`, `VITE_RPC_URL`,
 * `VITE_GATEWAY_URL`, `VITE_MINT_ADDRESS`. `loadConfig` reads a plain record so it can be
 * unit-tested; `src/config.ts` evaluates it against `import.meta.env`. The mint, decimals, symbol,
 * token program and operator the pages use come from `GET /api/config`, reconciled with the
 * committed deployment by {@link reconcileDeployment}: a disagreement disables burning and says why.
 */
import { DEFAULT_CLUSTER, CLUSTERS, parseCluster, type Cluster } from '@beagle/shared/clusters';
import { resolveDeployment, type ResolvedDeployment } from '@beagle/shared/addresses';
import { DEFAULT_DECIMALS } from '@beagle/shared/solana';

/** The `VITE_*` keys the app reads. */
export interface WebEnv {
  VITE_CLUSTER?: string | undefined;
  VITE_RPC_URL?: string | undefined;
  VITE_GATEWAY_URL?: string | undefined;
  VITE_MINT_ADDRESS?: string | undefined;
}

/** Resolved, validated app configuration. */
export interface AppConfig {
  /** Cluster the app is bound to (default `localnet`). */
  cluster: Cluster;
  /** Display name (`Localnet`, `Devnet`, `Mainnet Beta`). */
  clusterName: string;
  /** Committed deployment with `VITE_MINT_ADDRESS` / `VITE_RPC_URL` applied. */
  deployment: ResolvedDeployment;
  /** JSON-RPC endpoint of the wallet connection (`VITE_RPC_URL` or the cluster default). */
  rpcUrl: string;
  /** Public gateway URL (`VITE_GATEWAY_URL`), without trailing slash; `''` = same origin. */
  gatewayUrl: string;
  /** Prefix for `fetch` calls: `''` in development (Vite proxy) or when the gateway is same-origin. */
  apiBase: string;
  /** Human-readable configuration problems to surface in the UI (the app still boots). */
  errors: string[];
}

function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v === undefined || v === '' ? undefined : v;
}

/** Strips a trailing slash from a URL-ish string. */
export function stripSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Builds the {@link AppConfig} from `env`. Never throws: an unknown cluster falls back to
 * `localnet` and bad overrides are reported in `errors` (the override is then ignored).
 */
export function loadConfig(env: WebEnv, opts: { dev: boolean }): AppConfig {
  const errors: string[] = [];
  let cluster: Cluster = DEFAULT_CLUSTER;
  try {
    cluster = parseCluster(env.VITE_CLUSTER);
  } catch (e) {
    errors.push(`VITE_CLUSTER: ${e instanceof Error ? e.message : String(e)}; using ${DEFAULT_CLUSTER}`);
  }

  let deployment: ResolvedDeployment;
  try {
    deployment = resolveDeployment(cluster, { mint: clean(env.VITE_MINT_ADDRESS), rpcUrl: clean(env.VITE_RPC_URL) });
  } catch (e) {
    errors.push(e instanceof Error ? e.message : String(e));
    // Keep whichever override is valid on its own.
    let partial: ResolvedDeployment | undefined;
    try {
      partial = resolveDeployment(cluster, { rpcUrl: clean(env.VITE_RPC_URL) });
    } catch {
      partial = undefined;
    }
    try {
      partial ??= resolveDeployment(cluster, { mint: clean(env.VITE_MINT_ADDRESS) });
    } catch {
      partial = undefined;
    }
    deployment = partial ?? resolveDeployment(cluster);
  }

  const gatewayUrl = stripSlash(clean(env.VITE_GATEWAY_URL) ?? '');
  const apiBase = opts.dev ? '' : gatewayUrl;

  return {
    cluster,
    clusterName: CLUSTERS[cluster].name,
    deployment,
    rpcUrl: deployment.rpcUrl,
    gatewayUrl,
    apiBase,
    errors,
  };
}

/** The gateway URL users should call directly: `gatewayUrl` when set, else the page origin. */
export function publicGatewayUrl(cfg: Pick<AppConfig, 'gatewayUrl'>, pageOrigin: string): string {
  return cfg.gatewayUrl !== '' ? cfg.gatewayUrl : stripSlash(pageOrigin);
}

/** The subset of `GET /api/config` the reconciliation reads. */
export interface GatewayDeployment {
  cluster: string;
  mint: string;
  decimals: number;
  symbol: string;
  tokenProgram: string;
  memoProgram: string;
  operator: string | null;
}

/** What the pages need to build burns and budgets, after reconciling the build with the gateway. */
export interface DeploymentView {
  /** The mint to burn, `undefined` when unknown or when the two sources disagree. */
  mint: string | undefined;
  decimals: number;
  symbol: string;
  tokenProgram: string;
  memoProgram: string;
  /** The delegate of every budget; `undefined` while the gateway has no operator (draws disabled). */
  operator: string | undefined;
  /** Human-readable explanation when the build and the gateway disagree (mint or cluster). */
  mismatch: string | undefined;
}

/**
 * Picks the deployment the pages use. The gateway's `/api/config` is the source of truth for the
 * token facts (decimals, symbol, token program, memo program, operator); the committed deployment
 * (with `VITE_MINT_ADDRESS`) only serves as a fallback and as a cross-check: a burn of a mint the
 * gateway's indexer does not watch would never be credited, and a gateway on another cluster would
 * never see the transaction, so either disagreement disables the flows instead of proceeding.
 */
export function reconcileDeployment(committed: ResolvedDeployment, gateway: GatewayDeployment | undefined): DeploymentView {
  let mismatch: string | undefined;
  if (gateway !== undefined && gateway.cluster !== committed.cluster) {
    mismatch = `This web build targets ${committed.cluster} but the gateway runs on ${gateway.cluster}. Burns and budgets are disabled until the two agree (VITE_CLUSTER vs the gateway's CLUSTER).`;
  } else if (gateway !== undefined && committed.mint !== undefined && gateway.mint !== committed.mint) {
    mismatch = `This web build targets mint ${committed.mint} but the gateway indexes ${gateway.mint}. Burns and budgets are disabled until the two agree (check VITE_MINT_ADDRESS / deployments.generated.ts against the gateway's MINT_ADDRESS).`;
  }
  const operator = gateway !== undefined ? (gateway.operator ?? undefined) : committed.operator;
  return {
    mint: mismatch !== undefined ? undefined : (gateway?.mint ?? committed.mint),
    decimals: gateway?.decimals ?? committed.decimals ?? DEFAULT_DECIMALS,
    symbol: gateway?.symbol ?? committed.symbol ?? 'BEAGLE',
    tokenProgram: gateway?.tokenProgram ?? committed.tokenProgram,
    memoProgram: gateway?.memoProgram ?? committed.memoProgram,
    operator,
    mismatch,
  };
}
