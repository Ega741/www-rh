/**
 * `POST /api/metadata` (`docs/SPEC.md` §5): strict validation with `mindMetadataSchema`,
 * `hash = metadataHash(meta)`, storage of the canonical JSON (deduplicated by hash) and the response
 * `{ uri: metadataUri(hash), hash, personaHash: personaHash(meta.persona) }`.
 *
 * @module metadata/store
 */
import { canonicalJson, metadataHash, metadataUri, mindMetadataSchema, personaHash, type MetadataUploadResponse } from '@www-rh/shared';
import type { Repos } from '../db/repos.js';

/** Result of {@link storeMetadata}. */
export type StoreResult = { ok: true; response: MetadataUploadResponse } | { ok: false; error: string };

/** Validates and stores a metadata document (already JSON-parsed). */
export function storeMetadata(repos: Repos, body: unknown, now: number = Date.now()): StoreResult {
  const parsed = mindMetadataSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `invalid metadata: ${issue === undefined ? 'unknown error' : `${issue.path.join('.') || '(root)'}: ${issue.message}`}` };
  }
  const meta = parsed.data;
  const hash = metadataHash(meta);
  const persona = personaHash(meta.persona);
  repos.metadata.put(hash, canonicalJson(meta), persona, now);
  return { ok: true, response: { uri: metadataUri(hash), hash, personaHash: persona } };
}
