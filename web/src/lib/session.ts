/** Pure state of the SIWE sign-in flow (`nonce → createSiweMessage → signMessage → verify`). */

/** Where the sign-in flow currently is. */
export type SignInPhase = 'idle' | 'nonce' | 'signing' | 'verifying';

/** Button label for a phase. */
export function phaseLabel(phase: SignInPhase): string {
  switch (phase) {
    case 'idle':
      return 'Sign in';
    case 'nonce':
      return 'Requesting nonce…';
    case 'signing':
      return 'Confirm in wallet…';
    case 'verifying':
      return 'Verifying…';
  }
}

/** Why sign-in is not possible right now, or `undefined` when it is. */
export function signInBlocker(input: { connected: boolean; phase: SignInPhase; hasAddress: boolean }): string | undefined {
  if (!input.connected || !input.hasAddress) return 'Connect a wallet first';
  if (input.phase !== 'idle') return phaseLabel(input.phase);
  return undefined;
}

/** Session status derived from the `GET /api/me` query. */
export type SessionStatus = 'loading' | 'anonymous' | 'authenticated';

/** Derives the session status from the me-query state. */
export function sessionStatus(input: { pending: boolean; me: { workspace: string } | null | undefined }): SessionStatus {
  if (input.pending) return 'loading';
  return input.me ? 'authenticated' : 'anonymous';
}

/**
 * `true` when the connected wallet differs from the signed-in workspace (show a notice: the
 * session stays valid, but on-chain actions will come from the other account).
 */
export function walletMismatch(sessionWorkspace: string | undefined, walletAddress: string | undefined): boolean {
  if (sessionWorkspace === undefined || walletAddress === undefined) return false;
  return sessionWorkspace.toLowerCase() !== walletAddress.toLowerCase();
}
