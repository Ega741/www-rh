/**
 * Mind metadata (R1): draft validation, the JSON document uploaded to `POST /api/metadata`,
 * the on-chain `personaHash` / `modelId` (R12), and the `data:` URI fallback used when the
 * runner is unreachable (W2).
 *
 * @module lib/metadata
 */
import { modelIdToHash } from '@www-rh/shared';
import { keccak256, toBytes, type Hex } from 'viem';
import { canonicalJson, jsonDataUri, utf8ByteLength } from './canonical';
import type { MindLinks, MindMetadata } from './types';

/** Limits enforced by the contracts (D10) and the runner (R1). */
export const METADATA_LIMITS = {
  nameBytes: 64,
  symbolBytes: 16,
  /** `metadataURI` ≤ 2048 bytes on-chain (D10) — bounds the `data:` URI fallback. */
  metadataUriBytes: 2048,
  /** `POST /api/metadata` body ≤ 32 KB (R1). */
  metadataJsonBytes: 32 * 1024,
  personaChars: 8000,
  descriptionChars: 1000,
} as const;

/** Form state of the create / reconfigure flows. */
export interface MetadataDraft {
  name: string;
  symbol: string;
  description: string;
  image: string;
  persona: string;
  model: string;
  links: { x: string; website: string; telegram: string };
}

/** Field → message map of validation problems. */
export type DraftErrors = Partial<Record<'name' | 'symbol' | 'description' | 'image' | 'persona' | 'model' | 'links' | 'size', string>>;

function isHttpUrl(text: string): boolean {
  try {
    const u = new URL(text);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

function isImageRef(text: string): boolean {
  return isHttpUrl(text) || text.startsWith('ipfs://') || /^data:image\/(png|jpeg|webp|gif);base64,/.test(text);
}

/** Builds the metadata JSON from a draft: trims strings and omits empty optional fields. */
export function buildMetadata(draft: MetadataDraft): MindMetadata {
  const meta: MindMetadata = {
    name: draft.name.trim(),
    symbol: draft.symbol.trim(),
    persona: draft.persona.trim(),
    model: draft.model,
  };
  const description = draft.description.trim();
  const image = draft.image.trim();
  if (description !== '') meta.description = description;
  if (image !== '') meta.image = image;
  const links: MindLinks = {};
  const x = draft.links.x.trim();
  const website = draft.links.website.trim();
  const telegram = draft.links.telegram.trim();
  if (x !== '') links.x = x;
  if (website !== '') links.website = website;
  if (telegram !== '') links.telegram = telegram;
  if (Object.keys(links).length > 0) meta.links = links;
  return meta;
}

/** Canonical JSON of a metadata document (R2) — the bytes hashed by the runner and embedded in `data:` URIs. */
export function metadataJson(meta: MindMetadata): string {
  return canonicalJson({ ...meta, links: meta.links === undefined ? undefined : { ...meta.links } });
}

/** `data:application/json;base64,…` with the canonical JSON (W2 fallback). */
export function metadataDataUri(meta: MindMetadata): string {
  return jsonDataUri(metadataJson(meta));
}

/** `keccak256(utf8(persona))` — the on-chain `personaHash` (R1). */
export function personaHashOf(persona: string): Hex {
  return keccak256(toBytes(persona));
}

/** `keccak256(utf8(modelId))` — the on-chain `modelId` (R12). */
export function modelHashOf(model: string): Hex {
  return modelIdToHash(model);
}

/** Validates a draft against D10 / R1 limits. Returns an empty object when valid. */
export function validateDraft(draft: MetadataDraft): DraftErrors {
  const errors: DraftErrors = {};
  const name = draft.name.trim();
  const symbol = draft.symbol.trim();
  const persona = draft.persona.trim();
  if (name === '') errors.name = 'Give the coin a name.';
  else if (utf8ByteLength(name) > METADATA_LIMITS.nameBytes) errors.name = `At most ${METADATA_LIMITS.nameBytes} bytes.`;
  if (symbol === '') errors.symbol = 'Pick a ticker.';
  else if (utf8ByteLength(symbol) > METADATA_LIMITS.symbolBytes) errors.symbol = `At most ${METADATA_LIMITS.symbolBytes} bytes.`;
  else if (/\s/.test(symbol)) errors.symbol = 'No spaces in the ticker.';
  if (draft.description.trim().length > METADATA_LIMITS.descriptionChars) {
    errors.description = `At most ${METADATA_LIMITS.descriptionChars} characters.`;
  }
  const image = draft.image.trim();
  if (image !== '' && !isImageRef(image)) errors.image = 'Use an https:// or ipfs:// image URL, or upload a file.';
  if (persona.length < 20) errors.persona = 'Describe the mind in at least 20 characters: what it is curious about and how it talks.';
  else if (persona.length > METADATA_LIMITS.personaChars) errors.persona = `At most ${METADATA_LIMITS.personaChars} characters.`;
  if (draft.model === '') errors.model = 'Choose a model.';
  const { x, website, telegram } = draft.links;
  for (const link of [x, website, telegram]) {
    const t = link.trim();
    if (t !== '' && !isHttpUrl(t)) {
      errors.links = 'Links must be full http(s) URLs.';
      break;
    }
  }
  if (Object.keys(errors).length === 0) {
    const size = utf8ByteLength(metadataJson(buildMetadata(draft)));
    if (size > METADATA_LIMITS.metadataJsonBytes) {
      errors.size = `Metadata is ${size} bytes; the runner accepts at most ${METADATA_LIMITS.metadataJsonBytes}. Use a smaller image or a shorter persona.`;
    }
  }
  return errors;
}

/** Whether the `data:` URI fallback fits the on-chain `metadataURI` limit (D10). */
export function dataUriFits(meta: MindMetadata): { uri: string; bytes: number; fits: boolean } {
  const uri = metadataDataUri(meta);
  const bytes = utf8ByteLength(uri);
  return { uri, bytes, fits: bytes <= METADATA_LIMITS.metadataUriBytes };
}
