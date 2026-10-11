/**
 * Dashboard sessions (SPEC §1, §5.3): a random 32-byte token valid for 7 days, presented as the
 * `beagle_session` cookie or `Authorization: Bearer <token>`. The database stores
 * `HMAC-SHA256(SESSION_SECRET, token)`, so a leaked table yields no usable tokens.
 *
 * @module auth/session
 */
import type { SessionRepo, SessionRow } from '../db/repos.js';
import { normalizeWorkspace } from '../db/repos.js';
import { hmacHex, randomBase64Url } from './crypto.js';

/** Cookie name. */
export const SESSION_COOKIE = 'beagle_session';
/** Session lifetime. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Creates and validates sessions. */
export class SessionService {
  constructor(
    private readonly sessions: SessionRepo,
    private readonly secret: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private id(token: string): string {
    return hmacHex(this.secret, token);
  }

  /** Creates a session; returns the token to hand to the client. */
  create(workspace: string): { token: string; expiresAt: number } {
    const token = randomBase64Url(32);
    const now = this.now();
    const expiresAt = now + SESSION_TTL_MS;
    this.sessions.insert({ id: this.id(token), workspace: normalizeWorkspace(workspace), createdAt: now, expiresAt });
    return { token, expiresAt };
  }

  /** The session for `token`, or `undefined` when unknown/expired. */
  resolve(token: string): SessionRow | undefined {
    if (token.length < 16 || token.length > 128) return undefined;
    const row = this.sessions.get(this.id(token));
    if (row === undefined) return undefined;
    if (row.expiresAt <= this.now()) {
      this.sessions.delete(row.id);
      return undefined;
    }
    return row;
  }

  /** Deletes the session of `token`. */
  destroy(token: string): void {
    this.sessions.delete(this.id(token));
  }

  purgeExpired(): number {
    return this.sessions.purgeExpired(this.now());
  }
}

/** Parses a `Cookie` header into a map. */
export function parseCookies(header: string | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (name !== '') {
      try {
        out.set(name, decodeURIComponent(value));
      } catch {
        out.set(name, value);
      }
    }
  }
  return out;
}

/** Extracts a presented session token from the cookie or a non-API-key bearer header. */
export function extractSessionToken(headers: { get(name: string): string | null | undefined }): string | undefined {
  const cookie = parseCookies(headers.get('cookie')).get(SESSION_COOKIE);
  if (cookie) return cookie;
  const auth = headers.get('authorization');
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m && m[1] !== undefined && !m[1].trim().startsWith('bgl_')) return m[1].trim();
  }
  return undefined;
}

/** Builds the `Set-Cookie` value for a session token (or a clearing cookie when `token` is null). */
export function sessionCookie(token: string | null, secure: boolean, maxAgeMs = SESSION_TTL_MS): string {
  const attrs = ['Path=/', 'HttpOnly', 'SameSite=Lax', ...(secure ? ['Secure'] : [])];
  if (token === null) return `${SESSION_COOKIE}=; Max-Age=0; ${attrs.join('; ')}`;
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Max-Age=${Math.floor(maxAgeMs / 1000)}; ${attrs.join('; ')}`;
}
