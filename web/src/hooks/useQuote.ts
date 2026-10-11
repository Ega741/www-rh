/** On-chain reads of the desk: parameters, unit price, and a live quote for an amount. */
import { useReadContract } from 'wagmi';
import type { Address } from 'viem';
import { CREDIT_DESK_ABI } from '@beagle/shared/abi';
import { config } from '../config.js';
import { describeError, revertName } from '../lib/errors.js';

const REFRESH_MS = 15_000;

/** Desk parameters and the current unit price (`quote(10^decimals)`). */
export interface DeskParams {
  minBurn: bigint | undefined;
  paused: boolean | undefined;
  maxPriceAge: number | undefined;
  /** USD per whole token × 1e18, from `quote(1 token)`; undefined when unavailable/stale. */
  priceE18: bigint | undefined;
  /** Unix seconds of the price observation. */
  priceUpdatedAt: number | undefined;
  /** `PriceStale` / `PriceUnavailable` / other revert name when the price read failed. */
  priceError: string | undefined;
  priceErrorText: string | undefined;
  loading: boolean;
  refetch(): Promise<unknown>;
}

/** Reads `minBurn`, `paused`, `maxPriceAge` and `quote(10^decimals)`. */
export function useDeskParams(desk: Address | undefined, decimals: number | undefined): DeskParams {
  const enabled = desk !== undefined;
  const common = { abi: CREDIT_DESK_ABI, address: desk, chainId: config.chainId } as const;
  const minBurn = useReadContract({ ...common, functionName: 'minBurn', query: { enabled, refetchInterval: REFRESH_MS } });
  const paused = useReadContract({ ...common, functionName: 'paused', query: { enabled, refetchInterval: REFRESH_MS } });
  const maxAge = useReadContract({ ...common, functionName: 'maxPriceAge', query: { enabled, staleTime: 60_000 } });
  const unit = 10n ** BigInt(decimals ?? 18);
  const price = useReadContract({
    ...common,
    functionName: 'quote',
    args: [unit],
    query: { enabled: enabled && decimals !== undefined, refetchInterval: REFRESH_MS, retry: false },
  });

  return {
    minBurn: minBurn.data,
    paused: paused.data,
    maxPriceAge: maxAge.data,
    priceE18: price.data?.[1],
    priceUpdatedAt: price.data === undefined ? undefined : Number(price.data[2]),
    priceError: price.error ? (revertName(price.error) ?? 'ReadFailed') : undefined,
    priceErrorText: price.error ? describeError(price.error) : undefined,
    loading: enabled && (minBurn.isPending || paused.isPending || price.isPending),
    refetch: () => Promise.all([minBurn.refetch(), paused.refetch(), maxAge.refetch(), price.refetch()]),
  };
}

/** Live quote for `amount` raw tokens. */
export interface Quote {
  usdMicro: bigint | undefined;
  priceE18: bigint | undefined;
  updatedAt: number | undefined;
  loading: boolean;
  error: string | undefined;
  revert: string | undefined;
  /** Re-reads the quote now (the "Re-quote" action after `SlippageExceeded`). */
  refetch(): Promise<unknown>;
}

/** `desk.quote(amount)`; disabled for zero amounts. */
export function useQuote(desk: Address | undefined, amount: bigint | undefined): Quote {
  const enabled = desk !== undefined && amount !== undefined && amount > 0n;
  const q = useReadContract({
    abi: CREDIT_DESK_ABI,
    address: desk,
    chainId: config.chainId,
    functionName: 'quote',
    args: [amount ?? 0n],
    query: { enabled, refetchInterval: REFRESH_MS, retry: false },
  });
  return {
    usdMicro: enabled ? q.data?.[0] : undefined,
    priceE18: enabled ? q.data?.[1] : undefined,
    updatedAt: enabled && q.data !== undefined ? Number(q.data[2]) : undefined,
    loading: enabled && q.isPending,
    error: enabled && q.error ? describeError(q.error) : undefined,
    revert: enabled && q.error ? revertName(q.error) : undefined,
    refetch: () => q.refetch(),
  };
}
