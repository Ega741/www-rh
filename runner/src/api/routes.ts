/**
 * HTTP API (`docs/SPEC.md` §5) as a Hono app under `/api`, CORS for the `PUBLIC_WEB_ORIGIN` list.
 * Errors are `{ error }` with 400 / 404 / 413 / 429 / 500.
 *
 * @module api/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import {
  canonicalJson,
  MAX_METADATA_JSON_BYTES,
  MODELS,
  toPublicModelSpec,
  type ComputeResponse,
  type HealthResponse,
  type MindsResponse,
  type StatsResponse,
} from '@www-rh/shared';
import type { Repos } from '../db/repos.js';
import { microToUsd } from '../economics/budget.js';
import type { MindEconomics } from '../economics/service.js';
import { STATE_TOTAL_FEES_TO_MINDS, STATE_TOTAL_VOLUME } from '../indexer/apply.js';
import { errorMessage, type Logger } from '../log.js';
import { buildAnchorBatch, memoryDto } from '../memory/memory.js';
import { storeMetadata } from '../metadata/store.js';
import type { StreamBus } from '../stream/bus.js';
import { activityByToken, drawDto, drawReceiptDto, ledgerEntryDto, mindDetailDto, mindSummaryDto, thoughtDto, tradeDto } from './dto.js';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DAY_MS = 86_400_000;

/** Runtime facts the API reports. */
export interface ApiStatus {
  chainId: number;
  launchpad: string | null;
  dryRun(): boolean;
  indexer(): { live: boolean; lastError: string | null; headBlock: bigint | null; lastIndexedBlock: bigint | null };
  activeMinds(): number;
}

/** Dependencies of {@link createApi}. */
export interface ApiDeps {
  repos: Repos;
  economics: { snapshot(token: string): Promise<MindEconomics> };
  bus: StreamBus;
  status: ApiStatus;
  origins: readonly string[];
  log: Logger;
  now?: () => number;
  /** POST /api/metadata requests per minute (global). */
  metadataRateLimit?: number;
}

/** Sliding one-minute window limiter. */
class RateLimiter {
  readonly #hits: number[] = [];

  constructor(
    private readonly limit: number,
    private readonly now: () => number,
  ) {}

  allow(): boolean {
    const t = this.now();
    while (this.#hits.length > 0 && (this.#hits[0] as number) <= t - 60_000) this.#hits.shift();
    if (this.#hits.length >= this.limit) return false;
    this.#hits.push(t);
    return true;
  }
}

function intParam(value: string | undefined, fallback: number, min: number, max: number): number | null {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= min && n <= max ? n : null;
}

/**
 * Reads a request body of at most `max` bytes. Chunked bodies are streamed and the read stops at the
 * first byte over the limit (nothing beyond `max` is buffered); `null` = too large. Under
 * `@hono/node-server` the Node request is read directly and paused on overflow.
 */
export async function readBodyCapped(c: Context, max: number): Promise<Uint8Array | null> {
  const incoming = (c.env as { incoming?: IncomingMessage } | undefined)?.incoming;
  if (incoming !== undefined && typeof incoming.on === 'function' && !incoming.readableEnded) {
    return new Promise<Uint8Array | null>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const cleanup = (): void => {
        incoming.off('data', onData);
        incoming.off('end', onEnd);
        incoming.off('error', onError);
        incoming.off('aborted', onAborted);
      };
      const onData = (chunk: Buffer): void => {
        size += chunk.length;
        if (size > max) {
          cleanup();
          incoming.pause();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      };
      const onEnd = (): void => {
        cleanup();
        resolve(new Uint8Array(Buffer.concat(chunks)));
      };
      const onError = (err: Error): void => {
        cleanup();
        reject(err);
      };
      const onAborted = (): void => onError(new Error('request aborted'));
      incoming.on('data', onData);
      incoming.on('end', onEnd);
      incoming.on('error', onError);
      incoming.on('aborted', onAborted);
      incoming.resume();
    });
  }
  const body = c.req.raw.body;
  if (body === null) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const ch of chunks) {
    out.set(ch, offset);
    offset += ch.byteLength;
  }
  return out;
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset })).toString('base64url');
}

function decodeCursor(cursor: string | undefined): number | null {
  if (cursor === undefined || cursor === '') return 0;
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: unknown };
    return typeof v.o === 'number' && Number.isSafeInteger(v.o) && v.o >= 0 ? v.o : null;
  } catch {
    return null;
  }
}

