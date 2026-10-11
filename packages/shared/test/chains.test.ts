import { describe, expect, it } from 'vitest';
import {
  ANVIL_CHAIN_ID,
  MULTICALL3_ADDRESS,
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_TESTNET_CHAIN_ID,
  SUPPORTED_CHAINS,
  SUPPORTED_CHAIN_IDS,
  anvilChain,
  chainById,
  explorerAddressUrl,
  explorerBaseUrl,
  explorerBlockUrl,
  explorerTokenUrl,
  explorerTxUrl,
  isSupportedChainId,
  robinhoodChain,
  robinhoodChainTestnet,
  toAddEthereumChainParameter,
  withMulticall3,
} from '../src/chains.js';

describe('chain definitions', () => {
  it('uses the chain ids of docs/ROBINHOOD_CHAIN.md', () => {
    expect(ROBINHOOD_CHAIN_ID).toBe(4663);
    expect(ROBINHOOD_TESTNET_CHAIN_ID).toBe(46630);
    expect(ANVIL_CHAIN_ID).toBe(31337);
    expect(robinhoodChain.id).toBe(4663);
    expect(robinhoodChainTestnet.id).toBe(46630);
    expect(anvilChain.id).toBe(31337);
  });

  it('describes mainnet', () => {
    expect(robinhoodChain.name).toBe('Robinhood Chain');
    expect(robinhoodChain.nativeCurrency).toEqual({ name: 'Ether', symbol: 'ETH', decimals: 18 });
    expect(robinhoodChain.rpcUrls.default.http[0]).toBe('https://rpc.mainnet.chain.robinhood.com');
    expect(robinhoodChain.rpcUrls.default.http).toContain('https://robinhood-rpc.publicnode.com');
    expect(robinhoodChain.rpcUrls.default.webSocket).toContain('wss://robinhood.drpc.org');
    expect(robinhoodChain.blockExplorers?.default.url).toBe('https://robinhoodchain.blockscout.com');
    expect(robinhoodChain.blockExplorers?.default.apiUrl).toBe('https://robinhoodchain.blockscout.com/api');
    expect(robinhoodChain.sourceId).toBe(1);
    expect(robinhoodChain.testnet).toBe(false);
    expect(robinhoodChain.contracts?.multicall3).toBeUndefined();
  });

  it('describes testnet', () => {
    expect(robinhoodChainTestnet.name).toBe('Robinhood Chain Testnet');
    expect(robinhoodChainTestnet.rpcUrls.default.http[0]).toBe('https://rpc.testnet.chain.robinhood.com/rpc');
    expect(robinhoodChainTestnet.blockExplorers?.default.url).toBe('https://explorer.testnet.chain.robinhood.com');
    expect(robinhoodChainTestnet.sourceId).toBe(11_155_111);
    expect(robinhoodChainTestnet.testnet).toBe(true);
  });

  it('describes anvil without an explorer', () => {
    expect(anvilChain.rpcUrls.default.http).toEqual(['http://127.0.0.1:8545']);
    expect(anvilChain.blockExplorers).toBeUndefined();
    expect(anvilChain.testnet).toBe(true);
  });
});

describe('lookup helpers', () => {
  it('SUPPORTED_CHAINS is keyed by id', () => {
    expect(Object.keys(SUPPORTED_CHAINS).map(Number).sort((a, b) => a - b)).toEqual([4663, 31337, 46630]);
    expect(SUPPORTED_CHAIN_IDS).toEqual([4663, 46630, 31337]);
  });

  it('chainById resolves known ids and returns undefined otherwise', () => {
    expect(chainById(4663)).toBe(robinhoodChain);
    expect(chainById(46630)).toBe(robinhoodChainTestnet);
    expect(chainById(31337)).toBe(anvilChain);
    expect(chainById(1)).toBeUndefined();
  });

  it('isSupportedChainId narrows', () => {
    expect(isSupportedChainId(4663)).toBe(true);
    expect(isSupportedChainId(1)).toBe(false);
    expect(isSupportedChainId(Number.NaN)).toBe(false);
  });
});

describe('toAddEthereumChainParameter', () => {
  it('builds the EIP-3085 object of docs/ROBINHOOD_CHAIN.md', () => {
    expect(toAddEthereumChainParameter(robinhoodChain)).toEqual({
      chainId: '0x1237',
      chainName: 'Robinhood Chain',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood-rpc.publicnode.com', 'https://robinhood.drpc.org'],
      blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
    });
    expect(toAddEthereumChainParameter(robinhoodChainTestnet).chainId).toBe('0xb626');
  });

  it('omits blockExplorerUrls when the chain has no explorer', () => {
    const param = toAddEthereumChainParameter(anvilChain);
    expect(param.chainId).toBe('0x7a69');
    expect('blockExplorerUrls' in param).toBe(false);
  });

  it('returns copies, not the chain internals', () => {
    const param = toAddEthereumChainParameter(robinhoodChain);
    param.rpcUrls.push('x');
    expect(robinhoodChain.rpcUrls.default.http).not.toContain('x');
  });
});

describe('withMulticall3', () => {
  it('declares multicall3 without mutating the input', () => {
    const chain = withMulticall3(robinhoodChain);
    expect(chain.contracts?.multicall3?.address).toBe(MULTICALL3_ADDRESS);
    expect(chain.id).toBe(4663);
    expect(robinhoodChain.contracts?.multicall3).toBeUndefined();
    expect(MULTICALL3_ADDRESS).toBe('0xcA11bde05977b3631167028862bE2a173976CA11');
  });
});

describe('explorer URL helpers', () => {
  const tx = '0x' + 'ab'.repeat(32);
  const addr = '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73';

  it('build Blockscout paths', () => {
    expect(explorerBaseUrl(robinhoodChain)).toBe('https://robinhoodchain.blockscout.com');
    expect(explorerTxUrl(robinhoodChain, tx)).toBe(`https://robinhoodchain.blockscout.com/tx/${tx}`);
    expect(explorerAddressUrl(robinhoodChain, addr)).toBe(`https://robinhoodchain.blockscout.com/address/${addr}`);
    expect(explorerTokenUrl(robinhoodChain, addr)).toBe(`https://robinhoodchain.blockscout.com/token/${addr}`);
    expect(explorerBlockUrl(robinhoodChain, 12)).toBe('https://robinhoodchain.blockscout.com/block/12');
    expect(explorerBlockUrl(robinhoodChainTestnet, 99n)).toBe('https://explorer.testnet.chain.robinhood.com/block/99');
  });

  it('return undefined for chains without an explorer', () => {
    expect(explorerBaseUrl(anvilChain)).toBeUndefined();
    expect(explorerTxUrl(anvilChain, tx)).toBeUndefined();
    expect(explorerAddressUrl(anvilChain, addr)).toBeUndefined();
    expect(explorerTokenUrl(anvilChain, addr)).toBeUndefined();
    expect(explorerBlockUrl(anvilChain, 1)).toBeUndefined();
  });
});
