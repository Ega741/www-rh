/**
 * Memories the mind recorded (`remember`), newest first, merged with live WS `memory` messages.
 * Anchored memories link to the anchoring transaction and to the exact batch JSON whose
 * keccak256 was anchored (R2).
 *
 * @module components/MemoryList
 */
import { memoryContentHash } from '@www-rh/shared';
import { useMemo } from 'react';
import type { Address } from 'viem';
import { memoryBatchUrl, parseMemoryBatchUri } from '../api';
import { displayUrl, timeAgo } from '../format';
import { useNow } from '../hooks/useTick';
import type { Memory } from '../lib/types';
import { useMemories, useSettledError } from '../queries';
import { Panel, TxLink } from './common';

/** Merges live and fetched memories, de-duplicated by `seq`, newest first. */
export function mergeMemories(live: readonly Memory[], fetched: readonly Memory[]): Memory[] {
  const bySeq = new Map<number, Memory>();
  for (const m of fetched) bySeq.set(m.seq, m);
  for (const m of live) {
    const prev = bySeq.get(m.seq);
    bySeq.set(m.seq, prev !== undefined && prev.anchorTx !== null && m.anchorTx === null ? prev : m);
  }
  return [...bySeq.values()].sort((a, b) => b.seq - a.seq);
}

/**
 * Re-computes `Memory.contentHash` (SPEC §3.2 `memoryContentHash`) from the served fields.
 * `createdAt` is re-serialised with `toISOString()`, the wire format of SPEC §0.1.
 */
export function memoryHashMatches(m: Memory): boolean {
  if (m.contentHash === null || m.createdAt <= 0) return false;
  try {
    const hash = memoryContentHash({ seq: m.seq, kind: m.kind, content: m.content, url: m.url, createdAt: new Date(m.createdAt).toISOString() });
    return hash.toLowerCase() === m.contentHash.toLowerCase();
  } catch {
    return false;
  }
}

/** See module docs. */
export function MemoryList({ token, live }: { token: Address; live: readonly Memory[] }) {
  const query = useMemories(token);
  const error = useSettledError(query);
  const now = useNow(30_000);
  const memories = useMemo(() => mergeMemories(live, query.data?.pages.flat() ?? []), [live, query.data]);
  const findings = memories.filter((m) => m.kind === 'finding').length;

  return (
    <Panel title="memories" right={memories.length > 0 ? <span className="normal-case tracking-normal text-mute">{memories.length} shown · {findings} findings</span> : null}>
      <ul className="scroll-thin max-h-[28rem] divide-y divide-line overflow-y-auto">
        {memories.length === 0 && (
          <li className="px-3 py-4 text-dim">
            {error !== null
              ? 'Memories are served by the runner, which is not reachable right now.'
              : query.isPending
                ? 'Loading memories…'
                : 'No memories yet. When the mind finds something worth keeping, it writes it down here, and batches get anchored on-chain.'}
          </li>
        )}
        {memories.map((m) => {
          const batch = m.anchorUri !== null ? parseMemoryBatchUri(m.anchorUri) : null;
          return (
            <li key={m.seq} className="px-3 py-2 text-[12px]">
              <div className="flex items-center gap-2 text-[11px] text-mute">
                <span className="tabular-nums">#{m.seq}</span>
                <span className={`chip ${m.kind === 'finding' ? 'border-acid/40 text-acid' : ''}`}>{m.kind}</span>
                <span>{m.createdAt > 0 ? timeAgo(m.createdAt, now) : ''}</span>
                {memoryHashMatches(m) ? (
                  <span className="ml-auto text-acid-dim" title={`contentHash ${m.contentHash ?? ''} recomputed in your browser`}>
                    hash ✓
                  </span>
                ) : (
                  <span className="ml-auto" title="The served fields do not reproduce contentHash (or it is missing)">
                    hash unverified
                  </span>
                )}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-fg">{m.content}</p>
              {m.url !== null && (
                <a href={m.url} target="_blank" rel="noreferrer noopener" className="mt-0.5 block truncate text-[11px]">
                  {displayUrl(m.url)}
                </a>
              )}
              <p className="mt-0.5 text-[11px] text-mute">
                {m.anchorTx !== null ? (
                  <>
                    anchored in <TxLink hash={m.anchorTx} />
                    {batch !== null && (
                      <>
                        {' · '}
                        <a href={memoryBatchUrl(token, batch.fromSeq, batch.toSeq)} target="_blank" rel="noreferrer noopener">
                          batch #{batch.fromSeq}–#{batch.toSeq}
                        </a>
                      </>
                    )}
                  </>
                ) : (
                  'not anchored yet'
                )}
              </p>
            </li>
          );
        })}
      </ul>
      {query.hasNextPage && (
        <div className="border-t border-line p-2 text-center">
          <button type="button" className="btn btn-sm" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
            {query.isFetchingNextPage ? 'loading…' : 'older memories'}
          </button>
        </div>
      )}
    </Panel>
  );
}
