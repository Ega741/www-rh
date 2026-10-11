/**
 * Error thrown by the dashboard API client (`src/api.ts`) for non-2xx responses.
 * `code` is the gateway error code (`{ error: { code, message } }`, SPEC §5.9) or `http_<status>`.
 */
export class ApiError extends Error {
  /** HTTP status of the response. */
  readonly status: number;
  /** Gateway error code, e.g. `insufficient_credit`, `invalid_request_error`, `unauthorized`. */
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }

  /** `true` for 401 (no or expired session). */
  get unauthorized(): boolean {
    return this.status === 401;
  }
}

/** `true` when `err` is an {@link ApiError} with the given status. */
export function isApiError(err: unknown, status?: number): err is ApiError {
  return err instanceof ApiError && (status === undefined || err.status === status);
}
