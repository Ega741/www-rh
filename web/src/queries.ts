/**
 * TanStack Query hooks over the dashboard API. Query keys contain only strings/numbers so the
 * default hasher works; bigint lives in the data. Public queries poll; workspace queries refetch
 * on focus and are invalidated by the mutations below.
 */
import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { RegisterBudgetRequest } from '@beagle/shared/api';
import type { ByokProvider } from '@beagle/shared/models';
import { api, type UsageListParams } from './api.js';
import type { UsageWindow } from './lib/windows.js';

/** Query keys. */
export const qk = {
  me: ['me'] as const,
  status: ['status'] as const,
  config: ['config'] as const,
  price: ['price'] as const,
  models: ['models'] as const,
  balance: ['balance'] as const,
  keys: ['keys'] as const,
  usageSummary: (window: UsageWindow) => ['usage', 'summary', window] as const,
  usageList: (filters: Omit<UsageListParams, 'before'>) => ['usage', 'list', filters.limit ?? 50, filters.model ?? '', filters.status ?? ''] as const,
  receipts: ['receipts', 'list'] as const,
  receipt: (id: string) => ['receipts', 'one', id] as const,
  ledger: ['ledger'] as const,
  providers: ['providers'] as const,
  budgets: ['budgets'] as const,
  upgrades: ['upgrades'] as const,
  upgradePrices: ['upgrades', 'prices'] as const,
};

/** Keys of everything that belongs to the signed-in workspace (dropped on sign-out). */
export const WORKSPACE_KEYS = [qk.me, qk.balance, qk.keys, ['usage'], qk.receipts, ['receipts'], qk.ledger, qk.providers, qk.budgets, qk.upgrades] as const;

/** Removes all workspace-scoped queries from the cache. */
export function clearWorkspaceQueries(client: QueryClient): void {
  for (const key of WORKSPACE_KEYS) client.removeQueries({ queryKey: key });
}

/** Invalidates balance-related queries after a credit event. */
export async function invalidateBalances(client: QueryClient): Promise<void> {
  await Promise.all([client.invalidateQueries({ queryKey: qk.me }), client.invalidateQueries({ queryKey: qk.balance }), client.invalidateQueries({ queryKey: qk.receipts })]);
}

// ---------------------------------------------------------------------------------------------
// Public

/** `GET /api/status`, polled every 10 s. */
export function useStatus() {
  return useQuery({ queryKey: qk.status, queryFn: () => api.status(), refetchInterval: 10_000, staleTime: 5_000 });
}

/** `GET /api/config`; a failed read is retried every 15 s (the flows need it), a good one refreshed every 5 min. */
export function useGatewayConfig() {
  return useQuery({ queryKey: qk.config, queryFn: () => api.config(), staleTime: 5 * 60_000, refetchInterval: (q) => (q.state.status === 'error' ? 15_000 : 5 * 60_000) });
}

/** `GET /api/price`, polled every 15 s. */
export function usePrice() {
  return useQuery({ queryKey: qk.price, queryFn: () => api.price(), refetchInterval: 15_000, staleTime: 10_000 });
}

/** `GET /api/models`. */
export function useModels() {
  return useQuery({ queryKey: qk.models, queryFn: () => api.models(), staleTime: 60_000, refetchInterval: 60_000 });
}

// ---------------------------------------------------------------------------------------------
// Workspace

/** `GET /api/balance`; `pollMs` enables polling (post-burn watcher). */
export function useBalance(pollMs?: number) {
  return useQuery({
    queryKey: qk.balance,
    queryFn: () => api.balance(),
    staleTime: 5_000,
    ...(pollMs === undefined ? {} : { refetchInterval: pollMs }),
  });
}

/** `GET /api/keys`. */
export function useKeys() {
  return useQuery({ queryKey: qk.keys, queryFn: () => api.keys.list() });
}

/** `POST /api/keys`. */
export function useCreateKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => api.keys.create(name),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.keys }),
  });
}

