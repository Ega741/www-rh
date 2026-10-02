/**
 * Small async / time helpers shared by the runner modules.
 *
 * @module util
 */

/** Resolves after `ms` milliseconds, or rejects early with the signal's reason when aborted. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Exponential backoff delay: `base · 2^attempt`, capped at `max`, with ±20 % jitter. */
export function backoffMs(attempt: number, base = 1_000, max = 60_000, random: () => number = Math.random): number {
  const raw = Math.min(max, base * 2 ** Math.max(0, attempt));
  return Math.round(raw * (0.8 + 0.4 * random()));
}

/** Current time as ISO-8601. */
export function nowIso(now: number = Date.now()): string {
  return new Date(now).toISOString();
}

/** Converts a unix timestamp in seconds to ISO-8601. */
export function unixToIso(seconds: number | bigint): string {
  return new Date(Number(seconds) * 1000).toISOString();
}

/** Lowercases an address-like string. */
export function lower<T extends string>(value: T): Lowercase<T> {
  return value.toLowerCase() as Lowercase<T>;
}

/** Truncates `text` to at most `max` characters (appending `…`). */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Runs `fn` and resolves to `undefined` (logging nothing) if it throws. */
export async function attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch {
    return undefined;
  }
}

/** A simple async mutex-free concurrency limiter for fire-and-forget jobs. */
export class TaskQueue {
  #running = 0;
  readonly #queue: (() => Promise<void>)[] = [];

  constructor(private readonly concurrency: number) {}

  /** Enqueues `job`; errors are swallowed (jobs must handle their own). */
  push(job: () => Promise<void>): void {
    this.#queue.push(job);
    this.#drain();
  }

  /** Number of queued + running jobs. */
  get size(): number {
    return this.#queue.length + this.#running;
  }

  #drain(): void {
    while (this.#running < this.concurrency && this.#queue.length > 0) {
      const job = this.#queue.shift() as () => Promise<void>;
      this.#running++;
      void job()
        .catch(() => undefined)
        .finally(() => {
          this.#running--;
          this.#drain();
        });
    }
  }
}
