import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_HARVEST_MIN_WEI, loadConfig, mindContract } from '../src/config.js';

describe('loadConfig (SPEC §4 env)', () => {
  it('applies the spec defaults with only RPC_URL set', () => {
    const c = loadConfig({ RPC_URL: 'http://127.0.0.1:8545' });
    expect(c).toMatchObject({
      chainId: 46630, launchpad: null, startBlock: 0n, confirmations: 0, dryRun: true, anthropicApiKey: null, ethUsdPriceMicro: 3_000_000_000,
      minTickBudgetUsd: 0.05, maxTickCostUsd: 0.25, drawThresholdUsd: 2, targetRunwayDays: 14, minDailySpendUsd: 0.5, dbPath: './data/runner.sqlite',
      port: 8787, publicWebOrigins: ['http://localhost:5173'], maxConcurrentMinds: 3, tickIntervalMs: 20_000, tickMaxIterations: 8,
      tickTimeoutMs: 180_000, anchorEveryNMemories: 5, harvestIntervalMs: 21_600_000, browserHeadless: true, frameFps: 1, ipfsGateway: 'https://ipfs.io/ipfs/',
    });
  });

  it('RPC_URL is required; malformed values are reported', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    try {
      loadConfig({ RPC_URL: 'http://x', DRY_RUN: 'yes', PORT: 'abc', LAUNCHPAD_ADDRESS: '0x12' });
    } catch (err) {
      expect((err as ConfigError).issues.map((i) => i.split(':')[0])).toEqual(expect.arrayContaining(['DRY_RUN', 'PORT', 'LAUNCHPAD_ADDRESS']));
    }
  });

  it('zero LAUNCHPAD_ADDRESS counts as unset; empty strings are unset; booleans accept 1/0; origins are a list', () => {
    const c = loadConfig({
      RPC_URL: 'http://x',
      LAUNCHPAD_ADDRESS: '0x0000000000000000000000000000000000000000',
      ANTHROPIC_API_KEY: '',
      BROWSER_HEADLESS: '0',
      DRY_RUN: 'false',
      OPERATOR_PRIVATE_KEY: '0x' + '11'.repeat(32),
      PUBLIC_WEB_ORIGIN: 'http://localhost:5173, https://www.example',
      ETH_USD_PRICE: '3123.4567891',
      IPFS_GATEWAY: 'https://dweb.link/ipfs',
    });
    expect(c.launchpad).toBeNull();
    expect(c.anthropicApiKey).toBeNull();
    expect(c.browserHeadless).toBe(false);
    expect(c.dryRun).toBe(false);
    expect(c.publicWebOrigins).toEqual(['http://localhost:5173', 'https://www.example']);
    expect(c.ethUsdPriceMicro).toBe(3_123_456_789);
    expect(c.ipfsGateway).toBe('https://dweb.link/ipfs/');
  });

  it('no operator key forces dry run; a launchpad address is checksummed', () => {
    const c = loadConfig({ RPC_URL: 'http://x', DRY_RUN: 'false', OPERATOR_PRIVATE_KEY: '0x', LAUNCHPAD_ADDRESS: '0x5fbdb2315678afecb367f032d93f642f64180aa3' });
    expect(c.dryRun).toBe(true);
    expect(c.launchpad).toBe('0x5FbDB2315678afecb367f032d93F642f64180aa3');
  });
});

describe('loadConfig: review additions', () => {
  it('TOOL_TIMEOUT_MS and ETH_USD_MIN / ETH_USD_MAX defaults and validation', () => {
    const c = loadConfig({ RPC_URL: 'http://x' });
    expect(c.toolTimeoutMs).toBe(30_000);
    expect(c.ethUsdBoundsMicro).toEqual({ min: 100_000_000, max: 100_000_000_000 });
    const d = loadConfig({ RPC_URL: 'http://x', TOOL_TIMEOUT_MS: '5000', ETH_USD_MIN: '500', ETH_USD_MAX: '20000' });
    expect([d.toolTimeoutMs, d.ethUsdBoundsMicro]).toEqual([5_000, { min: 500_000_000, max: 20_000_000_000 }]);
    expect(() => loadConfig({ RPC_URL: 'http://x', ETH_USD_MIN: '5000', ETH_USD_MAX: '100' })).toThrow(ConfigError);
    expect(() => loadConfig({ RPC_URL: 'http://x', TOOL_TIMEOUT_MS: '10' })).toThrow(ConfigError);
  });
});

describe('loadConfig: Pons mode (SPEC §9.4)', () => {
  it('VENUE defaults to pons on 4663 and curve elsewhere; HARVEST_MIN_WEI defaults to 0.002 ether; PONS_* default to the mainnet contracts', () => {
    const main = loadConfig({ RPC_URL: 'http://x', CHAIN_ID: '4663' });
    expect(main).toMatchObject({ venue: 'pons', registry: null, launchpad: null, harvestMinWei: 2_000_000_000_000_000n });
    expect(DEFAULT_HARVEST_MIN_WEI).toBe(2n * 10n ** 15n);
    expect(main.pons).toEqual({ factory: '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e', feeEscrow: '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e', memeHook: '0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044' });
    const test = loadConfig({ RPC_URL: 'http://x' });
    expect(test.venue).toBe('curve');
    expect(test.pons).toEqual({ factory: null, feeEscrow: null, memeHook: null });
  });

  it('VENUE / REGISTRY_ADDRESS / HARVEST_MIN_WEI / PONS_* overrides and validation; mindContract follows the venue', () => {
    const c = loadConfig({
      RPC_URL: 'http://x', VENUE: 'pons', REGISTRY_ADDRESS: '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0', LAUNCHPAD_ADDRESS: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
      HARVEST_MIN_WEI: '5000000000000000', PONS_FACTORY: '0x1111111111111111111111111111111111111111', PONS_FEE_ESCROW: '0x0000000000000000000000000000000000000000',
    });
    expect([c.venue, c.registry, c.harvestMinWei, c.pons.factory, c.pons.feeEscrow]).toEqual(['pons', '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0', 5n * 10n ** 15n, '0x1111111111111111111111111111111111111111', null]);
    expect(mindContract(c)).toBe(c.registry);
    expect(mindContract({ ...c, venue: 'curve' })).toBe(c.launchpad);
    expect(loadConfig({ RPC_URL: 'http://x', CHAIN_ID: '4663', VENUE: 'curve' }).venue).toBe('curve');
    for (const [key, value] of [['VENUE', 'pump'], ['HARVEST_MIN_WEI', '0.002'], ['HARVEST_MIN_WEI', '-1'], ['REGISTRY_ADDRESS', '0x12'], ['PONS_MEME_HOOK', 'hook']] as const) {
      expect(() => loadConfig({ RPC_URL: 'http://x', [key]: value }), `${key}=${value}`).toThrow(ConfigError);
    }
  });
});
