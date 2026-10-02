/**
 * Mind page data: the runner's `MindDetail` merged with fresh on-chain reads (`getMind`,
 * `getCurve`, `mindBalance`, token `name`/`symbol`). On-chain values win for status, phase,
 * reserves and vault balance; when the runner is unreachable the page still renders from chain.
 *
 * @module hooks/useMindData
 */
import { marketCap, mindLaunchpadAbi as launchpadAbi, priceOf, progressBps } from '@www-rh/shared';
import { useEffect, useState } from 'react';
import { erc20Abi, zeroAddress, type Address } from 'viem';
import { useReadContract } from 'wagmi';
import { LAUNCHPAD_ADDRESS, TARGET_CHAIN } from '../config';
import { decodeJsonDataUri } from '../lib/dataUri';
import { readText } from '../lib/json';
import { personaHashOf } from '../lib/metadata';
import { toPhaseName, toStatusName } from '../lib/normalize';
import type { MindDetail } from '../lib/types';
import { useMindDetail } from '../queries';

/** What the chain says about the token. */
export type ChainLookup = 'disabled' | 'pending' | 'mind' | 'not-a-mind' | 'error';

/** Merged mind data. */
export interface MindData {
  mind: MindDetail | null;
  /** The runner request is still in flight and nothing is known yet. */
  loading: boolean;
  /** On-chain lookup state (`getMind`). */
  chain: ChainLookup;
  apiError: unknown;
  chainError: unknown;
  /** Re-reads on-chain state (after a transaction). */
  refetchChain: () => void;
}

/** Loads and merges runner + chain data for `token`. */
export function useMindData(token: Address | undefined): MindData {
  const enabled = token !== undefined && LAUNCHPAD_ADDRESS !== null;
  const api = useMindDetail(token);
  const base = { address: LAUNCHPAD_ADDRESS ?? zeroAddress, abi: launchpadAbi, chainId: TARGET_CHAIN.id } as const;
  const args = [token ?? zeroAddress] as const;

  const info = useReadContract({ ...base, functionName: 'getMind', args, query: { enabled, refetchInterval: 15_000 } });
  const curve = useReadContract({ ...base, functionName: 'getCurve', args, query: { enabled, refetchInterval: 5_000 } });
  const vault = useReadContract({ ...base, functionName: 'mindBalance', args, query: { enabled, refetchInterval: 5_000 } });
  // TanStack Query resets a never-successful query to `pending` on every refetch (the 2 s polling
  // while the runner answers 404), so remember the last error until a success arrives.
  const [lastError, setLastError] = useState<unknown>(null);
  useEffect(() => {
    if (api.isSuccess) setLastError(null);
    else if (api.error !== null) setLastError(api.error);
  }, [api.isSuccess, api.error]);
  const apiError: unknown = api.isSuccess ? null : (api.error ?? lastError);

  const needNames = token !== undefined && api.data === undefined;
  const name = useReadContract({ address: token, abi: erc20Abi, functionName: 'name', chainId: TARGET_CHAIN.id, query: { enabled: needNames, staleTime: Infinity } });
  const symbol = useReadContract({ address: token, abi: erc20Abi, functionName: 'symbol', chainId: TARGET_CHAIN.id, query: { enabled: needNames, staleTime: Infinity } });

  const chainInfo = info.data;
  const chainCurve = curve.data;
  const isOnchainMind = chainInfo !== undefined && chainInfo.creator !== zeroAddress;

  let mind: MindDetail | null = api.data ?? null;
  const namesSettled = (name.isSuccess || name.isError) && (symbol.isSuccess || symbol.isError);
  if (mind === null && token !== undefined && isOnchainMind && chainCurve !== undefined && namesSettled) {
    mind = {
      token: token.toLowerCase() as Address,
      name: name.data ?? 'Unnamed mind',
      symbol: symbol.data ?? '???',
      creator: chainInfo.creator.toLowerCase() as Address,
      metadataURI: chainInfo.metadataURI,
      image: null,
      modelId: chainInfo.modelId,
      model: null,
      status: 'dormant',
      phase: 'bonding',
      priceWei: 0n,
      marketCapWei: 0n,
      progressBps: 0,
      realEthReserveWei: 0n,
      tokensSold: 0n,
      mindBalanceWei: 0n,
      lastTickAt: null,
      currentUrl: null,
      createdAt: Number(chainInfo.createdAt) * 1000,
      trades24h: 0,
      volume24hWei: 0n,
      personaHash: chainInfo.personaHash,
      personaVerified: null,
      pool: null,
      positionId: null,
      description: null,
      persona: null,
      links: null,
      lastFrameAt: null,
    };
  }

  // Metadata embedded as a data: URI can be read (and its persona verified) without the runner.
  if (mind !== null && mind.persona === null && api.data === undefined) {
    const meta = decodeJsonDataUri(mind.metadataURI);
    if (meta !== null) {
      const persona = readText(meta, 'persona');
      const verified = persona !== null && personaHashOf(persona).toLowerCase() === mind.personaHash.toLowerCase();
      mind = {
        ...mind,
        persona: verified ? persona : null,
        personaVerified: persona === null ? null : verified,
        description: mind.description ?? readText(meta, 'description'),
      };
    }
  }

  if (mind !== null && isOnchainMind) {
    mind = { ...mind, status: toStatusName(chainInfo.status), modelId: chainInfo.modelId, personaHash: chainInfo.personaHash, metadataURI: chainInfo.metadataURI };
    if (mind.creator === zeroAddress) mind = { ...mind, creator: chainInfo.creator.toLowerCase() as Address };
  }
  if (mind !== null && chainCurve !== undefined) {
    const reserves = { realEthReserve: chainCurve.realEthReserve, tokensSold: chainCurve.tokensSold };
    const phase = toPhaseName(chainCurve.phase);
    const pool = chainCurve.pool !== zeroAddress ? (chainCurve.pool.toLowerCase() as Address) : mind.pool;
    mind = {
      ...mind,
      phase,
      realEthReserveWei: chainCurve.realEthReserve,
      tokensSold: chainCurve.tokensSold,
      progressBps: Number(progressBps(chainCurve.tokensSold)),
      pool,
      positionId: phase === 'graduated' ? chainCurve.positionId : mind.positionId,
      ...(phase === 'graduated' ? {} : { priceWei: priceOf(reserves), marketCapWei: marketCap(reserves) }),
    };
  }
  if (mind !== null && vault.data !== undefined) mind = { ...mind, mindBalanceWei: vault.data };

  const chain: ChainLookup = !enabled ? 'disabled' : info.isSuccess ? (isOnchainMind ? 'mind' : 'not-a-mind') : info.isError ? 'error' : 'pending';

  return {
    mind,
    loading: mind === null && api.isPending && apiError === null && chain !== 'error' && chain !== 'not-a-mind',
    chain,
    apiError,
    chainError: info.error ?? curve.error,
    refetchChain: () => {
      void info.refetch();
      void curve.refetch();
      void vault.refetch();
    },
  };
}
