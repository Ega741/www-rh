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
  close(): Promise<void>;
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
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
