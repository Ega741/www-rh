/**
 * WebSocket client for the live mind stream (SPEC §6 as amended by R7 and R10).
 *
 * - `parseWsMessage` validates one server message with the shared `wsServerMessageSchema`
 *   (mismatches are logged once and read leniently) and normalises it (unknown types → `null`).
 * - `MindSocket` connects to `<WS_BASE>?token=0x…`, pings every 20 s, and reconnects with
 *   exponential backoff + jitter: at least 10 s after close 1013 (too many viewers), every 3 s
 *   (max 10 attempts) after 4404 (token not indexed yet), never after 1008 (bad token).
 *
 * @module ws
 */
import { wsServerMessageSchema } from '@www-rh/shared';
import type { Address } from 'viem';
import { isObject, readBigint, readNumber, readString, readText, readTime } from './lib/json';
import { checkShape, normalizeMemory, normalizeThought, normalizeTrade, toPhaseName, toStatusName } from './lib/normalize';
import type { CurvePhaseName, Memory, MindStatusName, Thought, Trade } from './lib/types';

/** `hello` — sent after connecting (and after a `subscribe`). */
export interface WsHello {
  type: 'hello';
  token: Address | null;
  status: MindStatusName;
  phase: CurvePhaseName;
  /** Last captured frame (SPEC `frame: {jpegBase64,url,at}`; legacy `lastFrame` string accepted). */
  frame: { jpegBase64: string; url: string | null; at: number } | null;
  currentUrl: string | null;
}
/** `frame` — latest browser screenshot (JPEG, base64). */
export interface WsFrame {
  type: 'frame';
  jpegBase64: string;
  url: string | null;
  at: number;
}
/** `thought` — streamed text/thinking deltas, then one final `delta:false` with the full block (R7). */
export interface WsThought {
  type: 'thought';
  tickId: number;
  kind: 'text' | 'thinking';
  text: string;
  delta: boolean;
  at: number;
}
/** `action` — a tool call (input redacted to ≤ 300 chars). */
export interface WsAction {
  type: 'action';
  tool: string;
  input: string;
  tickId: number | null;
  at: number;
}
/** `thoughtSaved` — an `aloud` / `summary` thought was persisted. */
export interface WsThoughtSaved {
  type: 'thoughtSaved';
  thought: Thought;
}
/** `anchor` — a memory batch anchor changed state (runner extension; triggers a memory refetch). */
export interface WsAnchor {
  type: 'anchor';
}
/** `memory` — a new memory was recorded. */
export interface WsMemory {
  type: 'memory';
  memory: Memory;
}
/** `status` — status / phase changed. */
export interface WsStatus {
  type: 'status';
  status: MindStatusName;
  phase: CurvePhaseName;
  at: number;
}
/** `budget` — vault balance and burn rate. */
export interface WsBudget {
  type: 'budget';
  balanceWei: bigint;
  balanceUsd: number;
  burnUsdPerHour: number;
  runwayHours: number | null;
  at: number;
}
/** `trade` — a new curve trade. */
export interface WsTrade {
  type: 'trade';
  trade: Trade;
}
/** `pong` — reply to a client ping (R10). */
export interface WsPong {
  type: 'pong';
}
/** `error` — server-side error notice (R10). */
export interface WsError {
  type: 'error';
  message: string;
}

/** Every server → client message the web app understands. */
export type WsMessage =
  | WsHello
  | WsFrame
  | WsThought
  | WsThoughtSaved
  | WsAction
  | WsMemory
  | WsAnchor
  | WsStatus
  | WsBudget
  | WsTrade
  | WsPong
  | WsError;

/**
 * Parses one raw WebSocket payload (string or already-parsed object). Returns `null` for
 * malformed JSON, unknown message types, or messages missing required fields.
 */
