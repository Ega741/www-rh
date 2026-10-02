/**
 * Robinhood Chain definitions for viem / wagmi.
 *
 * Robinhood Chain is an Arbitrum Orbit (Nitro) L2 settling to Ethereum (mainnet, chain id 4663)
 * or Sepolia (testnet, chain id 46630). Gas is paid in ETH. See `docs/ROBINHOOD_CHAIN.md`.
 *
 * @module chains
 */
import { defineChain, type Chain } from 'viem';

/** Chain id of Robinhood Chain mainnet. */
export const ROBINHOOD_CHAIN_ID = 4663 as const;
/** Chain id of Robinhood Chain testnet (Sepolia-based). */
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630 as const;
/** Chain id of a local anvil node (used by the `anvil:e2e` flow). */
export const ANVIL_CHAIN_ID = 31337 as const;

/**
 * Canonical Multicall3 address (EIP-55). Multicall3 is deployed at this deterministic address on
 * most EVM chains, but its presence on Robinhood Chain could not be verified, so the chain
 * definitions below do NOT declare it; opt in with {@link withMulticall3} after checking
 * `cast code 0xcA11bde05977b3631167028862bE2a173976CA11` on your RPC.
 */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

/** Returns a copy of `chain` declaring `contracts.multicall3` at {@link MULTICALL3_ADDRESS}. */
export function withMulticall3(chain: Chain): Chain {
  return { ...chain, contracts: { ...chain.contracts, multicall3: { address: MULTICALL3_ADDRESS } } };
}

/** Robinhood Chain mainnet (chain id 4663). Parent chain: Ethereum (1). */
export const robinhoodChain: Chain = /* #__PURE__ */ defineChain({
  id: ROBINHOOD_CHAIN_ID,
  name: 'Robinhood Chain',
  network: 'robinhood',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        'https://rpc.mainnet.chain.robinhood.com',
        'https://robinhood-rpc.publicnode.com',
        'https://robinhood.drpc.org',
      ],
      webSocket: ['wss://robinhood-rpc.publicnode.com', 'wss://robinhood.drpc.org'],
    },
    public: {
      http: [
        'https://robinhood-rpc.publicnode.com',
        'https://robinhood.drpc.org',
        'https://rpc.arrowrpc.com',
        'https://rpc.ordofi.network',
      ],
      webSocket: ['wss://robinhood-rpc.publicnode.com', 'wss://robinhood.drpc.org'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Blockscout',
      url: 'https://robinhoodchain.blockscout.com',
      apiUrl: 'https://robinhoodchain.blockscout.com/api',
    },
    robinscan: { name: 'Robinscan', url: 'https://robinscan.io' },
    hoodscan: { name: 'Hoodscan', url: 'https://hoodscan.co' },
  },
  sourceId: 1,
  testnet: false,
});

/** Robinhood Chain testnet (chain id 46630). Parent chain: Sepolia (11155111). */
export const robinhoodChainTestnet: Chain = /* #__PURE__ */ defineChain({
  id: ROBINHOOD_TESTNET_CHAIN_ID,
  name: 'Robinhood Chain Testnet',
  network: 'robinhood-testnet',
  nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        'https://rpc.testnet.chain.robinhood.com/rpc',
        'https://robinhood-sepolia-rpc.publicnode.com',
        'https://robinhood-testnet.drpc.org',
      ],
      webSocket: ['wss://robinhood-sepolia-rpc.publicnode.com', 'wss://robinhood-testnet.drpc.org'],
    },
    public: {
      http: ['https://robinhood-sepolia-rpc.publicnode.com', 'https://robinhood-testnet.drpc.org'],
      webSocket: ['wss://robinhood-sepolia-rpc.publicnode.com', 'wss://robinhood-testnet.drpc.org'],
    },
  },
  blockExplorers: {
    default: {
      name: 'Blockscout',
      url: 'https://explorer.testnet.chain.robinhood.com',
      apiUrl: 'https://explorer.testnet.chain.robinhood.com/api',
    },
  },
  sourceId: 11_155_111,
  testnet: true,
});

/** Local anvil chain used by `pnpm anvil:e2e` and by the runner/web in development. */
export const anvilChain: Chain = /* #__PURE__ */ defineChain({
  id: ANVIL_CHAIN_ID,
  name: 'Anvil',
  network: 'anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['http://127.0.0.1:8545'], webSocket: ['ws://127.0.0.1:8545'] },
  },
  testnet: true,
});

/** All chains this project knows about, keyed by chain id. */
export const SUPPORTED_CHAINS = {
  [ROBINHOOD_CHAIN_ID]: robinhoodChain,
  [ROBINHOOD_TESTNET_CHAIN_ID]: robinhoodChainTestnet,
  [ANVIL_CHAIN_ID]: anvilChain,
} as const satisfies Record<number, Chain>;

/** Chain ids that `chainById` resolves. */
export type SupportedChainId = keyof typeof SUPPORTED_CHAINS;

/**
 * Returns the chain definition for `chainId`, or `undefined` if unknown.
 */
export function chainById(chainId: number): Chain | undefined {
  return (SUPPORTED_CHAINS as Record<number, Chain | undefined>)[chainId];
}

/**
 * EIP-3085 `wallet_addEthereumChain` parameters for a supported chain
 * (what the web app sends to MetaMask for "Add Robinhood Chain").
 */
export interface AddEthereumChainParameter {
  chainId: `0x${string}`;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrls: string[];
  blockExplorerUrls?: string[];
}

/** Builds the EIP-3085 parameter object for `chain`. */
export function toAddEthereumChainParameter(chain: Chain): AddEthereumChainParameter {
  const explorer = chain.blockExplorers?.default.url;
  const param: AddEthereumChainParameter = {
    chainId: `0x${chain.id.toString(16)}`,
    chainName: chain.name,
    nativeCurrency: chain.nativeCurrency,
    rpcUrls: [...chain.rpcUrls.default.http],
  };
  if (explorer !== undefined) param.blockExplorerUrls = [explorer];
  return param;
}

/** Explorer URL helpers (Blockscout path layout). */
export function explorerTxUrl(chain: Chain, txHash: string): string | undefined {
  const base = chain.blockExplorers?.default.url;
  return base === undefined ? undefined : `${base}/tx/${txHash}`;
}

/** Explorer URL for an address (Blockscout path layout). */
export function explorerAddressUrl(chain: Chain, address: string): string | undefined {
  const base = chain.blockExplorers?.default.url;
  return base === undefined ? undefined : `${base}/address/${address}`;
}

/** Explorer URL for an ERC-20 token page (Blockscout path layout). */
export function explorerTokenUrl(chain: Chain, address: string): string | undefined {
  const base = chain.blockExplorers?.default.url;
  return base === undefined ? undefined : `${base}/token/${address}`;
}
