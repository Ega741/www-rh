import { describe, expect, it } from 'vitest';
import {
  CLUSTERS,
  CLUSTER_NAMES,
  DEFAULT_CLUSTER,
  clusterCaip,
  clusterFromCaip,
  deriveWsUrl,
  explorerAddressUrl,
  explorerClusterQuery,
  explorerTokenUrl,
  explorerTxUrl,
  isCluster,
  parseCluster,
} from '../src/clusters.js';

const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
const MINT = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

describe('clusters (SPEC §1, §4.1)', () => {
  it('names, default and isCluster', () => {
    expect(CLUSTER_NAMES).toEqual(['mainnet-beta', 'devnet', 'localnet']);
    expect(DEFAULT_CLUSTER).toBe('localnet');
    expect(isCluster('devnet')).toBe(true);
    expect(isCluster('mainnet')).toBe(false);
    expect(isCluster('testnet')).toBe(false);
    expect(isCluster(undefined)).toBe(false);
    expect(isCluster(3)).toBe(false);
  });

  it('parseCluster accepts env spellings', () => {
    expect(parseCluster(undefined)).toBe('localnet');
    expect(parseCluster('')).toBe('localnet');
    expect(parseCluster('  devnet ')).toBe('devnet');
    expect(parseCluster('Mainnet-Beta')).toBe('mainnet-beta');
    expect(parseCluster('mainnet')).toBe('mainnet-beta');
    expect(parseCluster('local')).toBe('localnet');
    expect(parseCluster('localhost')).toBe('localnet');
    expect(() => parseCluster('testnet')).toThrow(/unknown cluster "testnet"/);
  });

  it('endpoints and explorer bases', () => {
    expect(CLUSTERS['mainnet-beta'].rpcUrl).toBe('https://api.mainnet-beta.solana.com');
    expect(CLUSTERS['mainnet-beta'].wsUrl).toBe('wss://api.mainnet-beta.solana.com');
    expect(CLUSTERS.devnet.rpcUrl).toBe('https://api.devnet.solana.com');
    expect(CLUSTERS.localnet.rpcUrl).toBe('http://127.0.0.1:8899');
    expect(CLUSTERS.localnet.wsUrl).toBe('ws://127.0.0.1:8900');
    for (const name of CLUSTER_NAMES) {
      expect(CLUSTERS[name].cluster).toBe(name);
      expect(CLUSTERS[name].explorer).toBe('https://explorer.solana.com');
      expect(CLUSTERS[name].solscan).toBe('https://solscan.io');
      expect(Object.isFrozen(CLUSTERS[name])).toBe(true);
    }
    expect(Object.isFrozen(CLUSTERS)).toBe(true);
  });

  it('CAIP-2 ids (SIWS chainId)', () => {
    expect(clusterCaip('mainnet-beta')).toBe('solana:mainnet');
    expect(clusterCaip('devnet')).toBe('solana:devnet');
    expect(clusterCaip('localnet')).toBe('solana:localnet');
    expect(clusterFromCaip('solana:devnet')).toBe('devnet');
    expect(clusterFromCaip('solana:mainnet')).toBe('mainnet-beta');
    expect(clusterFromCaip('solana:mainnet-beta')).toBeUndefined();
    expect(clusterFromCaip('eip155:1')).toBeUndefined();
  });

  it('explorer URLs select the cluster by query', () => {
    expect(explorerClusterQuery('mainnet-beta')).toBe('');
    expect(explorerClusterQuery('devnet')).toBe('?cluster=devnet');
    expect(explorerClusterQuery('localnet')).toBe('?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899');
    expect(explorerClusterQuery('localnet', 'http://localhost:8899')).toBe('?cluster=custom&customUrl=http%3A%2F%2Flocalhost%3A8899');

    expect(explorerTxUrl('mainnet-beta', SIG)).toBe(`https://explorer.solana.com/tx/${SIG}`);
    expect(explorerTxUrl('devnet', SIG)).toBe(`https://explorer.solana.com/tx/${SIG}?cluster=devnet`);
    expect(explorerTxUrl('localnet', SIG)).toBe(`https://explorer.solana.com/tx/${SIG}?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899`);
    expect(explorerTxUrl('localnet', SIG, { rpcUrl: 'http://validator:8899' })).toBe(
      `https://explorer.solana.com/tx/${SIG}?cluster=custom&customUrl=http%3A%2F%2Fvalidator%3A8899`,
    );
    expect(explorerAddressUrl('devnet', MINT)).toBe(`https://explorer.solana.com/address/${MINT}?cluster=devnet`);
    expect(explorerTokenUrl('mainnet-beta', MINT)).toBe(`https://explorer.solana.com/address/${MINT}`);
  });

  it('Solscan variants', () => {
    expect(explorerTxUrl('mainnet-beta', SIG, { site: 'solscan' })).toBe(`https://solscan.io/tx/${SIG}`);
    expect(explorerTxUrl('devnet', SIG, { site: 'solscan' })).toBe(`https://solscan.io/tx/${SIG}?cluster=devnet`);
    expect(explorerAddressUrl('devnet', MINT, { site: 'solscan' })).toBe(`https://solscan.io/account/${MINT}?cluster=devnet`);
    expect(explorerTokenUrl('devnet', MINT, { site: 'solscan' })).toBe(`https://solscan.io/token/${MINT}?cluster=devnet`);
    expect(explorerTokenUrl('localnet', MINT, { site: 'solscan', rpcUrl: 'http://127.0.0.1:8899' })).toBe(
      `https://solscan.io/token/${MINT}?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899`,
    );
  });

  it('escapes path segments', () => {
    expect(explorerTxUrl('mainnet-beta', 'a/b?c')).toBe('https://explorer.solana.com/tx/a%2Fb%3Fc');
  });

  it('deriveWsUrl follows the web3.js convention', () => {
    expect(deriveWsUrl('http://127.0.0.1:8899')).toBe('ws://127.0.0.1:8900');
    expect(deriveWsUrl('https://api.devnet.solana.com')).toBe('wss://api.devnet.solana.com');
    expect(deriveWsUrl('https://rpc.example.com/abc?key=1')).toBe('wss://rpc.example.com/abc?key=1');
    expect(deriveWsUrl('http://localhost:8899/')).toBe('ws://localhost:8900');
    expect(deriveWsUrl(CLUSTERS.localnet.rpcUrl)).toBe(CLUSTERS.localnet.wsUrl);
    expect(deriveWsUrl(CLUSTERS.devnet.rpcUrl)).toBe(CLUSTERS.devnet.wsUrl);
    expect(() => deriveWsUrl('ws://x')).toThrow(/http\(s\)/);
    expect(() => deriveWsUrl('nope')).toThrow(/not a URL/);
  });
});
