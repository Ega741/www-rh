import { describe, expect, it } from 'vitest';
import { anvilChain, robinhoodChain } from '@beagle/shared/chains';
import { addressLink, blockLink, checksum, sameAddress, shortAddress, shortHash, txLink } from './explorer.js';

const ADDR = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const HASH = '0x' + 'ab'.repeat(32);

describe('explorer helpers', () => {
  it('checksums and shortens addresses', () => {
    expect(checksum(ADDR)).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(shortAddress(ADDR)).toBe('0xf39F…2266');
    expect(shortAddress(ADDR, 6)).toBe('0xf39Fd6…b92266');
    expect(checksum('not-an-address')).toBe('not-an-address');
  });
  it('shortens hashes', () => {
    expect(shortHash(HASH)).toBe('0xabababab…abab');
    expect(shortHash('0x12')).toBe('0x12');
  });
  it('builds explorer links for chains with an explorer only', () => {
    expect(txLink(robinhoodChain, HASH)).toBe(`https://robinhoodchain.blockscout.com/tx/${HASH}`);
    expect(addressLink(robinhoodChain, ADDR)).toBe('https://robinhoodchain.blockscout.com/address/0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(blockLink(robinhoodChain, 12n)).toBe('https://robinhoodchain.blockscout.com/block/12');
    expect(txLink(anvilChain, HASH)).toBeUndefined();
    expect(addressLink(anvilChain, ADDR)).toBeUndefined();
  });
  it('compares addresses case-insensitively', () => {
    expect(sameAddress(ADDR, ADDR.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(sameAddress(ADDR, undefined)).toBe(false);
  });
});
