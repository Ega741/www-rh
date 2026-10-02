/**
 * Graduation grace window (SPEC §2.3 rule 3): once a curve is `Complete`, sells are allowed again
 * when `block.timestamp >= completedAt(token) + graduationGrace()`; the first such sell flips the
 * phase back to `Bonding` (`CurveReopened`). Buys stay `Bonding`-only.
 *
 * Pure helpers (window math, countdown copy, Complete → Bonding transition tracking) so the UI
 * logic is unit-tested without wagmi.
 *
 * @module lib/grace
 */
import type { CurvePhaseName } from './types';

/** Default `graduationGrace()` set by the constructor (1 day). */
export const DEFAULT_GRADUATION_GRACE_SECONDS = 86_400;

/** Where a `Complete` curve stands relative to its grace window. */
export type GraceWindow =
  /** `completedAt` / `graduationGrace` not read yet, or `completedAt == 0` (not complete). */
  | { state: 'unknown' }
  /** The window is still running: sells stay disabled. `endsAt` in unix seconds. */
  | { state: 'running'; endsAt: number; remainingSeconds: number }
  /** The window has passed: sells (and `quoteSell`) are allowed again. */
  | { state: 'expired'; endsAt: number; expiredForSeconds: number };

type Seconds = bigint | number | null | undefined;

function toSeconds(value: Seconds): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** `completedAt + graduationGrace` in unix seconds, or `null` when unknown or `completedAt == 0`. */
export function graceEndsAt(completedAt: Seconds, graceSeconds: Seconds): number | null {
  const c = toSeconds(completedAt);
  const g = toSeconds(graceSeconds);
  if (c === null || g === null || c === 0) return null;
  return c + g;
}

/**
 * Window state at `nowMs` (wall clock). Matches the contract check
 * `block.timestamp >= completedAt + graduationGrace` with `block.timestamp = floor(now / 1000)`.
 */
export function graceWindow(completedAt: Seconds, graceSeconds: Seconds, nowMs: number): GraceWindow {
  const endsAt = graceEndsAt(completedAt, graceSeconds);
  if (endsAt === null || !Number.isFinite(nowMs)) return { state: 'unknown' };
  const nowSec = Math.floor(nowMs / 1000);
  return nowSec >= endsAt ? { state: 'expired', endsAt, expiredForSeconds: nowSec - endsAt } : { state: 'running', endsAt, remainingSeconds: endsAt - nowSec };
}

/** Whether a `Complete` curve accepts sells at `nowMs`. */
export function sellsReopened(completedAt: Seconds, graceSeconds: Seconds, nowMs: number): boolean {
  return graceWindow(completedAt, graceSeconds, nowMs).state === 'expired';
}

/** Countdown `HH:MM:SS` (hours are not wrapped: a 30-day grace reads `720:00:00`; negatives clamp to zero). */
export function formatCountdown(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

/** Follows the curve phase of one token to spot a Complete → Bonding reopening (`CurveReopened`). */
export interface ReopenTracker {
  token: string | null;
  phase: CurvePhaseName | null;
  /** Last `completedAt` read while `Complete` (0 = unknown, or reset by a reopening). */
  completedAt: bigint;
  /**
   * Times the curve went Bonding → Complete while watched. Used as the cache scope of the
   * `completedAt` read, so a new completion never shows the previous completion's timestamp.
   */
  completions: number;
  /** The curve went Complete → Bonding while watched, with a non-zero `completedAt` before it. */
  reopened: boolean;
}

/** Nothing observed yet. */
export const initialReopenTracker: ReopenTracker = { token: null, phase: null, completedAt: 0n, completions: 0, reopened: false };

/**
 * Next tracker state for an observation. Returns `prev` itself when nothing changed (safe as a
 * React state updater). A phase transition from REST, WS or chain reads all count; the reopened
 * notice needs a non-zero `completedAt` seen while `Complete`, so a stale `complete` from the
 * runner corrected by the chain (which then reads `completedAt == 0`) raises no notice.
 */
export function trackReopen(prev: ReopenTracker, next: { token: string; phase: CurvePhaseName; completedAt: bigint | undefined }): ReopenTracker {
  const base = prev.token === next.token ? prev : { ...initialReopenTracker, token: next.token };
  let { completedAt, completions, reopened } = base;
  if (next.phase === 'complete') {
    if (base.phase === 'bonding') {
      // a new completion: the value passed in still belongs to the previous one
      completions += 1;
      completedAt = 0n;
    } else if (next.completedAt !== undefined) {
      completedAt = next.completedAt;
    }
    reopened = false;
  } else if (next.phase === 'bonding') {
    if (base.phase === 'complete') reopened = completedAt > 0n;
    completedAt = 0n;
  } else {
    reopened = false;
  }
  if (base === prev && prev.phase === next.phase && prev.completedAt === completedAt && prev.completions === completions && prev.reopened === reopened) {
    return prev;
  }
  return { token: next.token, phase: next.phase, completedAt, completions, reopened };
}
