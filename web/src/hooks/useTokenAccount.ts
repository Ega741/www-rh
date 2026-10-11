/** Wallet token balance and allowance towards the desk. */
import { useReadContract } from 'wagmi';
import type { Address } from 'viem';
import { ERC20_ABI } from '@beagle/shared/abi';
import { config } from '../config.js';
import { describeError } from '../lib/errors.js';

/** What {@link useTokenAccount} returns. */
export interface TokenAccount {
  balance: bigint | undefined;
  allowance: bigint | undefined;
  loading: boolean;
  error: string | undefined;
  refetch(): Promise<unknown>;
}

/** `balanceOf(owner)` and `allowance(owner, spender)`, refreshed every 15 s. */
export function useTokenAccount(token: Address | undefined, owner: Address | undefined, spender: Address | undefined): TokenAccount {
  const enabled = token !== undefined && owner !== undefined;
  const balance = useReadContract({
    abi: ERC20_ABI,
    address: token,
    chainId: config.chainId,
    functionName: 'balanceOf',
    args: [owner ?? '0x0000000000000000000000000000000000000000'],
    query: { enabled, refetchInterval: 15_000 },
  });
  const allowance = useReadContract({
    abi: ERC20_ABI,
    address: token,
    chainId: config.chainId,
    functionName: 'allowance',
    args: [owner ?? '0x0000000000000000000000000000000000000000', spender ?? '0x0000000000000000000000000000000000000000'],
    query: { enabled: enabled && spender !== undefined, refetchInterval: 15_000 },
  });
  const err = balance.error ?? allowance.error;
  return {
    balance: enabled ? balance.data : undefined,
    allowance: enabled && spender !== undefined ? allowance.data : undefined,
    loading: enabled && (balance.isPending || (spender !== undefined && allowance.isPending)),
    error: err ? describeError(err) : undefined,
    refetch: () => Promise.all([balance.refetch(), allowance.refetch()]),
  };
}