/** `DELETE /api/keys/:id`. */
export function useRevokeKey() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.keys.revoke(id),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.keys }),
  });
}

/** `GET /api/usage/summary?window=`. */
export function useUsageSummary(window: UsageWindow) {
  return useQuery({ queryKey: qk.usageSummary(window), queryFn: () => api.usage.summary(window), staleTime: 15_000 });
}

/** `GET /api/usage` with cursor pagination (`nextBefore`). */
export function useUsageList(filters: Omit<UsageListParams, 'before'> = {}) {
  return useInfiniteQuery({
    queryKey: qk.usageList(filters),
    queryFn: ({ pageParam }) => api.usage.list({ ...filters, ...(pageParam === undefined ? {} : { before: pageParam }) }),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    staleTime: 10_000,
  });
}

/** `GET /api/receipts` (credit events); `pollMs` enables polling (post-burn watcher). */
export function useCreditEvents(limit = 20, pollMs?: number) {
  return useQuery({
    queryKey: [...qk.receipts, limit],
    queryFn: () => api.receipts.list({ limit }),
    staleTime: 10_000,
    ...(pollMs === undefined ? {} : { refetchInterval: pollMs }),
  });
}

/** `GET /api/receipts/:requestId`. */
export function useReceipt(requestId: string | undefined) {
  return useQuery({
    queryKey: qk.receipt(requestId ?? ''),
    queryFn: () => api.receipts.get(requestId as string),
    enabled: requestId !== undefined && requestId !== '',
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** `GET /api/providers`. */
export function useProviders() {
  return useQuery({ queryKey: qk.providers, queryFn: () => api.providers.list() });
}

/** `PUT /api/providers/:provider`. */
export function usePutProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (v: { provider: ByokProvider; apiKey: string; baseUrl?: string }) =>
      api.providers.put(v.provider, { apiKey: v.apiKey, ...(v.baseUrl === undefined ? {} : { baseUrl: v.baseUrl }) }),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.providers }),
  });
}

/** `DELETE /api/providers/:provider`. */
export function useRemoveProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (provider: ByokProvider) => api.providers.remove(provider),
    onSuccess: () => client.invalidateQueries({ queryKey: qk.providers }),
  });
}

/** `POST /api/providers/:provider/test`. */
export function useTestProvider() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (provider: ByokProvider) => api.providers.test(provider),
    onSettled: () => client.invalidateQueries({ queryKey: qk.providers }),
  });
}

/** `GET /api/budgets`, polled every 15 s (headroom refresher cadence). */
export function useBudgets() {
  return useQuery({ queryKey: qk.budgets, queryFn: () => api.budgets.list(), refetchInterval: 15_000, staleTime: 5_000 });
}

/** `POST /api/budgets/register` (after `ApproveChecked`); refreshes the list and the balance headroom. */
export function useRegisterBudget() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: RegisterBudgetRequest) => api.budgets.register(body),
    onSuccess: async () => {
      await Promise.all([client.invalidateQueries({ queryKey: qk.budgets }), client.invalidateQueries({ queryKey: qk.me }), client.invalidateQueries({ queryKey: qk.balance })]);
    },
  });
}

/** `GET /api/upgrades`. */
export function useUpgrades() {
  return useQuery({ queryKey: qk.upgrades, queryFn: () => api.upgrades.list() });
}

/** `GET /api/upgrades/prices`. */
export function useUpgradePrices() {
  return useQuery({ queryKey: qk.upgradePrices, queryFn: () => api.upgrades.prices(), staleTime: 5 * 60_000 });
}

/** `POST /api/upgrades`. */
export function useBuyUpgrade() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (v: { kind: 'pro' | 'warm'; quantity: number }) => api.upgrades.buy(v.kind, v.quantity),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: qk.upgrades }),
        client.invalidateQueries({ queryKey: qk.me }),
        client.invalidateQueries({ queryKey: qk.balance }),
        client.invalidateQueries({ queryKey: qk.status }),
      ]);
    },
  });
}
