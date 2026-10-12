#!/usr/bin/env node
/**
 * Operator CLI (SPEC §5.12): `migrate`, `create-key --workspace <base58> [--name]`,
 * `credit --workspace <base58> --usd 10 [--memo] [--force]`, `set-price --usd 0.01`,
 * `register-budget --token-account <base58> [--workspace <base58>]`, `status`.
 * Reads the same env as the gateway and opens `DB_PATH` (WAL allows a running gateway).
 *
 * @module cli
 */
import { parseUsdToMicro } from '@beagle/shared/credit';
import { isBase58Pubkey } from '@beagle/shared/solana';
import { budgetDto, statusDto } from './api/dto.js';
import { BudgetRegisterError } from './chain/budgets.js';
import { ConfigError, loadConfig, parsePriceUsdE18, type Config } from './config.js';
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

  migrate                                        apply database migrations
  create-key --workspace <base58> [--name NAME]  create an API key (prints the key on stdout)
  credit --workspace <base58> --usd 10 [--memo M] [--force]
                                                 admin ledger adjustment (refused in production without --force)
  set-price --usd 0.01                           publish a manual price point
  register-budget --token-account <base58> [--workspace <base58>]
                                                 register a delegated token account as a budget
  status                                         print the gateway status as JSON (indexer cursor, head slot, price, operator SOL)
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

function requirePubkey(flags: Cli['flags'], name: string): string {
  const v = requireFlag(flags, name).trim();
  if (!isBase58Pubkey(v)) throw new Error(`--${name} must be a base58 Solana public key`);
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

  const offline = command === 'create-key' || command === 'credit' || command === 'set-price';
  const services = createServices(config, { logger, ...(offline ? { chain: null } : {}) });
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
  switch (command) {
    case 'create-key': {
      const workspace = requirePubkey(flags, 'workspace');
      const created = services.apiKeys.create(workspace, flagString(flags, 'name') ?? 'cli');
      err(JSON.stringify({ id: created.id, prefix: created.prefix, name: created.name, workspace, createdAt: created.createdAt }));
      out(created.key);
      return 0;
    }
    case 'credit': {
      const workspace = requirePubkey(flags, 'workspace');
      if (config.isProduction && flags['force'] !== true) throw new Error('refusing to adjust the ledger in production without --force');
      const micro = parseUsdToMicro(requireFlag(flags, 'usd'));
      const id = services.ledger.adjust(workspace, micro, flagString(flags, 'memo') ?? 'cli credit');
      out(JSON.stringify({ ok: true, ledgerId: id, workspace, amountMicro: micro.toString(), balanceMicro: services.ledger.balance(workspace).toString() }));
      return 0;
    }
    case 'set-price': {
      const priceE18 = parsePriceUsdE18(requireFlag(flags, 'usd'));
      const point = services.price.set(priceE18, 'manual');
      out(JSON.stringify({ ok: true, price: services.price.toDto(point) }));
      return 0;
    }
    case 'register-budget': {
      const tokenAccount = requirePubkey(flags, 'token-account');
      const workspace = flagString(flags, 'workspace');
      if (workspace !== undefined && !isBase58Pubkey(workspace)) throw new Error('--workspace must be a base58 Solana public key');
      if (services.budgets === undefined) throw new Error('register-budget needs chain access (a known mint for CLUSTER or MINT_ADDRESS)');
      try {
        const row = await services.budgets.register(tokenAccount, workspace);
        out(JSON.stringify(budgetDto(services, row)));
        return 0;
      } catch (e) {
        if (e instanceof BudgetRegisterError) throw new Error(`${e.code}: ${e.message}`);
        throw e;
      }
    }
    case 'status': {
      const chain = services.chain;
      let headSlot: number | null = null;
      let operatorSol: string | null = null;
      if (chain !== undefined) {
        try {
          headSlot = await chain.reader.getSlot();
          if (chain.operator !== undefined) {
            const lamports = await chain.reader.getBalance(chain.operator);
            services.runtime.operatorSolBalance = lamports;
            operatorSol = (Number(lamports) / 1e9).toFixed(9);
          }
        } catch (e) {
          err(`rpc unavailable: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      const status = statusDto(services);
      if (headSlot !== null) status.indexer = { ...status.indexer, headSlot, lagSlots: status.indexer.lastSlot === null ? 0 : Math.max(0, headSlot - status.indexer.lastSlot) };
      out(JSON.stringify({ ...status, operatorSol }, null, 2));
      return 0;
    }
    default:
      err(`unknown command ${JSON.stringify(command)}\n${USAGE}`);
      return 1;
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
