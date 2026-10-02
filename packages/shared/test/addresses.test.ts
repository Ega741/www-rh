import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import {
  ADDRESSES,
  ANVIL_ADDRESSES,
  DEPLOYMENTS,
  ROBINHOOD_ADDRESSES,
  ROBINHOOD_TESTNET_ADDRESSES,
  addressesFor,
  launchpadAddress,
} from '../src/addresses.js';

describe('known addresses (SPEC §3.1)', () => {
  it('match docs/ROBINHOOD_CHAIN.md and are stored EIP-55 checksummed', () => {
    expect(ROBINHOOD_ADDRESSES.weth9).toBe('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');
    expect(ROBINHOOD_ADDRESSES.uniswapV3Factory).toBe('0x1f7d7550B1b028f7571E69A784071F0205FD2EfA');
    expect(ROBINHOOD_ADDRESSES.uniswapV3PositionManager).toBe('0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3');
    expect(ROBINHOOD_ADDRESSES.uniswapV3SwapRouter02?.toLowerCase()).toBe('0xcaf681a66d020601342297493863e78c959e5cb2');
    expect(ROBINHOOD_ADDRESSES.uniswapV3FeeTier).toBe(10_000);
    for (const set of [ROBINHOOD_ADDRESSES, ROBINHOOD_TESTNET_ADDRESSES, ANVIL_ADDRESSES]) {
      for (const [key, value] of Object.entries(set)) {
        if (typeof value === 'string' && value.length === 42) expect(getAddress(value), key).toBe(value);
      }
    }
    expect(ROBINHOOD_TESTNET_ADDRESSES.weth9).toBe('0x7943e237c7F95DA44E0301572D358911207852Fa');
    expect(ROBINHOOD_TESTNET_ADDRESSES.uniswapV3Factory).toBeUndefined();
    expect(addressesFor(4663)).toBe(ADDRESSES[4663]);
    expect(addressesFor(1)).toBeUndefined();
  });
});

describe('launchpadAddress (static DEPLOYMENTS, no file reads)', () => {
  it('returns DEPLOYMENTS[chainId].launchpad and undefined for unknown chains', () => {
    for (const [chainId, record] of Object.entries(DEPLOYMENTS)) {
      expect(record.chainId).toBe(Number(chainId));
      expect(getAddress(record.launchpad)).toBe(record.launchpad);
      expect(['uniswapv3', 'mock']).toContain(record.graduatorKind);
      expect(launchpadAddress(Number(chainId))).toBe(record.launchpad);
    }
    expect(launchpadAddress(999_999)).toBeUndefined();
    expect(launchpadAddress.length).toBe(1);
  });
});
