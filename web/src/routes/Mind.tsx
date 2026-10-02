/**
 * `/mind/:token` — three columns: (1) stream: live frame, URL, thoughts, actions; (2) trade:
 * curve stats, buy / sell, graduation; (3) mind: model & persona, compute meter + feed,
 * creator tools, memories, receipts. Recent trades below.
 *
 * @module routes/Mind
 */
import { modelById } from '@www-rh/shared';
import { useMemo } from 'react';
import { Link, useParams } from 'react-router';
import { isAddress, type Address } from 'viem';
import { useConnection } from 'wagmi';
import { ApiError } from '../api';
import { ActionLog } from '../components/ActionLog';
import { ComputeMeter } from '../components/ComputeMeter';
import { CreatorTools } from '../components/CreatorTools';
import { MemoryList } from '../components/MemoryList';
import { MindInfoPanel } from '../components/MindInfoPanel';
import { ReceiptsList } from '../components/ReceiptsList';
import { StreamPanel } from '../components/StreamPanel';
import { ThoughtsTicker } from '../components/ThoughtsTicker';
import { TradePanel } from '../components/TradePanel';
import { TradesTable, mergeTrades } from '../components/TradesTable';
import { AddressLink, CopyButton, ExternalLink, MindAvatar, PhaseBadge, StatusBadge } from '../components/common';
import { modelLabel } from '../components/MindCard';
import { RUNNER_LABEL } from '../config';
import { formatEth, shortAddress, timeAgo } from '../format';
import { useMindData } from '../hooks/useMindData';
import { useMindStream } from '../hooks/useMindStream';
import { useNow } from '../hooks/useTick';
import { tokenUrl } from '../lib/chain';
import { describeError } from '../lib/errors';
import type { MindDetail } from '../lib/types';
import { isNotFound, useCompute, useThoughts, useTrades } from '../queries';

/** Mind route. */
export function Mind() {
  const params = useParams();
  const raw = params['token'] ?? '';
  const token = isAddress(raw, { strict: false }) ? (raw.toLowerCase() as Address) : undefined;
  if (token === undefined) {
    return (
      <div className="panel mx-auto max-w-lg p-8 text-center">
        <p className="text-fg">That is not a token address.</p>
        <p className="mt-1 text-dim">Coin pages live at /mind/0x… followed by the 40-character token address.</p>
        <Link to="/" className="btn btn-sm mt-4 hover:no-underline">
          back to all minds
        </Link>
      </div>
    );
  }
  return <MindPage token={token} />;
}

