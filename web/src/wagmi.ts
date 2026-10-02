/**
 * wagmi configuration (directive W5): the target chain from `@www-rh/shared`, the injected
 * connector always (EIP-6963 discovery included), WalletConnect only when
 * `VITE_WALLETCONNECT_PROJECT_ID` is set, no Multicall3 batching unless `VITE_MULTICALL=1`,
 * and a 2 s polling interval (receipts, block watching) suited to Robinhood Chain's ~100 ms blocks.
 *
 * @module wagmi
 */
import { http, createConfig, injected, type CreateConnectorFn } from 'wagmi';
import { walletConnect } from 'wagmi/connectors/walletConnect';
import { MULTICALL_ENABLED, TARGET_CHAIN, WALLETCONNECT_PROJECT_ID } from './config';

function connectors(): CreateConnectorFn[] {
  const list: CreateConnectorFn[] = [injected({ shimDisconnect: true })];
  if (WALLETCONNECT_PROJECT_ID !== '') {
    list.push(
      walletConnect({
        projectId: WALLETCONNECT_PROJECT_ID,
        showQrModal: true,
        metadata: {
          name: 'www/rh',
          description: 'worldwideweb on Robinhood Chain — every coin has a mind',
          url: typeof window === 'undefined' ? 'https://localhost' : window.location.origin,
          icons: [],
        },
      }),
    );
  }
  return list;
}

/** The app's wagmi config. */
export const wagmiConfig = createConfig({
  chains: [TARGET_CHAIN],
  connectors: connectors(),
  transports: { [TARGET_CHAIN.id]: http() },
  batch: { multicall: MULTICALL_ENABLED },
  pollingInterval: 2_000,
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
