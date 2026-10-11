/**
 * Gateway entry point: config → database migration → services → chain workers and housekeeping
 * loops → HTTP server. Stops cleanly on SIGINT / SIGTERM.
 *
 * @module main
 */
import { serve } from '@hono/node-server';
import { createApp } from './api/server.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger } from './log.js';
import { createServices, type Services } from './services.js';

/** A periodic job that never overlaps itself and never throws. */
export function startLoop(name: string, intervalMs: number, job: () => Promise<unknown>, services: Services): () => void {
  let running = false;
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    try {
      await job();
    } catch (e) {
      services.logger.warn(`${name} failed`, { error: e });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/** Starts every background loop; returns a stopper. */
export function startWorkers(services: Services): () => void {
  const stops: (() => void)[] = [];
  const { config } = services;
  if (services.indexer !== undefined) stops.push(startLoop('indexer', config.chain.pollIntervalMs, () => services.indexer!.step(), services));
  if (services.headroom !== undefined) stops.push(startLoop('headroom refresher', config.budgets.headroomRefreshMs, () => services.headroom!.refreshAll(), services));
  if (services.drawer !== undefined && services.chain?.writer !== undefined && !config.operator.dryRun) {
    stops.push(startLoop('budget drawer', config.budgets.drawIntervalMs, () => services.drawer!.tick(), services));
  } else if (services.drawer !== undefined) services.logger.info('budget drawer disabled', { dryRun: config.operator.dryRun, operator: services.chain?.writer !== undefined });
  if (services.poster !== undefined) stops.push(startLoop('price poster', config.poster.intervalMs, () => services.poster!.tick(), services));
  stops.push(
    startLoop(
      'housekeeping',
      60_000,
      async () => {
        services.ledger.purgeExpiredReservations();
        services.sessions.purgeExpired();
        services.siwe.purgeExpired();
        await services.warm.ensureWarm();
      },
      services,
    ),
  );
  return () => {
    for (const stop of stops) stop();
  };
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }
  const logger = createLogger({ level: config.server.logLevel });
  const services = createServices(config, { logger });
  const app = createApp(services);
  const stopWorkers = startWorkers(services);
  const server = serve({ fetch: app.fetch, port: config.server.port, hostname: config.server.host }, (info) => {
    logger.info('gateway listening', {
      host: info.address,
      port: info.port,
      chainId: config.chain.chainId,
      creditDesk: services.chain?.creditDesk ?? null,
      operator: services.chain?.writer?.address ?? null,
      dryRun: config.operator.dryRun,
      providers: { anthropic: services.registry.platformConfigured('anthropic'), openai: services.registry.platformConfigured('openai'), google: services.registry.platformConfigured('google'), house: services.registry.platformConfigured('house') },
    });
  });
  const shutdown = (signal: string): void => {
    logger.info('shutting down', { signal });
    stopWorkers();
    server.close(() => {
      services.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main().catch((e: unknown) => {
  process.stderr.write(`fatal: ${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
  process.exit(1);
});
