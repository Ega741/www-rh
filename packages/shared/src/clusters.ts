/**
 * Solana clusters (SPEC §1, §4.1): default RPC / WebSocket endpoints, explorer bases and the
 * CAIP-2 chain ids used by Sign-In-With-Solana.
 *
 * Browser-safe, dependency-free. Explorer links are plain string building: `explorer.solana.com`
 * takes `?cluster=devnet` and, for a local validator, `?cluster=custom&customUrl=<rpc>`; Solscan
 * takes the same query (mainnet is the default on both sites, so it carries no query).
 *
 * @module clusters
 */

/** The clusters Beagle runs on (`solana-test-validator` is `localnet`). */
export const CLUSTER_NAMES = ['mainnet-beta', 'devnet', 'localnet'] as const;
/** `'mainnet-beta' | 'devnet' | 'localnet'`. */
export type Cluster = (typeof CLUSTER_NAMES)[number];
/** The cluster the gateway and the web default to (`CLUSTER` / `VITE_CLUSTER` unset). */
export const DEFAULT_CLUSTER: Cluster = 'localnet';

/** CAIP-2 chain ids of the clusters (the `Chain ID:` line of a SIWS message). */
export type ClusterCaip = 'solana:mainnet' | 'solana:devnet' | 'solana:localnet';

/** Static facts about one cluster. */
export interface ClusterInfo {
  cluster: Cluster;
  /** Display name (`"Mainnet Beta"`). */
  name: string;
  /** Default JSON-RPC endpoint (override with `RPC_URL` / `VITE_RPC_URL`). */
  rpcUrl: string;
  /** Default WebSocket endpoint (the local validator uses RPC port + 1). */
  wsUrl: string;
  /** Solana Explorer base URL. */
  explorer: string;
  /** Solscan base URL. */
  solscan: string;
  /** CAIP-2 id. */
  caip: ClusterCaip;
}

/** Per-cluster facts, frozen. */
export const CLUSTERS: Readonly<Record<Cluster, Readonly<ClusterInfo>>> = Object.freeze({
  'mainnet-beta': Object.freeze({
    cluster: 'mainnet-beta',
    name: 'Mainnet Beta',
    rpcUrl: 'https://api.mainnet-beta.solana.com',
    wsUrl: 'wss://api.mainnet-beta.solana.com',
    explorer: 'https://explorer.solana.com',
    solscan: 'https://solscan.io',
    caip: 'solana:mainnet',
  } satisfies ClusterInfo),
  devnet: Object.freeze({
    cluster: 'devnet',
    name: 'Devnet',
    rpcUrl: 'https://api.devnet.solana.com',
    wsUrl: 'wss://api.devnet.solana.com',
    explorer: 'https://explorer.solana.com',
    solscan: 'https://solscan.io',
    caip: 'solana:devnet',
  } satisfies ClusterInfo),
  localnet: Object.freeze({
    cluster: 'localnet',
    name: 'Localnet',
    rpcUrl: 'http://127.0.0.1:8899',
    wsUrl: 'ws://127.0.0.1:8900',
    explorer: 'https://explorer.solana.com',
    solscan: 'https://solscan.io',
    caip: 'solana:localnet',
  } satisfies ClusterInfo),
});

/** `true` when `value` is one of {@link CLUSTER_NAMES}. */
export function isCluster(value: unknown): value is Cluster {
  return typeof value === 'string' && (CLUSTER_NAMES as readonly string[]).includes(value);
}

/**
 * Parses a cluster name (`CLUSTER` env, `VITE_CLUSTER`, CLI flag); blank → `DEFAULT_CLUSTER`.
 * Accepts the common aliases `mainnet` and `local`/`localhost`. Throws on anything else.
 */
export function parseCluster(value: string | null | undefined): Cluster {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '') return DEFAULT_CLUSTER;
  if (v === 'mainnet') return 'mainnet-beta';
  if (v === 'local' || v === 'localhost') return 'localnet';
  if (isCluster(v)) return v;
  throw new RangeError(`unknown cluster ${JSON.stringify(value)} (expected ${CLUSTER_NAMES.join(' | ')})`);
}

