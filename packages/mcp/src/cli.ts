/**
 * Implementation of the `beagle-mcp` stdio binary (SPEC §6.1); `bin.ts` is the shebang entry.
 *
 * Environment:
 * - `BEAGLE_API_URL`  gateway origin (default `http://localhost:8787`)
 * - `BEAGLE_API_KEY`  `bgl_…` API key (required; exit code 2 without it)
 * - `BEAGLE_AGENT_SECRET_KEY`  optional Solana keypair of the agent wallet: base58 or a JSON byte
 *   array (the contents of a `solana-keygen` file); with it the wallet tools sign and send
 * - `BEAGLE_RPC_URL`  optional JSON-RPC URL (default: the cluster RPC from `GET /api/config`)
 * - `BEAGLE_WORKSPACE`  optional default workspace (base58 public key) for the wallet tools
 *
 * stdout carries the MCP protocol, so every log line goes to stderr.
 *
 * @module cli
 */
import { isBase58Pubkey } from '@beagle/shared/solana';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Keypair } from '@solana/web3.js';
import { createRestBeagleApi, type BeagleApi } from './api.js';
import { createBeagleMcpServer, walletDeployment, type BeagleMcpServerOptions } from './server.js';
import { createKeypairWalletExecutor, createLazyWalletExecutor, keypairFromSecret, WalletError, type SolanaRpc, type WalletExecutor } from './wallet.js';

/** Default gateway URL of the stdio binary. */
export const DEFAULT_API_URL = 'http://localhost:8787';

/** Parsed environment of {@link main}. */
export interface BinConfig {
  apiUrl: string;
  apiKey: string;
  /** The agent keypair parsed from `BEAGLE_AGENT_SECRET_KEY`; never logged. */
  keypair?: Keypair;
  rpcUrl?: string;
  workspace?: string;
}

/** Thrown by {@link readBinConfig} for a missing or malformed variable; `exitCode` is 2. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  readonly exitCode = 2;
}

/** Reads and validates the environment (pure; no process access). Secret material never appears in errors. */
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
  const secret = env['BEAGLE_AGENT_SECRET_KEY']?.trim();
  if (secret !== undefined && secret !== '') {
    try {
      config.keypair = keypairFromSecret(secret);
    } catch (error) {
      throw new ConfigError(
        `BEAGLE_AGENT_SECRET_KEY must be a Solana secret key as base58 or a JSON byte array (solana-keygen file contents): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const rpc = env['BEAGLE_RPC_URL']?.trim();
  if (rpc !== undefined && rpc !== '') {
    if (!/^https?:\/\//.test(rpc)) throw new ConfigError(`BEAGLE_RPC_URL must start with http:// or https:// (got ${JSON.stringify(rpc)})`);
    config.rpcUrl = rpc;
  }
  const ws = env['BEAGLE_WORKSPACE']?.trim();
  if (ws !== undefined && ws !== '') {
    if (!isBase58Pubkey(ws)) throw new ConfigError('BEAGLE_WORKSPACE must be a base58 Solana public key');
    config.workspace = ws;
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
  /** RPC connection or test fake; overrides `BEAGLE_RPC_URL`. */
  connection?: SolanaRpc;
}

/**
 * The agent wallet of the stdio binary, or `undefined` without `BEAGLE_AGENT_SECRET_KEY`.
 *
 * Its address comes from the keypair immediately (no network), so the wallet tools can default
 * `workspace` and describe themselves as signing from the start; the cluster, mint, token program
 * and operator are read from `GET /api/config` on the **first wallet-tool call** and retried on
 * each call until that succeeds. A gateway that is down, slow or mid-deploy when the MCP client
 * spawns the binary therefore neither delays the MCP handshake nor downgrades the session to
 * unsigned transactions: the affected call fails with `wallet_unavailable` and the next one tries
 * again. The RPC endpoint is `BEAGLE_RPC_URL`, else the gateway's `rpcUrl`.
 */
export function createAgentWallet(api: BeagleApi, config: BinConfig, options: AgentWalletOptions = {}): WalletExecutor | undefined {
  const keypair = config.keypair;
  if (keypair === undefined) return undefined;
  const address = keypair.publicKey.toBase58();
  const emit = options.log ?? (() => undefined);
  return createLazyWalletExecutor({
    address,
    build: async () => {
      const gateway = await api.config();
      const deployment = walletDeployment(gateway);
      if (deployment.mint === '' ) throw new WalletError('not_configured', 'the gateway reports no mint for its cluster');
      const rpcUrl = config.rpcUrl ?? gateway.rpcUrl;
      const wallet = createKeypairWalletExecutor({
        secretKey: keypair,
        deployment,
        rpcUrl,
        ...(options.connection === undefined ? {} : { connection: options.connection }),
      });
      emit(`agent wallet ${address} ready on ${gateway.cluster} (mint ${gateway.mint}, rpc ${options.connection === undefined ? rpcUrl : 'injected'})`);
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
    ...(config.rpcUrl === undefined ? {} : { rpcUrl: config.rpcUrl }),
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
        ? ' (no agent wallet: on-chain tools return unsigned transactions)'
        : ` (agent wallet ${wallet.address ?? '?'}; cluster and mint are read from the gateway on the first wallet call)`
    }`,
  );
}
