import { zeroAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { canRecover, checkRecoverToken } from './recover';

describe('recover tokens input (SPEC §9.7 recoverAccountTokens)', () => {
  it('accepts an ERC-20 address (lower-cased)', () => {
    expect(checkRecoverToken(' 0x00000000000000000000000000000000000000AB ')).toEqual({ ok: true, erc20: '0x00000000000000000000000000000000000000ab' });
  });

  it('shows nothing for empty input and rejects junk and the zero address', () => {
    expect(checkRecoverToken('  ')).toEqual({ ok: false, message: null });
    expect(checkRecoverToken('0x12')).toEqual({ ok: false, message: 'Not an address.' });
    expect(checkRecoverToken(zeroAddress)).toMatchObject({ ok: false, message: expect.stringMatching(/ETH cannot be recovered/) });
  });

  it('allows recovery unless the balance is known to be zero', () => {
    expect(canRecover(0n)).toBe(false);
    expect(canRecover(1n)).toBe(true);
    expect(canRecover(null)).toBe(true);
    expect(canRecover(undefined)).toBe(true);
  });
});
