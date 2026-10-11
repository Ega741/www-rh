/** Time formatting helpers. Off-chain timestamps are unix ms; on-chain ones are unix seconds. */

/** `2026-10-11 14:05` in `timeZone` (default: the viewer's zone). */
export function formatDateTime(ms: number, timeZone?: string): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-CA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(timeZone === undefined ? {} : { timeZone }),
  }).formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}`;
}

/** `2026-10-11` in `timeZone` (default: the viewer's zone). */
export function formatDate(ms: number, timeZone?: string): string {
  return formatDateTime(ms, timeZone).slice(0, 10);
}

/** Unix seconds → formatted date-time. */
export function formatUnixSeconds(sec: number | bigint, timeZone?: string): string {
  return formatDateTime(Number(sec) * 1000, timeZone);
}

/** Human duration from seconds: `45 s`, `3 min`, `2 h 15 min`, `3 d 4 h`. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s} s`;
  const minutes = Math.floor(s / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const restMin = minutes % 60;
  if (hours < 24) return restMin === 0 ? `${hours} h` : `${hours} h ${restMin} min`;
  const days = Math.floor(hours / 24);
  const restH = hours % 24;
  return restH === 0 ? `${days} d` : `${days} d ${restH} h`;
}

/** `3 min ago` / `in 2 h` / `just now` relative to `nowMs`. */
export function relativeTime(ms: number, nowMs: number): string {
  const diff = ms - nowMs;
  const abs = Math.abs(diff);
  if (abs < 15_000) return 'just now';
  const text = formatDuration(abs / 1000);
  return diff < 0 ? `${text} ago` : `in ${text}`;
}

/** Seconds until a unix-seconds deadline (negative when past). */
export function secondsUntil(deadlineSec: number | bigint, nowMs: number): number {
  return Number(deadlineSec) - Math.floor(nowMs / 1000);
}

/** Age in seconds of a unix-seconds observation (`updatedAt`). */
export function ageSeconds(updatedAtSec: number | bigint, nowMs: number): number {
  return Math.max(0, Math.floor(nowMs / 1000) - Number(updatedAtSec));
}

/** `YYYY-MM-DD` of a UTC day offset from `today` (negative = past). */
export function utcDayKey(today: Date, offsetDays: number): string {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offsetDays));
  return d.toISOString().slice(0, 10);
}
