/**
 * Pons-mode chain plumbing: the factory address (from `registry.factory()`, falling back to the
 * mainnet constant) and the launch settings (`/api/launch-config`, falling back to factory reads
 * when the runner is unreachable).
 *
 * @module hooks/usePons
 */
import { useMemo } from 'react';
import { zeroAddress, type Address } from 'viem';
import { useReadContract, useReadContracts } from 'wagmi';
import { REGISTRY_ADDRESS, TARGET_CHAIN, VENUE } from '../config';
import { ponsAddressesFor, ponsFactoryAbi, ponsMindRegistryAbi, type PonsLaunchConfig, type PonsLaunchSettings } from '../lib/pons';
import { useLaunchConfigApi } from '../queries';

/** Most launch configs read from the chain in the fallback path. */
const MAX_CHAIN_CONFIGS = 16;

/** The Pons factory the registry is wired to (`registry.factory()`), or the known mainnet factory, or `null`. */
export function usePonsFactory(): Address | null {
  const read = useReadContract({
    address: REGISTRY_ADDRESS ?? zeroAddress,
    abi: ponsMindRegistryAbi,
    functionName: 'factory',
    chainId: TARGET_CHAIN.id,
    query: { enabled: VENUE === 'pons' && REGISTRY_ADDRESS !== null, staleTime: Infinity },
  });
  if (read.data !== undefined && read.data !== zeroAddress) return read.data;
  return ponsAddressesFor(TARGET_CHAIN.id)?.factory ?? null;
}

/** Result of {@link usePonsLaunchSettings}. */
export interface PonsLaunchSettingsResult {
  settings: PonsLaunchSettings | undefined;
  source: 'runner' | 'chain' | null;
  loading: boolean;
  error: unknown;
}

/** `/api/launch-config`, or the same figures read from the factory when the runner fails. */
export function usePonsLaunchSettings(): PonsLaunchSettingsResult {
  const api = useLaunchConfigApi(VENUE === 'pons');
  const factory = usePonsFactory();
  const useChain = VENUE === 'pons' && api.isError && factory !== null;
  const base = { address: factory ?? zeroAddress, abi: ponsFactoryAbi, chainId: TARGET_CHAIN.id } as const;
  const head = useReadContracts({
    contracts: [
      { ...base, functionName: 'launchFee' },
      { ...base, functionName: 'maxCreatorTaxBps' },
      { ...base, functionName: 'snipeTaxSeconds' },
      { ...base, functionName: 'launchConfigCount' },
    ],
    query: { enabled: useChain, staleTime: 60_000 },
  });
  const count = head.data?.[3]?.result;
  const ids = count !== undefined ? Array.from({ length: Math.min(Number(count), MAX_CHAIN_CONFIGS) }, (_, i) => BigInt(i)) : [];
  const configs = useReadContracts({
    contracts: ids.map((id) => ({ ...base, functionName: 'getLaunchConfig' as const, args: [id] as const })),
    query: { enabled: useChain && ids.length > 0, staleTime: 60_000 },
  });

  const chainSettings = useMemo((): PonsLaunchSettings | undefined => {
    const launchFee = head.data?.[0]?.result;
    if (launchFee === undefined || count === undefined) return undefined;
    const list: PonsLaunchConfig[] = [];
    configs.data?.forEach((r, i) => {
      if (r.status !== 'success') return;
      const c = r.result;
      list.push({ id: BigInt(i), supply: c.supply, curveFeeBps: Number(c.curveFeeBps), phantomQuote: c.phantomQuote, graduationThreshold: c.graduationThreshold, enabled: c.enabled });
    });
    if (ids.length > 0 && configs.data === undefined) return undefined;
    const max = head.data?.[1]?.result;
    const snipe = head.data?.[2]?.result;
    return {
      launchFee,
      configs: list,
      maxCreatorTaxBps: max !== undefined ? Number(max) : 0,
      snipeTaxSeconds: snipe !== undefined ? Number(snipe) : 15,
    };
  }, [head.data, configs.data, count, ids.length]);

  if (api.data !== undefined) return { settings: api.data, source: 'runner', loading: false, error: null };
  if (chainSettings !== undefined) return { settings: chainSettings, source: 'chain', loading: false, error: null };
  const loading = api.isPending || (useChain && (head.isPending || configs.isPending));
  return { settings: undefined, source: null, loading, error: useChain ? (head.error ?? configs.error ?? api.error) : api.error };
}
