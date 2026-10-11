#!/usr/bin/env node
/**
 * Operator CLI (SPEC §5.12): `migrate`, `create-key --workspace 0x… [--name]`,
 * `credit --workspace 0x… --usd 10 [--memo] [--force]`, `post-price --usd 0.01`, `status`.
 * Reads the same env as the gateway and opens `DB_PATH` (WAL allows a running gateway).
 *
 * @module cli
 */
import { parseUsdToMicro } from '@beagle/shared/credit';
import { statusDto } from './api/dto.js';
import { usdStringToPriceE18 } from './chain/poster.js';
import { ConfigError, loadConfig, type Config } from './config.js';
import { Db } from './db/sqlite.js';
import { migrate } from './db/schema.js';
import { createLogger } from './log.js';
import { createServices, type Services } from './services.js';

/** Parsed command line: positional command plus `--flag value` / `--flag` options. */
export interface Cli {
  command: string | undefined;
  flags: Record<string, string | true>;
}

/** Parses `argv` (without node and script). */
export function parseArgs(argv: readonly string[]): Cli {
  const flags: Record<string, string | true> = {};
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[a.slice(2)] = next;
          i++;
        } else flags[a.slice(2)] = true;
      }
    } else if (command === undefined) command = a;
  }
  return { command, flags };
}

const USAGE = `beagle-gateway <command> [options]

  migrate                                   apply database migrations
  create-key --workspace 0x… [--name NAME]  create an API key (prints the key on stdout)
  credit --workspace 0x… --usd 10 [--memo M] [--force]
                                            admin ledger adjustment (refused in production without --force)
  post-price --usd 0.01 [--force]           post a price to the ManualPriceSource with the operator key
  status                                    print the gateway status as JSON
`;

function flagString(flags: Cli['flags'], name: string): string | undefined {
  const v = flags[name];
  return typeof v === 'string' ? v : undefined;
}

function requireFlag(flags: Cli['flags'], name: string): string {
  const v = flagString(flags, name);
  if (v === undefined) throw new Error(`--${name} is required`);
  return v;
}

/** Runs the CLI; returns the exit code. `out`/`err` receive stdout/stderr lines. */
export async function runCli(argv: readonly string[], env: Record<string, string | undefined>, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const { command, flags } = parseArgs(argv);
  if (command === undefined || command === 'help' || flags['help'] === true) {
    out(USAGE);
    return command === undefined ? 1 : 0;
  }
  let config;
  try {
    config = loadConfig(env);
  } catch (e) {
    if (e instanceof ConfigError) {
      err(e.message);
      return 2;
    }
    throw e;
  }
  const logger = createLogger({ level: 'error', write: (line) => err(line) });

  if (command === 'migrate') {
    const db = new Db(config.server.dbPath);
    try {
      const r = migrate(db);
      out(`migrated ${config.server.dbPath}: schema ${r.from} → ${r.to}`);
    } finally {
      db.close();
    }
    return 0;
  }

  const services = createServices(config, { logger, ...(command === 'create-key' || command === 'credit' ? { chain: null } : {}) });
  try {
    return await runCommand(command, flags, config, services, out, err);
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 1;
  } finally {
    services.close();
  }
}

async function runCommand(command: string, flags: Cli['flags'], config: Config, services: Services, out: (s: string) => void, err: (s: string) => void): Promise<number> {
  {
    switch (command) {
      case 'create-key': {
        const workspace = requireFlag(flags, 'workspace');
        if (!/^0x[0-9a-fA-F]{40}$/.test(workspace)) throw new Error('--workspace must be a 0x address');
        const created = services.apiKeys.create(workspace, flagString(flags, 'name') ?? 'cli');
        err(JSON.stringify({ id: created.id, prefix: created.prefix, name: created.name, workspace: workspace.toLowerCase(), createdAt: created.createdAt }));
        out(created.key);
        return 0;
      }
      case 'credit': {
        const workspace = requireFlag(flags, 'workspace');
        if (!/^0x[0-9a-fA-F]{40}$/.test(workspace)) throw new Error('--workspace must be a 0x address');
        if (config.isProduction && flags['force'] !== true) throw new Error('refusing to adjust the ledger in production without --force');
        const micro = parseUsdToMicro(requireFlag(flags, 'usd'));
        const id = services.ledger.adjust(workspace, micro, flagString(flags, 'memo') ?? 'cli credit');
        out(JSON.stringify({ ok: true, ledgerId: id, workspace: workspace.toLowerCase(), amountMicro: micro.toString(), balanceMicro: services.ledger.balance(workspace).toString() }));
        return 0;
      }
      case 'post-price': {
        const priceE18 = usdStringToPriceE18(requireFlag(flags, 'usd'));
        const writer = services.chain?.writer;
        if (writer === undefined) throw new Error('post-price needs RPC_URL and OPERATOR_PRIVATE_KEY');
        if (config.operator.dryRun && flags['force'] !== true) {
          out(JSON.stringify({ dryRun: true, priceE18: priceE18.toString() }));
          return 0;
        }
        const txHash = await writer.postPrice(priceE18);
        services.repos.pricePosts.insert({ priceE18, source: 'cli', txHash, status: 'sent', createdAt: services.now() });
        out(JSON.stringify({ ok: true, priceE18: priceE18.toString(), txHash }));
        return 0;
      }
      case 'status': {
        if (services.indexer !== undefined) {
          try {
            await services.indexer.step();
          } catch (e) {
            err(`indexer step failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        out(JSON.stringify(statusDto(services), null, 2));
        return 0;
      }
      default:
        err(`unknown command ${JSON.stringify(command)}\n${USAGE}`);
        return 1;
    }
  }
}

const isMain = process.argv[1] !== undefined && /cli\.(js|ts|mjs)$/.test(process.argv[1]);
if (isMain) {
  runCli(
    process.argv.slice(2),
    process.env,
    (s) => process.stdout.write(`${s}\n`),
    (s) => process.stderr.write(`${s}\n`),
  )
    .then((code) => process.exit(code))
    .catch((e: unknown) => {
      process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
      process.exit(1);
    });
}
