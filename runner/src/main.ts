#!/usr/bin/env node
/**
 * Runner entry point (`pnpm --filter @www-rh/runner start`): parses the environment, starts the
 * indexer, the API/WS server and (once live, with an Anthropic key) the scheduler. SIGINT/SIGTERM,
 * unhandled promise rejections and uncaught exceptions shut down gracefully (bounded stages, DB
 * closed last); a stuck shutdown is forced after {@link SHUTDOWN_FORCE_MS}.
 *
 * @module main
 */
import { createRunnerApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger, errorMessage } from './log.js';

const log = createLogger('main');

/** Forced exit when the graceful shutdown does not finish (its stages are bounded well below this). */
export const SHUTDOWN_FORCE_MS = 70_000;

/** Starts the runner and installs signal handlers. */
export async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
  const app = await createRunnerApp(config);
  let stopping = false;
  const shutdown = (reason: string, exitCode: number): void => {
    if (stopping) return;
    stopping = true;
    log.info('shutdown requested', { reason });
    const force = setTimeout(() => {
      log.error('graceful shutdown did not finish in time; exiting', { ms: SHUTDOWN_FORCE_MS });
      process.exit(1);
    }, SHUTDOWN_FORCE_MS);
    force.unref();
    app.stop().then(
      () => process.exit(exitCode),
      (err: unknown) => {
        log.error('shutdown failed', { error: errorMessage(err) });
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', () => shutdown('SIGINT', 0));
  process.once('SIGTERM', () => shutdown('SIGTERM', 0));
  process.on('unhandledRejection', (reason: unknown) => {
    log.error('unhandled promise rejection', { error: errorMessage(reason), stack: reason instanceof Error ? reason.stack : undefined, stopping });
    shutdown('unhandledRejection', 1);
  });
  process.on('uncaughtException', (err: Error) => {
    log.error('uncaught exception', { error: errorMessage(err), stack: err.stack, stopping });
    shutdown('uncaughtException', 1);
  });
  await app.start();
}

main().catch((err: unknown) => {
  log.error('fatal', { error: errorMessage(err) });
  process.exit(1);
});
