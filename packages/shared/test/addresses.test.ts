import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import {
  ADDRESSES,
  DEPLOYMENTS,
  ROBINHOOD_ADDRESSES,
  ROBINHOOD_TESTNET_ADDRESSES,
  addressesFor,
  deploymentFor,
  launchpadAddress,
  launchpadAddressFromDeployment,
} from '../src/addresses.js';

describe('known addresses', () => {
  it('mainnet addresses from docs/ROBINHOOD_CHAIN.md are checksummed', () => {
    expect(ROBINHOOD_ADDRESSES.weth9).toBe('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');
    expect(ROBINHOOD_ADDRESSES.uniswapV3Factory).toBe('0x1f7d7550B1b028f7571E69A784071F0205FD2EfA');
    expect(ROBINHOOD_ADDRESSES.uniswapV3PositionManager).toBe('0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3');
    expect(ROBINHOOD_ADDRESSES.uniswapV3FeeTier).toBe(10_000);
    for (const [key, value] of Object.entries(ROBINHOOD_ADDRESSES)) {
      if (typeof value === 'string' && value.length === 42) expect(value, key).toBe(getAddress(value));
    }
    expect(ROBINHOOD_TESTNET_ADDRESSES.weth9).toBe('0x7943e237c7F95DA44E0301572D358911207852Fa');
    expect(ROBINHOOD_TESTNET_ADDRESSES.uniswapV3Factory).toBeUndefined();
    expect(addressesFor(4663)).toBe(ADDRESSES[4663]);
    expect(addressesFor(1)).toBeUndefined();
  });
});

describe('launchpadAddress (R13: static, generated, no file reads)', () => {
  const addr = '0x5fbdb2315678afecb367f032d93f642f64180aa3';

  it('reads the generated DEPLOYMENTS map', () => {
    expect(typeof DEPLOYMENTS).toBe('object');
    for (const [chainId, record] of Object.entries(DEPLOYMENTS)) {
      expect(record.chainId).toBe(Number(chainId));
      expect(deploymentFor(Number(chainId))).toBe(record);
      expect(launchpadAddress(Number(chainId))).toBe(getAddress(record.launchpad));
    }
    expect(deploymentFor(999_999)).toBeUndefined();
    expect(launchpadAddress(999_999)).toBeUndefined();
  });

  it('override wins when it is a non-zero address; garbage and zero are ignored', () => {
    expect(launchpadAddress(999_999, { override: addr })).toBe(getAddress(addr));
    expect(launchpadAddress(999_999, { override: '0x' + '00'.repeat(20) })).toBeUndefined();
    expect(launchpadAddress(999_999, { override: 'garbage' })).toBeUndefined();
    expect(launchpadAddress(999_999, { override: undefined })).toBeUndefined();
  });

  it('launchpadAddressFromDeployment accepts alternative keys', () => {
    expect(launchpadAddressFromDeployment({ launchpad: addr })).toBe(getAddress(addr));
    expect(launchpadAddressFromDeployment({ MindLaunchpad: addr })).toBe(getAddress(addr));
    expect(launchpadAddressFromDeployment({ launchpadAddress: addr })).toBe(getAddress(addr));
    expect(launchpadAddressFromDeployment({ launchpad: 'nope' })).toBeUndefined();
    expect(launchpadAddressFromDeployment(null)).toBeUndefined();
    expect(launchpadAddressFromDeployment({})).toBeUndefined();
  });
});
