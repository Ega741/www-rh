import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_API_URL, readBinConfig } from '../src/cli.js';

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
