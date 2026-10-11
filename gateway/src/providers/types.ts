/**
 * Provider adapter contract (SPEC §5.5): credentials, the `ProviderAdapter` interface and
 * `ProviderError`, whose `retryable` flag drives fallback and circuit breaking.
 *
 * @module providers/types
 */
import type { Provider } from '@beagle/shared/models';
import type { InternalChunk, InternalRequest, InternalResponse } from '../translate/internal.js';

/** Where a provider key came from. */
export type CredentialKind = 'byok' | 'platform';

/** Resolved credentials for one upstream call. */
export interface Credentials {
  kind: CredentialKind;
  /** Provider API key (empty for a house endpoint without auth). */
  key: string;
  baseUrl: string;
}

/** A failure of an upstream call, already classified. */
export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  /** Upstream-equivalent HTTP status (`0` for network failures). */
  readonly status: number;
  /** Short machine code: `rate_limited`, `auth`, `bad_request`, `upstream_error`, `timeout`, `network`, `stream_error`. */
  readonly code: string;
  readonly retryable: boolean;
  readonly provider: Provider;
  /** `Retry-After` seconds when the provider sent one. */
  readonly retryAfterSec: number | undefined;
  /** `true` when the failure means the credential is invalid (401/403). */
  readonly authFailure: boolean;

  constructor(input: { provider: Provider; status: number; code: string; message: string; retryable: boolean; retryAfterSec?: number; authFailure?: boolean; cause?: unknown }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.provider = input.provider;
    this.status = input.status;
    this.code = input.code;
    this.retryable = input.retryable;
    this.retryAfterSec = input.retryAfterSec;
    this.authFailure = input.authFailure ?? false;
  }

  /** `true` when `e` is a {@link ProviderError} (works across module instances). */
  static is(e: unknown): e is ProviderError {
    return e instanceof ProviderError || (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'ProviderError' && typeof (e as { retryable?: unknown }).retryable === 'boolean');
  }
}

/** One upstream provider implementation. */
export interface ProviderAdapter {
  readonly provider: Provider;
  /** Non-streaming completion. Throws {@link ProviderError}. */
  complete(req: InternalRequest, creds: Credentials, signal: AbortSignal): Promise<InternalResponse>;
  /**
   * Streaming completion. Errors before the first chunk reject the first `next()`; later failures
   * end the stream with an `error` chunk.
   */
  stream(req: InternalRequest, creds: Credentials, signal: AbortSignal): AsyncIterable<InternalChunk>;
}

/**
 * Classifies an HTTP status the way SPEC §5.5 prescribes. `kind` decides what a 401/403 means:
 * for BYOK it is the workspace's problem (non-retryable), for platform keys it marks the provider down.
 */
export function classifyStatus(provider: Provider, status: number, kind: CredentialKind, message: string, retryAfterSec?: number): ProviderError {
  const base = { provider, status, message, ...(retryAfterSec === undefined ? {} : { retryAfterSec }) };
  if (status === 429) return new ProviderError({ ...base, code: 'rate_limited', retryable: true });
  if (status === 401 || status === 403) return new ProviderError({ ...base, code: 'auth', retryable: kind === 'platform', authFailure: true });
  if (status === 400 || status === 404 || status === 422 || status === 413) return new ProviderError({ ...base, code: 'bad_request', retryable: false });
  if (status >= 500) return new ProviderError({ ...base, code: 'upstream_error', retryable: true });
  if (status === 408) return new ProviderError({ ...base, code: 'timeout', retryable: true });
  return new ProviderError({ ...base, code: 'upstream_error', retryable: status >= 500 || status === 0 });
}

/** Wraps a transport failure (network, abort, timeout) as a retryable {@link ProviderError}. */
export function networkError(provider: Provider, e: unknown): ProviderError {
  const isTimeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
  return new ProviderError({
    provider,
    status: 0,
    code: isTimeout ? 'timeout' : 'network',
    message: isTimeout ? `${provider}: request timed out` : `${provider}: ${e instanceof Error ? e.message : String(e)}`,
    retryable: true,
    cause: e,
  });
}

/** Parses a `Retry-After` header (seconds or HTTP date) into seconds. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const t = Date.parse(value);
  if (Number.isFinite(t)) return Math.max(0, Math.ceil((t - now) / 1000));
  return undefined;
}
