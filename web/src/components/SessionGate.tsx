/** Gate for `/app/*`: shows the sign-in panel until a session exists, then the app sub-nav. */
import { NavLink, Outlet } from 'react-router';
import { useWallet } from '@solana/wallet-adapter-react';
import { useSession } from '../hooks/useSession.jsx';
import { phaseLabel } from '../lib/session.js';
import { Button, Note, Skeleton } from './ui.jsx';
import { WalletButton } from './WalletButton.jsx';

const APP_NAV = [
  { to: '/app', label: 'Overview', end: true },
  { to: '/app/credits', label: 'Credits' },
  { to: '/app/keys', label: 'Keys' },
  { to: '/app/usage', label: 'Usage' },
  { to: '/app/providers', label: 'Providers' },
  { to: '/app/upgrades', label: 'Upgrades' },
  { to: '/app/budgets', label: 'Budgets' },
] as const;

/** Sign-in panel. */
export function SignInPanel() {
  const session = useSession();
  const { connected } = useWallet();
  return (
    <div className="mx-auto mt-6 max-w-md">
      <div className="card text-center">
        <p className="font-mono text-xs uppercase tracking-widest text-accent">workspace = wallet</p>
        <h1 className="mt-2 text-xl font-semibold">Sign in with your Solana wallet</h1>
        <p className="mt-2 text-sm text-muted">Connect a wallet, then sign a message (Sign-In-With-Solana: no transaction, no fee). New wallets get a workspace on first sign-in. No e-mail, no card.</p>
        <div className="mt-5 flex flex-col items-center gap-2">
          {!connected ? (
            <WalletButton />
          ) : (
            <Button variant="primary" busy={session.phase !== 'idle'} disabled={session.blocker !== undefined} reason={session.blocker} onClick={() => void session.signIn()}>
              {phaseLabel(session.phase)}
            </Button>
          )}
        </div>
        {session.restoreError !== undefined ? (
          <div className="mt-4 text-left">
            <Note tone="warn" title="Could not restore the session">
              {session.restoreError}
            </Note>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** `/app` layout. */
export function AppShell() {
  const session = useSession();
  if (session.status === 'loading') {
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-28 w-full" />
      </div>
    );
  }
  if (session.status !== 'authenticated') return <SignInPanel />;
  return (
    <div>
      <nav aria-label="App" className="-mx-4 mb-6 overflow-x-auto border-b border-line px-4">
        <ul className="flex min-w-max gap-1">
          {APP_NAV.map((n) => (
            <li key={n.to}>
              <NavLink
                to={n.to}
                end={'end' in n ? n.end : false}
                className={({ isActive }) => `inline-block border-b-2 px-3 py-2 text-sm ${isActive ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'}`}
              >
                {n.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      {session.walletMismatch && session.me !== undefined ? (
        <div className="mb-4">
          <Note tone="warn" title="Wallet differs from the signed-in workspace">
            You are signed in as <span className="font-mono">{session.me.workspace}</span>; the connected wallet is another account. Credits you buy here still go to the signed-in workspace (the burn carries a memo naming it), paid from the connected wallet. Budgets are different: a budget funds the workspace of the wallet that delegates, so opening one is disabled until you sign in with the connected wallet. Sign out and in again to switch workspaces.
          </Note>
        </div>
      ) : null}
      <Outlet />
    </div>
  );
}
