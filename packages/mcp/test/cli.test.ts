import { SYSTEM_PROGRAM_ID } from '@beagle/shared/addresses';
import bs58 from 'bs58';
import { describe, expect, it } from 'vitest';
import { BeagleApiError } from '../src/api.js';
import { ConfigError, createAgentWallet, DEFAULT_API_URL, readBinConfig } from '../src/cli.js';
import { WalletError } from '../src/wallet.js';
import { AGENT_ATA, createFakeApi } from './fake-api.js';
import { AGENT, AGENT_KEYPAIR, createFakeConnection, MINT, OTHER_WORKSPACE } from './fake-connection.js';

const KEY = 'bgl_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const SECRET_B58 = bs58.encode(AGENT_KEYPAIR.secretKey);
const SECRET_JSON = JSON.stringify(Array.from(AGENT_KEYPAIR.secretKey));

describe('readBinConfig', () => {
  it('requires BEAGLE_API_KEY with exit code 2', () => {
    expect(() => readBinConfig({})).toThrow(ConfigError);
    try {
      readBinConfig({ BEAGLE_API_KEY: '   ' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).exitCode).toBe(2);
      expect((error as ConfigError).message).toMatch(/BEAGLE_API_KEY is required/);
    }
  });

  it('defaults the API URL and leaves optional fields out', () => {
    const config = readBinConfig({ BEAGLE_API_KEY: KEY });
    expect(config).toEqual({ apiUrl: DEFAULT_API_URL, apiKey: KEY });
    expect(DEFAULT_API_URL).toBe('http://localhost:8787');
  });

  it('reads the optional wallet settings: base58 or JSON secret key, RPC URL, workspace', () => {
    const config = readBinConfig({
      BEAGLE_API_KEY: ` ${KEY} `,
      BEAGLE_API_URL: 'https://beagle.example',
      BEAGLE_AGENT_SECRET_KEY: SECRET_B58,
      BEAGLE_RPC_URL: 'https://rpc.example',
      BEAGLE_WORKSPACE: OTHER_WORKSPACE,
    });
    expect(config.apiUrl).toBe('https://beagle.example');
    expect(config.apiKey).toBe(KEY);
    expect(config.keypair?.publicKey.toBase58()).toBe(AGENT);
    expect(config.rpcUrl).toBe('https://rpc.example');
    expect(config.workspace).toBe(OTHER_WORKSPACE);

    const fromFile = readBinConfig({ BEAGLE_API_KEY: KEY, BEAGLE_AGENT_SECRET_KEY: `${SECRET_JSON}\n` });
    expect(fromFile.keypair?.publicKey.toBase58()).toBe(AGENT);
    expect(fromFile.rpcUrl).toBeUndefined();
  });

  it('rejects malformed values without echoing the secret', () => {
    expect(() => readBinConfig({ BEAGLE_API_KEY: KEY, BEAGLE_API_URL: 'localhost:8787' })).toThrow(/BEAGLE_API_URL/);
    expect(() => readBinConfig({ BEAGLE_API_KEY: KEY, BEAGLE_RPC_URL: 'rpc.example' })).toThrow(/BEAGLE_RPC_URL/);
    expect(() => readBinConfig({ BEAGLE_API_KEY: KEY, BEAGLE_WORKSPACE: '0x70997970c51812dc3a010c7d01b50e0d17dc79c8' })).toThrow(/BEAGLE_WORKSPACE/);
    const badSecret = bs58.encode(new Uint8Array(20).fill(3));
    try {
      readBinConfig({ BEAGLE_API_KEY: KEY, BEAGLE_AGENT_SECRET_KEY: badSecret });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toMatch(/BEAGLE_AGENT_SECRET_KEY/);
      expect((error as ConfigError).message).not.toContain(badSecret);
    }
    expect(() => readBinConfig({ BEAGLE_API_KEY: KEY, BEAGLE_AGENT_SECRET_KEY: '0x1234' })).toThrow(ConfigError);
  });
});

