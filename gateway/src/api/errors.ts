/**
 * The gateway's error type and its three wire envelopes (SPEC §5.8, §5.9): OpenAI
 * (`/v1/chat/completions`), Anthropic (`/v1/messages`) and the dashboard `{ error: { code, message } }`.
 *
 * @module api/errors
 */
import { INSUFFICIENT_CREDIT_MESSAGE } from '@beagle/shared/routing';
import { anthropicError, ERROR_STATUS, openAiError, type OpenAiErrorCode } from '@beagle/shared/openai';
import { RequestValidationError } from '../translate/internal.js';
import { InsufficientCreditError } from '../metering/reserve.js';

/** Options of {@link GatewayError}. */
export interface GatewayErrorOptions {
  status?: number;
  param?: string | null;
  retryAfterSec?: number;
  /** Extra response headers (e.g. `x-beagle-balance-micro`). */
  headers?: Record<string, string>;
  cause?: unknown;
}

/** An error with a Beagle code, an HTTP status and optional headers. */
export class GatewayError extends Error {
  override readonly name = 'GatewayError';
  readonly code: OpenAiErrorCode;
  readonly status: number;
  readonly param: string | null;
  readonly retryAfterSec: number | undefined;
  readonly headers: Record<string, string>;

  constructor(code: OpenAiErrorCode, message: string, options: GatewayErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.status = options.status ?? ERROR_STATUS[code];
    this.param = options.param ?? null;
    this.retryAfterSec = options.retryAfterSec;
    this.headers = { ...(options.headers ?? {}) };
    if (options.retryAfterSec !== undefined) this.headers['retry-after'] = String(Math.max(1, Math.ceil(options.retryAfterSec)));
  }

  /** `true` when `e` is a {@link GatewayError}. */
  static is(e: unknown): e is GatewayError {
    return e instanceof GatewayError || (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'GatewayError' && typeof (e as { status?: unknown }).status === 'number');
  }

  /** The 402 of SPEC §5.7 with its headers. */
  static insufficientCredit(balanceMicro: bigint, creditsUrl: string): GatewayError {
    return new GatewayError('insufficient_credit', INSUFFICIENT_CREDIT_MESSAGE, {
      headers: { 'x-beagle-balance-micro': balanceMicro.toString(), 'x-beagle-credits-url': creditsUrl },
    });
  }

  /** `invalid_api_key` 401. */
  static invalidApiKey(message = 'Invalid or revoked API key.'): GatewayError {
    return new GatewayError('invalid_api_key', message);
  }

  /** Wraps any thrown value. */
  static from(e: unknown): GatewayError {
    if (GatewayError.is(e)) return e;
    if (e instanceof RequestValidationError) return new GatewayError('invalid_request_error', e.message, { param: e.param, cause: e });
    if (e instanceof InsufficientCreditError) return new GatewayError('insufficient_credit', e.message, { headers: { 'x-beagle-balance-micro': e.balanceMicro.toString() }, cause: e });
    if (e instanceof SyntaxError) return new GatewayError('invalid_request_error', `invalid JSON body: ${e.message}`, { cause: e });
    return new GatewayError('internal_error', 'Internal error.', { cause: e });
  }

  /** OpenAI envelope. */
  toOpenAi(): { status: number; body: ReturnType<typeof openAiError>['body']; headers: Record<string, string> } {
    const type = this.code === 'invalid_request_error' || this.code === 'internal_error' ? (this.code === 'internal_error' ? 'api_error' : 'invalid_request_error') : this.code;
    const { status, body } = openAiError(this.code, this.message, this.status, { param: this.param, type });
    return { status, body, headers: this.headers };
  }

  /** Anthropic envelope. */
  toAnthropic(): { status: number; body: ReturnType<typeof anthropicError>['body']; headers: Record<string, string> } {
    const { status, body } = anthropicError(this.code, this.message, this.status);
    return { status, body, headers: this.headers };
  }

  /** Dashboard envelope. */
  toApi(): { status: number; body: { error: { code: string; message: string } }; headers: Record<string, string> } {
    return { status: this.status, body: { error: { code: this.code, message: this.message } }, headers: this.headers };
  }
}

/** The SPEC §5.9 dashboard error with an arbitrary code (not limited to the inference codes). */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }

  /** `true` when `e` is an {@link ApiError}. */
  static is(e: unknown): e is ApiError {
    return e instanceof ApiError || (typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'ApiError' && typeof (e as { status?: unknown }).status === 'number');
  }
}
