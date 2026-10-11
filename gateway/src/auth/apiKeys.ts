/**
 * API keys (SPEC §1, §5.3): `bgl_` + base64url(32 random bytes); stored as `sha256(key)`; `prefix`
 * is the first 12 characters. Lookup by hash; `last_used_at` is written at most once a minute.
 *
 * @module auth/apiKeys
 */
import type { ApiKeyRepo, ApiKeyRow, WorkspaceRepo } from '../db/repos.js';
import { normalizeWorkspace } from '../db/repos.js';
import { randomBase64Url, sha256Hex, uuid } from './crypto.js';

/** Key prefix. */
export const API_KEY_PREFIX = 'bgl_';
/** Characters of the display prefix (`bgl_xxxxxxxx`). */
export const API_KEY_DISPLAY_PREFIX_LENGTH = 12;
/** Minimum spacing between `last_used_at` writes. */
export const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/** Full key format: `bgl_` + 43 base64url chars. */
export const API_KEY_PATTERN = /^bgl_[A-Za-z0-9_-]{43}$/;

/** Generates a fresh API key string. */
export function generateApiKey(): string {
  return `${API_KEY_PREFIX}${randomBase64Url(32)}`;
}

/** `sha256(key)` hex, the stored lookup value. */
export function hashApiKey(key: string): string {
  return sha256Hex(key);
}

/** The display prefix of a key. */
export function apiKeyPrefix(key: string): string {
  return key.slice(0, API_KEY_DISPLAY_PREFIX_LENGTH);
}

/** Result of {@link ApiKeyService.create}. */
export interface CreatedApiKey {
  id: string;
  key: string;
  prefix: string;
  name: string;
  createdAt: number;
}

/** Result of a successful lookup. */
export interface AuthenticatedKey {
  key: ApiKeyRow;
  workspace: string;
}

/** Creates, lists, revokes and authenticates API keys. */
export class ApiKeyService {
  constructor(
    private readonly keys: ApiKeyRepo,
    private readonly workspaces: WorkspaceRepo,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Creates a key for `workspace` (creating the workspace if needed). The full key is returned once. */
  create(workspace: string, name: string): CreatedApiKey {
    const ws = normalizeWorkspace(workspace);
    const now = this.now();
    this.workspaces.ensure(ws, now);
    const key = generateApiKey();
    const id = `key_${uuid()}`;
    const prefix = apiKeyPrefix(key);
    this.keys.insert({ id, workspace: ws, name, prefix, hash: hashApiKey(key), createdAt: now });
    return { id, key, prefix, name, createdAt: now };
  }

  /** Looks a presented key up; `undefined` when unknown, malformed or revoked. */
  authenticate(presented: string): AuthenticatedKey | undefined {
    const key = presented.trim();
    if (!key.startsWith(API_KEY_PREFIX) || key.length > 128) return undefined;
    const row = this.keys.byHash(hashApiKey(key));
    if (row === undefined || row.revokedAt !== null) return undefined;
    const now = this.now();
    if (row.lastUsedAt === null || now - row.lastUsedAt >= LAST_USED_WRITE_INTERVAL_MS) this.keys.touch(row.id, now);
    return { key: row, workspace: row.workspace };
  }

  list(workspace: string): ApiKeyRow[] {
    return this.keys.listByWorkspace(workspace);
  }

  revoke(id: string, workspace: string): boolean {
    return this.keys.revoke(id, workspace, this.now());
  }
}

/** Extracts a presented API key from `Authorization: Bearer bgl_…` or `x-api-key`. */
export function extractApiKey(headers: { get(name: string): string | null | undefined }): string | undefined {
  const xApiKey = headers.get('x-api-key');
  if (xApiKey && xApiKey.trim().startsWith(API_KEY_PREFIX)) return xApiKey.trim();
  const auth = headers.get('authorization');
  if (auth) {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m && m[1] !== undefined && m[1].trim().startsWith(API_KEY_PREFIX)) return m[1].trim();
  }
  return undefined;
}
