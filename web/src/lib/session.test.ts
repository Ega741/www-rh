import { describe, expect, it } from 'vitest';
import { phaseLabel, sessionStatus, signInBlocker, walletMismatch } from './session.js';

describe('session helpers', () => {
  it('phase labels', () => {
    expect(phaseLabel('idle')).toBe('Sign in');
    expect(phaseLabel('signing')).toBe('Confirm in wallet…');
  });
  it('blockers', () => {
    expect(signInBlocker({ connected: false, hasAddress: false, phase: 'idle' })).toBe('Connect a wallet first');
    expect(signInBlocker({ connected: true, hasAddress: true, phase: 'nonce' })).toBe('Requesting nonce…');
    expect(signInBlocker({ connected: true, hasAddress: true, phase: 'idle' })).toBeUndefined();
  });
  it('status and mismatch', () => {
    expect(sessionStatus({ pending: true, me: undefined })).toBe('loading');
    expect(sessionStatus({ pending: false, me: null })).toBe('anonymous');
    expect(sessionStatus({ pending: false, me: { workspace: '0xabc' } })).toBe('authenticated');
    expect(walletMismatch('0xABC', '0xabc')).toBe(false);
    expect(walletMismatch('0xabc', '0xdef')).toBe(true);
    expect(walletMismatch(undefined, '0xdef')).toBe(false);
  });
});
