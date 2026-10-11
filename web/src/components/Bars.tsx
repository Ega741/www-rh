/**
 * Single-series horizontal bar chart in CSS (no chart library). One hue, thin marks, labels in
 * text tokens, values alongside (the list doubles as the table view), hover title per bar.
 */
import type { Bar } from '../lib/usage.js';

/** Renders `bars` with a formatted value per row. */
export function Bars({ bars, format, ariaLabel, emptyText = 'No data in this window' }: { bars: readonly Bar[]; format: (b: Bar) => string; ariaLabel: string; emptyText?: string }) {
  if (bars.length === 0 || bars.every((b) => b.value === 0n && b.requests === 0)) {
    return <p className="py-6 text-center text-sm text-muted">{emptyText}</p>;
  }
  return (
    <ul className="space-y-1.5" aria-label={ariaLabel} role="list">
      {bars.map((b) => (
        <li key={b.key} className="grid grid-cols-[minmax(0,7rem)_1fr_auto] items-center gap-2 text-xs sm:grid-cols-[minmax(0,11rem)_1fr_auto]" title={`${b.label}: ${format(b)} · ${b.requests} requests`}>
          <span className="truncate font-mono text-muted">{b.label}</span>
          <span className="relative h-3 overflow-hidden rounded-sm bg-elevated" aria-hidden>
            <span className="absolute inset-y-0 left-0 rounded-r-sm bg-accent/80 transition-[width]" style={{ width: `${Math.max(b.ratio > 0 ? 1 : 0, Math.round(b.ratio * 100))}%` }} />
          </span>
          <span className="whitespace-nowrap font-mono tabular-nums">{format(b)}</span>
        </li>
      ))}
    </ul>
  );
}

/** Vertical column variant for per-day series: equal-width columns, labels under every 5th day. */
export function Columns({ bars, format, ariaLabel, emptyText = 'No data in this window' }: { bars: readonly Bar[]; format: (b: Bar) => string; ariaLabel: string; emptyText?: string }) {
  if (bars.length === 0 || bars.every((b) => b.value === 0n && b.requests === 0)) {
    return <p className="py-6 text-center text-sm text-muted">{emptyText}</p>;
  }
  const labelEvery = bars.length > 14 ? 5 : bars.length > 7 ? 2 : 1;
  return (
    <div aria-label={ariaLabel} role="img" className="w-full">
      <div className="flex h-32 items-end gap-[2px]">
        {bars.map((b) => (
          <div key={b.key} className="group relative flex h-full flex-1 items-end" title={`${b.key}: ${format(b)} · ${b.requests} requests`}>
            <div className="w-full rounded-t-sm bg-accent/80 transition-colors group-hover:bg-accent" style={{ height: `${Math.max(b.ratio > 0 ? 2 : 0, Math.round(b.ratio * 100))}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex gap-[2px] font-mono text-[10px] text-faint">
        {bars.map((b, i) => (
          <div key={b.key} className="flex-1 truncate text-center">
            {i % labelEvery === 0 || i === bars.length - 1 ? b.label : ''}
          </div>
        ))}
      </div>
    </div>
  );
}
