import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';

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
