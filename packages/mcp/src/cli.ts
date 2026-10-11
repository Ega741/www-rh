/**
 * Implementation of the `beagle-mcp` stdio binary (SPEC §6.1); `bin.ts` is the shebang entry.
 *
 * Environment:
 * - `BEAGLE_API_URL`  gateway origin (default `http://localhost:8787`)
 * - `BEAGLE_API_KEY`  `bgl_…` API key (required; exit code 2 without it)
 * - `BEAGLE_AGENT_PRIVATE_KEY`  optional 0x private key; with it the wallet tools sign and send
 * - `BEAGLE_RPC_URL`  optional JSON-RPC URL for the agent wallet (default: the chain's public RPC)
 * - `BEAGLE_WORKSPACE`  optional default workspace address for the wallet tools
 *
 * stdout carries the MCP protocol, so every log line goes to stderr.
 *
 * @module cli
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Address, Hex, Transport } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createRestBeagleApi, type BeagleApi } from './api.js';
import { createBeagleMcpServer, type BeagleMcpServerOptions } from './server.js';
import { createLazyWalletExecutor, createViemWalletExecutor, WalletError, type WalletExecutor } from './wallet.js';

/** Default gateway URL of the stdio binary. */
export const DEFAULT_API_URL = 'http://localhost:8787';

/** Parsed environment of {@link main}. */
export interface BinConfig {
  apiUrl: string;
  apiKey: string;
  privateKey?: Hex;
  rpcUrl?: string;
  workspace?: Address;
}

/** Thrown by {@link readBinConfig} for a missing or malformed variable; `exitCode` is 2. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  readonly exitCode = 2;
}

/** Reads and validates the environment (pure; no process access). */
export function readBinConfig(env: Record<string, string | undefined>): BinConfig {
  const apiKey = env['BEAGLE_API_KEY']?.trim() ?? '';
  if (apiKey === '') {
    throw new ConfigError(
      'BEAGLE_API_KEY is required: create a key on the dashboard (Keys page) or with `beagle-gateway create-key`, then set BEAGLE_API_KEY=bgl_…',
    );
  }
  const apiUrl = (env['BEAGLE_API_URL']?.trim() ?? '') || DEFAULT_API_URL;
  if (!/^https?:\/\//.test(apiUrl)) throw new ConfigError(`BEAGLE_API_URL must start with http:// or https:// (got ${JSON.stringify(apiUrl)})`);
  const config: BinConfig = { apiUrl, apiKey };
  const pk = env['BEAGLE_AGENT_PRIVATE_KEY']?.trim();
  if (pk !== undefined && pk !== '') {
    if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new ConfigError('BEAGLE_AGENT_PRIVATE_KEY must be a 0x-prefixed 32-byte hex private key');
    config.privateKey = pk as Hex;
  }
  const rpc = env['BEAGLE_RPC_URL']?.trim();
  if (rpc !== undefined && rpc !== '') config.rpcUrl = rpc;
  const ws = env['BEAGLE_WORKSPACE']?.trim();
  if (ws !== undefined && ws !== '') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(ws)) throw new ConfigError('BEAGLE_WORKSPACE must be a 0x address');
    config.workspace = ws as Address;
  }
  return config;
}

function log(message: string): void {
  process.stderr.write(`[beagle-mcp] ${message}\n`);
}

/** Options of {@link createAgentWallet}. */
export interface AgentWalletOptions {
  /** Receives one line when the wallet is ready (stderr in the binary). */
  log?: (message: string) => void;
  /** Custom viem transport (tests); overrides `BEAGLE_RPC_URL`. */
  transport?: Transport;
}

/**
 * The agent wallet of the stdio binary, or `undefined` without `BEAGLE_AGENT_PRIVATE_KEY`.
 *
 * Its address is derived from the key immediately (no network), so the wallet tools can default
 * `workspace` and describe themselves as signing from the start; the chain id and the desk / token
 * addresses are read from `GET /api/config` on the **first wallet-tool call** and retried on each
 * call until that succeeds. A gateway that is down, slow or mid-deploy when the MCP client spawns
 * the binary therefore neither delays the MCP handshake nor downgrades the session to unsigned
 * steps: the affected call fails with `wallet_unavailable` and the next one tries again.
 */
export function createAgentWallet(api: BeagleApi, config: BinConfig, options: AgentWalletOptions = {}): WalletExecutor | undefined {
  const privateKey = config.privateKey;
  if (privateKey === undefined) return undefined;
  const address = privateKeyToAccount(privateKey).address;
  const emit = options.log ?? (() => undefined);
  return createLazyWalletExecutor({
    address,
    build: async () => {
      const gateway = await api.config();
      if (gateway.creditDesk === null || gateway.token === null) {
        throw new WalletError('not_configured', 'the gateway reports no CreditDesk deployment for its chain');
      }
      const wallet = createViemWalletExecutor({
        privateKey,
        chainId: gateway.chainId,
        deployment: { creditDesk: gateway.creditDesk as Address, token: gateway.token.address as Address },
        ...(config.rpcUrl === undefined ? {} : { rpcUrl: config.rpcUrl }),
        ...(options.transport === undefined ? {} : { transport: options.transport }),
      });
      emit(`agent wallet ${address} ready on chain ${gateway.chainId} (desk ${gateway.creditDesk})`);
      return wallet;
    },
  });
}

/**
 * Entry point: builds the REST api and the (lazy) agent wallet, connects stdio first and serves MCP
 * until stdin closes. Nothing here waits on the gateway.
 */
export async function main(env: Record<string, string | undefined> = process.env): Promise<void> {
  let config: BinConfig;
  try {
    config = readBinConfig(env);
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof ConfigError ? error.exitCode : 1;
    return;
  }

  const api = createRestBeagleApi({ baseUrl: config.apiUrl, apiKey: config.apiKey });
  const wallet = createAgentWallet(api, config, { log });

  const opts: BeagleMcpServerOptions = {
    apiUrl: config.apiUrl,
    ...(wallet === undefined ? {} : { wallet }),
    ...(config.workspace === undefined ? {} : { workspace: config.workspace }),
  };
  const server = createBeagleMcpServer(api, opts);
  const transport = new StdioServerTransport();

  const shutdown = (signal: string): void => {
    log(`${signal}: shutting down`);
    void server.close().finally(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));

  await server.connect(transport);
  log(
    `serving ${config.apiUrl} over stdio${
      wallet === undefined
        ? ' (no agent wallet: wallet tools return unsigned steps)'
        : ` (agent wallet ${wallet.address ?? '?'}; chain and CreditDesk are read from the gateway on the first wallet call)`
    }`,
  );
}
