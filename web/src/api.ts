/**
 * Typed client for the runner HTTP API (SPEC §5 as amended by R1, R2, R11).
 *
 * Base URL per directive W1 (`API_BASE`: '' in dev through the Vite proxy, `VITE_RUNNER_URL` in
 * prod). Every response is normalised into the view models of `lib/types.ts`.
 *
 * @module api
 */
import type { Address } from 'viem';
import { API_BASE } from './config';
import { isObject } from './lib/json';
import {
  normalizeCompute,
  normalizeHealth,
  normalizeLaunchConfig,
  normalizeMemory,
  normalizeMetadataUpload,
  normalizeMindDetail,
  normalizeMindsPage,
  normalizeModel,
  normalizePendingAdoptions,
  normalizeStats,
  normalizeThought,
  normalizeTrade,
} from './lib/normalize';
import { mapValid, readList } from './lib/json';
import type { PonsLaunchSettings } from './lib/pons/launch';
import type {
  ComputeInfo,
  Health,
  Memory,
  MetadataUploadResult,
  MindDetail,
  MindMetadata,
  MindsPage,
  MindsSort,
  ModelInfo,
  PendingAdoption,
  Stats,
  Thought,
  Trade,
} from './lib/types';

/** Error raised for failed API calls. */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  /**
   * @param status HTTP status, or `null` when the request never got a response.
   * @param unavailable `true` when the runner is unreachable or failing (network error, timeout, 5xx).
   */
  constructor(
    message: string,
    readonly status: number | null,
    readonly unavailable: boolean,
  ) {
    super(message);
  }
}

/** Default request timeout. */
export const API_TIMEOUT_MS = 10_000;

function url(path: string): string {
  return `${API_BASE}${path}`;
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url(path), {
      ...init,
      headers: { accept: 'application/json', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      signal: init.signal ?? AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ApiError(`runner unreachable (${reason})`, null, true);
  }
  const text = await response.text();
  let body: unknown = null;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const detail = isObject(body)
      ? String(body['error'] ?? body['message'] ?? response.statusText)
      : typeof body === 'string' && body.length < 200 && body !== ''
        ? body
        : response.statusText || 'request failed';
    throw new ApiError(`${response.status} ${detail}`, response.status, response.status >= 500);
  }
  return body;
}

function enc(value: string | number): string {
  return encodeURIComponent(String(value));
}

/** `GET /api/health`. */
export async function getHealth(): Promise<Health> {
  return normalizeHealth(await request('/api/health'));
}

/** `GET /api/minds?sort&limit&cursor`. */
export async function getMinds(params: { sort: MindsSort; limit?: number; cursor?: string | null }): Promise<MindsPage> {
  const q = new URLSearchParams({ sort: params.sort, limit: String(params.limit ?? 48) });
  if (params.cursor) q.set('cursor', params.cursor);
  return normalizeMindsPage(await request(`/api/minds?${q.toString()}`));
}

/** `GET /api/minds/:token`. */
export async function getMind(token: Address): Promise<MindDetail> {
  return normalizeMindDetail(await request(`/api/minds/${enc(token.toLowerCase())}`));
}

/** `GET /api/minds/:token/trades?limit`. */
export async function getTrades(token: Address, limit = 100): Promise<Trade[]> {
  const raw = await request(`/api/minds/${enc(token.toLowerCase())}/trades?limit=${limit}`);
  return mapValid(readList(raw, 'items', 'trades'), normalizeTrade, 'trade');
}

/** `GET /api/minds/:token/memories?limit&before`. */
export async function getMemories(token: Address, params: { limit?: number; before?: number | null } = {}): Promise<Memory[]> {
  const q = new URLSearchParams({ limit: String(params.limit ?? 50) });
  if (params.before !== undefined && params.before !== null) q.set('before', String(params.before));
  const raw = await request(`/api/minds/${enc(token.toLowerCase())}/memories?${q.toString()}`);
  return mapValid(readList(raw, 'items', 'memories'), normalizeMemory, 'memory');
}

/** `GET /api/minds/:token/thoughts?limit`. */
export async function getThoughts(token: Address, limit = 100): Promise<Thought[]> {
  const raw = await request(`/api/minds/${enc(token.toLowerCase())}/thoughts?limit=${limit}`);
  return mapValid(readList(raw, 'items', 'thoughts'), normalizeThought, 'thought');
}

/** `GET /api/minds/:token/compute` (balance, burn, runway, ledger, receipts). */
export async function getCompute(token: Address): Promise<ComputeInfo> {
  return normalizeCompute(await request(`/api/minds/${enc(token.toLowerCase())}/compute`));
}

/** `GET /api/minds/:token/adoptions` (SPEC §9.7): pending adoption preparations of a token. */
export async function getMindAdoptions(token: Address): Promise<PendingAdoption[]> {
  return normalizePendingAdoptions(await request(`/api/minds/${enc(token.toLowerCase())}/adoptions`));
}

/** `GET /api/models`. */
export async function getModels(): Promise<ModelInfo[]> {
  const raw = await request('/api/models');
  return mapValid(readList(raw, 'items', 'models'), normalizeModel, 'model');
}

/** `GET /api/stats`. */
export async function getStats(): Promise<Stats> {
  return normalizeStats(await request('/api/stats'));
}

/** `GET /api/launch-config` (SPEC §9.4, Pons mode): launch fee, launch configs, creator tax cap, snipe window. */
export async function getLaunchConfig(): Promise<PonsLaunchSettings> {
  return normalizeLaunchConfig(await request('/api/launch-config'));
}

/** `POST /api/metadata` (R1): stores the metadata JSON, returns `runner://metadata/<hash>`. */
export async function postMetadata(metadata: MindMetadata): Promise<MetadataUploadResult> {
  return normalizeMetadataUpload(
    await request('/api/metadata', { method: 'POST', body: JSON.stringify(metadata) }),
  );
}

/** `GET /api/metadata/:hash` (R1). */
export async function getMetadata(hash: string): Promise<unknown> {
  return request(`/api/metadata/${enc(hash)}`);
}

/** URL of the latest frame JPEG; `bust` defeats HTTP caches for the 5 s thumbnail refresh. */
export function frameUrl(token: Address, bust?: number): string {
  const base = url(`/api/minds/${enc(token.toLowerCase())}/frame.jpg`);
  return bust === undefined ? base : `${base}?t=${bust}`;
}

/** URL of an anchored memory batch (R2) — the exact object whose keccak256 was anchored. */
export function memoryBatchUrl(token: Address, fromSeq: number, toSeq: number): string {
  return url(`/api/minds/${enc(token.toLowerCase())}/memories/batch/${fromSeq}-${toSeq}`);
}

/** Parses `runner://memories/<token>/<from>-<to>` into a batch range. */
export function parseMemoryBatchUri(uri: string): { token: string; fromSeq: number; toSeq: number } | null {
  const m = /^runner:\/\/memories\/(0x[0-9a-fA-F]{40})\/(\d+)-(\d+)$/.exec(uri.trim());
  if (m === null) return null;
  return { token: (m[1] ?? '').toLowerCase(), fromSeq: Number(m[2]), toSeq: Number(m[3]) };
}
