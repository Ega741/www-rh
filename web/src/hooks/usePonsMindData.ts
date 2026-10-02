/**
 * Pons-mode mind page data (SPEC §9.5/§9.7): the runner's `MindDetail` merged with the registry
 * (`getMind`, `ponsMind`, `mindBalance`, `claimable`, `hasLeft`), the Pons factory launch record
 * (`getLaunchedToken`: phase, fee recipient) and the Pons curve (`getReserves`, `sellableTokens`,
 * `realQuoteReserve`, `graduationThreshold`, `feeBps`, `creatorTaxBps`, `graduated`,
 * `readyToGraduate`). On-chain values win; the page renders from chain while the runner is down.
 *
 * @module hooks/usePonsMindData
 */
import { useEffect, useState } from 'react';
import { erc20Abi, zeroAddress, type Address } from 'viem';
import { useReadContract, useReadContracts } from 'wagmi';
import { REGISTRY_ADDRESS, TARGET_CHAIN } from '../config';
import { decodeJsonDataUri } from '../lib/dataUri';
import { readText } from '../lib/json';
import { personaHashOf } from '../lib/metadata';
import { toStatusName } from '../lib/normalize';
import { ponsCurveAbi, ponsCurveExtrasAbi, ponsFactoryAbi, ponsMindRegistryAbi, ponsPhase, ponsPrice, ponsProgressBps } from '../lib/pons';
import type { MindDetail, PonsInfo, PonsLive } from '../lib/types';
import { useMindDetail } from '../queries';
import type { ChainLookup, MindData } from './useMindData';
import { usePonsFactory } from './usePons';

const E18 = 10n ** 18n;

function nonZero(a: Address | undefined | null): Address | null {
  return a !== undefined && a !== null && a.toLowerCase() !== zeroAddress ? (a.toLowerCase() as Address) : null;
}

