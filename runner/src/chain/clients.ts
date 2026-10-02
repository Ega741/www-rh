/**
 * viem clients: a polling HTTP public client and, when an operator key is configured, a wallet
 * client for the operator account (SPEC §4.1 `chain/clients.ts`).
 *
 * @module chain/clients
 */
import { createPublicClient, createWalletClient, defineChain, http, type Chain, type PublicClient, type Transport, type WalletClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { chainById } from '@www-rh/shared';

/** The public client type used across the runner. */
export type RunnerPublicClient = PublicClient<Transport, Chain>;
/** The operator wallet client type. */
export type RunnerWalletClient = WalletClient<Transport, Chain, PrivateKeyAccount>;

/** Clients bound to one chain. */
export interface ChainClients {
  chain: Chain;
  publicClient: RunnerPublicClient;
  /** `null` when no `OPERATOR_PRIVATE_KEY` is configured. */
  walletClient: RunnerWalletClient | null;
  account: PrivateKeyAccount | null;
}

/** Options for {@link createChainClients}. */
export interface ChainClientOptions {
  chainId: number;
  rpcUrl: string;
  operatorPrivateKey: `0x${string}` | null;
  pollingIntervalMs: number;
  /** Per-request timeout. */
  timeoutMs?: number;
}

/** The known chain definition for `chainId` with its default RPC replaced by `rpcUrl`. */
export function resolveChain(chainId: number, rpcUrl: string): Chain {
  const known = chainById(chainId);
  if (known !== undefined) {
    return { ...known, rpcUrls: { ...known.rpcUrls, default: { http: [rpcUrl] } } };
  }
  return defineChain({
    id: chainId,
    name: `Chain ${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

/** Creates the public (and optional wallet) client over an HTTP transport with polling. */
export function createChainClients(opts: ChainClientOptions): ChainClients {
  const chain = resolveChain(opts.chainId, opts.rpcUrl);
  const transport = http(opts.rpcUrl, { timeout: opts.timeoutMs ?? 10_000, retryCount: 1, retryDelay: 250 });
  const publicClient = createPublicClient({ chain, transport, pollingInterval: opts.pollingIntervalMs, batch: { multicall: false } });
  if (opts.operatorPrivateKey === null) return { chain, publicClient, walletClient: null, account: null };
  const account = privateKeyToAccount(opts.operatorPrivateKey);
  const walletClient = createWalletClient({ chain, transport, account });
  return { chain, publicClient, walletClient, account };
}
