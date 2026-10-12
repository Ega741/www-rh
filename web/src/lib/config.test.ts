import { describe, expect, it } from 'vitest';
import { MEMO_PROGRAM_ID, TOKEN_PROGRAM_ID, deploymentFor, resolveDeployment } from '@beagle/shared/addresses';
import { loadConfig, publicGatewayUrl, reconcileDeployment, stripSlash } from './config.js';

const LOCAL = deploymentFor('localnet');
if (LOCAL === undefined) throw new Error('the committed localnet deployment is required by these tests');
const OTHER_MINT = 'So11111111111111111111111111111111111111112';
const OPERATOR = LOCAL.operator;

describe('loadConfig', () => {
  it('defaults to localnet with the committed deployment', () => {
    const cfg = loadConfig({}, { dev: true });
    expect(cfg.cluster).toBe('localnet');
    expect(cfg.clusterName).toBe('Localnet');
    expect(cfg.deployment.mint).toBe(LOCAL.mint);
    expect(cfg.rpcUrl).toBe('http://127.0.0.1:8899');
    expect(cfg.apiBase).toBe('');
    expect(cfg.errors).toEqual([]);
  });
  it('applies the mint and RPC overrides', () => {
    const cfg = loadConfig({ VITE_CLUSTER: 'devnet', VITE_MINT_ADDRESS: OTHER_MINT, VITE_RPC_URL: 'https://rpc.example/x' }, { dev: false });
    expect(cfg.cluster).toBe('devnet');
    expect(cfg.deployment.mint).toBe(OTHER_MINT);
    expect(cfg.rpcUrl).toBe('https://rpc.example/x');
    expect(cfg.deployment.overridden).toEqual(['mint', 'rpcUrl']);
    expect(cfg.errors).toEqual([]);
  });
  it('accepts the cluster aliases', () => {
    expect(loadConfig({ VITE_CLUSTER: 'mainnet' }, { dev: true }).cluster).toBe('mainnet-beta');
    expect(loadConfig({ VITE_CLUSTER: ' LOCAL ' }, { dev: true }).cluster).toBe('localnet');
  });
  it('reports an unknown cluster and falls back to localnet', () => {
    const cfg = loadConfig({ VITE_CLUSTER: 'testnet' }, { dev: true });
    expect(cfg.cluster).toBe('localnet');
    expect(cfg.errors[0]).toMatch(/VITE_CLUSTER: unknown cluster/);
  });
  it('reports a bad mint override without throwing and keeps the valid RPC override', () => {
    const cfg = loadConfig({ VITE_MINT_ADDRESS: 'nope', VITE_RPC_URL: 'http://localhost:9999' }, { dev: true });
    expect(cfg.errors.some((e) => /not a base58 public key/.test(e))).toBe(true);
    expect(cfg.deployment.mint).toBe(LOCAL.mint);
    expect(cfg.rpcUrl).toBe('http://localhost:9999');
  });
  it('reports a bad RPC override and keeps the mint override', () => {
    const cfg = loadConfig({ VITE_MINT_ADDRESS: OTHER_MINT, VITE_RPC_URL: 'ftp://nope' }, { dev: true });
    expect(cfg.errors.some((e) => /rpcUrl/.test(e))).toBe(true);
    expect(cfg.deployment.mint).toBe(OTHER_MINT);
    expect(cfg.rpcUrl).toBe('http://127.0.0.1:8899');
  });
  it('a cluster without a committed deployment still boots (the gateway supplies the mint)', () => {
    const cfg = loadConfig({ VITE_CLUSTER: 'devnet' }, { dev: true });
    expect(cfg.errors).toEqual([]);
    expect(cfg.deployment.tokenProgram).toBe(TOKEN_PROGRAM_ID);
    expect(cfg.rpcUrl).toBe('https://api.devnet.solana.com');
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
  it('stripSlash', () => {
    expect(stripSlash('https://x.y///')).toBe('https://x.y');
  });
});

describe('reconcileDeployment', () => {
  const committed = resolveDeployment('localnet');
  const gateway = { cluster: 'localnet', mint: LOCAL.mint, decimals: 6, symbol: 'BEAGLE', tokenProgram: TOKEN_PROGRAM_ID, memoProgram: MEMO_PROGRAM_ID, operator: OPERATOR };

  it('takes the token facts from the gateway when it agrees', () => {
    const v = reconcileDeployment(committed, { ...gateway, symbol: 'BGL', operator: null });
    expect(v.mint).toBe(LOCAL.mint);
    expect(v.symbol).toBe('BGL');
    expect(v.operator).toBeUndefined();
    expect(v.mismatch).toBeUndefined();
  });
  it('falls back to the committed deployment while the gateway is unknown', () => {
    const v = reconcileDeployment(committed, undefined);
    expect(v).toEqual({ mint: LOCAL.mint, decimals: 6, symbol: 'BEAGLE', tokenProgram: TOKEN_PROGRAM_ID, memoProgram: MEMO_PROGRAM_ID, operator: OPERATOR, mismatch: undefined });
  });
  it('uses the gateway mint when nothing is committed', () => {
    const none = resolveDeployment('devnet');
    const v = reconcileDeployment(none, { ...gateway, cluster: 'devnet', mint: OTHER_MINT });
    expect(v.mint).toBe(OTHER_MINT);
    expect(v.mismatch).toBeUndefined();
    expect(reconcileDeployment(none, undefined).mint).toBeUndefined();
    expect(reconcileDeployment(none, undefined).decimals).toBe(6);
  });
  it('disables the flows when the build and the gateway disagree on the mint', () => {
    const v = reconcileDeployment(committed, { ...gateway, mint: OTHER_MINT });
    expect(v.mint).toBeUndefined();
    expect(v.mismatch).toContain(LOCAL.mint);
    expect(v.mismatch).toContain(OTHER_MINT);
  });
  it('disables the flows when the gateway runs on another cluster', () => {
    const v = reconcileDeployment(committed, { ...gateway, cluster: 'devnet' });
    expect(v.mint).toBeUndefined();
    expect(v.mismatch).toMatch(/targets localnet but the gateway runs on devnet/);
  });
});
