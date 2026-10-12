import { describe, expect, it } from 'vitest';
import { defaultTargetWorkspace, phaseLabel, sessionStatus, shouldResetWorkspaceCache, signInBlocker, walletMismatch } from './session.js';

const SESSION_A = 'BEJQY85xuHoT2NyAT5eXF9ftMv6RnSM7LQSujxm8BAbZ';
const WALLET_B = 'HBJrfAHGsn7WQYk4FaBXv3wA7fVRL4ctSriSdj3UiDND';

describe('session helpers', () => {
  it('phase labels', () => {
    expect(phaseLabel('idle')).toBe('Sign in');
    expect(phaseLabel('signing')).toBe('Confirm in wallet…');
  });
  it('blockers', () => {
    expect(signInBlocker({ connected: false, hasAddress: false, canSign: true, phase: 'idle' })).toBe('Connect a wallet first');
    expect(signInBlocker({ connected: true, hasAddress: true, canSign: false, phase: 'idle' })).toBe('This wallet cannot sign messages');
    expect(signInBlocker({ connected: true, hasAddress: true, canSign: true, phase: 'nonce' })).toBe('Requesting nonce…');
    expect(signInBlocker({ connected: true, hasAddress: true, canSign: true, phase: 'idle' })).toBeUndefined();
  });
  it('status and mismatch (base58 is case-sensitive)', () => {
    expect(sessionStatus({ pending: true, me: undefined })).toBe('loading');
    expect(sessionStatus({ pending: false, me: null })).toBe('anonymous');
    expect(sessionStatus({ pending: false, me: { workspace: SESSION_A } })).toBe('authenticated');
    expect(walletMismatch(SESSION_A, SESSION_A)).toBe(false);
    expect(walletMismatch(SESSION_A, SESSION_A.toLowerCase())).toBe(true);
    expect(walletMismatch(SESSION_A, WALLET_B)).toBe(true);
    expect(walletMismatch(undefined, WALLET_B)).toBe(false);
  });
  it('burns and budgets target the signed-in workspace, not the connected wallet (SPEC §7)', () => {
    expect(defaultTargetWorkspace(SESSION_A, WALLET_B)).toBe(SESSION_A);
    expect(defaultTargetWorkspace(undefined, WALLET_B)).toBe(WALLET_B);
    expect(defaultTargetWorkspace(undefined, undefined)).toBeUndefined();
  });
  it('a sign-in to another workspace drops the cached data of the previous one', () => {
    expect(shouldResetWorkspaceCache(undefined, WALLET_B)).toBe(false);
    expect(shouldResetWorkspaceCache(SESSION_A, SESSION_A)).toBe(false);
    expect(shouldResetWorkspaceCache(SESSION_A, WALLET_B)).toBe(true);
  });
});
