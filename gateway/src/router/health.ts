/**
 * Provider health / circuit breaker (SPEC §5.6): a 60 s sliding window of retryable failures per
 * provider; ≥ 3 → `down` for `open_for_ms` (30 s, doubling to 300 s on consecutive openings);
 * after the window → `degraded` (half-open); a success → `ok` and reset. Non-retryable errors never
 * affect health; a platform 401/403 opens the breaker immediately. Persisted in `provider_health`.
 *
 * @module router/health
 */
import type { Provider } from '@beagle/shared/models';
import type { ProviderState } from '@beagle/shared/routing';
import type { ProviderHealthRepo, ProviderHealthRow } from '../db/repos.js';
import type { ProviderError } from '../providers/types.js';

/** Failure window. */
export const HEALTH_WINDOW_MS = 60_000;
/** Failures within the window that open the breaker. */
export const HEALTH_FAILURE_THRESHOLD = 3;
/** First open duration. */
export const HEALTH_OPEN_MS = 30_000;
/** Maximum open duration. */
export const HEALTH_OPEN_MAX_MS = 300_000;

interface Entry {
  state: 'ok' | 'degraded' | 'down';
  failures: number[];
  openedAt: number | null;
  openForMs: number;
  /** Consecutive openings without a success (drives the doubling). */
  openings: number;
}

const PROVIDERS: readonly Provider[] = ['anthropic', 'openai', 'google', 'house'];

/** In-memory health store backed by `provider_health`. */
export class HealthStore {
  private readonly entries = new Map<Provider, Entry>();

  constructor(
    private readonly repo: ProviderHealthRepo | undefined,
    private readonly now: () => number = () => Date.now(),
  ) {
    for (const p of PROVIDERS) this.entries.set(p, { state: 'ok', failures: [], openedAt: null, openForMs: 0, openings: 0 });
    for (const row of repo?.all() ?? []) {
      const e = this.entries.get(row.provider);
      if (e === undefined) continue;
      e.state = row.state;
      e.openedAt = row.openedAt;
      e.openForMs = row.openForMs;
      e.openings = row.openForMs > 0 ? Math.max(1, Math.round(Math.log2(row.openForMs / HEALTH_OPEN_MS)) + 1) : 0;
      e.failures = row.failures > 0 ? Array.from({ length: Math.min(row.failures, HEALTH_FAILURE_THRESHOLD) }, () => row.updatedAt) : [];
    }
  }

  private entry(p: Provider): Entry {
    return this.entries.get(p) as Entry;
  }

  private persist(p: Provider, e: Entry): void {
    const row: ProviderHealthRow = { provider: p, state: e.state, failures: e.failures.length, openedAt: e.openedAt, openForMs: e.openForMs, updatedAt: this.now() };
    this.repo?.upsert(row);
  }

  /** Refreshes a `down` entry whose open window elapsed → `degraded` (half-open). */
  private refresh(p: Provider, e: Entry): void {
    if (e.state === 'down' && e.openedAt !== null && this.now() - e.openedAt >= e.openForMs) {
      e.state = 'degraded';
      this.persist(p, e);
    }
  }

  /** Current state of `provider`. */
  state(provider: Provider): ProviderState['state'] {
    const e = this.entry(provider);
    this.refresh(provider, e);
    return e.state;
  }

  /** States of all providers as the router expects them. */
  snapshot(): Record<Provider, ProviderState> {
    const out = {} as Record<Provider, ProviderState>;
    for (const p of PROVIDERS) out[p] = { state: this.state(p) };
    return out;
  }

  private open(p: Provider, e: Entry): void {
    e.openings += 1;
    e.openForMs = Math.min(HEALTH_OPEN_MAX_MS, HEALTH_OPEN_MS * 2 ** (e.openings - 1));
    e.openedAt = this.now();
    e.state = 'down';
    e.failures = [];
    this.persist(p, e);
  }

  /** Records a provider failure. Only retryable errors (and platform auth failures) count. */
  recordFailure(provider: Provider, error: ProviderError, credentialKind: 'byok' | 'platform'): void {
    const e = this.entry(provider);
    this.refresh(provider, e);
    if (error.authFailure) {
      if (credentialKind === 'platform') this.open(provider, e);
      return;
    }
    if (!error.retryable) return;
    const now = this.now();
    e.failures = e.failures.filter((t) => now - t < HEALTH_WINDOW_MS);
    e.failures.push(now);
    if (e.state === 'degraded' || e.failures.length >= HEALTH_FAILURE_THRESHOLD) this.open(provider, e);
    else this.persist(provider, e);
  }

  /** Records a success: `ok` and reset. */
  recordSuccess(provider: Provider): void {
    const e = this.entry(provider);
    if (e.state === 'ok' && e.failures.length === 0) return;
    e.state = 'ok';
    e.failures = [];
    e.openedAt = null;
    e.openForMs = 0;
    e.openings = 0;
    this.persist(provider, e);
  }
}