/** CAIP-2 id of `cluster`: `solana:mainnet | solana:devnet | solana:localnet`. */
export function clusterCaip(cluster: Cluster): ClusterCaip {
  return CLUSTERS[cluster].caip;
}

/** The cluster of a CAIP-2 id, or `undefined` (`solana:mainnet-beta` is not a CAIP id). */
export function clusterFromCaip(caip: string): Cluster | undefined {
  for (const name of CLUSTER_NAMES) if (CLUSTERS[name].caip === caip) return name;
  return undefined;
}

/** Which explorer site to link to. */
export type ExplorerSite = 'solana' | 'solscan';

/** Options of the explorer URL builders. */
export interface ExplorerOptions {
  /** `'solana'` (explorer.solana.com, default) or `'solscan'`. */
  site?: ExplorerSite;
  /** The RPC endpoint a localnet link should point the explorer at (default: the cluster's `rpcUrl`). */
  rpcUrl?: string;
}

function explorerBase(cluster: Cluster, site: ExplorerSite): string {
  return site === 'solscan' ? CLUSTERS[cluster].solscan : CLUSTERS[cluster].explorer;
}

/**
 * Query string selecting `cluster` on the explorer sites: `''` for mainnet, `?cluster=devnet`, and
 * `?cluster=custom&customUrl=<encoded rpc>` for localnet.
 */
export function explorerClusterQuery(cluster: Cluster, rpcUrl?: string): string {
  switch (cluster) {
    case 'mainnet-beta':
      return '';
    case 'devnet':
      return '?cluster=devnet';
    case 'localnet':
      return `?cluster=custom&customUrl=${encodeURIComponent(rpcUrl ?? CLUSTERS.localnet.rpcUrl)}`;
  }
}

function explorerUrl(cluster: Cluster, path: string, options: ExplorerOptions): string {
  const site = options.site ?? 'solana';
  return `${explorerBase(cluster, site)}${path}${explorerClusterQuery(cluster, options.rpcUrl)}`;
}

/** Explorer page of a transaction signature. */
export function explorerTxUrl(cluster: Cluster, signature: string, options: ExplorerOptions = {}): string {
  return explorerUrl(cluster, `/tx/${encodeURIComponent(signature)}`, options);
}

/** Explorer page of an account (wallet, token account, program). */
export function explorerAddressUrl(cluster: Cluster, address: string, options: ExplorerOptions = {}): string {
  const site = options.site ?? 'solana';
  const segment = site === 'solscan' ? 'account' : 'address';
  return explorerUrl(cluster, `/${segment}/${encodeURIComponent(address)}`, options);
}

/** Explorer page of a mint (Solana Explorer shows mints under `/address/`, Solscan under `/token/`). */
export function explorerTokenUrl(cluster: Cluster, mint: string, options: ExplorerOptions = {}): string {
  const site = options.site ?? 'solana';
  const segment = site === 'solscan' ? 'token' : 'address';
  return explorerUrl(cluster, `/${segment}/${encodeURIComponent(mint)}`, options);
}

/**
 * The WebSocket endpoint conventionally paired with an RPC endpoint (the `@solana/web3.js`
 * convention: `http→ws`, `https→wss`, an explicit port is incremented by one). Throws when
 * `rpcUrl` is not an `http(s)` URL.
 */
export function deriveWsUrl(rpcUrl: string): string {
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    throw new TypeError(`deriveWsUrl: not a URL: ${JSON.stringify(rpcUrl)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError(`deriveWsUrl: expected an http(s) URL, got ${JSON.stringify(rpcUrl)}`);
  }
  const secure = url.protocol === 'https:';
  url.protocol = secure ? 'wss:' : 'ws:';
  if (url.port !== '') url.port = String(Number(url.port) + 1);
  return url.toString().replace(/\/$/, '');
}
