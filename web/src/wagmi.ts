/**
 * wagmi configuration: the single chain this build targets (from `@beagle/shared/chains`), the
 * injected connector, WalletConnect when `VITE_WALLETCONNECT_PROJECT_ID` is set, and an http
 * transport honouring `VITE_RPC_URL`. Multicall aggregation follows `VITE_MULTICALL`.
 */
import { createConfig, http, injected, type CreateConnectorFn, type Transport } from 'wagmi';
import { walletConnect } from 'wagmi/connectors';
import { config } from './config.js';

const connectors: CreateConnectorFn[] = [injected({ shimDisconnect: true })];
if (config.walletConnectProjectId !== undefined) {
  connectors.push(
    walletConnect({
      projectId: config.walletConnectProjectId,
      showQrModal: true,
      metadata: {
        name: 'Beagle',
        description: 'Compute for agents on Robinhood Chain. Burn becomes compute.',
        url: typeof window === 'undefined' ? 'https://localhost' : window.location.origin,
        icons: [],
      },
    }),
  );
}

const transports: Record<number, Transport> = { [config.chain.id]: http(config.rpcUrl) };

/** The wagmi config used by `WagmiProvider`. */
export const wagmiConfig = createConfig({
  chains: [config.chain],
  connectors,
  transports,
  multiInjectedProviderDiscovery: true,
  batch: { multicall: config.multicall },
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
