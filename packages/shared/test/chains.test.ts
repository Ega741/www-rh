import { describe, expect, it } from 'vitest';
import {
  MULTICALL3_ADDRESS,
  anvilChain,
  chainById,
  explorerAddressUrl,
  explorerTokenUrl,
  explorerTxUrl,
  robinhoodChain,
  robinhoodChainTestnet,
  toAddEthereumChainParameter,
} from '../src/chains.js';

describe('chains', () => {
  it('mainnet 4663 and testnet 46630 per docs/ROBINHOOD_CHAIN.md', () => {
    expect(robinhoodChain.id).toBe(4663);
    expect(robinhoodChain.name).toBe('Robinhood Chain');
    expect(robinhoodChain.nativeCurrency).toEqual({ name: 'Ether', symbol: 'ETH', decimals: 18 });
    expect(robinhoodChain.rpcUrls.default.http[0]).toBe('https://rpc.mainnet.chain.robinhood.com');
    expect(robinhoodChain.blockExplorers?.default.url).toBe('https://robinhoodchain.blockscout.com');
    expect(robinhoodChain.blockExplorers?.default.apiUrl).toBe('https://robinhoodchain.blockscout.com/api');
    expect(robinhoodChain.sourceId).toBe(1);
    expect(robinhoodChain.testnet).toBe(false);
    expect(robinhoodChain.contracts?.multicall3?.address.toLowerCase()).toBe(MULTICALL3_ADDRESS);

    expect(robinhoodChainTestnet.id).toBe(46630);
    expect(robinhoodChainTestnet.rpcUrls.default.http[0]).toBe('https://rpc.testnet.chain.robinhood.com/rpc');
    expect(robinhoodChainTestnet.blockExplorers?.default.url).toBe('https://explorer.testnet.chain.robinhood.com');
    expect(robinhoodChainTestnet.sourceId).toBe(11155111);
    expect(robinhoodChainTestnet.testnet).toBe(true);
    expect(anvilChain.id).toBe(31337);
  });

  it('chainById resolves known ids only', () => {
    expect(chainById(4663)).toBe(robinhoodChain);
    expect(chainById(46630)).toBe(robinhoodChainTestnet);
    expect(chainById(31337)).toBe(anvilChain);
    expect(chainById(1)).toBeUndefined();
  });

  it('EIP-3085 parameters match the wallet config in the docs', () => {
    expect(toAddEthereumChainParameter(robinhoodChain)).toMatchObject({
      chainId: '0x1237',
      chainName: 'Robinhood Chain',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
    });
    expect(toAddEthereumChainParameter(robinhoodChain).rpcUrls[0]).toBe('https://rpc.mainnet.chain.robinhood.com');
    expect(toAddEthereumChainParameter(robinhoodChainTestnet).chainId).toBe('0xb626');
  });

  it('explorer helpers', () => {
    expect(explorerTxUrl(robinhoodChain, '0xabc')).toBe('https://robinhoodchain.blockscout.com/tx/0xabc');
    expect(explorerAddressUrl(robinhoodChainTestnet, '0xdef')).toBe('https://explorer.testnet.chain.robinhood.com/address/0xdef');
    expect(explorerTokenUrl(robinhoodChain, '0x1')).toBe('https://robinhoodchain.blockscout.com/token/0x1');
    expect(explorerTxUrl(anvilChain, '0x1')).toBeUndefined();
  });
});
