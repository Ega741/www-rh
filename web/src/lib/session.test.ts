import { describe, expect, it } from 'vitest';
import { defaultTargetWorkspace, phaseLabel, sessionStatus, shouldResetWorkspaceCache, signInBlocker, walletMismatch } from './session.js';

const SESSION_A = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const SESSION_A_EIP55 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const WALLET_B = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

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
  it('burns and budgets target the signed-in workspace, not the connected wallet (SPEC §7)', () => {
    expect(defaultTargetWorkspace(SESSION_A, WALLET_B)).toBe(SESSION_A_EIP55);
    expect(defaultTargetWorkspace(SESSION_A, SESSION_A_EIP55)).toBe(SESSION_A_EIP55);
    expect(defaultTargetWorkspace(undefined, WALLET_B)).toBe(WALLET_B);
    expect(defaultTargetWorkspace(undefined, undefined)).toBeUndefined();
  });
  it('a sign-in to another workspace drops the cached data of the previous one', () => {
    expect(shouldResetWorkspaceCache(undefined, WALLET_B)).toBe(false);
    expect(shouldResetWorkspaceCache(SESSION_A, SESSION_A_EIP55)).toBe(false);
    expect(shouldResetWorkspaceCache(SESSION_A, WALLET_B)).toBe(true);
  });
});
