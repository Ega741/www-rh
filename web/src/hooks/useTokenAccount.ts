/**
 * The connected wallet's token account of the mint (its ATA): balance, delegate and delegated
 * amount, read with one `getAccountInfo` and unpacked with `@solana/spl-token`, refreshed every
 * 15 s. A missing account is a first-class state ("no token account": the wallet never received
 * BEAGLE), not an error.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useConnection } from '@solana/wallet-adapter-react';
import { PublicKey } from '@solana/web3.js';
import { describeError } from '../lib/errors.js';
import { associatedTokenAddress, readTokenAccount, type TokenAccountView } from '../lib/token.js';

/** What {@link useTokenAccount} returns. */
export interface TokenAccountState {
  /** The ATA address (derivable before the read). */
  address: string | undefined;
  /** The account as last read; `undefined` while loading / disabled. */
  account: TokenAccountView | undefined;
  /** Raw balance (0 for a missing account). */
  balance: bigint | undefined;
  /** `true` once the read settled (success or error). */
  settled: boolean;
  loading: boolean;
  error: string | undefined;
  refetch(): Promise<unknown>;
}

/** Query key of a wallet's token account. */
export function tokenAccountKey(mint: string | undefined, owner: string | undefined, tokenProgram: string): readonly unknown[] {
  return ['tokenAccount', mint ?? '', owner ?? '', tokenProgram] as const;
}

/** Reads the ATA of `owner` for `mint`. Disabled until both are known. */
export function useTokenAccount(mint: string | undefined, owner: string | undefined, tokenProgram: string): TokenAccountState {
  const { connection } = useConnection();
  const enabled = mint !== undefined && owner !== undefined;
  let address: string | undefined;
  if (enabled) {
    try {
      address = associatedTokenAddress(mint, owner, tokenProgram);
    } catch {
      address = undefined;
    }
  }
  const query = useQuery({
    queryKey: tokenAccountKey(mint, owner, tokenProgram),
    enabled: enabled && address !== undefined,
    queryFn: async (): Promise<TokenAccountView> => {
      const ata = new PublicKey(address as string);
      const info = await connection.getAccountInfo(ata, 'confirmed');
      return readTokenAccount(ata, info, tokenProgram);
    },
    refetchInterval: 15_000,
    staleTime: 5_000,
    retry: 1,
  });
  return {
    address,
    account: enabled ? query.data : undefined,
    balance: enabled ? query.data?.amount : undefined,
    settled: enabled && !query.isPending,
    loading: enabled && query.isPending,
    error: enabled && query.isError ? describeError(query.error) : undefined,
    refetch: () => query.refetch(),
  };
}

/** Drops cached token-account reads (after a burn / approve / revoke confirmed). */
export function useInvalidateTokenAccounts(): () => Promise<void> {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: ['tokenAccount'] });
}
