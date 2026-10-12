import { describe, expect, it } from 'vitest';
import { addressLink, sameAddress, shortAddress, shortHash, shortSignature, tokenLink, txLink } from './explorer.js';

const ADDR = 'BEJQY85xuHoT2NyAT5eXF9ftMv6RnSM7LQSujxm8BAbZ';
const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
const HASH = '0x' + 'ab'.repeat(32);

describe('explorer helpers', () => {
  it('shortens addresses, signatures and hashes', () => {
    expect(shortAddress(ADDR)).toBe('BEJQ…BAbZ');
    expect(shortAddress(ADDR, 6)).toBe('BEJQY8…m8BAbZ');
    expect(shortSignature(SIG)).toBe('5VERv8NM…kQUW');
    expect(shortSignature('abc')).toBe('abc');
    expect(shortHash(HASH)).toBe('0xabababab…abab');
    expect(shortHash('0x12')).toBe('0x12');
  });
  it('builds explorer links per cluster, with the RPC for localnet', () => {
    expect(txLink('mainnet-beta', SIG)).toBe(`https://explorer.solana.com/tx/${SIG}`);
    expect(txLink('devnet', SIG)).toBe(`https://explorer.solana.com/tx/${SIG}?cluster=devnet`);
    expect(txLink('localnet', SIG, 'http://localhost:8899')).toBe(`https://explorer.solana.com/tx/${SIG}?cluster=custom&customUrl=${encodeURIComponent('http://localhost:8899')}`);
    expect(txLink('localnet', SIG)).toContain(encodeURIComponent('http://127.0.0.1:8899'));
    expect(addressLink('devnet', ADDR)).toBe(`https://explorer.solana.com/address/${ADDR}?cluster=devnet`);
    expect(tokenLink('mainnet-beta', ADDR)).toBe(`https://explorer.solana.com/address/${ADDR}`);
  });
  it('compares base58 keys exactly', () => {
    expect(sameAddress(ADDR, ADDR)).toBe(true);
    expect(sameAddress(ADDR, ADDR.toLowerCase())).toBe(false);
    expect(sameAddress(ADDR, undefined)).toBe(false);
    expect(sameAddress('', '')).toBe(false);
    expect(sameAddress(null, ADDR)).toBe(false);
  });
});
