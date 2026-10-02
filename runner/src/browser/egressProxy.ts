/**
 * Local HTTP forward proxy enforcing the egress filter on every connection Chromium opens.
 *
 * Defense in depth for SPEC §4.1: Playwright route handlers are not re-invoked for redirect hops
 * the browser follows by itself, and a hostname may resolve differently between the check and the
 * connection (DNS rebinding). Chromium is launched with this proxy (and `<-loopback>` removed from
 * the bypass list), so every hop — redirects, subresources, `CONNECT` tunnels for https/wss —
 * is re-checked here and connected to the exact address that passed the check.
 *
 * @module browser/egressProxy
 */
import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import type { Logger } from '../log.js';
import type { EgressFilter } from './egress.js';

const HOP_BY_HOP = new Set(['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade']);

/** The egress proxy server. */
export class EgressProxy {
  #server: http.Server | null = null;
  readonly #sockets = new Set<Duplex>();

  constructor(
    private readonly filter: EgressFilter,
    private readonly log: Logger,
  ) {}

  /** `http://127.0.0.1:<port>` once started. */
  get url(): string | null {
    const addr = this.#server?.address();
    return addr !== null && typeof addr === 'object' ? `http://127.0.0.1:${addr.port}` : null;
  }

  /** Starts listening on an ephemeral loopback port. */
  async start(): Promise<string> {
    const server = http.createServer((req, res) => void this.#onRequest(req, res));
    server.on('connect', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void this.#onConnect(req, socket, head));
    server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => void this.#onUpgrade(req, socket, head));
    server.on('connection', (socket: net.Socket) => {
      this.#sockets.add(socket);
      socket.on('close', () => this.#sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    this.#server = server;
    return this.url as string;
  }

  async #resolve(hostname: string): Promise<string | null> {
    const verdict = await this.filter.checkHost(hostname);
    if (!verdict.ok) {
      this.log.info('egress blocked', { host: hostname, reason: verdict.reason });
      return null;
    }
    return verdict.addresses[0] ?? null;
  }

  async #onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('absolute URL required');
      return;
    }
    if (target.protocol !== 'http:') {
      res.writeHead(403).end('blocked');
      return;
    }
    const address = await this.#resolve(target.hostname);
    if (address === null) {
      res.writeHead(403).end('blocked by egress filter');
      return;
    }
    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k) && v !== undefined) headers[k] = v;
    const upstream = http.request(
      { host: address, port: Number(target.port || 80), path: `${target.pathname}${target.search}`, method: req.method, headers, setHost: false },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  }

  async #tunnel(hostPort: string): Promise<net.Socket | null> {
    const m = /^\[?([^\]]+?)\]?:(\d{1,5})$/.exec(hostPort);
    if (m === null) return null;
    const address = await this.#resolve(m[1] as string);
    if (address === null) return null;
    const socket = net.connect(Number(m[2]), address);
    this.#sockets.add(socket);
    socket.on('close', () => this.#sockets.delete(socket));
    return socket;
  }

  async #onConnect(req: http.IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    const upstream = await this.#tunnel(req.url ?? '');
    if (upstream === null) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  }

  async #onUpgrade(req: http.IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      client.destroy();
      return;
    }
    const upstream = await this.#tunnel(`${target.hostname}:${target.port || 80}`);
    if (upstream === null) {
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    upstream.once('connect', () => {
      const lines = [`${req.method ?? 'GET'} ${target.pathname}${target.search} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const k = req.rawHeaders[i] as string;
        if (!k.toLowerCase().startsWith('proxy-')) lines.push(`${k}: ${req.rawHeaders[i + 1] as string}`);
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  }

  /** Stops the server and destroys open tunnels. */
  async close(): Promise<void> {
    for (const s of this.#sockets) s.destroy();
    const server = this.#server;
    this.#server = null;
    if (server !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
