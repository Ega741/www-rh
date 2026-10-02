import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';
import { ponsLifecycle } from './lifecycle';

const ACCOUNT = '0x4444444444444444444444444444444444444444' as Address;
const WALLET = '0x5555555555555555555555555555555555555555' as Address;
const pons = { account: ACCOUNT, left: false, adopted: true, launchedHere: false };

describe('Pons mind lifecycle (SPEC §9.7)', () => {
  it('receiving while the account is the recipient', () => {
    expect(ponsLifecycle(pons, false, '0x4444444444444444444444444444444444444444')).toBe('receiving');
    expect(ponsLifecycle({ ...pons, adopted: false, launchedHere: true }, null, ACCOUNT)).toBe('receiving');
  });

  it('left wins, from the live read or the runner flag', () => {
    expect(ponsLifecycle(pons, true, WALLET)).toBe('left');
    expect(ponsLifecycle({ ...pons, left: true }, null, null)).toBe('left');
    // the chain read overrides a stale runner flag
    expect(ponsLifecycle({ ...pons, left: true }, false, ACCOUNT)).toBe('receiving');
  });

  it('recipient moved away without leaving', () => {
    expect(ponsLifecycle(pons, false, WALLET)).toBe('recipient-moved');
    expect(ponsLifecycle({ ...pons, adopted: false, launchedHere: true }, false, WALLET)).toBe('recipient-moved');
  });

  it('unknown without a recipient read, or for a legacy pending preparation', () => {
    expect(ponsLifecycle(pons, false, null)).toBe('unknown');
    expect(ponsLifecycle({ ...pons, adopted: false }, false, WALLET)).toBe('unknown');
  });
});
