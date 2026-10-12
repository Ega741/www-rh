import { describe, expect, it } from 'vitest';
import { SIWS_DEFAULT_STATEMENT, parseSiwsMessage, validateSiwsFields } from '@beagle/shared/siws';
import { buildSiwsMessage, encodeSignature, messageBytes, messageText, siwsAuthority, siwsSignInInput } from './siws.js';

const ADDRESS = 'BEJQY85xuHoT2NyAT5eXF9ftMv6RnSM7LQSujxm8BAbZ';
const NOW = new Date('2026-10-12T12:00:00.000Z');

describe('buildSiwsMessage', () => {
  it('uses the gateway host as domain, its origin as uri and the cluster CAIP id', () => {
    const text = buildSiwsMessage({ address: ADDRESS, cluster: 'devnet', nonce: 'abcdefgh12345678', gatewayUrl: 'https://api.beagle.example:8443/', pageOrigin: 'http://localhost:5173', now: NOW });
    expect(text.startsWith(`api.beagle.example:8443 wants you to sign in with your Solana account:\n${ADDRESS}\n\n${SIWS_DEFAULT_STATEMENT}\n\n`)).toBe(true);
    const fields = parseSiwsMessage(text);
    expect(fields).toMatchObject({
      domain: 'api.beagle.example:8443',
      address: ADDRESS,
      uri: 'https://api.beagle.example:8443/',
      version: '1',
      chainId: 'solana:devnet',
      nonce: 'abcdefgh12345678',
      issuedAt: '2026-10-12T12:00:00.000Z',
      expirationTime: '2026-10-12T12:10:00.000Z',
    });
  });
  it('produces a message the gateway validator accepts (SPEC §5.3 fields)', () => {
    const text = buildSiwsMessage({ address: ADDRESS, cluster: 'localnet', nonce: 'nonce-1234567890', gatewayUrl: '', pageOrigin: 'http://localhost:5173', now: NOW });
    const fields = parseSiwsMessage(text);
    const problems = validateSiwsFields(fields, {
      domain: 'localhost:5173',
      uri: 'http://localhost:5173',
      chainId: 'solana:localnet',
      address: ADDRESS,
      now: NOW.getTime() + 60_000,
      nonceOk: (n) => n === 'nonce-1234567890',
    });
    expect(problems).toEqual([]);
    expect(validateSiwsFields(fields, { domain: 'other.example', uri: 'http://localhost:5173', chainId: 'solana:devnet', now: NOW.getTime() }).map((p) => p.code)).toEqual(['domain_mismatch', 'chain_mismatch']);
  });
  it('falls back to the page origin when the gateway is same-origin', () => {
    expect(siwsAuthority('', 'https://beagle.example').host).toBe('beagle.example');
    expect(siwsAuthority('  ', 'https://beagle.example/').origin).toBe('https://beagle.example');
    const input = siwsSignInInput({ address: ADDRESS, cluster: 'mainnet-beta', nonce: 'nonce-1234567890', gatewayUrl: '', pageOrigin: 'https://beagle.example', now: NOW });
    expect(input).toEqual({
      domain: 'beagle.example',
      address: ADDRESS,
      statement: SIWS_DEFAULT_STATEMENT,
      uri: 'https://beagle.example/',
      version: '1',
      chainId: 'solana:mainnet',
      nonce: 'nonce-1234567890',
      issuedAt: '2026-10-12T12:00:00.000Z',
      expirationTime: '2026-10-12T12:10:00.000Z',
    });
  });
  it('round-trips message bytes and encodes signatures as base58', () => {
    const text = 'héllo\nworld';
    expect(messageText(messageBytes(text))).toBe(text);
    expect(messageBytes('abc')).toEqual(new Uint8Array([97, 98, 99]));
    const sig = new Uint8Array(64).fill(7);
    const encoded = encodeSignature(sig);
    expect(encoded).toMatch(/^[1-9A-HJ-NP-Za-km-z]{86,88}$/);
    expect(encodeSignature(new Uint8Array([0, 0, 1]))).toBe('112');
  });
});