export function parseWsMessage(data: unknown, now: number = Date.now()): WsMessage | null {
  let raw: unknown = data;
  if (typeof data === 'string') {
    try {
      raw = JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (!isObject(raw)) return null;
  checkShape(wsServerMessageSchema, raw, `ws message "${String(raw['type'])}"`);
  const at = readTime(raw, 'at') ?? now;
  try {
    switch (raw['type']) {
      case 'hello': {
        const token = readString(raw, 'token');
        const frameObj = isObject(raw['frame']) ? raw['frame'] : null;
        const frameData = frameObj !== null ? readText(frameObj, 'jpegBase64') : readText(raw, 'lastFrame');
        const frameUrl = frameObj !== null ? readText(frameObj, 'url') : readText(raw, 'currentUrl', 'url');
        return {
          type: 'hello',
          token: token !== null && /^0x[0-9a-fA-F]{40}$/.test(token) ? (token.toLowerCase() as Address) : null,
          status: toStatusName(raw['status']),
          phase: toPhaseName(raw['phase']),
          frame: frameData !== null ? { jpegBase64: frameData, url: frameUrl, at: (frameObj !== null ? readTime(frameObj, 'at') : null) ?? at } : null,
          currentUrl: frameUrl ?? readText(raw, 'currentUrl'),
        };
      }
      case 'frame': {
        const jpegBase64 = readText(raw, 'jpegBase64', 'jpeg', 'data');
        if (jpegBase64 === null) return null;
        return { type: 'frame', jpegBase64, url: readText(raw, 'url'), at };
      }
      case 'thought': {
        const text = readString(raw, 'text');
        if (text === null) return null;
        return {
          type: 'thought',
          tickId: readNumber(raw, 'tickId') ?? 0,
          kind: raw['kind'] === 'thinking' ? 'thinking' : 'text',
          text,
          delta: raw['delta'] === true,
          at,
        };
      }
      case 'action': {
        const tool = readText(raw, 'tool', 'name');
        if (tool === null) return null;
        const input = raw['input'];
        return {
          type: 'action',
          tool,
          input: typeof input === 'string' ? input : input === undefined ? '' : JSON.stringify(input).slice(0, 300),
          tickId: readNumber(raw, 'tickId'),
          at,
        };
      }
      case 'thoughtSaved':
      case 'thought_saved':
        return { type: 'thoughtSaved', thought: normalizeThought(raw['thought']) };
      case 'anchor':
        return { type: 'anchor' };
      case 'memory':
        return { type: 'memory', memory: normalizeMemory(raw['memory']) };
      case 'status':
        return { type: 'status', status: toStatusName(raw['status']), phase: toPhaseName(raw['phase']), at };
      case 'budget': {
        const balanceWei = readBigint(raw, 'balanceWei');
        if (balanceWei === null) return null;
        const runway = raw['runwayHours'];
        return {
          type: 'budget',
          balanceWei,
          balanceUsd: readNumber(raw, 'balanceUsd') ?? 0,
          burnUsdPerHour: readNumber(raw, 'burnUsdPerHour') ?? 0,
          runwayHours: typeof runway === 'number' && Number.isFinite(runway) ? runway : null,
          at,
        };
      }
      case 'trade':
        return { type: 'trade', trade: normalizeTrade(raw['trade']) };
      case 'pong':
        return { type: 'pong' };
      case 'error':
        return { type: 'error', message: readString(raw, 'message') ?? 'unknown error' };
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Builds the stream URL for `token` (R10: `?token=0x…`). */
export function mindStreamUrl(base: string, token: Address): string {
  return `${base}${base.includes('?') ? '&' : '?'}token=${token.toLowerCase()}`;
}

/** Connection lifecycle reported by {@link MindSocket}. */
export type SocketState = 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Minimal WebSocket constructor (lets tests inject a fake). */
export type WebSocketFactory = (url: string) => WebSocket;

/** Options for {@link MindSocket}. */
export interface MindSocketOptions {
  url: string;
  onMessage: (message: WsMessage) => void;
  onState?: (state: SocketState, detail?: { code?: number; retryInMs?: number }) => void;
  createSocket?: WebSocketFactory;
  pingIntervalMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

/** Close code the runner uses when a mind already has the maximum number of viewers (R10). */
export const WS_CLOSE_TRY_AGAIN_LATER = 1013;
/** Close code for a malformed / missing token (no retry). */
export const WS_CLOSE_POLICY = 1008;
/** Close code for a token that is not indexed yet (retry every 3 s, at most 10 times). */
export const WS_CLOSE_UNKNOWN_TOKEN = 4404;
/** Max reconnects after {@link WS_CLOSE_UNKNOWN_TOKEN}. */
export const UNKNOWN_TOKEN_MAX_RETRIES = 10;

/**
 * Backoff for reconnect attempt `attempt` (0-based): exponential from `min` to `max`, ±20 %
 * jitter; at least 10 s after a 1013 close.
 */
export function backoffDelay(attempt: number, opts: { min: number; max: number; code?: number | undefined; random?: number }): number {
  if (opts.code === WS_CLOSE_UNKNOWN_TOKEN) return 3_000;
  const base = Math.min(opts.max, opts.min * 2 ** Math.max(0, attempt));
  const jitter = 1 + ((opts.random ?? Math.random()) * 0.4 - 0.2);
  const delay = Math.round(base * jitter);
  return opts.code === WS_CLOSE_TRY_AGAIN_LATER ? Math.max(10_000, delay) : delay;
}

/** Reconnecting WebSocket for one mind's stream. */
export class MindSocket {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private unknownTokenRetries = 0;
  private stopped = true;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly opts: Required<Omit<MindSocketOptions, 'onState'>> & Pick<MindSocketOptions, 'onState'>;

  constructor(options: MindSocketOptions) {
    this.opts = {
      createSocket: (u) => new WebSocket(u),
      pingIntervalMs: 20_000,
      minBackoffMs: 1_000,
      maxBackoffMs: 30_000,
      ...options,
    };
  }

  /** Opens the connection (idempotent). */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    if (typeof window !== 'undefined') window.addEventListener('online', this.handleOnline);
  }

  /** Closes the connection and cancels reconnects. */
  stop(): void {
    this.stopped = true;
    this.clearTimers();
    if (typeof window !== 'undefined') window.removeEventListener('online', this.handleOnline);
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      if (socket.readyState === 0 || socket.readyState === 1) socket.close(1000, 'client closed');
    }
    this.opts.onState?.('closed');
  }

  private readonly handleOnline = (): void => {
    if (this.stopped || this.socket !== null) return;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.connect();
  };

  private clearTimers(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.pingTimer = null;
    this.retryTimer = null;
  }

  private connect(): void {
    this.opts.onState?.(this.attempt === 0 ? 'connecting' : 'reconnecting');
    let socket: WebSocket;
    try {
      socket = this.opts.createSocket(this.opts.url);
    } catch {
      this.scheduleReconnect(undefined);
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.opts.onState?.('open');
      this.pingTimer = setInterval(() => {
        if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'ping' }));
      }, this.opts.pingIntervalMs);
    };
    socket.onmessage = (event: MessageEvent) => {
      const message = parseWsMessage(event.data);
      if (message !== null) this.opts.onMessage(message);
    };
    socket.onerror = () => {
      // onclose follows and handles the reconnect.
    };
    socket.onclose = (event: CloseEvent) => {
      if (this.pingTimer !== null) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.socket = null;
      if (this.stopped) return;
      if (event.code === WS_CLOSE_POLICY) {
        this.opts.onState?.('closed', { code: event.code });
        return;
      }
      if (event.code === WS_CLOSE_UNKNOWN_TOKEN) {
        this.unknownTokenRetries += 1;
        if (this.unknownTokenRetries > UNKNOWN_TOKEN_MAX_RETRIES) {
          this.opts.onState?.('closed', { code: event.code });
          return;
        }
      } else {
        this.unknownTokenRetries = 0;
      }
      this.scheduleReconnect(event.code);
    };
  }

  private scheduleReconnect(code: number | undefined): void {
    const retryInMs = backoffDelay(this.attempt, { min: this.opts.minBackoffMs, max: this.opts.maxBackoffMs, code });
    this.attempt += 1;
    this.opts.onState?.('reconnecting', { ...(code !== undefined ? { code } : {}), retryInMs });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped) this.connect();
    }, retryInMs);
  }
}