function MindPage({ token }: { token: Address }) {
  const data = useMindData(token);
  const stream = useMindStream(token);
  const trades = useTrades(token);
  const thoughts = useThoughts(token);
  const compute = useCompute(token);
  const { address } = useConnection();
  const mergedTrades = useMemo(() => mergeTrades(stream.trades, trades.data ?? []), [stream.trades, trades.data]);

  if (data.mind === null) {
    if (data.loading) {
      return <div className="panel h-96 animate-pulse" aria-busy="true" />;
    }
    const unavailable = data.apiError instanceof ApiError && data.apiError.unavailable;
    return (
      <div className="panel mx-auto max-w-lg p-8 text-center">
        {unavailable ? (
          <>
            <p className="text-fg">Can't load this mind right now.</p>
            <p className="mt-1 text-dim">
              {RUNNER_LABEL} is unreachable ({describeError(data.apiError)}) and the coin could not be read from the chain either.
            </p>
          </>
        ) : (
          <>
            <p className="text-fg">No mind lives at {shortAddress(token)}.</p>
            <p className="mt-1 text-dim">This address is not a coin of this launchpad. Check the link, or browse the minds that exist.</p>
          </>
        )}
        <Link to="/" className="btn btn-sm mt-4 hover:no-underline">
          back to all minds
        </Link>
      </div>
    );
  }

  const live: MindDetail = {
    ...data.mind,
    ...(stream.status !== null && data.mind.status === 'alive' && stream.status !== 'alive' ? { status: stream.status } : {}),
  };
  const isCreator = address !== undefined && address.toLowerCase() === live.creator.toLowerCase();
  const currentModel = live.model ?? modelById(live.modelId)?.id ?? null;

  return (
    <div className="space-y-4">
      <MindHeader mind={live} />
      {isNotFound(data.apiError) ? (
        <p className="rounded border border-info/40 bg-info/5 px-3 py-2 text-[12px] text-info">
          indexing… The runner has not picked this coin up yet (it appears within a few blocks of creation). Curve and trading already work from the
          chain; the stream starts once it is indexed.
        </p>
      ) : (
        data.apiError !== null &&
        data.apiError !== undefined && (
          <p className="rounded border border-amber/40 bg-amber/5 px-3 py-2 text-[12px] text-amber">
            The runner is not answering ({describeError(data.apiError)}). Curve, balances and trading come straight from the chain; the stream,
            memories and history return when it does.
          </p>
        )
      )}
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-[minmax(0,1.6fr)_minmax(300px,1fr)_minmax(300px,1fr)]">
        <div className="min-w-0 space-y-4 lg:col-span-2 xl:col-span-1">
          <StreamPanel mind={live} stream={stream} />
          <ThoughtsTicker blocks={stream.blocks} history={thoughts.data} saved={stream.savedThoughts} historyError={thoughts.isError} />
          <ActionLog actions={stream.actions} />
        </div>
        <div className="min-w-0 space-y-4">
          <TradePanel mind={live} onTx={data.refetchChain} />
        </div>
        <div className="min-w-0 space-y-4">
          <MindInfoPanel mind={live} />
          <ComputeMeter mind={live} compute={compute.data} computeError={compute.isError} budget={stream.budget} onFunded={data.refetchChain} />
          {isCreator && <CreatorTools mind={live} currentModel={currentModel} onChanged={data.refetchChain} />}
          <MemoryList token={token} live={stream.memories} />
          <ReceiptsList compute={compute.data} error={compute.isError} />
        </div>
      </div>
      <TradesTable trades={mergedTrades} symbol={live.symbol} loading={trades.isPending} error={trades.isError} />
    </div>
  );
}

function MindHeader({ mind }: { mind: MindDetail }) {
  const now = useNow(10_000);
  return (
    <header className="flex flex-col gap-3 border-b border-line pb-4 md:flex-row md:items-start md:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <MindAvatar image={mind.image} symbol={mind.symbol} size={56} />
        <div className="min-w-0 space-y-1">
          <h1 className="truncate text-lg text-fg">
            {mind.name} <span className="text-dim">${mind.symbol}</span>
          </h1>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={mind.status} />
            <PhaseBadge phase={mind.phase} />
            <span className="chip">{modelLabel(mind)}</span>
            {mind.lastTickAt !== null && <span className="text-[11px] text-mute">last thought {timeAgo(mind.lastTickAt, now)}</span>}
          </div>
          {mind.description !== null && <p className="max-w-3xl text-dim">{mind.description}</p>}
          {mind.links !== null && (
            <div className="flex flex-wrap gap-3 text-[12px]">
              {mind.links.website !== undefined && <ExternalLink href={mind.links.website}>website</ExternalLink>}
              {mind.links.x !== undefined && <ExternalLink href={mind.links.x}>x</ExternalLink>}
              {mind.links.telegram !== undefined && <ExternalLink href={mind.links.telegram}>telegram</ExternalLink>}
            </div>
          )}
        </div>
      </div>
      <dl className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-0.5 text-[12px] md:text-right">
        <dt className="text-mute">token</dt>
        <dd className="flex items-center gap-2 md:justify-end">
          <ExternalLink href={tokenUrl(mind.token)}>{shortAddress(mind.token)}</ExternalLink>
          <CopyButton value={mind.token} />
        </dd>
        <dt className="text-mute">creator</dt>
        <dd>
          <AddressLink address={mind.creator} />
        </dd>
        <dt className="text-mute">vault</dt>
        <dd className="tabular-nums">{formatEth(mind.mindBalanceWei)}</dd>
        <dt className="text-mute">born</dt>
        <dd>{mind.createdAt > 0 ? timeAgo(mind.createdAt, now) : '—'}</dd>
      </dl>
    </header>
  );
}
