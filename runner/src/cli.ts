#!/usr/bin/env node
/**
 * Runner CLI: `start | index [--follow] | tick --token <0x…> | graduate --token <0x…> |
 * harvest --token <0x…> | --help`. Every command reads the same environment as `main.ts`;
 * `graduate` / `harvest` follow `VENUE` (Pons: `createGraduatedPool` / registry `harvest`).
 *
 * @module cli
 */
import { parseArgs } from 'node:util';
import type { Address } from 'viem';
import { curvePhaseName, modelById, ponsPhaseName } from '@www-rh/shared';
import { createRunnerApp } from './app.js';
import { ConfigError, ENV_VARS, loadConfig } from './config.js';
import { microToUsd } from './economics/budget.js';
import { createLogger, errorMessage } from './log.js';
import { verifiedPersona } from './mind/scheduler.js';
import { runTick } from './mind/tick.js';

/** Usage text. */
export const USAGE = `www-rh runner — every coin has a mind

Usage:
  www-rh-runner start                      run indexer + API/WS + scheduler (same as dist/main.js)
  www-rh-runner index [--follow]           index launchpad (curve) / registry + Pons (pons) logs up to the head (--follow keeps following)
  www-rh-runner tick --token <address>     run one tick of one mind now (needs ANTHROPIC_API_KEY)
  www-rh-runner graduate --token <address> curve: queue graduate(token) if the curve is Complete
                                           pons: queue createGraduatedPool(token) if the launch is Swept (DRY_RUN-aware)
  www-rh-runner harvest --token <address>  curve: queue harvest(token) if the coin is Graduated
                                           pons: queue registry harvest(token) (sweep + claim into the vault; DRY_RUN-aware)
  www-rh-runner --help                     show this help

Environment (see the repository .env.example and runner/README.md):
  ${ENV_VARS.join(', ')}
`;

const log = createLogger('cli');

function requireToken(token: string | undefined): Address {
  if (token === undefined || !/^0x[0-9a-fA-F]{40}$/.test(token)) {
    process.stderr.write('error: --token <0x address> is required\n');
    process.exit(2);
  }
  return token.toLowerCase() as Address;
}

async function syncToHead(app: Awaited<ReturnType<typeof createRunnerApp>>): Promise<void> {
  for (;;) {
    const r = await app.indexer.syncOnce();
    if (r.caughtUp) {
      log.info('indexed', { head: r.head, lastIndexedBlock: app.repos.state.lastBlock() });
      return;
    }
  }
}

/** Runs the CLI with `argv` (without node + script). */
export async function cli(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { token: { type: 'string' }, follow: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  const command = positionals[0];
  if (values.help === true || command === undefined || command === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    throw err;
  }

  switch (command) {
    case 'start': {
      await import('./main.js');
      return -1; // main.ts keeps the process alive
    }
    case 'index': {
      const app = await createRunnerApp(config, { api: false });
      if (values.follow === true) {
        app.indexer.start();
        await new Promise<void>((resolve) => process.once('SIGINT', () => resolve()));
        await app.stop();
        return 0;
      }
      await syncToHead(app);
      await app.stop();
      return 0;
    }
    case 'tick': {
      const token = requireToken(values.token);
      const app = await createRunnerApp(config, { api: false });
      try {
        await syncToHead(app);
        const mind = app.repos.minds.get(token);
        if (mind === undefined) throw new Error(`unknown mind ${token} (not indexed)`);
        const spec = modelById(mind.model_id);
        if (spec === undefined) throw new Error(`mind ${token} uses a model outside the catalog`);
        const econ = await app.economics.snapshot(token);
        const result = await runTick(app.tickDeps(), {
          identity: { token, name: mind.name, symbol: mind.symbol, modelId: mind.model_id, personaHash: mind.persona_hash, verifiedPersona: verifiedPersona(mind) },
          spec,
          vaultUsd: microToUsd(econ.budget.vaultUsdMicro),
          runwayHours: econ.runwayHours,
          currentUrl: mind.current_url,
        });
        process.stdout.write(`${JSON.stringify({ tickId: result.tickId, status: result.status, stopReason: result.stopReason, error: result.error, costUsd: microToUsd(result.totals.costUsdMicro) })}\n`);
        return result.failed ? 1 : 0;
      } finally {
        await app.stop();
      }
    }
    case 'graduate':
    case 'harvest': {
      const token = requireToken(values.token);
      const app = await createRunnerApp(config, { api: false });
      try {
        if (config.venue === 'pons') {
          if (app.ponsReader === null) throw new Error('no registry address configured (REGISTRY_ADDRESS)');
          if (command === 'graduate') {
            const phase = (await app.ponsReader.launchedToken(token)).phase;
            if (phase !== 1) {
              process.stdout.write(`skipped: Pons launch phase is ${ponsPhaseName(phase)} (${phase})\n`);
              return 0;
            }
          }
          const write = command === 'graduate' ? ({ functionName: 'createGraduatedPool', args: [token] } as const) : ({ functionName: 'harvest', args: [token] } as const);
          const outcome = await app.queue.enqueue(write, `${write.functionName} ${token}`);
          process.stdout.write(`${JSON.stringify(outcome)}\n`);
          return outcome.kind === 'confirmed' || outcome.kind === 'dry_run' ? 0 : 1;
        }
        if (app.reader === null) throw new Error('no launchpad address configured');
        const curve = await app.reader.getCurve(token);
        const wanted = command === 'graduate' ? 1 : 2;
        if (curve.phase !== wanted) {
          process.stdout.write(`skipped: phase is ${curvePhaseName(curve.phase)}\n`);
          return 0;
        }
        const outcome = await app.queue.enqueue({ functionName: command, args: [token] }, `${command} ${token}`);
        process.stdout.write(`${JSON.stringify(outcome)}\n`);
        return outcome.kind === 'confirmed' || outcome.kind === 'dry_run' ? 0 : 1;
      } finally {
        await app.stop();
      }
    }
    default:
      process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
      return 2;
  }
}

cli(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (err: unknown) => {
    log.error('failed', { error: errorMessage(err) });
    process.exit(1);
  },
);