describe('createAgentWallet', () => {
  const config = readBinConfig({ BEAGLE_API_KEY: KEY, BEAGLE_AGENT_SECRET_KEY: SECRET_JSON });
  const node = () => createFakeConnection({ tokenAccounts: [{ address: AGENT_ATA, mint: MINT, owner: AGENT, amount: 10n ** 9n }] });

  it('is undefined without an agent key', () => {
    expect(createAgentWallet(createFakeApi(), readBinConfig({ BEAGLE_API_KEY: KEY }))).toBeUndefined();
  });

  it('knows its address without touching the gateway and defers GET /api/config to the first wallet call', async () => {
    const api = createFakeApi();
    const rpc = node();
    const logs: string[] = [];
    const wallet = createAgentWallet(api, config, { connection: rpc, log: (m) => logs.push(m) })!;
    expect(wallet.address).toBe(AGENT);
    expect(api.callsTo('config')).toBe(0);
    expect(rpc.calls.length).toBe(0);
    const result = await wallet.buyCompute({ workspace: AGENT, tokens: 1_000_000n });
    expect(api.callsTo('config')).toBe(1);
    expect(result.tokenAccount).toBe(AGENT_ATA);
    expect(rpc.sent.length).toBe(1);
    expect(logs).toEqual([`agent wallet ${AGENT} ready on localnet (mint ${MINT}, rpc injected)`]);
  });

  it('fails the call with wallet_unavailable while the gateway is down and recovers on the next call without a restart', async () => {
    const api = createFakeApi({ failures: { config: new BeagleApiError(0, 'network_error', 'request to GET /api/config failed: fetch failed') } });
    const logs: string[] = [];
    const rpc = node();
    const wallet = createAgentWallet(api, config, { connection: rpc, log: (m) => logs.push(m) })!;

    const down = await wallet.buyCompute({ workspace: AGENT, tokens: 1n }).catch((e: unknown) => e);
    expect((down as WalletError).code).toBe('wallet_unavailable');
    expect((down as WalletError).message).toMatch(/fetch failed/);
    expect(logs).toEqual([]);
    expect(rpc.calls.length).toBe(0);

    api.state.failures = {}; // the gateway comes up
    const up = await wallet.openBudget({ cap: 1n });
    expect(up.tokenAccount).toBe(AGENT_ATA);
    expect(api.callsTo('config')).toBe(2);
    expect(logs.length).toBe(1);

    // and the built executor is cached: no third config() call
    await wallet.closeBudget({});
    expect(api.callsTo('config')).toBe(2);
  });

  it('detects a wrong RPC endpoint on the first call (chain_mismatch) and sends nothing', async () => {
    const api = createFakeApi();
    const rpc = createFakeConnection({ mintExists: false });
    const wallet = createAgentWallet(api, config, { connection: rpc })!;
    const error = await wallet.buyCompute({ workspace: AGENT, tokens: 1n }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WalletError);
    expect((error as WalletError).code).toBe('chain_mismatch');
    expect(rpc.sent.length).toBe(0);
  });

  it('reports chain_unavailable (not chain_mismatch) when the gateway has no chain and advertises the all-zero mint', async () => {
    const api = createFakeApi();
    api.state.config = { ...api.state.config, mint: SYSTEM_PROGRAM_ID, operator: null };
    const rpc = node();
    const logs: string[] = [];
    const wallet = createAgentWallet(api, config, { connection: rpc, log: (m) => logs.push(m) })!;
    const error = await wallet.buyCompute({ workspace: AGENT, tokens: 1n }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WalletError);
    expect((error as WalletError).code).toBe('chain_unavailable');
    expect((error as WalletError).message).toMatch(/no chain access configured/);
    expect((error as WalletError).message).toMatch(/read-only and inference tools still work/);
    expect(rpc.calls.length).toBe(0);
    expect(logs).toEqual([]);

    // the gateway gets its chain configured: the next call builds the wallet
    api.state.config = createFakeApi().state.config;
    const result = await wallet.buyCompute({ workspace: AGENT, tokens: 1n });
    expect(result.tokenAccount).toBe(AGENT_ATA);
    expect(api.callsTo('config')).toBe(2);
  });
});
