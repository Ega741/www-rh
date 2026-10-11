import { describe, expect, it } from 'vitest';
import { ConfigError, DEV_SESSION_SECRET, loadConfig, testConfig } from '../src/config.js';

describe('config', () => {
  it('applies defaults and converts USD values to µUSD', () => {
    const c = loadConfig({});
    expect(c.chain.chainId).toBe(31337);
    expect(c.server.port).toBe(8787);
    expect(c.economics.markupBps).toBe(1000);
    expect(c.economics.lowCreditMicro).toBe(1_000_000n);
    expect(c.economics.veryLowCreditMicro).toBe(100_000n);
    expect(c.economics.minReserveMicro).toBe(10_000n);
    expect(c.economics.maxReserveMicro).toBe(5_000_000n);
    expect(c.economics.proPriceMicro).toBe(20_000_000n);
    expect(c.budgets.drawThresholdMicro).toBe(1_000_000n);
    expect(c.operator.dryRun).toBe(true);
    expect(c.secrets.sessionSecret).toBe(DEV_SESSION_SECRET);
    expect(c.secrets.sessionSecretIsDefault).toBe(true);
    expect(c.providers.houseBaseUrl).toBeUndefined();
    expect(c.server.publicHost).toBe('localhost:8787');
  });

  it('treats empty strings as unset and the zero address as no override', () => {
    const c = loadConfig({ ANTHROPIC_API_KEY: '', OPERATOR_PRIVATE_KEY: '0x', CREDIT_DESK_ADDRESS: '0x0000000000000000000000000000000000000000', START_BLOCK: '', RPC_URL: '' });
    expect(c.providers.anthropicApiKey).toBeUndefined();
    expect(c.operator.privateKey).toBeUndefined();
    expect(c.chain.creditDeskAddress).toBe('0x0000000000000000000000000000000000000000');
    expect(c.chain.startBlock).toBeUndefined();
    expect(c.chain.rpcUrl).toBeUndefined();
  });

  it('parses the e2e environment', () => {
    const c = loadConfig({
      CHAIN_ID: '31337',
      RPC_URL: 'http://127.0.0.1:8545',
      START_BLOCK: '0',
      OPERATOR_PRIVATE_KEY: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
      DRY_RUN: 'false',
      PUBLIC_WEB_ORIGIN: 'http://localhost:5173, http://web:80/',
      KEYRING_MASTER_KEY: '11'.repeat(32),
      DRAW_THRESHOLD_USD: '0.000001',
      HOUSE_BASE_URL: 'http://127.0.0.1:9999/v1/',
    });
    expect(c.chain.startBlock).toBe(0);
    expect(c.operator.dryRun).toBe(false);
    expect(c.operator.privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(c.server.webOrigins).toEqual(['http://localhost:5173', 'http://web:80']);
    expect(c.secrets.keyringMasterKey?.length).toBe(32);
    expect(c.budgets.drawThresholdMicro).toBe(1n);
    expect(c.providers.houseBaseUrl).toBe('http://127.0.0.1:9999/v1');
  });

  it('rejects bad values', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow(ConfigError);
    expect(() => loadConfig({ LOW_CREDIT_USD: 'lots' })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ MIN_RESERVE_USD: '10', MAX_RESERVE_USD: '1' })).toThrow(/MIN_RESERVE_USD/);
    expect(() => loadConfig({ PRICE_POSTER_ENABLED: 'true' })).toThrow(/PRICE_FEED_URL/);
    expect(() => loadConfig({ KEYRING_MASTER_KEY: 'short' })).toThrow(ConfigError);
    expect(() => loadConfig({ LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });

  it('testConfig is production-free and in-memory', () => {
    const c = testConfig();
    expect(c.server.dbPath).toBe(':memory:');
    expect(c.isProduction).toBe(false);
    expect(c.secrets.adminToken).toBe('test-admin');
  });
});
