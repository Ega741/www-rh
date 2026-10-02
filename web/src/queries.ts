/**
 * TanStack Query hooks over the runner API.
 *
 * @module queries
 */
import { MODELS, toPublicModelSpec } from '@www-rh/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { Address } from 'viem';
import { ApiError, getCompute, getHealth, getLaunchConfig, getMemories, getMind, getMindAdoptions, getMinds, getModels, getStats, getThoughts, getTrades } from './api';
import type { ComputeInfo, MindsSort, ModelInfo, PendingAdoption } from './lib/types';

/** Query keys. */
export const queryKeys = {
  minds: (sort: MindsSort) => ['minds', sort] as const,
  mind: (token: string) => ['mind', token.toLowerCase()] as const,
  trades: (token: string) => ['trades', token.toLowerCase()] as const,
  memories: (token: string) => ['memories', token.toLowerCase()] as const,
  thoughts: (token: string) => ['thoughts', token.toLowerCase()] as const,
  compute: (token: string) => ['compute', token.toLowerCase()] as const,
  adoptions: (token: string) => ['adoptions', token.toLowerCase()] as const,
  models: ['models'] as const,
  stats: ['stats'] as const,
  health: ['health'] as const,
  launchConfig: ['launch-config'] as const,
};

/** Paged mind list for the home grid. */
export function useMindsList(sort: MindsSort) {
  return useInfiniteQuery({
    queryKey: queryKeys.minds(sort),
    queryFn: ({ pageParam }) => getMinds({ sort, limit: 48, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: 15_000,
  });
}

/** Whether `error` is an API 404 (e.g. a freshly created mind that is not indexed yet). */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** Runs `load`, mapping a 404 (mind not indexed yet) to `empty`. */
async function orEmptyOn404<T>(load: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (isNotFound(error)) return empty;
    throw error;
  }
}

/**
 * The query's error, kept until the next success. TanStack Query resets a query that never
 * succeeded back to `pending` (error `null`) on every refetch; without this, error copy would
 * flicker away during each retry against an unreachable runner.
 */
export function useSettledError(query: { isSuccess: boolean; error: unknown }): unknown {
  const [last, setLast] = useState<unknown>(null);
  useEffect(() => {
    if (query.isSuccess) setLast(null);
    else if (query.error !== null && query.error !== undefined) setLast(query.error);
  }, [query.isSuccess, query.error]);
  return query.isSuccess ? null : (query.error ?? last);
}

/** Mind detail from the runner; polls every 2 s while the runner answers 404 ("indexing…", SPEC §7). */
export function useMindDetail(token: Address | undefined) {
  return useQuery({
    queryKey: queryKeys.mind(token ?? ''),
    queryFn: () => getMind(token as Address),
    enabled: token !== undefined,
    refetchInterval: (query) => (isNotFound(query.state.error) ? 2_000 : 15_000),
    retry: (count, error) => !isNotFound(error) && count < 1,
  });
}

/** Recent trades. */
export function useTrades(token: Address | undefined) {
  return useQuery({
    queryKey: queryKeys.trades(token ?? ''),
    queryFn: () => orEmptyOn404(() => getTrades(token as Address, 100), []),
    enabled: token !== undefined,
    refetchInterval: 20_000,
    retry: 1,
  });
}

/** Memories, newest first, paged with `before=seq`. */
export function useMemories(token: Address | undefined) {
  return useInfiniteQuery({
    queryKey: queryKeys.memories(token ?? ''),
    queryFn: ({ pageParam }) => orEmptyOn404(() => getMemories(token as Address, { limit: 30, before: pageParam }), []),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => {
      if (last.length < 30) return null;
      const oldest = last.reduce((min, m) => Math.min(min, m.seq), Number.POSITIVE_INFINITY);
      return Number.isFinite(oldest) && oldest > 0 ? oldest : null;
    },
    enabled: token !== undefined,
    refetchInterval: 30_000,
    retry: 1,
  });
}

/** Persisted thoughts (think_aloud + tick summaries). */
export function useThoughts(token: Address | undefined) {
  return useQuery({
    queryKey: queryKeys.thoughts(token ?? ''),
    queryFn: () => orEmptyOn404(() => getThoughts(token as Address, 50), []),
    enabled: token !== undefined,
    refetchInterval: 20_000,
    retry: 1,
  });
}

/** Compute meter data: balance, burn, runway, ledger, receipts (`null` while the mind is not indexed). */
export function useCompute(token: Address | undefined) {
  return useQuery({
    queryKey: queryKeys.compute(token ?? ''),
    queryFn: () => orEmptyOn404<ComputeInfo | null>(() => getCompute(token as Address), null),
    enabled: token !== undefined,
    refetchInterval: 20_000,
    retry: 1,
  });
}

/**
 * Pending adoption preparations of a token (SPEC §9.7, `GET /api/minds/:token/adoptions`); a 404
 * (token unknown to the runner, or a pre-§9.7 runner) reads as none.
 */
export function useMindAdoptions(token: Address | undefined) {
  return useQuery({
    queryKey: queryKeys.adoptions(token ?? ''),
    queryFn: () => orEmptyOn404<PendingAdoption[]>(() => getMindAdoptions(token as Address), []),
    enabled: token !== undefined,
    refetchInterval: 15_000,
    retry: 1,
  });
}

/** Result of {@link useModels}: models plus where they came from. */
export interface ModelsResult {
  models: ModelInfo[];
  source: 'runner' | 'catalog';
}

/** Built-in catalog from `@www-rh/shared`, used when the runner cannot be reached. */
export function catalogModels(): ModelInfo[] {
  return MODELS.map((m) => toPublicModelSpec(m));
}

/** `GET /api/models`, falling back to the shared catalog. */
export function useModels() {
  return useQuery<ModelsResult>({
    queryKey: queryKeys.models,
    queryFn: async () => {
      try {
        const models = await getModels();
        if (models.length > 0) return { models, source: 'runner' };
      } catch {
        // fall through to the catalog
      }
      return { models: catalogModels(), source: 'catalog' };
    },
    staleTime: 5 * 60_000,
  });
}

/** Global stats strip. */
export function useStats() {
  return useQuery({ queryKey: queryKeys.stats, queryFn: getStats, refetchInterval: 30_000, retry: 1 });
}

/** Runner health (footer indicator). */
export function useHealth() {
  return useQuery({ queryKey: queryKeys.health, queryFn: getHealth, refetchInterval: 30_000, retry: 0 });
}

/** `GET /api/launch-config` (Pons mode; the runner caches it for 60 s). */
export function useLaunchConfigApi(enabled = true) {
  return useQuery({ queryKey: queryKeys.launchConfig, queryFn: getLaunchConfig, enabled, staleTime: 60_000, refetchInterval: 60_000, retry: 1 });
}
