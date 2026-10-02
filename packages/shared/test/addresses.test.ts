import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { getAddress } from 'viem';
import {
  ADDRESSES,
  ROBINHOOD_ADDRESSES,
  ROBINHOOD_TESTNET_ADDRESSES,
  addressesFor,
  defaultDeploymentsDir,
  launchpadAddress,
  launchpadAddressFromDeployment,
} from '../src/addresses.js';

const dir = mkdtempSync(join(tmpdir(), 'www-rh-deployments-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

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

describe('launchpadAddress', () => {
  const addr = '0x5fbdb2315678afecb367f032d93f642f64180aa3';

  it('reads deployments/<chainId>.json when present', () => {
    writeFileSync(join(dir, '31337.json'), JSON.stringify({ chainId: 31337, launchpad: addr, graduatorKind: 'mock' }));
    expect(launchpadAddress(31337, { deploymentsDir: dir })).toBe(getAddress(addr));
    expect(launchpadAddress(4663, { deploymentsDir: dir })).toBeUndefined();
  });

  it('tolerates malformed files', () => {
    writeFileSync(join(dir, '1.json'), '{not json');
    writeFileSync(join(dir, '2.json'), JSON.stringify({ launchpad: 'nope' }));
    expect(launchpadAddress(1, { deploymentsDir: dir })).toBeUndefined();
    expect(launchpadAddress(2, { deploymentsDir: dir })).toBeUndefined();
  });

  it('override wins when it is a non-zero address', () => {
    expect(launchpadAddress(31337, { deploymentsDir: dir, override: '0x' + '11'.repeat(20) })).toBe(getAddress('0x' + '11'.repeat(20)));
    expect(launchpadAddress(31337, { deploymentsDir: dir, override: '0x' + '00'.repeat(20) })).toBe(getAddress(addr));
    expect(launchpadAddress(31337, { deploymentsDir: dir, override: 'garbage' })).toBe(getAddress(addr));
  });

  it('launchpadAddressFromDeployment accepts alternative keys', () => {
    expect(launchpadAddressFromDeployment({ MindLaunchpad: addr })).toBe(getAddress(addr));
    expect(launchpadAddressFromDeployment({ launchpadAddress: addr })).toBe(getAddress(addr));
    expect(launchpadAddressFromDeployment(null)).toBeUndefined();
    expect(launchpadAddressFromDeployment({})).toBeUndefined();
  });

  it('default deployments dir points at <repo>/contracts/deployments', () => {
    expect(defaultDeploymentsDir()?.replace(/\\/g, '/')).toMatch(/\/contracts\/deployments$/);
  });
});
