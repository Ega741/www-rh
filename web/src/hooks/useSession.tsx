/**
 * Session state: restore via `GET /api/me`, SIWE sign-in (`nonce → createSiweMessage →
 * signMessage → verify`), logout. Exposed through a context so the whole app shares one query.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useConnection, useSignMessage } from 'wagmi';
import type { MeDto } from '@beagle/shared/api';
import { api, isApiError, sessionToken } from '../api.js';
import { config, publicGatewayUrl } from '../config.js';
import { describeError } from '../lib/errors.js';
import { sessionStatus, signInBlocker, walletMismatch, type SessionStatus, type SignInPhase } from '../lib/session.js';
import { buildSiweMessage } from '../lib/siwe.js';
import { clearWorkspaceQueries, qk } from '../queries.js';
import { useToast } from './useToast.js';

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
  /** The connected wallet differs from the signed-in workspace. */
  walletMismatch: boolean;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  refresh(): Promise<void>;
}

const SessionContext = createContext<Session | undefined>(undefined);

/** Provides {@link useSession}. Must sit inside Wagmi, Query and Toast providers. */
export function SessionProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const toast = useToast();
  const { address, isConnected } = useConnection();
  const { mutateAsync: signMessageAsync } = useSignMessage();
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

  const signIn = useCallback(async () => {
    if (!isConnected || address === undefined) {
      toast.push({ kind: 'warning', title: 'Connect a wallet first' });
      return;
    }
    try {
      setPhase('nonce');
      const { nonce } = await api.nonce();
      setPhase('signing');
      const message = buildSiweMessage({
        address,
        chainId: config.chainId,
        nonce,
        gatewayUrl: config.gatewayUrl,
        pageOrigin: publicGatewayUrl(),
        now: new Date(),
      });
      const signature = await signMessageAsync({ message });
      setPhase('verifying');
      const { token } = await api.verify(message, signature);
      if (token !== '') sessionToken.set(token);
      await client.invalidateQueries({ queryKey: qk.me });
      toast.push({ kind: 'success', title: 'Signed in' });
    } catch (e) {
      toast.push({ kind: 'error', title: 'Sign-in failed', message: describeError(e) });
    } finally {
      setPhase('idle');
    }
  }, [address, isConnected, signMessageAsync, client, toast]);

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

  const value = useMemo<Session>(() => {
    const me = meQuery.data ?? undefined;
    return {
      status: sessionStatus({ pending: meQuery.isPending, me: meQuery.data }),
      me,
      restoreError: meQuery.isError ? describeError(meQuery.error) : undefined,
      phase,
      blocker: signInBlocker({ connected: isConnected, hasAddress: address !== undefined, phase }),
      walletMismatch: walletMismatch(me?.workspace, address),
      signIn,
      signOut,
      refresh,
    };
  }, [meQuery.data, meQuery.isPending, meQuery.isError, meQuery.error, phase, isConnected, address, signIn, signOut, refresh]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** The current session. */
export function useSession(): Session {
  const ctx = useContext(SessionContext);
  if (ctx === undefined) throw new Error('useSession must be used inside <SessionProvider>');
  return ctx;
}
