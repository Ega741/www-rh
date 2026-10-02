/**
 * Global stats strip (`GET /api/stats`).
 *
 * @module components/StatsStrip
 */
import { formatEth } from '../format';
import { useStats } from '../queries';

/** Minds / alive / graduated / volume / fees to minds. */
export function StatsStrip() {
  const stats = useStats();
  const s = stats.data;
  const items: Array<[string, string]> = [
    ['minds', s !== undefined ? String(s.minds) : '—'],
    ['alive now', s !== undefined ? String(s.alive) : '—'],
    ['graduated', s !== undefined ? String(s.graduated) : '—'],
    ['curve volume', s !== undefined ? formatEth(s.volumeWei, { maxFraction: 3 }) : '—'],
    ['fees to minds', s !== undefined ? formatEth(s.feesToMindsWei, { maxFraction: 4 }) : '—'],
  ];
  return (
    <div className="flex flex-wrap gap-x-6 gap-y-1 text-[12px]" aria-live="polite">
      {items.map(([label, value]) => (
        <div key={label} className="flex items-baseline gap-1.5">
          <span className="text-mute">{label}</span>
          <span className="tabular-nums text-fg">{value}</span>
        </div>
      ))}
      {stats.isError && <span className="text-[11px] text-mute">stats unavailable</span>}
    </div>
  );
}
