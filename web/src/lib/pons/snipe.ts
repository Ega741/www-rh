/**
 * Snipe-tax window of a Pons launch (SPEC §9.1: 99 % decaying over `snipeTaxSeconds`, 15 s by
 * default, for non-exempt buyers). The mind page warns buyers while it is open (SPEC §9.5).
 *
 * @module lib/pons/snipe
 */

/** State of the snipe-tax window at `nowMs`. */
export interface SnipeWindow {
  /** The window is open (`launchedAt <= now < launchedAt + seconds`). */
  active: boolean;
  /** Whole seconds left (rounded up), 0 when closed. */
  remainingSeconds: number;
  /** Unix seconds at which the window closes, or `null` when the launch time is unknown. */
  endsAt: number | null;
}

/** Computes the snipe-tax window; unknown launch time or a non-positive window = closed. */
export function snipeWindow(launchedAtSec: number | null, windowSeconds: number, nowMs: number): SnipeWindow {
  if (launchedAtSec === null || !Number.isFinite(launchedAtSec) || !(windowSeconds > 0)) return { active: false, remainingSeconds: 0, endsAt: null };
  const endsAt = launchedAtSec + windowSeconds;
  const remainingMs = endsAt * 1000 - nowMs;
  if (remainingMs <= 0) return { active: false, remainingSeconds: 0, endsAt };
  return { active: true, remainingSeconds: Math.ceil(remainingMs / 1000), endsAt };
}
