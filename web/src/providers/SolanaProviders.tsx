/**
 * Solana wallet layer (SPEC §7): `ConnectionProvider` on the cluster RPC of the build,
 * `WalletProvider` with `autoConnect` and wallet-standard discovery (Phantom, Solflare, Backpack,
 * … register themselves; no hard-coded adapters), and the wallet-adapter modal. Adapter errors
 * (connection refused, wallet not installed) surface as toasts.
 */
import { useCallback, useMemo, type ReactNode } from 'react';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import type { Adapter, WalletError } from '@solana/wallet-adapter-base';
import { WalletNotReadyError } from '@solana/wallet-adapter-base';
import { config } from '../config.js';
import { useToast } from '../hooks/useToast.jsx';
import { describeError, isUserRejection } from '../lib/errors.js';

/** Adapters listed explicitly (none: wallet-standard discovery covers the installed wallets). */
const ADAPTERS: Adapter[] = [];

/** Wraps `children` in the wallet-adapter providers. Must sit inside `ToastProvider`. */
export function SolanaProviders({ children }: { children: ReactNode }) {
  const toast = useToast();
  const connectionConfig = useMemo(() => ({ commitment: 'confirmed' as const, wsEndpoint: config.deployment.wsUrl }), []);
  const onError = useCallback(
    (error: WalletError, adapter?: Adapter) => {
      if (isUserRejection(error)) return;
      if (error instanceof WalletNotReadyError) {
        toast.push({ kind: 'warning', title: `${adapter?.name ?? 'Wallet'} is not available`, message: 'Install the wallet extension or open this page in the wallet’s browser.' });
        return;
      }
      toast.push({ kind: 'error', title: adapter === undefined ? 'Wallet error' : `${adapter.name}: wallet error`, message: describeError(error) });
    },
    [toast],
  );
  return (
    <ConnectionProvider endpoint={config.rpcUrl} config={connectionConfig}>
      <WalletProvider wallets={ADAPTERS} autoConnect onError={onError}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
