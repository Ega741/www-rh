/**
 * Session state: restore via `GET /api/me`, SIWS sign-in (`nonce → createSiwsMessage →
 * signMessage → verify`, SPEC §5.3), logout. Exposed through a context so the whole app shares
 * one query. Wallets without `signMessage` but with the wallet-standard `signIn` feature sign
 * the same fields rendered by the wallet; the gateway accepts that text too.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useWallet } from '@solana/wallet-adapter-react';
import type { MeDto } from '@beagle/shared/api';
import { api, isApiError, sessionToken } from '../api.js';
import { config, pageOrigin } from '../config.js';
import { WalletUnavailableError, describeError } from '../lib/errors.js';
import { sessionStatus, shouldResetWorkspaceCache, signInBlocker, walletMismatch, type SessionStatus, type SignInPhase } from '../lib/session.js';
import { buildSiwsMessage, encodeSignature, messageBytes, messageText, siwsSignInInput } from '../lib/siws.js';
import { clearWorkspaceQueries, qk } from '../queries.js';
import { useToast } from './useToast.jsx';

/** What {@link useSession} returns. */
export interface Session {
  status: SessionStatus;
  /** The signed-in workspace, when authenticated. */
  me: MeDto | undefined;
  /** Error of the `GET /api/me` restore (network/server), if any. */
  restoreError: string | undefined;
  phase: SignInPhase;
  /** Why sign-in is unavailable right now (undefined = can sign in). */
  blocker: string | undefined;
  /** The connected wallet (base58), if any. */
  wallet: string | undefined;
  /** The connected wallet differs from the signed-in workspace. */
  walletMismatch: boolean;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
}

const SessionContext = createContext<Session | undefined>(undefined);

/** Provides {@link useSession}. Must sit inside the wallet, Query and Toast providers. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const toast = useToast();
  const { publicKey, connected, signMessage, signIn: walletSignIn } = useWallet();
  const address = publicKey?.toBase58();
  const [phase, setPhase] = useState<SignInPhase>('idle');

  const meQuery = useQuery({
    queryKey: qk.me,
    queryFn: async (): Promise<MeDto | null> => {
      try {
        return await api.me();
      } catch (e) {
        if (isApiError(e) && (e.status === 401 || e.status === 403)) {
          sessionToken.clear();
          return null;
        }
        throw e;
      }
    },
    staleTime: 30_000,
    retry: 1,
  });

  /** Workspace of the last authenticated session, kept across an expiry so a sign-in with another wallet drops its cached data. */
  const lastWorkspace = useRef<string | undefined>(undefined);
  const meWorkspace = meQuery.data?.workspace;
  useEffect(() => {
    if (meWorkspace !== undefined) lastWorkspace.current = meWorkspace;
  }, [meWorkspace]);

  const signIn = useCallback(async () => {
    if (!connected || address === undefined) {
      toast.push({ kind: 'warning', title: 'Connect a wallet first' });
      return;
    }
    try {
      setPhase('nonce');
      const { nonce } = await api.nonce();
      setPhase('signing');
      const input = { address, cluster: config.cluster, nonce, gatewayUrl: config.gatewayUrl, pageOrigin: pageOrigin(), now: new Date() };
      let message: string;
      let signature: string;
      if (signMessage !== undefined) {
        message = buildSiwsMessage(input);
        signature = encodeSignature(await signMessage(messageBytes(message)));
      } else if (walletSignIn !== undefined) {
        const out = await walletSignIn(siwsSignInInput(input));
        message = messageText(out.signedMessage);
        signature = encodeSignature(out.signature);
      } else {
        throw new WalletUnavailableError('This wallet cannot sign messages');
      }
      setPhase('verifying');
      const { token, workspace } = await api.verify(message, signature, address);
      if (token !== '') sessionToken.set(token);
      if (shouldResetWorkspaceCache(lastWorkspace.current, workspace)) clearWorkspaceQueries(client);
      await client.invalidateQueries({ queryKey: qk.me });
      toast.push({ kind: 'success', title: 'Signed in' });
    } catch (e) {
      toast.push({ kind: 'error', title: 'Sign-in failed', message: describeError(e) });
    } finally {
      setPhase('idle');
    }
  }, [address, connected, signMessage, walletSignIn, client, toast]);

  const signOut = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* the local session is dropped regardless */
    }
    sessionToken.clear();
    clearWorkspaceQueries(client);
    client.setQueryData(qk.me, null);
    toast.push({ kind: 'info', title: 'Signed out' });
  }, [client, toast]);

  const refresh = useCallback(async () => {
    await client.invalidateQueries({ queryKey: qk.me });
  }, [client]);

  const canSign = signMessage !== undefined || walletSignIn !== undefined;
  const value = useMemo<Session>(() => {
    const me = meQuery.data ?? undefined;
    return {
      status: sessionStatus({ pending: meQuery.isPending, me: meQuery.data }),
      me,
      restoreError: meQuery.isError ? describeError(meQuery.error) : undefined,
      phase,
      blocker: signInBlocker({ connected, hasAddress: address !== undefined, canSign, phase }),
      wallet: address,
      walletMismatch: walletMismatch(me?.workspace, address),
      signIn,
      signOut,
      refresh,
    };
  }, [meQuery.data, meQuery.isPending, meQuery.isError, meQuery.error, phase, connected, address, canSign, signIn, signOut, refresh]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** The current session. */
export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (ctx === undefined) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
