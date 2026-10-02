/**
 * WebSocket stream (`docs/SPEC.md` §6) on `/ws?token=0x…`, attached to the API's HTTP server.
 *
 * One subscription per connection; malformed token → `error` + close 1008; unknown token →
 * `error('unknown token')` + close 4404; more than 100 connections per mind → close 1013. Frames
 * are dropped while `bufferedAmount > 1 MB`; above 4 MB the connection is closed (1013). Protocol
 * pings every 25 s terminate dead peers; client `ping` → `pong`; unparsable or > 1 KB client
 * messages are answered with `error`.
 *
 * @module api/ws
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { WS_PING_INTERVAL_MS, curvePhaseName, mindStatusName, wsClientMessageSchema, type WsServerMessage } from '@www-rh/shared';
import type { Repos } from '../db/repos.js';
import type { Logger } from '../log.js';
import type { StreamBus } from '../stream/bus.js';

/** Frames are dropped above this buffered amount. */
export const WS_DROP_FRAMES_ABOVE = 1_000_000;
/** Connections are closed above this buffered amount. */
export const WS_CLOSE_ABOVE = 4_000_000;
/** Per-mind connection limit. */
export const WS_MAX_PER_MIND = 100;
/** Maximum client message size. */
export const WS_MAX_CLIENT_MESSAGE = 1_024;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

interface Connection {
  ws: WebSocket;
  token: string | null;
  unsubscribe: (() => void) | null;
  alive: boolean;
}

/** The `/ws` hub. */
export class WsHub {
  readonly #wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  readonly #conns = new Set<Connection>();
  readonly #perMind = new Map<string, number>();
  readonly #pinger: NodeJS.Timeout;

  constructor(
    private readonly repos: Repos,
    private readonly bus: StreamBus,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {
    this.#pinger = setInterval(() => this.#pingAll(), WS_PING_INTERVAL_MS);
    this.#pinger.unref();
  }

  /** Handles `upgrade` requests for `/ws` on `server`. */
  attach(server: Server): void {
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws') {
        socket.destroy();
        return;
      }
      this.#wss.handleUpgrade(req, socket, head, (ws) => this.#onConnection(ws, url.searchParams.get('token')));
    });
  }

  /** Open connections (all minds). */
  get size(): number {
    return this.#conns.size;
  }

  #send(conn: Connection, msg: WsServerMessage): void {
    const ws = conn.ws;
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > WS_CLOSE_ABOVE) {
      ws.close(1013, 'client too slow');
      return;
    }
    if (msg.type === 'frame' && ws.bufferedAmount > WS_DROP_FRAMES_ABOVE) return;
    ws.send(JSON.stringify(msg));
  }

  #hello(token: string): WsServerMessage | null {
    const row = this.repos.minds.get(token);
    if (row === undefined) return null;
    return { type: 'hello', token: row.token as `0x${string}`, status: mindStatusName(row.status), phase: curvePhaseName(row.phase), frame: this.bus.lastFrame(token), at: new Date(this.now()).toISOString() };
  }

  #subscribe(conn: Connection, token: string): 'ok' | 'unknown' | 'full' {
    const hello = this.#hello(token);
    if (hello === null) return 'unknown';
    if (conn.token !== token && (this.#perMind.get(token) ?? 0) >= WS_MAX_PER_MIND) return 'full';
    this.#unsubscribe(conn);
    conn.token = token;
    this.#perMind.set(token, (this.#perMind.get(token) ?? 0) + 1);
    conn.unsubscribe = this.bus.subscribe(token, (m) => this.#send(conn, m));
    this.#send(conn, hello);
    return 'ok';
  }

  #unsubscribe(conn: Connection): void {
    conn.unsubscribe?.();
    conn.unsubscribe = null;
    if (conn.token !== null) {
      const n = (this.#perMind.get(conn.token) ?? 1) - 1;
      if (n <= 0) this.#perMind.delete(conn.token);
      else this.#perMind.set(conn.token, n);
    }
    conn.token = null;
  }

  #onConnection(ws: WebSocket, tokenParam: string | null): void {
    const conn: Connection = { ws, token: null, unsubscribe: null, alive: true };
    if (tokenParam === null || !ADDRESS.test(tokenParam)) {
      this.#send(conn, { type: 'error', message: 'missing or malformed token' });
      ws.close(1008, 'bad token');
      return;
    }
    const result = this.#subscribe(conn, tokenParam.toLowerCase());
    if (result === 'unknown') {
      this.#send(conn, { type: 'error', message: 'unknown token' });
      ws.close(4404, 'unknown token');
      return;
    }
    if (result === 'full') {
      ws.close(1013, 'too many connections for this mind');
      return;
    }
    this.#conns.add(conn);
    ws.on('pong', () => {
      conn.alive = true;
    });
    ws.on('message', (data: RawData, isBinary: boolean) => this.#onMessage(conn, data, isBinary));
    ws.on('close', () => {
      this.#unsubscribe(conn);
      this.#conns.delete(conn);
    });
    ws.on('error', (err) => this.log.debug('ws error', { error: err.message }));
  }

  #onMessage(conn: Connection, data: RawData, isBinary: boolean): void {
    const size = Array.isArray(data) ? data.reduce((s, b) => s + b.length, 0) : (data as Buffer | ArrayBuffer).byteLength;
    if (isBinary || size > WS_MAX_CLIENT_MESSAGE) {
      this.#send(conn, { type: 'error', message: 'message too large or binary' });
      return;
    }
    let parsed: ReturnType<typeof wsClientMessageSchema.safeParse>;
    try {
      parsed = wsClientMessageSchema.safeParse(JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8')));
    } catch {
      this.#send(conn, { type: 'error', message: 'invalid JSON' });
      return;
    }
    if (!parsed.success) {
      this.#send(conn, { type: 'error', message: 'unknown message' });
      return;
    }
    if (parsed.data.type === 'ping') {
      this.#send(conn, { type: 'pong' });
      return;
    }
    const result = this.#subscribe(conn, parsed.data.token.toLowerCase());
    if (result === 'unknown') this.#send(conn, { type: 'error', message: 'unknown token' });
    else if (result === 'full') this.#send(conn, { type: 'error', message: 'too many connections for this mind' });
  }

  #pingAll(): void {
    for (const conn of this.#conns) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      try {
        conn.ws.ping();
      } catch {
        conn.ws.terminate();
      }
    }
  }

  /** Closes every connection and the server. */
  async close(): Promise<void> {
    clearInterval(this.#pinger);
    for (const conn of this.#conns) conn.ws.close(1001, 'server shutting down');
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
  }
}
