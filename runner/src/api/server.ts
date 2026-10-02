/**
 * HTTP server bootstrap: the Hono app on `@hono/node-server` plus the `/ws` hub on the same port.
 *
 * @module api/server
 */
import type { Server } from 'node:http';
import { createAdaptorServer } from '@hono/node-server';
import type { Hono } from 'hono';
import type { WsHub } from './ws.js';

/** A running API server. */
export interface RunningServer {
  server: Server;
  port: number;
  /** Closes the WS hub first (WebSocket connections would keep `server.close()` pending), then the HTTP server; each step bounded by `timeoutMs`. */
  close(timeoutMs?: number): Promise<void>;
}

/** Starts `app` (and `hub` upgrades) on `port` (0 = ephemeral). */
export async function startServer(app: Hono, hub: WsHub | null, port: number, hostname?: string): Promise<RunningServer> {
  const server = createAdaptorServer({ fetch: app.fetch }) as Server;
  hub?.attach(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const actual = typeof address === 'object' && address !== null ? address.port : port;
  return {
    server,
    port: actual,
    async close(timeoutMs = 5_000) {
      // upgraded (WebSocket) sockets are not HTTP connections: server.close() would wait for them forever
      await withTimeout(hub?.close() ?? Promise.resolve(), timeoutMs);
      await withTimeout(
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections?.();
          server.closeAllConnections?.();
        }),
        timeoutMs,
      );
    },
  };
}

/** Resolves when `p` settles or after `ms`, whichever comes first (never rejects). */
export async function withTimeout(p: Promise<unknown>, ms: number): Promise<'done' | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    p.then(
      () => 'done' as const,
      () => 'done' as const,
    ),
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
  return result;
}
