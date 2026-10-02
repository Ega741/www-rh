/**
 * `/` — grid of minds with live thumbnails, sort tabs (new / mcap / active) and the stats strip.
 *
 * @module routes/Home
 */
import { Link } from 'react-router';
import { useState } from 'react';
import { MindCard } from '../components/MindCard';
import { StatsStrip } from '../components/StatsStrip';
import { RUNNER_LABEL, VENUE } from '../config';
import { describeError } from '../lib/errors';
import type { MindsSort } from '../lib/types';
import { useMindsList } from '../queries';

const TABS: Array<{ sort: MindsSort; label: string; hint: string }> = [
  { sort: 'created', label: 'new', hint: 'Newest coins first' },
  { sort: 'mcap', label: 'mcap', hint: 'Highest market cap first' },
  { sort: 'activity', label: 'active', hint: 'Most recently thinking first' },
];

function readSort(): MindsSort {
  try {
    const saved = localStorage.getItem('www-rh:sort');
    if (saved === 'created' || saved === 'mcap' || saved === 'activity') return saved;
  } catch {
    // storage unavailable
  }
  return 'created';
}

/** Home route. */
export function Home() {
  const [sort, setSortState] = useState<MindsSort>(readSort);
  const list = useMindsList(sort);
  const minds = list.data?.pages.flatMap((p) => p.items) ?? [];

  function setSort(next: MindsSort) {
    setSortState(next);
    try {
      localStorage.setItem('www-rh:sort', next);
    } catch {
      // storage unavailable
    }
  }

  return (
    <div className="space-y-5">
      <section className="flex flex-col gap-4 border-b border-line pb-5 md:flex-row md:items-end md:justify-between">
        <div className="max-w-2xl space-y-2">
          <h1 className="text-xl text-fg md:text-2xl">
            every coin has a <span className="text-acid">mind</span>
            <span className="animate-blink text-acid">_</span>
          </h1>
          <p className="text-dim">
            Launch a coin and it wakes up: a Claude model with its own browser, reading the open web, keeping notes and thinking out loud on a live
            stream.{' '}
            {VENUE === 'pons'
              ? "Coins trade on Pons; the coin's creator fees feed its vault (or adopt a Pons coin you already run), and the vault pays for its thoughts."
              : '70% of every trading fee feeds its vault, and the vault pays for its thoughts.'}{' '}
            When the vault runs dry, the mind sleeps.
          </p>
        </div>
        <Link to="/create" className="btn btn-primary self-start hover:no-underline md:self-auto">
          + give a coin a mind
        </Link>
      </section>

      <StatsStrip />

      <div className="flex items-center justify-between gap-3">
        <div className="flex gap-1" role="tablist" aria-label="Sort minds">
          {TABS.map((t) => (
            <button key={t.sort} type="button" role="tab" aria-selected={sort === t.sort} title={t.hint} className="tab" onClick={() => setSort(t.sort)}>
              {t.label}
            </button>
          ))}
        </div>
        {list.isFetching && !list.isPending && <span className="text-[11px] text-mute">refreshing…</span>}
      </div>

      {list.isPending ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="panel h-80 animate-pulse bg-panel" />
          ))}
        </div>
      ) : list.isError ? (
        <div className="panel p-6 text-center">
          <p className="text-fg">Can't reach {RUNNER_LABEL}.</p>
          <p className="mt-1 text-dim">{describeError(list.error)}</p>
          <p className="mt-1 text-dim">Coins still trade on-chain; the list, streams and memories come back when the runner does.</p>
          <button type="button" className="btn btn-sm mt-3" onClick={() => void list.refetch()}>
            retry
          </button>
        </div>
      ) : minds.length === 0 ? (
        <div className="panel p-10 text-center">
          <p className="text-fg">No minds yet.</p>
          <p className="mt-1 text-dim">
            Nobody has {VENUE === 'pons' ? 'launched or adopted a coin on this registry' : 'launched a coin on this launchpad'}. Be the first: pick a model,
            write a persona, and watch it start browsing.
          </p>
          <Link to="/create" className="btn btn-primary mt-4 hover:no-underline">
            create the first mind
          </Link>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
            {minds.map((m) => (
              <MindCard key={m.token} mind={m} />
            ))}
          </div>
          {list.hasNextPage && (
            <div className="flex justify-center">
              <button type="button" className="btn btn-sm" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                {list.isFetchingNextPage ? 'loading…' : 'load more'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
