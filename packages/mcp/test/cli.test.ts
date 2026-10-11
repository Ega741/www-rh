import { custom, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import { BeagleApiError } from '../src/api.js';
import { ConfigError, createAgentWallet, DEFAULT_API_URL, readBinConfig } from '../src/cli.js';
import { WalletError } from '../src/wallet.js';
import { createFakeApi, WORKSPACE } from './fake-api.js';

const KEY = 'bgl_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const PK = `0x${'11'.repeat(32)}`;
const WS = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

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

  it('reads the optional wallet settings', () => {
    const config = readBinConfig({
      BEAGLE_API_KEY: ` ${KEY} `,
      BEAGLE_API_URL: 'https://beagle.example',
      BEAGLE_AGENT_PRIVATE_KEY: PK,
      BEAGLE_RPC_URL: 'https://rpc.example',
      BEAGLE_WORKSPACE: WS,
    });
    expect(config).toEqual({ apiUrl: 'https://beagle.example', apiKey: KEY, privateKey: PK, rpcUrl: 'https://rpc.example', workspace: WS });
  });

  it('rejects malformed values', () => {
    expect(() => readBinConfig({ BEAGLE_API_KEY: KEY, BEAGLE_API_URL: 'localhost:8787' })).toThrow(/BEAGLE_API_URL/);
    expect(() => readBinConfig({ BEAGLE_API_KEY: KEY, BEAGLE_AGENT_PRIVATE_KEY: '0x1234' })).toThrow(/BEAGLE_AGENT_PRIVATE_KEY/);
    expect(() => readBinConfig({ BEAGLE_API_KEY: KEY, BEAGLE_WORKSPACE: 'nope' })).toThrow(/BEAGLE_WORKSPACE/);
  });
});

describe('createAgentWallet', () => {
  const config = readBinConfig({ BEAGLE_API_KEY: KEY, BEAGLE_AGENT_PRIVATE_KEY: PK });
  // a node that answers nothing: reaching it proves the viem executor was built from the gateway config
  const deadNode = custom({ request: async () => { throw new Error('no rpc in this test'); } }, { retryCount: 0 });

  it('is undefined without an agent key', () => {
    expect(createAgentWallet(createFakeApi(), readBinConfig({ BEAGLE_API_KEY: KEY }))).toBeUndefined();
  });

  it('knows its address without touching the gateway and defers GET /api/config to the first wallet call', async () => {
    const api = createFakeApi();
    const wallet = createAgentWallet(api, config, { transport: deadNode })!;
    expect(wallet.address).toBe(privateKeyToAccount(PK as Hex).address);
    expect(api.callsTo('config')).toBe(0);
    const error = await wallet.buyCompute({ workspace: WORKSPACE, tokens: 1n }).catch((e: unknown) => e);
    expect(api.callsTo('config')).toBe(1);
    // built from the gateway config, then failed at the (dead) RPC: not a setup failure
    expect(error).toBeInstanceOf(WalletError);
    expect((error as WalletError).code).toBe('rpc_error');
  });

  it('fails the call with wallet_unavailable while the gateway is down and recovers on the next call without a restart', async () => {
    const api = createFakeApi({ failures: { config: new BeagleApiError(0, 'network_error', 'request to GET /api/config failed: fetch failed') } });
    const logs: string[] = [];
    const wallet = createAgentWallet(api, config, { transport: deadNode, log: (m) => logs.push(m) })!;

    const down = await wallet.buyCompute({ workspace: WORKSPACE, tokens: 1n }).catch((e: unknown) => e);
    expect((down as WalletError).code).toBe('wallet_unavailable');
    expect((down as WalletError).message).toMatch(/fetch failed/);
    expect(logs).toEqual([]);

    api.state.failures = {}; // the gateway comes up
    const up = await wallet.openBudget({ workspace: WORKSPACE, cap: 1n, deadline: 1n }).catch((e: unknown) => e);
    expect((up as WalletError).code).toBe('rpc_error');
    expect(api.callsTo('config')).toBe(2);
    expect(logs).toEqual([`agent wallet ${wallet.address} ready on chain 31337 (desk ${api.state.config.creditDesk})`]);

    // and the built executor is cached: no third config() call
    await wallet.buyCompute({ workspace: WORKSPACE, tokens: 1n }).catch(() => undefined);
    expect(api.callsTo('config')).toBe(2);
  });

  it('reports a gateway without a deployment as wallet_unavailable', async () => {
    const api = createFakeApi();
    api.state.config = { ...api.state.config, creditDesk: null, token: null };
    const wallet = createAgentWallet(api, config, { transport: deadNode })!;
    const error = await wallet.buyCompute({ workspace: WORKSPACE, tokens: 1n }).catch((e: unknown) => e);
    expect((error as WalletError).code).toBe('wallet_unavailable');
    expect((error as WalletError).message).toMatch(/no CreditDesk deployment/);
  });
});