/** See module docs. */
export function usePonsMindData(token: Address | undefined): MindData {
  const enabled = token !== undefined && REGISTRY_ADDRESS !== null;
  const api = useMindDetail(token);
  const reg = { address: REGISTRY_ADDRESS ?? zeroAddress, abi: ponsMindRegistryAbi, chainId: TARGET_CHAIN.id } as const;
  const args = [token ?? zeroAddress] as const;

  const info = useReadContract({ ...reg, functionName: 'getMind', args, query: { enabled, refetchInterval: 15_000 } });
  const record = useReadContract({ ...reg, functionName: 'ponsMind', args, query: { enabled, refetchInterval: 30_000 } });
  const vault = useReadContract({ ...reg, functionName: 'mindBalance', args, query: { enabled, refetchInterval: 5_000 } });
  const claimable = useReadContract({ ...reg, functionName: 'claimable', args, query: { enabled, refetchInterval: 15_000 } });
  // SPEC §9.7; best-effort (a pre-§9.7 registry has no hasLeft: fall back to the runner's pons.left)
  const leftRead = useReadContract({ ...reg, functionName: 'hasLeft', args, query: { enabled, refetchInterval: 30_000, retry: false } });
  const factory = usePonsFactory();
  const launch = useReadContract({
    address: factory ?? zeroAddress,
    abi: ponsFactoryAbi,
    functionName: 'getLaunchedToken',
    args,
    chainId: TARGET_CHAIN.id,
    query: { enabled: token !== undefined && factory !== null, refetchInterval: 10_000 },
  });

  const launchData = launch.data !== undefined && launch.data.exists ? launch.data : undefined;
  const curveAddress = nonZero(record.data?.curve) ?? nonZero(launchData?.curve) ?? api.data?.pons?.curve ?? null;
  const c = { address: curveAddress ?? zeroAddress, abi: ponsCurveAbi, chainId: TARGET_CHAIN.id } as const;
  const curve = useReadContracts({
    contracts: [
      { ...c, functionName: 'getReserves' },
      { ...c, functionName: 'sellableTokens' },
      { ...c, functionName: 'realQuoteReserve' },
      { ...c, functionName: 'graduationThreshold' },
      { ...c, functionName: 'feeBps' },
      { ...c, functionName: 'creatorTaxBps' },
      { ...c, functionName: 'graduated' },
      { ...c, functionName: 'readyToGraduate' },
    ],
    query: { enabled: curveAddress !== null, refetchInterval: 5_000 },
  });
  const launchedAtRead = useReadContract({
    address: curveAddress ?? zeroAddress,
    abi: ponsCurveExtrasAbi,
    functionName: 'launchedAt',
    chainId: TARGET_CHAIN.id,
    query: { enabled: curveAddress !== null, staleTime: Infinity, retry: false },
  });
  const supply = useReadContract({ address: token, abi: erc20Abi, functionName: 'totalSupply', chainId: TARGET_CHAIN.id, query: { enabled: token !== undefined, staleTime: Infinity } });

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
  const isOnchainMind = chainInfo !== undefined && chainInfo.creator !== zeroAddress;
  const r = curve.data;
  const reserves = r?.[0]?.status === 'success' ? r[0].result : undefined;
  const pick = <T,>(i: number): T | null => {
    const item = r?.[i];
    return item !== undefined && item.status === 'success' ? (item.result as T) : null;
  };
  const sellable = pick<bigint>(1);
  const realQuote = pick<bigint>(2);
  const threshold = pick<bigint>(3);
  const feeBps = pick<bigint>(4);
  const taxBps = pick<bigint>(5);
  const graduated = pick<boolean>(6);
  const ready = pick<boolean>(7);
  const totalSupply = supply.data ?? null;

  let mind: MindDetail | null = api.data ?? null;
  const namesSettled = (name.isSuccess || name.isError) && (symbol.isSuccess || symbol.isError);
  if (mind === null && token !== undefined && isOnchainMind && record.data !== undefined && namesSettled) {
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
      venue: 'pons',
      personaHash: chainInfo.personaHash,
      personaVerified: null,
      pool: null,
      positionId: null,
      description: null,
      persona: null,
      links: null,
      lastFrameAt: null,
      pons: null,
    };
  }

  if (mind !== null && mind.persona === null && api.data === undefined) {
    const meta = decodeJsonDataUri(mind.metadataURI);
    if (meta !== null) {
      const persona = readText(meta, 'persona');
      const verified = persona !== null && personaHashOf(persona).toLowerCase() === mind.personaHash.toLowerCase();
      mind = { ...mind, persona: verified ? persona : null, personaVerified: persona === null ? null : verified, description: mind.description ?? readText(meta, 'description') };
    }
  }

  if (mind !== null && isOnchainMind) {
    mind = { ...mind, status: toStatusName(chainInfo.status), modelId: chainInfo.modelId, personaHash: chainInfo.personaHash, metadataURI: chainInfo.metadataURI };
    if (mind.creator === zeroAddress) mind = { ...mind, creator: chainInfo.creator.toLowerCase() as Address };
  }

  let live: PonsLive | null = null;
  if (mind !== null && curveAddress !== null) {
    const account = nonZero(record.data?.account) ?? api.data?.pons?.account ?? null;
    const launchedAtSec = launchedAtRead.data !== undefined && launchedAtRead.data > 0n ? Number(launchedAtRead.data) : null;
    const launchedHere = record.data?.launchedHere ?? api.data?.pons?.launchedHere ?? false;
    live = {
      curve: curveAddress,
      account,
      quoteReserve: reserves?.[0] ?? null,
      tokenReserve: reserves?.[1] ?? null,
      sellable,
      realQuoteReserve: realQuote,
      graduationThreshold: threshold ?? launchData?.graduationThreshold ?? null,
      feeBps: feeBps !== null ? Number(feeBps) : (api.data?.pons?.feeBps ?? null),
      creatorTaxBps: taxBps !== null ? Number(taxBps) : launchData !== undefined ? launchData.creatorTaxBps : (api.data?.pons?.creatorTaxBps ?? null),
      graduated,
      readyToGraduate: ready,
      factoryPhase: launchData?.phase ?? null,
      creatorFeeRecipient: nonZero(launchData?.creatorFeeRecipient),
      deployer: nonZero(launchData?.deployer),
      launchedAt: launchedAtSec ?? (launchedHere && mind.createdAt > 0 ? Math.floor(mind.createdAt / 1000) : null),
      totalSupply,
      claimableWei: claimable.data ?? null,
      left: leftRead.data ?? null,
    };
    const base: PonsInfo | null = mind.pons;
    const pons: PonsInfo | null =
      account === null
        ? base
        : {
            curve: curveAddress,
            account,
            deployer: live.deployer ?? base?.deployer ?? null,
            launchConfigId: record.data?.launchConfigId ?? base?.launchConfigId ?? null,
            feeBps: live.feeBps ?? base?.feeBps ?? null,
            creatorTaxBps: live.creatorTaxBps ?? base?.creatorTaxBps ?? null,
            claimableWei: live.claimableWei ?? base?.claimableWei ?? 0n,
            launchedHere,
            adopted: record.data?.adopted ?? base?.adopted ?? false,
            left: live.left ?? base?.left ?? false,
            poolId: base?.poolId ?? null,
          };
    const anyPhaseRead = live.factoryPhase !== null || graduated !== null || ready !== null;
    const phase = anyPhaseRead ? ponsPhase({ factoryPhase: live.factoryPhase, graduated, readyToGraduate: ready }) : mind.phase;
    mind = { ...mind, venue: 'pons', pons, phase };
    if (phase !== 'graduated' && reserves !== undefined) {
      const priceWei = ponsPrice(reserves[0], reserves[1]);
      mind = { ...mind, priceWei, marketCapWei: totalSupply !== null ? (priceWei * totalSupply) / E18 : mind.marketCapWei };
    }
    if (realQuote !== null && threshold !== null) {
      mind = {
        ...mind,
        realEthReserveWei: realQuote,
        progressBps: phase === 'bonding' ? Number(ponsProgressBps(realQuote, threshold)) : 10_000,
      };
    } else if (phase !== 'bonding') {
      mind = { ...mind, progressBps: 10_000 };
    }
    if (reserves !== undefined && totalSupply !== null && totalSupply >= reserves[1]) mind = { ...mind, tokensSold: totalSupply - reserves[1] };
  }
  if (mind !== null && vault.data !== undefined) mind = { ...mind, mindBalanceWei: vault.data };

  const chain: ChainLookup = !enabled ? 'disabled' : info.isSuccess ? (isOnchainMind ? 'mind' : 'not-a-mind') : info.isError ? 'error' : 'pending';

  return {
    mind,
    loading: mind === null && api.isPending && apiError === null && chain !== 'error' && chain !== 'not-a-mind',
    chain,
    apiError,
    chainError: info.error ?? record.error ?? curve.error,
    refetchChain: () => {
      void info.refetch();
      void record.refetch();
      void vault.refetch();
      void claimable.refetch();
      void leftRead.refetch();
      void launch.refetch();
      void curve.refetch();
    },
    ponsLive: live,
  };
}
