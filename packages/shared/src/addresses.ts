/**
 * Program ids and the per-cluster Beagle deployment lookup (SPEC §1, §3.1, §4.1, §4.2, §10).
 *
 * No file-system or environment access: deployments come from `deployments.generated.ts`
 * (written by `node scripts/sync-deployments.mjs` from `solana/deployments/<cluster>.json`). Env
 * overrides (`MINT_ADDRESS`, `OPERATOR_*`, `RPC_URL`, `VITE_MINT_ADDRESS`, …) are applied by the
 * consumer through {@link resolveDeployment}, where blank strings and the all-zero key count as
 * unset and anything that is not a 32-byte base58 key throws.
 *
 * @module addresses
 */
import { CLUSTERS, deriveWsUrl, type Cluster } from './clusters.js';
import { DEPLOYMENTS } from './deployments.generated.js';
import { isBase58Pubkey } from './solana.js';

/** SPL Token program. */
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
/** SPL Token-2022 (Token Extensions) program. */
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
/** Associated Token Account program. */
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
/** SPL Memo program (v2). */
export const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
/** System program (also the all-zero public key). */
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
/** Compute Budget program (priority fees on operator draws, SPEC §3.4). */
export const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';

/** The two token programs a deployment's `tokenProgram` may name. */
export const TOKEN_PROGRAM_IDS = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID] as const;
export type TokenProgramId = (typeof TOKEN_PROGRAM_IDS)[number];

/** `true` when `id` is the Token or the Token-2022 program id. */
export function isTokenProgramId(id: unknown): id is TokenProgramId {
  return typeof id === 'string' && (TOKEN_PROGRAM_IDS as readonly string[]).includes(id);
}

/**
 * One Beagle deployment, mirroring `solana/deployments/<cluster>.json` written by
 * `solana/scripts/setup-cluster.sh` (SPEC §3.1).
 */
export interface Deployment {
  cluster: Cluster;
  /** The BEAGLE mint (base58). */
  mint: string;
  /** Decimals of the mint (6 on every cluster Beagle targets). */
  decimals: number;
  symbol: string;
  /** Token program owning the mint: {@link TOKEN_PROGRAM_ID} or {@link TOKEN_2022_PROGRAM_ID}. */
  tokenProgram: string;
  /** The gateway's hot wallet: the delegate of every budget and the authority of every draw. */
  operator: string;
  memoProgram: string;
  /** Slot in which the mint was created (optional; a hint for backfills). */
  createdSlot?: number;
}

export { DEPLOYMENTS };

/** The committed deployment for `cluster`, or `undefined` when none is recorded. */
export function deploymentFor(cluster: Cluster): Deployment | undefined {
  return DEPLOYMENTS[cluster];
}

/** `true` when `value` is `undefined`, `null`, blank, or the all-zero key (`1111…1111`). */
export function isUnsetAddress(value: string | null | undefined): boolean {
  if (value === undefined || value === null) return true;
  const v = value.trim();
  return v === '' || v === SYSTEM_PROGRAM_ID;
}

/** Fields of a {@link Deployment} that env overrides may replace. */
export type OverridableAddress = 'mint' | 'operator' | 'tokenProgram';
/** Everything {@link resolveDeployment} may take from `overrides`. */
export type OverridableField = OverridableAddress | 'rpcUrl' | 'wsUrl';

/** Env overrides for {@link resolveDeployment}; blank strings and the all-zero key count as unset. */
export interface DeploymentOverrides {
  mint?: string | null | undefined;
  operator?: string | null | undefined;
  tokenProgram?: string | null | undefined;
  /** JSON-RPC endpoint (`RPC_URL`); must be `http(s)`. */
  rpcUrl?: string | null | undefined;
  /** WebSocket endpoint (`RPC_WS_URL`); defaults to the one derived from `rpcUrl` ({@link deriveWsUrl}). */
  wsUrl?: string | null | undefined;
}

