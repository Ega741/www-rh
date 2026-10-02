/**
 * Action log: the mind's tool calls as they happen (WS `action`).
 *
 * @module components/ActionLog
 */
import { clockTime } from '../format';
import type { ActionEntry } from '../lib/stream';
import { Panel } from './common';

const TOOL_LABELS: Record<string, string> = {
  browse_navigate: 'goto',
  browse_read: 'read',
  browse_click: 'click',
  browse_type: 'type',
  browse_scroll: 'scroll',
  browse_back: 'back',
  browse_screenshot: 'look',
  remember: 'remember',
  recall: 'recall',
  think_aloud: 'say',
};

/** Short label for a tool name. */
export function toolLabel(tool: string): string {
  return TOOL_LABELS[tool] ?? tool.replace(/^browse_/, '');
}

/** Compact one-line rendering of a (JSON) tool input. */
export function summarizeInput(input: string): string {
  try {
    const parsed: unknown = JSON.parse(input);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const values = Object.values(parsed as Record<string, unknown>)
        .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
        .filter((v) => v !== '' && v !== undefined);
      return values.join(' · ');
    }
  } catch {
    // not JSON
  }
  return input;
}

/** See module docs. */
export function ActionLog({ actions }: { actions: ActionEntry[] }) {
  return (
    <Panel title="actions" right={<span className="normal-case tracking-normal text-mute">{actions.length > 0 ? `${actions.length} recent` : ''}</span>}>
      <ul className="scroll-thin max-h-56 overflow-y-auto py-1">
        {actions.length === 0 && <li className="px-3 py-3 text-dim">No actions yet. Every click, page read and note the mind takes shows up here live.</li>}
        {actions.map((a) => (
          <li key={a.id} className="flex gap-2 px-3 py-0.5 text-[12px]">
            <span className="shrink-0 text-mute tabular-nums">{clockTime(a.at)}</span>
            <span className="w-16 shrink-0 text-acid">{toolLabel(a.tool)}</span>
            <span className="min-w-0 truncate text-dim" title={a.input}>
              {summarizeInput(a.input)}
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
