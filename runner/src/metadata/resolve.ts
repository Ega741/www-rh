/**
 * Resolution of `metadataURI` (`docs/SPEC.md` §4.1 `metadata/`): `runner://metadata/<hash>`
 * (local table), `data:application/json;base64,…`, `ipfs://<cid>[/path]` (via `IPFS_GATEWAY`) and
 * `http(s)://` (best effort, see {@link safeFetchText}). Documents are parsed with the
 * `mindMetadataSchema` shape in strip mode; any failure nulls every metadata-derived field. The
 * persona is kept only when `personaHash(persona)` equals the on-chain `personaHash`.
 *
 * @module metadata/resolve
 */
import { mindMetadataSchema, personaHash, type MindMetadata } from '@www-rh/shared';
import type { EgressFilter } from '../browser/egress.js';
import type { MindRow, Repos } from '../db/repos.js';
import { errorMessage, type Logger } from '../log.js';
import { TaskQueue } from '../util.js';
import { safeFetchText, type FetchText } from './safeFetch.js';

/** Maximum metadata document size. */
export const MAX_METADATA_DOC_BYTES = 65_536;

/** Strip-mode version of the strict upload schema (unknown keys ignored, also inside `links`). */
export const externalMetadataSchema = mindMetadataSchema.extend({ links: mindMetadataSchema.shape.links.unwrap().strip().optional() }).strip();

/** Normalizes an image URI: http(s) kept, `ipfs://x` → gateway + x, anything else → null. */
export function normalizeImage(image: string | undefined, ipfsGateway: string): string | null {
  if (image === undefined) return null;
  if (/^https?:\/\//i.test(image)) return image;
  if (/^ipfs:\/\//i.test(image)) return `${ipfsGateway}${image.slice('ipfs://'.length).replace(/^ipfs\//, '')}`;
  return null;
}

/** Loads the raw JSON text behind `uri`. */
export async function loadMetadataText(uri: string, deps: { repos: Repos; egress: EgressFilter; ipfsGateway: string; fetchText: FetchText }): Promise<string> {
  if (uri.startsWith('runner://metadata/')) {
    const row = deps.repos.metadata.get(uri.slice('runner://metadata/'.length));
    if (row === undefined) throw new Error('unknown runner metadata hash');
    return row.json;
  }
  const data = /^data:application\/json(?:;charset=[\w-]+)?;base64,([A-Za-z0-9+/=\s]*)$/i.exec(uri);
  if (data !== null) {
    const buf = Buffer.from(data[1] as string, 'base64');
    if (buf.length > MAX_METADATA_DOC_BYTES) throw new Error('data URI too large');
    return buf.toString('utf8');
  }
  if (/^ipfs:\/\//i.test(uri)) {
    const path = uri.slice('ipfs://'.length).replace(/^ipfs\//, '');
    if (path === '') throw new Error('empty ipfs URI');
    return deps.fetchText(`${deps.ipfsGateway}${path}`, deps.egress, { maxBytes: MAX_METADATA_DOC_BYTES });
  }
  if (/^https?:\/\//i.test(uri)) return deps.fetchText(uri, deps.egress, { maxBytes: MAX_METADATA_DOC_BYTES });
  throw new Error('unsupported metadata URI scheme');
}

/** Parses a metadata document in strip mode. */
export function parseExternalMetadata(text: string): MindMetadata {
  return externalMetadataSchema.parse(JSON.parse(text)) as MindMetadata;
}

/** Resolves and stores the metadata of minds. */
export class MetadataResolver {
  readonly #queue = new TaskQueue(2);
  readonly #inFlight = new Set<string>();
  readonly #again = new Set<string>();
  readonly #jobs = new Set<Promise<void>>();
  #stopped = false;

  constructor(
    private readonly repos: Repos,
    private readonly egress: EgressFilter,
    private readonly ipfsGateway: string,
    private readonly log: Logger,
    private readonly fetchText: FetchText = safeFetchText,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Resolves `token` now and stores the result — only if the mind still has the metadata URI and
   * persona hash that were resolved (a `MindConfigUpdated` meanwhile re-queues it instead).
   */
  async resolve(token: string): Promise<void> {
    const mind = this.repos.minds.get(token);
    if (mind === undefined || this.#stopped) return;
    const expect = { metadataUri: mind.metadata_uri, personaHash: mind.persona_hash };
    let stored: boolean;
    try {
      const meta = parseExternalMetadata(await loadMetadataText(mind.metadata_uri, { repos: this.repos, egress: this.egress, ipfsGateway: this.ipfsGateway, fetchText: this.fetchText }));
      if (this.#stopped) return;
      stored = this.#store(mind, meta, expect);
    } catch (err) {
      if (this.#stopped) return;
      this.log.debug('metadata unresolved', { token: mind.token, uri: mind.metadata_uri.slice(0, 120), error: errorMessage(err) });
      stored = this.repos.minds.setMetadata(mind.token, { status: 'error', image: null, description: null, persona: null, personaVerified: false, links: null, at: this.now() }, expect);
    }
    if (!stored) this.#again.add(mind.token);
  }

  #store(mind: MindRow, meta: MindMetadata, expect: { metadataUri: string; personaHash: string }): boolean {
    const verified = personaHash(meta.persona).toLowerCase() === mind.persona_hash.toLowerCase();
    const links = { x: meta.links?.x ?? null, website: meta.links?.website ?? null, telegram: meta.links?.telegram ?? null };
    return this.repos.minds.setMetadata(mind.token, {
      status: 'ok',
      image: normalizeImage(meta.image, this.ipfsGateway),
      description: meta.description ?? null,
      persona: verified ? meta.persona : null,
      personaVerified: verified,
      links: JSON.stringify(links),
      at: this.now(),
    }, expect);
  }

  /** Queues resolution of `token` (deduplicated; a request during resolution runs again afterwards). */
  enqueue(token: string): void {
    const key = token.toLowerCase();
    if (this.#stopped) return;
    if (this.#inFlight.has(key)) {
      this.#again.add(key);
      return;
    }
    this.#inFlight.add(key);
    this.#queue.push(async () => {
      const job = this.resolve(key).catch((err: unknown) => this.log.debug('metadata resolution failed', { token: key, error: errorMessage(err) }));
      this.#jobs.add(job);
      try {
        await job;
      } finally {
        this.#jobs.delete(job);
        this.#inFlight.delete(key);
        if (this.#again.delete(key)) this.enqueue(key);
      }
    });
  }

  /** Stops resolving (shutdown): no new job starts, running ones are awaited (their DB writes are skipped). */
  async stop(): Promise<void> {
    this.#stopped = true;
    await Promise.allSettled([...this.#jobs]);
  }

  /** Queues every mind whose metadata is still `pending`. */
  sweepPending(): void {
    for (const m of this.repos.minds.withMetaStatus('pending')) this.enqueue(m.token);
  }
}
