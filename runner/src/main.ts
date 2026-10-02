#!/usr/bin/env node
/**
 * Runner entry point (`pnpm --filter @www-rh/runner start`): parses the environment, starts the
 * indexer, the API/WS server and (once live, with an Anthropic key) the scheduler; SIGINT/SIGTERM
 * shut down gracefully.
 *
 * @module main
 */
import { createRunnerApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { createLogger, errorMessage } from './log.js';

const log = createLogger('main');

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
  await app.start();
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info('shutdown requested', { signal });
    const force = setTimeout(() => process.exit(1), 45_000);
    force.unref();
    app.stop().then(
      () => process.exit(0),
      (err: unknown) => {
        log.error('shutdown failed', { error: errorMessage(err) });
        process.exit(1);
      },
    );
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  log.error('fatal', { error: errorMessage(err) });
  process.exit(1);
});
