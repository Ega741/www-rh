/** Detects a wallet on the wrong chain and switches/adds the app chain (EIP-3085). */
import { useCallback } from 'react';
import { useConnection, useSwitchChain } from 'wagmi';
import { toAddEthereumChainParameter } from '@beagle/shared/chains';
import { config } from '../config.js';
import { describeError } from '../lib/errors.js';

/** What {@link useChainGuard} returns. */
export interface ChainGuard {
  isConnected: boolean;
  walletChainId: number | undefined;
  /** Connected and on a different chain than the build targets. */
  wrongChain: boolean;
  /** Connected, right chain. */
  ready: boolean;
  switching: boolean;
  error: string | undefined;
  switchToAppChain(): Promise<void>;
}

/** Chain guard state and action. */
export function useChainGuard(): ChainGuard {
  const { chainId, isConnected } = useConnection();
  const sw = useSwitchChain();
  const wrongChain = isConnected && chainId !== config.chainId;

  const switchToAppChain = useCallback(async () => {
    const { chainId: _ignored, ...param } = toAddEthereumChainParameter(config.chain);
    await sw.mutateAsync({ chainId: config.chainId, addEthereumChainParameter: param });
  }, [sw]);

  return {
    isConnected,
    walletChainId: chainId,
    wrongChain,
    ready: isConnected && !wrongChain,
    switching: sw.isPending,
    error: sw.error ? describeError(sw.error) : undefined,
    switchToAppChain,
  };
}