/** Builds the Hono app. */
export function createApi(deps: ApiDeps): Hono {
  const now = deps.now ?? Date.now;
  const limiter = new RateLimiter(deps.metadataRateLimit ?? 60, now);
  const app = new Hono();
  const fail = (c: Context, status: 400 | 404 | 413 | 429 | 500, error: string): Response => c.json({ error }, status);

  app.use('/api/*', cors({ origin: [...deps.origins], allowMethods: ['GET', 'POST', 'OPTIONS'], allowHeaders: ['Content-Type'], maxAge: 600 }));
  app.onError((err, c) => {
    deps.log.error('API error', { path: c.req.path, error: errorMessage(err) });
    return fail(c, 500, 'internal error');
  });
  app.notFound((c) => fail(c, 404, 'not found'));

  const mindOr404 = (c: Context): { token: string } | Response => {
    const raw = c.req.param('token') ?? '';
    if (!ADDRESS.test(raw)) return fail(c, 400, 'invalid token address');
    const token = raw.toLowerCase();
    if (deps.repos.minds.get(token) === undefined) return fail(c, 404, 'unknown mind');
    return { token };
  };

  app.get('/api/health', (c) => {
    const ix = deps.status.indexer();
    const body: HealthResponse = {
      ok: deps.status.launchpad !== null && ix.lastError === null,
      chainId: deps.status.chainId,
      launchpad: (deps.status.launchpad ?? ZERO_ADDRESS).toLowerCase() as `0x${string}`,
      lastIndexedBlock: ix.lastIndexedBlock === null ? 0 : Number(ix.lastIndexedBlock),
      headBlock: ix.headBlock === null ? 0 : Number(ix.headBlock),
      activeMinds: deps.status.activeMinds(),
      dryRun: deps.status.dryRun(),
    };
    return c.json(body);
  });

  app.get('/api/minds', (c) => {
    const sort = c.req.query('sort') ?? 'created';
    if (sort !== 'created' && sort !== 'mcap' && sort !== 'activity') return fail(c, 400, 'sort must be created|mcap|activity');
    const limit = intParam(c.req.query('limit'), 50, 1, 200);
    if (limit === null) return fail(c, 400, 'limit must be 1..200');
    const offset = decodeCursor(c.req.query('cursor'));
    if (offset === null) return fail(c, 400, 'invalid cursor');
    const rows = deps.repos.minds.list(sort, limit + 1, offset);
    const page = rows.slice(0, limit);
    const activity = activityByToken(deps.repos.trades.since(page.map((r) => r.token), now() - DAY_MS));
    const body: MindsResponse = {
      items: page.map((r) => mindSummaryDto(r, activity.get(r.token))),
      nextCursor: rows.length > limit ? encodeCursor(offset + limit) : null,
    };
    return c.json(body);
  });

  app.get('/api/minds/:token', (c) => {
    const m = mindOr404(c);
    if (m instanceof Response) return m;
    const row = deps.repos.minds.get(m.token);
    if (row === undefined) return fail(c, 404, 'unknown mind');
    const activity = activityByToken(deps.repos.trades.since([m.token], now() - DAY_MS));
    return c.json(mindDetailDto(row, activity.get(m.token)));
  });

  app.get('/api/minds/:token/trades', (c) => {
    const m = mindOr404(c);
    if (m instanceof Response) return m;
    const limit = intParam(c.req.query('limit'), 100, 1, 500);
    if (limit === null) return fail(c, 400, 'limit must be 1..500');
    return c.json(deps.repos.trades.listByToken(m.token, limit).map(tradeDto));
  });

  app.get('/api/minds/:token/memories/batch/:range', (c) => {
    const m = mindOr404(c);
    if (m instanceof Response) return m;
    const match = /^(\d+)-(\d+)$/.exec(c.req.param('range'));
    if (match === null) return fail(c, 400, 'range must be <fromSeq>-<toSeq>');
    const from = Number(match[1]);
    const to = Number(match[2]);
    if (from < 1 || to < from) return fail(c, 400, 'invalid range');
    if (to - from + 1 > 1000) return fail(c, 400, 'range too large (max 1000)');
    const rows = deps.repos.memories.range(m.token, from, to);
    if (rows.length !== to - from + 1) return fail(c, 404, 'range not found');
    // canonical bytes: keccak256(response body) == contentHash of the anchored batch
    return c.body(canonicalJson(buildAnchorBatch(m.token, rows)), 200, { 'Content-Type': 'application/json; charset=utf-8' });
  });

  app.get('/api/minds/:token/memories', (c) => {
    const m = mindOr404(c);
    if (m instanceof Response) return m;
    const limit = intParam(c.req.query('limit'), 50, 1, 200);
    if (limit === null) return fail(c, 400, 'limit must be 1..200');
    const beforeRaw = c.req.query('before');
    const before = beforeRaw === undefined ? undefined : intParam(beforeRaw, 0, 1, Number.MAX_SAFE_INTEGER);
    if (before === null) return fail(c, 400, 'before must be a positive seq');
    return c.json(deps.repos.memories.list(m.token, limit, before).map(memoryDto));
  });

  app.get('/api/minds/:token/thoughts', (c) => {
    const m = mindOr404(c);
    if (m instanceof Response) return m;
    const limit = intParam(c.req.query('limit'), 100, 1, 500);
    if (limit === null) return fail(c, 400, 'limit must be 1..500');
    return c.json(deps.repos.ticks.thoughts(m.token, limit).map(thoughtDto));
  });

  app.get('/api/minds/:token/compute', async (c) => {
    const m = mindOr404(c);
    if (m instanceof Response) return m;
    const row = deps.repos.minds.get(m.token);
    const econ = await deps.economics.snapshot(m.token);
    const runnable = row !== undefined && row.status === 0 && econ.modelKnown && econ.hasBudget && !(row.cooling_until !== null && row.cooling_until > now());
    const body: ComputeResponse = {
      balanceWei: econ.budget.balanceWei.toString(10),
      balanceUsd: microToUsd(econ.budget.balanceUsdMicro),
      unsettledUsd: microToUsd(econ.budget.unsettledUsdMicro),
      availableUsd: microToUsd(Math.max(0, econ.budget.availableUsdMicro)),
      burnUsdPerHour: Math.round(econ.burnUsdPerHour * 1e6) / 1e6,
      runwayHours: econ.runwayHours,
      tickIntervalMs: runnable ? econ.tickIntervalMs : null,
      ledger: deps.repos.ticks.ledger(m.token, 100).map(ledgerEntryDto),
      receipts: deps.repos.ticks.receipts(m.token, 50).map(drawReceiptDto),
      draws: deps.repos.facts.draws(m.token, 50).map(drawDto),
    };
    return c.json(body);
  });

  app.get('/api/minds/:token/frame.jpg', (c) => {
    const m = mindOr404(c);
    if (m instanceof Response) return m;
    const frame = deps.bus.lastFrame(m.token);
    if (frame === null) return fail(c, 404, 'no frame yet');
    return c.body(Buffer.from(frame.jpegBase64, 'base64'), 200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
  });

  app.get('/api/models', (c) => c.json(MODELS.map(toPublicModelSpec)));

  app.get('/api/stats', (c) => {
    const body: StatsResponse = {
      minds: deps.repos.minds.count(),
      alive: deps.repos.minds.countWhere('status', 0),
      graduated: deps.repos.minds.countWhere('phase', 2),
      totalVolumeWei: deps.repos.state.bigint(STATE_TOTAL_VOLUME).toString(10),
      totalFeesToMindsWei: deps.repos.state.bigint(STATE_TOTAL_FEES_TO_MINDS).toString(10),
    };
    return c.json(body);
  });

  const tooLarge = (c: Context): Response => {
    // stop reading the rest: the connection is closed after this response
    c.header('Connection', 'close');
    const env = c.env as { incoming?: IncomingMessage; outgoing?: ServerResponse } | undefined;
    env?.outgoing?.once('finish', () => setTimeout(() => env.incoming?.socket?.destroy(), 1_000).unref());
    return fail(c, 413, `body exceeds ${MAX_METADATA_JSON_BYTES} bytes`);
  };

  app.post('/api/metadata', async (c) => {
    if (!limiter.allow()) return fail(c, 429, 'rate limited');
    const declared = Number(c.req.header('content-length') ?? '0');
    if (declared > MAX_METADATA_JSON_BYTES) return tooLarge(c);
    if (!(c.req.header('content-type') ?? '').toLowerCase().startsWith('application/json')) return fail(c, 400, 'Content-Type must be application/json');
    // streamed with a hard cap: a chunked body (no Content-Length) is never buffered beyond 32 KB
    const raw = await readBodyCapped(c, MAX_METADATA_JSON_BYTES);
    if (raw === null) return tooLarge(c);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return fail(c, 400, 'body is not valid JSON');
    }
    const result = storeMetadata(deps.repos, body, now());
    return result.ok ? c.json(result.response) : fail(c, 400, result.error);
  });

  app.get('/api/metadata/:hash', (c) => {
    const hash = c.req.param('hash');
    if (!/^[0-9a-f]{64}$/.test(hash)) return fail(c, 400, 'hash must be 64 lowercase hex characters');
    const row = deps.repos.metadata.get(hash);
    if (row === undefined) return fail(c, 404, 'unknown metadata hash');
    return c.body(row.json, 200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=31536000, immutable' });
  });

  return app;
}
