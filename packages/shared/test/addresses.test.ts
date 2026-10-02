import { describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import {
  ADDRESSES,
  ANVIL_ADDRESSES,
  DEPLOYMENTS,
  PONS,
  PONS_ADDRESSES,
  ROBINHOOD_ADDRESSES,
  ROBINHOOD_TESTNET_ADDRESSES,
  addressesFor,
  defaultVenue,
  launchpadAddress,
  ponsAddressesFor,
  registryAddress,
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

describe('launchpadAddress / registryAddress (static DEPLOYMENTS, no file reads)', () => {
  it('returns DEPLOYMENTS[chainId].launchpad / .registry and undefined for unknown chains', () => {
    for (const [chainId, record] of Object.entries(DEPLOYMENTS)) {
      expect(record.chainId).toBe(Number(chainId));
      expect(['pons', 'curve']).toContain(record.venue);
      if (record.venue === 'curve') {
        expect(record.launchpad).toBeDefined();
        expect(['uniswapv3', 'mock']).toContain(record.graduatorKind);
      } else {
        expect(record.registry).toBeDefined();
      }
      for (const a of [record.launchpad, record.graduator, record.registry]) if (a !== undefined) expect(getAddress(a)).toBe(a);
      expect(launchpadAddress(Number(chainId))).toBe(record.launchpad);
      expect(registryAddress(Number(chainId))).toBe(record.registry);
    }
    expect(launchpadAddress(999_999)).toBeUndefined();
    expect(registryAddress(999_999)).toBeUndefined();
    expect(launchpadAddress.length).toBe(1);
  });
});

describe('Pons V2 addresses (SPEC §9.1, §9.3)', () => {
  it('mainnet constants match §9.1 and are EIP-55 checksummed', () => {
    expect(PONS.factory).toBe('0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e');
    expect(PONS.router.toLowerCase()).toBe('0xe33e9e479df8802cb0866d5d05258bec4cf62948');
    expect(PONS.feeEscrow.toLowerCase()).toBe('0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e');
    expect(PONS.memeHook.toLowerCase()).toBe('0xe5e702641ea86f4ae6cc3cdaed2b886f976be044');
    expect(PONS.locker.toLowerCase()).toBe('0x267444d099b10fb5ed7c3cc7b7c767adca574952');
    expect(PONS.buybackVault.toLowerCase()).toBe('0x42df2a798f82289e177311362e8f5ccc45c1219c');
    expect(PONS.graduationExecutor.toLowerCase()).toBe('0xc7819b64a1daecd7ec19856d026cb14efbd89046');
    expect(PONS.poolManager).toBe(ROBINHOOD_ADDRESSES.uniswapV4PoolManager);
    for (const [key, value] of Object.entries(PONS)) expect(getAddress(value), key).toBe(value);
    expect(ponsAddressesFor(4663)).toBe(PONS);
    expect(PONS_ADDRESSES[4663]).toBe(PONS);
    expect(ponsAddressesFor(46630)).toBeUndefined();
  });

  it('Pons is the default venue on mainnet only', () => {
    expect(defaultVenue(4663)).toBe('pons');
    expect(defaultVenue(46630)).toBe('curve');
    expect(defaultVenue(31337)).toBe('curve');
  });
});