/**
 * The outcome of {@link resolveDeployment}: the committed record (if any) with overrides applied,
 * plus the endpoints. `mint`, `operator`, `decimals`, `symbol` and `createdSlot` are optional
 * because a cluster may have no committed deployment while env still names the mint (e.g. a fresh
 * devnet); `tokenProgram` and `memoProgram` always resolve (defaults: the classic Token program
 * and the Memo program).
 */
export interface ResolvedDeployment {
  cluster: Cluster;
  mint?: string;
  decimals?: number;
  symbol?: string;
  tokenProgram: string;
  operator?: string;
  memoProgram: string;
  createdSlot?: number;
  rpcUrl: string;
  wsUrl: string;
  /** Fields that came from `overrides` rather than the committed record / cluster defaults. */
  overridden: readonly OverridableField[];
}

function overrideAddress(field: OverridableAddress, value: string | null | undefined): string | undefined {
  if (isUnsetAddress(value)) return undefined;
  const v = (value as string).trim();
  if (!isBase58Pubkey(v)) {
    throw new TypeError(`resolveDeployment: override ${field} is not a base58 public key: ${JSON.stringify(value)}`);
  }
  return v;
}

function overrideUrl(field: 'rpcUrl' | 'wsUrl', value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const v = value.trim();
  if (v === '') return undefined;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new TypeError(`resolveDeployment: override ${field} is not a URL: ${JSON.stringify(value)}`);
  }
  const allowed = field === 'rpcUrl' ? ['http:', 'https:'] : ['ws:', 'wss:'];
  if (!allowed.includes(url.protocol)) {
    throw new TypeError(`resolveDeployment: override ${field} must be ${allowed.join(' or ')}: ${JSON.stringify(value)}`);
  }
  return v;
}

/**
 * Resolves the deployment of `cluster`, applying `overrides` on top of the committed record and
 * the cluster's default endpoints. Blank / all-zero override values are ignored; other address
 * values must be 32-byte base58 keys and URLs must parse with the right scheme, or the function
 * throws `TypeError`. A `rpcUrl` override without `wsUrl` derives the WebSocket endpoint.
 */
export function resolveDeployment(cluster: Cluster, overrides: DeploymentOverrides = {}): ResolvedDeployment {
  const base = deploymentFor(cluster);
  const defaults = CLUSTERS[cluster];
  const overridden: OverridableField[] = [];

  const mint = overrideAddress('mint', overrides.mint);
  const operator = overrideAddress('operator', overrides.operator);
  const tokenProgram = overrideAddress('tokenProgram', overrides.tokenProgram);
  const rpcUrl = overrideUrl('rpcUrl', overrides.rpcUrl);
  const wsUrl = overrideUrl('wsUrl', overrides.wsUrl);

  const resolvedMint = mint ?? base?.mint;
  const resolvedOperator = operator ?? base?.operator;
  const resolvedRpc = rpcUrl ?? defaults.rpcUrl;
  const resolvedWs = wsUrl ?? (rpcUrl !== undefined ? deriveWsUrl(rpcUrl) : defaults.wsUrl);

  if (mint !== undefined) overridden.push('mint');
  if (operator !== undefined) overridden.push('operator');
  if (tokenProgram !== undefined) overridden.push('tokenProgram');
  if (rpcUrl !== undefined) overridden.push('rpcUrl');
  if (wsUrl !== undefined) overridden.push('wsUrl');

  return {
    cluster,
    ...(resolvedMint !== undefined ? { mint: resolvedMint } : {}),
    ...(base !== undefined ? { decimals: base.decimals, symbol: base.symbol } : {}),
    tokenProgram: tokenProgram ?? base?.tokenProgram ?? TOKEN_PROGRAM_ID,
    ...(resolvedOperator !== undefined ? { operator: resolvedOperator } : {}),
    memoProgram: base?.memoProgram ?? MEMO_PROGRAM_ID,
    ...(base?.createdSlot !== undefined ? { createdSlot: base.createdSlot } : {}),
    rpcUrl: resolvedRpc,
    wsUrl: resolvedWs,
    overridden,
  };
}
