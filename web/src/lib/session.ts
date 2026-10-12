/** Pure state of the SIWS sign-in flow (`nonce → createSiwsMessage → signMessage → verify`). */

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
export function signInBlocker(input: { connected: boolean; phase: SignInPhase; hasAddress: boolean; canSign: boolean }): string | undefined {
  if (!input.connected || !input.hasAddress) return 'Connect a wallet first';
  if (!input.canSign) return 'This wallet cannot sign messages';
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
 * session stays valid, but on-chain actions will come from the other account). Base58 keys are
 * case-sensitive, so the comparison is exact.
 */
export function walletMismatch(sessionWorkspace: string | undefined, walletAddress: string | undefined): boolean {
  if (sessionWorkspace === undefined || walletAddress === undefined) return false;
  return sessionWorkspace !== walletAddress;
}

/**
 * The workspace a burn or a budget targets by default (SPEC §7: "the target workspace defaults
 * to the signed-in workspace"): the session workspace; the connected wallet only when there is
 * no session. The connected wallet always pays, but with a wallet/session mismatch the credit
 * must still reach the workspace the dashboard shows (the burn then carries a memo).
 */
export function defaultTargetWorkspace(sessionWorkspace: string | undefined, walletAddress: string | undefined): string | undefined {
  return sessionWorkspace ?? walletAddress;
}

/**
 * `true` when a sign-in lands on another workspace than the last authenticated one, so the
 * cached keys / balance / budgets / usage of the previous workspace must be dropped instead of
 * being shown until their background refetch completes.
 */
export function shouldResetWorkspaceCache(previousWorkspace: string | undefined, nextWorkspace: string): boolean {
  return previousWorkspace !== undefined && previousWorkspace !== nextWorkspace;
}
