/**
 * Mind metadata (SPEC §5 `MindMetadata`, §3.2): draft validation (SPEC limits + the shared
 * `mindMetadataSchema`), building the document, the on-chain `personaHash` / `modelId`, and the
 * `data:` URI fallback (`metadataDataUri` from `@www-rh/shared`) used when the runner is unreachable.
 *
 * @module lib/metadata
 */
import {
  MAX_METADATA_JSON_BYTES,
  MAX_METADATA_URI_BYTES,
  isModelId,
  metadataDataUri,
  mindMetadataSchema,
  modelIdToHash,
  personaHash,
} from '@www-rh/shared';
import type { Hex } from 'viem';
import { canonicalJson, utf8ByteLength } from './canonical';
import type { MindLinks, MindMetadata } from './types';

/** Limits of SPEC §5 (`MindMetadata`) and §2.3 (`metadataURI` ≤ 2048 bytes). */
export const METADATA_LIMITS = {
  nameBytes: 64,
  symbolBytes: 16,
  descriptionChars: 2000,
  imageChars: 512,
  personaChars: 8000,
  linkChars: 256,
  /** `POST /api/metadata` body limit (`MAX_METADATA_JSON_BYTES`). */
  metadataJsonBytes: MAX_METADATA_JSON_BYTES,
  /** On-chain `metadataURI` limit — bounds the `data:` URI fallback (`MAX_METADATA_URI_BYTES`). */
  metadataUriBytes: MAX_METADATA_URI_BYTES,
} as const;

/** Example persona shown as the placeholder of the persona fields. */
export const PERSONA_PLACEHOLDER =
  'You are an amateur astronomer who never sleeps. Every day you read new exoplanet papers on arXiv, check NASA APOD and the Minor Planet Center, and explain what you found in plain words. You distrust hype, you always link your sources, and you keep a running list of open questions you want to answer next.';

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
export type DraftErrors = Partial<Record<'name' | 'symbol' | 'description' | 'image' | 'persona' | 'model' | 'links' | 'schema', string>>;

function isHttpUrl(text: string): boolean {
  try {
    const u = new URL(text);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Builds the `MindMetadata` document from a draft: empty optional fields are omitted (the runner
 * rejects empty strings). The persona is used verbatim — `personaHash` is computed over the exact
 * string (SPEC §3.2), so it is not trimmed. Throws when the model is not a catalog id.
 */
export function buildMetadata(draft: MetadataDraft): MindMetadata {
  if (!isModelId(draft.model)) throw new Error(`Unknown model "${draft.model}".`);
  const meta: MindMetadata = {
    name: draft.name.trim(),
    symbol: draft.symbol.trim(),
    persona: draft.persona,
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

/** Canonical JSON of a metadata document — the bytes the runner hashes and the `data:` URI embeds. */
export function metadataJson(meta: MindMetadata): string {
  return canonicalJson({ ...meta, links: meta.links === undefined ? undefined : { ...meta.links } });
}

/** `keccak256(utf8(persona))` — the on-chain `personaHash` (shared `personaHash`, SPEC §3.2). */
export function personaHashOf(persona: string): Hex {
  return personaHash(persona);
}

/** `keccak256(utf8(modelId))` — the on-chain `modelId` (`modelIdToHash` from shared). */
export function modelHashOf(model: string): Hex {
  return modelIdToHash(model);
}

/** Validates a draft against SPEC §5 limits and the shared `mindMetadataSchema`. Empty object = valid. */
export function validateDraft(draft: MetadataDraft): DraftErrors {
  const errors: DraftErrors = {};
  const name = draft.name.trim();
  const symbol = draft.symbol.trim();
  const persona = draft.persona;
  if (name === '') errors.name = 'Give the coin a name.';
  else if (utf8ByteLength(name) > METADATA_LIMITS.nameBytes) errors.name = `At most ${METADATA_LIMITS.nameBytes} bytes.`;
  if (symbol === '') errors.symbol = 'Pick a ticker.';
  else if (utf8ByteLength(symbol) > METADATA_LIMITS.symbolBytes) errors.symbol = `At most ${METADATA_LIMITS.symbolBytes} bytes.`;
  else if (/\s/.test(symbol)) errors.symbol = 'No spaces in the ticker.';
  if (draft.description.trim().length > METADATA_LIMITS.descriptionChars) {
    errors.description = `At most ${METADATA_LIMITS.descriptionChars} characters.`;
  }
  const image = draft.image.trim();
  if (image !== '' && !(isHttpUrl(image) || image.startsWith('ipfs://'))) errors.image = 'Use an https:// or ipfs:// image URL.';
  else if (image.length > METADATA_LIMITS.imageChars) errors.image = `At most ${METADATA_LIMITS.imageChars} characters.`;
  if (persona.trim().length < 20) errors.persona = 'Describe the mind in at least 20 characters: what it is curious about and how it talks.';
  else if (persona.length > METADATA_LIMITS.personaChars) errors.persona = `At most ${METADATA_LIMITS.personaChars} characters.`;
  if (!isModelId(draft.model)) errors.model = 'Choose a model.';
  for (const link of [draft.links.x, draft.links.website, draft.links.telegram]) {
    const t = link.trim();
    if (t !== '' && (!isHttpUrl(t) || t.length > METADATA_LIMITS.linkChars)) {
      errors.links = `Links must be full http(s) URLs of at most ${METADATA_LIMITS.linkChars} characters.`;
      break;
    }
  }
  if (Object.keys(errors).length === 0) {
    const meta = buildMetadata(draft);
    const parsed = mindMetadataSchema.safeParse(meta);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      errors.schema = `Metadata rejected by the shared schema${issue !== undefined ? ` (${issue.path.map(String).join('.')}: ${issue.message})` : ''}.`;
    } else if (utf8ByteLength(metadataJson(meta)) > METADATA_LIMITS.metadataJsonBytes) {
      errors.schema = `Metadata exceeds ${METADATA_LIMITS.metadataJsonBytes} bytes; shorten the persona.`;
    }
  }
  return errors;
}

/** The `data:` URI fallback and whether it fits the 2048-byte on-chain `metadataURI` limit. */
export function dataUriFits(meta: MindMetadata): { uri: string; bytes: number; fits: boolean } {
  const uri = metadataDataUri(meta);
  const bytes = utf8ByteLength(uri);
  return { uri, bytes, fits: bytes <= METADATA_LIMITS.metadataUriBytes };
}
