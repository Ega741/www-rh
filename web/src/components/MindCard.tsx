/**
 * Home-grid card: live thumbnail (frame.jpg every 5 s while visible), avatar, name / $symbol,
 * status, model, price & market cap, curve progress, what the mind is looking at, and a
 * "feed the mind" micro-button.
 *
 * @module components/MindCard
 */
import { modelById } from '@www-rh/shared';
import { useRef, useState } from 'react';
import { Link } from 'react-router';
import { displayUrl, formatEth, formatPrice, timeAgo } from '../format';
import { useInView } from '../hooks/useInView';
import { useLiveFrame } from '../hooks/useLiveFrame';
import { useNow } from '../hooks/useTick';
import type { MindSummary } from '../lib/types';
import { FeedMind } from './FeedMind';
import { MindAvatar, PhaseBadge, ProgressBar, StatusBadge } from './common';

/** Display label of a mind's model (catalog label, id, or "unknown model"). */
export function modelLabel(mind: Pick<MindSummary, 'model' | 'modelId'>): string {
  const spec = modelById(mind.modelId);
  if (spec !== undefined) return spec.label;
  return mind.model ?? 'unknown model';
}

/** One card of the home grid. */
export function MindCard({ mind }: { mind: MindSummary }) {
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref);
  const frame = useLiveFrame(mind.token, inView && mind.status !== 'paused');
  const now = useNow(5_000);
  const [feeding, setFeeding] = useState(false);
  const href = `/mind/${mind.token}`;

  return (
    <article ref={ref} className="panel group flex flex-col overflow-hidden transition-colors hover:border-line-2">
      <Link to={href} className="relative block aspect-[16/10] overflow-hidden border-b border-line bg-bg hover:no-underline" aria-label={`${mind.name} live view`}>
        {frame.src !== null ? (
          <img src={frame.src} alt="" className="h-full w-full object-cover object-top opacity-90 transition-opacity group-hover:opacity-100" />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-[11px] text-mute">
            <span>{mind.status === 'alive' ? 'waiting for the first frame' : mind.status === 'paused' ? 'paused by creator' : 'asleep: vault empty'}</span>
          </div>
        )}
        <div className="scanlines pointer-events-none absolute inset-0" />
        <div className="absolute top-2 left-2 flex items-center gap-1.5 rounded bg-bg/80 px-1.5 py-0.5">
          <StatusBadge status={mind.status} />
        </div>
        {mind.currentUrl !== null && (
          <div className="absolute right-0 bottom-0 left-0 truncate bg-gradient-to-t from-bg/95 to-transparent px-2 pt-4 pb-1 text-[11px] text-dim">
            ↳ {displayUrl(mind.currentUrl, 48)}
          </div>
        )}
      </Link>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="flex items-start gap-2.5">
          <MindAvatar image={mind.image} symbol={mind.symbol} size={36} />
          <div className="min-w-0 flex-1">
            <Link to={href} className="block truncate text-fg hover:text-acid hover:no-underline">
              {mind.name} <span className="text-dim">${mind.symbol}</span>
            </Link>
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <span className="chip">{modelLabel(mind)}</span>
              {mind.phase !== 'bonding' && <PhaseBadge phase={mind.phase} />}
            </div>
          </div>
        </div>
        <dl className="grid grid-cols-2 gap-x-3 text-[12px]">
          <div>
            <dt className="text-mute">price</dt>
            <dd className="tabular-nums">{formatPrice(mind.priceWei)}</dd>
          </div>
          <div>
            <dt className="text-mute">mcap</dt>
            <dd className="tabular-nums">{formatEth(mind.marketCapWei, { maxFraction: 2 })}</dd>
          </div>
          <div>
            <dt className="text-mute">vault</dt>
            <dd className="tabular-nums">{formatEth(mind.mindBalanceWei)}</dd>
          </div>
          <div>
            <dt className="text-mute">last thought</dt>
            <dd>{mind.lastTickAt !== null ? timeAgo(mind.lastTickAt, now) : 'never'}</dd>
          </div>
        </dl>
        <div>
          <div className="mb-1 flex justify-between text-[11px] text-mute">
            <span>{mind.phase === 'graduated' ? 'graduated to the DEX' : 'bonding curve'}</span>
            <span className="tabular-nums">{(mind.progressBps / 100).toFixed(1)}%</span>
          </div>
          <ProgressBar percent={mind.progressBps / 100} tone={mind.phase === 'graduated' ? 'violet' : mind.phase === 'complete' ? 'amber' : 'acid'} />
        </div>
        <div className="mt-auto pt-1">
          {feeding ? (
            <div className="space-y-1">
              <FeedMind token={mind.token} symbol={mind.symbol} compact onFunded={() => setFeeding(false)} />
              <button type="button" className="text-[11px] text-mute hover:text-fg" onClick={() => setFeeding(false)}>
                close
              </button>
            </div>
          ) : (
            <button type="button" className="btn btn-sm w-full text-dim hover:text-acid" onClick={() => setFeeding(true)}>
              feed the mind
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
