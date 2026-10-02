/**
 * Thoughts ticker: live text blocks streamed over the WebSocket (R7 / SPEC §6, one buffer per
 * `(tickId, kind)`), summarised `thinking` behind a toggle, and the persisted history (`aloud` /
 * `summary` thoughts from REST plus live `thoughtSaved`) when nothing is streaming.
 *
 * @module components/ThoughtsTicker
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { clockTime } from '../format';
import type { ThoughtBlock } from '../lib/stream';
import type { Thought } from '../lib/types';
import { Panel } from './common';

/** Merges REST and live persisted thoughts, de-duplicated by id, oldest first. */
export function mergeThoughts(rest: readonly Thought[], live: readonly Thought[], limit = 30): Thought[] {
  const byId = new Map<number, Thought>();
  for (const t of [...rest, ...live]) byId.set(t.id, t);
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt || a.id - b.id).slice(-limit);
}

/** Props of {@link ThoughtsTicker}. */
export interface ThoughtsTickerProps {
  blocks: ThoughtBlock[];
  history: Thought[] | undefined;
  saved: Thought[];
  historyError: boolean;
}

const SHOW_THINKING_KEY = 'www-rh:show-thinking';

function readShowThinking(): boolean {
  try {
    return localStorage.getItem(SHOW_THINKING_KEY) === '1';
  } catch {
    return false;
  }
}

/** See module docs. */
export function ThoughtsTicker({ blocks, history, saved, historyError }: ThoughtsTickerProps) {
  const [showThinking, setShowThinking] = useState(readShowThinking);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const visible = showThinking ? blocks : blocks.filter((b) => b.kind === 'text');
  const last = visible[visible.length - 1];
  const thinkingNow = blocks.length > 0 && !(blocks[blocks.length - 1]?.final ?? true);
  const past = useMemo(() => mergeThoughts(history ?? [], saved), [history, saved]);

  useEffect(() => {
    const el = scroller.current;
    if (el !== null && stick.current) el.scrollTop = el.scrollHeight;
  }, [visible.length, last?.text, past.length]);

  function toggle() {
    setShowThinking((v) => {
      try {
        localStorage.setItem(SHOW_THINKING_KEY, v ? '0' : '1');
      } catch {
        // storage unavailable
      }
      return !v;
    });
  }

  return (
    <Panel
      title="thoughts"
      right={
        <span className="flex items-center gap-3 normal-case tracking-normal">
          {thinkingNow && <span className="text-acid">thinking…</span>}
          <button type="button" className="text-mute hover:text-fg" onClick={toggle} aria-pressed={showThinking}>
            {showThinking ? 'hide thinking' : 'show thinking'}
          </button>
        </span>
      }
    >
      <div
        ref={scroller}
        className="scroll-thin max-h-80 min-h-40 space-y-3 overflow-y-auto px-3 py-3"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {visible.length === 0 && past.length === 0 && (
          <p className="text-dim">
            {historyError
              ? 'Thought history is unavailable right now.'
              : blocks.length > 0
                ? 'The mind is thinking privately. Turn on "show thinking" to follow along.'
                : 'Nothing said yet. Thoughts stream here, word by word, while the mind works.'}
          </p>
        )}
        {visible.length === 0 &&
          past.map((t) => (
            <div key={`h${t.id}`} className="text-[12px]">
              <span className="text-mute">
                {clockTime(t.createdAt)} · {t.kind === 'summary' ? 'tick summary' : 'aloud'}
              </span>
              <p className={`whitespace-pre-wrap ${t.kind === 'summary' ? 'text-dim' : 'text-fg'}`}>{t.text}</p>
            </div>
          ))}
        {visible.map((b) => (
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
