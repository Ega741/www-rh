import { describe, expect, it } from 'vitest';
import { ageSeconds, formatDate, formatDateTime, formatDuration, formatUnixSeconds, relativeTime, secondsUntil, utcDayKey } from './time.js';

const T = Date.UTC(2026, 9, 11, 14, 5, 0); // 2026-10-11T14:05:00Z

describe('time helpers', () => {
  it('formats date-times in a time zone', () => {
    expect(formatDateTime(T, 'UTC')).toBe('2026-10-11 14:05');
    expect(formatDate(T, 'UTC')).toBe('2026-10-11');
    expect(formatUnixSeconds(T / 1000, 'UTC')).toBe('2026-10-11 14:05');
    expect(formatDateTime(Date.UTC(2026, 0, 1, 0, 0), 'UTC')).toBe('2026-01-01 00:00');
    expect(formatDateTime(Number.NaN)).toBe('—');
  });
  it('formats durations', () => {
    expect(formatDuration(45)).toBe('45 s');
    expect(formatDuration(180)).toBe('3 min');
    expect(formatDuration(2 * 3600 + 15 * 60)).toBe('2 h 15 min');
    expect(formatDuration(3 * 3600)).toBe('3 h');
    expect(formatDuration(3 * 86400 + 4 * 3600)).toBe('3 d 4 h');
    expect(formatDuration(-5)).toBe('0 s');
  });
  it('relative times', () => {
    expect(relativeTime(T - 5000, T)).toBe('just now');
    expect(relativeTime(T - 3 * 60_000, T)).toBe('3 min ago');
    expect(relativeTime(T + 2 * 3600_000, T)).toBe('in 2 h');
  });
  it('deadline / age arithmetic in seconds', () => {
    expect(secondsUntil(T / 1000 + 90, T)).toBe(90);
    expect(secondsUntil(T / 1000 - 10, T)).toBe(-10);
    expect(ageSeconds(T / 1000 - 120, T)).toBe(120);
    expect(ageSeconds(T / 1000 + 120, T)).toBe(0);
  });
  it('utc day keys', () => {
    const today = new Date(T);
    expect(utcDayKey(today, 0)).toBe('2026-10-11');
    expect(utcDayKey(today, -1)).toBe('2026-10-10');
    expect(utcDayKey(today, -11)).toBe('2026-09-30');
  });
});
