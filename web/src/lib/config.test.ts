import { describe, expect, it } from 'vitest';
import { envFlag, loadConfig, publicGatewayUrl, stripSlash } from './config.js';

describe('loadConfig', () => {
  it('defaults to anvil with the committed deployment', () => {
    const cfg = loadConfig({}, { dev: true });
    expect(cfg.chainId).toBe(31337);
    expect(cfg.chain.name).toBe('Anvil');
    expect(cfg.deployment.creditDesk).toBe('0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0');
    expect(cfg.apiBase).toBe('');
    expect(cfg.errors).toEqual([]);
    expect(cfg.multicall).toBe(false);
    expect(cfg.chain.contracts?.multicall3).toBeUndefined();
  });
  it('applies the desk override and multicall flag', () => {
    const cfg = loadConfig(
      { VITE_CHAIN_ID: '4663', VITE_CREDIT_DESK_ADDRESS: '0x000000000000000000000000000000000000dead', VITE_MULTICALL: '1' },
      { dev: false },
    );
    expect(cfg.chainId).toBe(4663);
    expect(cfg.deployment.creditDesk).toBe('0x000000000000000000000000000000000000dEaD');
    expect(cfg.deployment.overridden).toEqual(['creditDesk']);
    expect(cfg.chain.contracts?.multicall3?.address).toBe('0xcA11bde05977b3631167028862bE2a173976CA11');
    expect(cfg.errors).toEqual([]);
  });
  it('reports an unknown chain and falls back to anvil', () => {
    const cfg = loadConfig({ VITE_CHAIN_ID: '1' }, { dev: true });
    expect(cfg.chainId).toBe(31337);
    expect(cfg.errors[0]).toMatch(/not a supported chain/);
  });
  it('reports a missing deployment and a bad override without throwing', () => {
    const cfg = loadConfig({ VITE_CHAIN_ID: '46630', VITE_CREDIT_DESK_ADDRESS: 'nope' }, { dev: true });
    expect(cfg.errors.some((e) => /not an address/.test(e))).toBe(true);
    expect(cfg.errors.some((e) => /No CreditDesk deployment/.test(e))).toBe(true);
    expect(cfg.deployment.creditDesk).toBeUndefined();
  });
  it('uses the gateway URL as API base only in production', () => {
    expect(loadConfig({ VITE_GATEWAY_URL: 'https://api.example.com/' }, { dev: true }).apiBase).toBe('');
    const prod = loadConfig({ VITE_GATEWAY_URL: 'https://api.example.com/' }, { dev: false });
    expect(prod.apiBase).toBe('https://api.example.com');
    expect(prod.gatewayUrl).toBe('https://api.example.com');
  });
});

describe('helpers', () => {
  it('publicGatewayUrl prefers the configured URL', () => {
    expect(publicGatewayUrl({ gatewayUrl: '' }, 'http://localhost:5173/')).toBe('http://localhost:5173');
    expect(publicGatewayUrl({ gatewayUrl: 'http://localhost:8787' }, 'http://localhost:5173')).toBe('http://localhost:8787');
  });
  it('envFlag and stripSlash', () => {
    expect(envFlag('1')).toBe(true);
    expect(envFlag('TRUE')).toBe(true);
    expect(envFlag('0')).toBe(false);
    expect(envFlag(undefined)).toBe(false);
    expect(stripSlash('https://x.y///')).toBe('https://x.y');
  });
});
