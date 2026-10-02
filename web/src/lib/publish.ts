/**
 * Publishing mind metadata (W2): `POST /api/metadata` first; when the runner is unreachable,
 * fall back to a `data:application/json;base64,` URI with the same canonical JSON, provided it
 * fits the 2048-byte on-chain `metadataURI` limit (D10).
 *
 * @module lib/publish
 */
import type { Hex } from 'viem';
import { ApiError, postMetadata } from '../api';
import { METADATA_LIMITS, dataUriFits, personaHashOf } from './metadata';
import type { MindMetadata } from './types';

/** Where the metadata ended up. */
export interface PublishedMetadata {
  uri: string;
  personaHash: Hex;
  via: 'runner' | 'data-uri';
}

/** Uploads `meta` (or embeds it) and returns the `metadataURI` + `personaHash` for the contract call. */
export async function publishMetadata(meta: MindMetadata, upload: typeof postMetadata = postMetadata): Promise<PublishedMetadata> {
  const localHash = personaHashOf(meta.persona);
  try {
    const res = await upload(meta);
    if (res.personaHash.toLowerCase() !== localHash.toLowerCase()) {
      throw new Error('The runner returned a personaHash that does not match keccak256(persona); refusing to publish.');
    }
    return { uri: res.uri, personaHash: res.personaHash, via: 'runner' };
  } catch (error) {
    if (error instanceof ApiError && error.unavailable) {
      const embedded = dataUriFits(meta);
      if (!embedded.fits) {
        throw new Error(
          `The runner is unreachable, and the metadata is too large to embed on-chain as a data: URI (${embedded.bytes} bytes, limit ${METADATA_LIMITS.metadataUriBytes}). Shorten the persona or description, drop the uploaded image (use an image URL), or try again when the runner is back.`,
        );
      }
      return { uri: embedded.uri, personaHash: localHash, via: 'data-uri' };
    }
    throw error;
  }
}
