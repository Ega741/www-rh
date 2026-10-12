/**
 * Gateway entry point: config → database migration → services → mint check → chain workers and
 * housekeeping loops → HTTP server. Stops cleanly on SIGINT / SIGTERM.
 *
 * @module main
 */
import { serve } from '@hono/node-server';
import { createApp } from './api/server.js';
import { verifyMint } from './chain/rpc.js';
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

/** Refreshes the operator's SOL balance for `/api/status` (housekeeping). */
export async function refreshOperatorBalance(services: Services): Promise<void> {
  const chain = services.chain;
  if (chain === undefined || chain.operator === undefined) return;
  services.runtime.operatorSolBalance = await chain.reader.getBalance(chain.operator);
}

/** Starts every background loop (SPEC §5.4); returns a stopper. */
export function startWorkers(services: Services): () => void {
  const stops: (() => void)[] = [];
  const { config } = services;
  if (services.indexer !== undefined) {
    stops.push(startLoop('indexer', config.cluster.pollIntervalMs, () => services.indexer!.step(), services));
    stops.push(startLoop('finality sweep', 60_000, () => services.indexer!.sweepFinality(), services));
  }
  if (services.budgets !== undefined) {
    stops.push(startLoop('budget scanner', config.budgets.scanIntervalMs, () => services.budgets!.scan(), services));
    stops.push(startLoop('headroom refresh', config.budgets.headroomRefreshMs, () => services.budgets!.refresh(), services));
  }
  if (services.drawer !== undefined && services.chain?.writer !== undefined && !config.operator.dryRun) {
    stops.push(startLoop('budget drawer', config.budgets.drawIntervalMs, () => services.drawer!.tick(), services));
  } else if (services.drawer !== undefined) {
    services.logger.info('budget drawer disabled', { dryRun: config.operator.dryRun, operatorKey: services.chain?.writer !== undefined });
  }
  stops.push(startLoop('price refresh', config.price.refreshMs, () => services.price.refresh(), services));
  stops.push(
    startLoop(
      'housekeeping',
      60_000,
      async () => {
        services.ledger.purgeExpiredReservations();
        services.sessions.purgeExpired();
        services.siws.purgeExpired();
        await services.warm.ensureWarm();
        await refreshOperatorBalance(services);
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
  if (services.chain !== undefined) await verifyMint(services.chain, logger);
  const app = createApp(services);
  const stopWorkers = startWorkers(services);
  const server = serve({ fetch: app.fetch, port: config.server.port, hostname: config.server.host }, (info) => {
    logger.info('gateway listening', {
      host: info.address,
      port: info.port,
      cluster: config.cluster.name,
      rpcUrl: services.chainInfo.rpcUrl,
      mint: services.chainInfo.mint ?? null,
      operator: services.chainInfo.operator ?? null,
      chain: services.chain !== undefined,
      dryRun: config.operator.dryRun,
      priceSource: config.price.source,
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
