/**
 * Connect / account menu: opens the wallet-adapter modal (wallet-standard wallets list
 * themselves), then shows the address, the cluster this page talks to, the session state,
 * sign-in / sign-out and disconnect.
 */
import { useEffect, useRef, useState } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useWalletModal } from '@solana/wallet-adapter-react-ui';
import { config } from '../config.js';
import { useSession } from '../hooks/useSession.jsx';
import { useToast } from '../hooks/useToast.jsx';
import { describeError, isUserRejection } from '../lib/errors.js';
import { shortAddress } from '../lib/explorer.js';
import { phaseLabel } from '../lib/session.js';
import { AddressText } from './Hash.jsx';
import { Badge, Button, Dot } from './ui.jsx';

/** The header wallet control. */
export function WalletButton() {
  const { publicKey, connected, connecting, disconnecting, wallet, disconnect } = useWallet();
  const { setVisible } = useWalletModal();
  const session = useSession();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const address = publicKey?.toBase58();

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const onDisconnect = () => {
    setOpen(false);
    disconnect().catch((e: unknown) => {
      if (!isUserRejection(e)) toast.push({ kind: 'error', title: 'Disconnect failed', message: describeError(e) });
    });
  };

  if (!connected || address === undefined) {
    return (
      <Button variant="primary" busy={connecting} onClick={() => setVisible(true)} className="font-mono">
        {connecting ? (
          'Connecting…'
        ) : (
          <>
            Connect<span className="hidden sm:inline"> wallet</span>
          </>
        )}
      </Button>
    );
  }

  return (
    <div className="relative" ref={ref}>
      <Button variant="secondary" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} className="font-mono">
        <Dot tone={session.status === 'authenticated' ? (session.walletMismatch ? 'warn' : 'ok') : 'neutral'} />
        {shortAddress(address)}
      </Button>
      {open ? (
        <div role="menu" className="absolute right-0 z-40 mt-2 w-72 rounded-xl border border-line bg-elevated p-3 text-sm shadow-xl">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs uppercase tracking-wider text-muted">{wallet?.adapter.name ?? 'Account'}</span>
            <AddressText address={address} copy />
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-xs uppercase tracking-wider text-muted">Cluster</span>
            <Badge tone="ok" title="The cluster this page sends transactions to; make sure the wallet is on the same network">
              {config.cluster}
            </Badge>
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-xs uppercase tracking-wider text-muted">Session</span>
            {session.status === 'authenticated' && session.me !== undefined ? (
              <Badge tone={session.walletMismatch ? 'warn' : 'ok'} title={session.walletMismatch ? 'Signed in as another wallet' : undefined}>
                {shortAddress(session.me.workspace)}
              </Badge>
            ) : (
              <Badge>signed out</Badge>
            )}
          </div>
          <div className="mt-3 flex flex-col gap-2">
            {session.status === 'authenticated' ? (
              <Button onClick={() => void session.signOut()}>Sign out</Button>
            ) : (
              <Button variant="primary" busy={session.phase !== 'idle'} reason={session.blocker} disabled={session.blocker !== undefined} onClick={() => void session.signIn()}>
                {phaseLabel(session.phase)}
              </Button>
            )}
            <Button variant="ghost" onClick={() => setVisible(true)}>
              Change wallet
            </Button>
            <Button variant="ghost" busy={disconnecting} onClick={onDisconnect}>
              Disconnect
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
