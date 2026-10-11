import { describe, expect, it } from 'vitest';
import { parseSiweMessage, validateSiweMessage } from 'viem/siwe';
import { SIWE_STATEMENT, buildSiweMessage, siweAuthority } from './siwe.js';

const ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const NOW = new Date('2026-10-11T14:05:00.000Z');

describe('buildSiweMessage', () => {
  it('uses the gateway host as domain and its origin as uri', () => {
    const msg = buildSiweMessage({ address: ADDRESS, chainId: 31337, nonce: 'abcdefgh12345678', gatewayUrl: 'http://localhost:8787', pageOrigin: 'http://localhost:5173', now: NOW });
    const parsed = parseSiweMessage(msg);
    expect(parsed.domain).toBe('localhost:8787');
    expect(parsed.uri).toBe('http://localhost:8787/');
    expect(parsed.address).toBe(ADDRESS);
    expect(parsed.chainId).toBe(31337);
    expect(parsed.nonce).toBe('abcdefgh12345678');
    expect(parsed.statement).toBe(SIWE_STATEMENT);
    expect(parsed.issuedAt?.toISOString()).toBe(NOW.toISOString());
    expect(parsed.expirationTime?.getTime()).toBe(NOW.getTime() + 10 * 60 * 1000);
    expect(validateSiweMessage({ message: parsed, address: ADDRESS, domain: 'localhost:8787', nonce: 'abcdefgh12345678', time: NOW })).toBe(true);
  });
  it('falls back to the page origin when the gateway is same-origin', () => {
    expect(siweAuthority('', 'https://beagle.example').host).toBe('beagle.example');
    const msg = buildSiweMessage({ address: ADDRESS, chainId: 4663, nonce: 'abcdefgh12345678', gatewayUrl: '', pageOrigin: 'https://beagle.example', now: NOW });
    expect(parseSiweMessage(msg).domain).toBe('beagle.example');
  });
});
