/**
 * Switch the wallet to the target chain, adding it when unknown: wagmi `switchChain` with the
 * chain object (which itself falls back to `wallet_addEthereumChain` on error 4902), then — for
 * wallets that report other errors — an explicit `wallet_addEthereumChain` through the
 * connector's EIP-1193 provider followed by another switch.
 *
 * @module hooks/useChainSwitch
 */
import { useCallback, useState } from 'react';
import type { EIP1193Provider } from 'viem';
import { useConnection, useSwitchChain } from 'wagmi';
import { TARGET_CHAIN } from '../config';
import { addChainParameter } from '../lib/chain';
import { describeError, isUserRejection } from '../lib/errors';

/** Chain-switch state and action. */
export interface ChainSwitch {
  /** Connected to a different chain than the target. */
  wrongChain: boolean;
  pending: boolean;
  error: string | null;
  /** Switches (adding the chain when needed). Resolves `true` on success. */
  switchToTarget: () => Promise<boolean>;
}

function isEip1193(value: unknown): value is EIP1193Provider {
  return typeof value === 'object' && value !== null && typeof (value as { request?: unknown }).request === 'function';
}

/** Hook exposing {@link ChainSwitch}. */
export function useChainSwitch(): ChainSwitch {
  const connection = useConnection();
  const switchChain = useSwitchChain();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrongChain = connection.isConnected && connection.chainId !== TARGET_CHAIN.id;

  const switchToTarget = useCallback(async (): Promise<boolean> => {
    setPending(true);
    setError(null);
    const param = addChainParameter();
    try {
      await switchChain.mutateAsync({
        chainId: TARGET_CHAIN.id,
        addEthereumChainParameter: {
          chainName: param.chainName,
          nativeCurrency: param.nativeCurrency,
          rpcUrls: param.rpcUrls,
          ...(param.blockExplorerUrls !== undefined ? { blockExplorerUrls: param.blockExplorerUrls } : {}),
        },
      });
      return true;
    } catch (first) {
      if (isUserRejection(first)) {
        setError('Network switch rejected in the wallet.');
        return false;
      }
      try {
        const provider: unknown = await connection.connector?.getProvider();
        if (!isEip1193(provider)) throw first;
        await provider.request({ method: 'wallet_addEthereumChain', params: [param] });
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: param.chainId }] });
        return true;
      } catch (second) {
        setError(describeError(second));
        return false;
      }
    } finally {
      setPending(false);
    }
  }, [connection.connector, switchChain]);

  return { wrongChain, pending, error, switchToTarget };
}
