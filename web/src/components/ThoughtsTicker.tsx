/**
 * Thoughts ticker: live text / summarised-thinking blocks streamed over the WebSocket (R7),
 * with the persisted history (`aloud` / `summary` thoughts) when nothing is streaming.
 *
 * @module components/ThoughtsTicker
 */
import { useEffect, useRef } from 'react';
import { clockTime } from '../format';
import type { ThoughtBlock } from '../lib/stream';
import type { Thought } from '../lib/types';
import { Panel } from './common';

/** Props of {@link ThoughtsTicker}. */
export interface ThoughtsTickerProps {
  blocks: ThoughtBlock[];
  history: Thought[] | undefined;
  historyError: boolean;
}

/** See module docs. */
export function ThoughtsTicker({ blocks, history, historyError }: ThoughtsTickerProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const last = blocks[blocks.length - 1];

  useEffect(() => {
    const el = scroller.current;
    if (el !== null && stick.current) el.scrollTop = el.scrollHeight;
  }, [blocks.length, last?.text]);

  const pastThoughts = (history ?? []).slice().sort((a, b) => a.createdAt - b.createdAt || a.id - b.id).slice(-30);

  return (
    <Panel title="thoughts" right={last !== undefined && !last.final ? <span className="text-acid normal-case tracking-normal">thinking…</span> : null}>
      <div
        ref={scroller}
        className="scroll-thin max-h-80 min-h-40 space-y-3 overflow-y-auto px-3 py-3"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {blocks.length === 0 && pastThoughts.length === 0 && (
          <p className="text-dim">{historyError ? 'Thought history is unavailable right now.' : 'Nothing said yet. Thoughts stream here, word by word, while the mind works.'}</p>
        )}
        {blocks.length === 0 &&
          pastThoughts.map((t) => (
            <div key={`h${t.id}`} className="text-[12px]">
              <span className="text-mute">
                {clockTime(t.createdAt)} · {t.kind === 'summary' ? 'tick summary' : 'aloud'}
              </span>
              <p className={`whitespace-pre-wrap ${t.kind === 'summary' ? 'text-dim' : 'text-fg'}`}>{t.text}</p>
            </div>
          ))}
        {blocks.map((b) => (
          <div key={b.id} className="text-[12px]">
            <span className="text-mute">
              {clockTime(b.at)} · tick {b.tickId} · {b.kind === 'thinking' ? 'thinking' : 'says'}
            </span>
            <p className={`whitespace-pre-wrap ${b.kind === 'thinking' ? 'text-dim italic' : 'text-fg'}`}>
              {b.text}
              {!b.final && <span className="animate-blink text-acid">▍</span>}
            </p>
          </div>
        ))}
      </div>
    </Panel>
  );
}
