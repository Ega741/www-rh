/** Connect / account menu: connectors list, address, sign-in / sign-out, disconnect. */
import { useEffect, useRef, useState } from 'react';
import { useConnect, useConnection, useConnectors, useDisconnect } from 'wagmi';
import { config } from '../config.js';
import { useSession } from '../hooks/useSession.jsx';
import { useToast } from '../hooks/useToast.jsx';
import { describeError } from '../lib/errors.js';
import { shortAddress } from '../lib/explorer.js';
import { phaseLabel } from '../lib/session.js';
import { AddressText } from './Hash.jsx';
import { Badge, Button, Dot } from './ui.jsx';

/** The header wallet control. */
export function WalletButton() {
  const { address, isConnected, status, chainId } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const session = useSession();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

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

  const onConnect = (uid: string) => {
    const connector = connectors.find((c) => c.uid === uid);
    if (connector === undefined) return;
    connect.mutate(
      { connector, chainId: config.chainId },
      {
        onSuccess: () => setOpen(false),
        onError: (e) => toast.push({ kind: 'error', title: 'Connection failed', message: describeError(e) }),
      },
    );
  };

  const wrongChain = isConnected && chainId !== config.chainId;
  const label = status === 'reconnecting' || status === 'connecting' ? 'Connecting…' : isConnected && address !== undefined ? shortAddress(address) : 'Connect wallet';

  return (
    <div className="relative" ref={ref}>
      <Button variant={isConnected ? 'secondary' : 'primary'} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} className="font-mono">
        {isConnected ? <Dot tone={session.status === 'authenticated' ? 'ok' : wrongChain ? 'warn' : 'neutral'} /> : null}
        {label}
      </Button>
      {open ? (
        <div role="menu" className="absolute right-0 z-40 mt-2 w-72 rounded-xl border border-line bg-elevated p-3 text-sm shadow-xl">
          {!isConnected ? (
            <>
              <p className="mb-2 text-xs uppercase tracking-wider text-muted">Choose a wallet</p>
              {connectors.length === 0 ? <p className="text-muted">No wallet connector available.</p> : null}
              <ul className="space-y-1">
                {connectors.map((c) => (
                  <li key={c.uid}>
                    <button
                      type="button"
                      role="menuitem"
                      className="flex w-full items-center justify-between rounded-lg border border-line px-3 py-2 text-left hover:border-muted disabled:opacity-50"
                      disabled={connect.isPending}
                      onClick={() => onConnect(c.uid)}
                    >
                      <span>{c.name}</span>
                      {c.type === 'injected' ? <Badge>browser</Badge> : c.type === 'walletConnect' ? <Badge>QR</Badge> : null}
                    </button>
                  </li>
                ))}
              </ul>
              {connect.isPending ? <p className="mt-2 text-xs text-muted">Confirm in your wallet…</p> : null}
            </>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs uppercase tracking-wider text-muted">Account</span>
                {address !== undefined ? <AddressText address={address} copy /> : null}
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-xs uppercase tracking-wider text-muted">Chain</span>
                <Badge tone={wrongChain ? 'warn' : 'ok'}>{wrongChain ? `chain ${chainId ?? '?'}` : config.chain.name}</Badge>
              </div>
              <div className="mt-2 flex items-center justify-between gap-2">
                <span className="text-xs uppercase tracking-wider text-muted">Session</span>
                {session.status === 'authenticated' && session.me !== undefined ? (
                  <Badge tone={session.walletMismatch ? 'warn' : 'ok'} title={session.walletMismatch ? 'Signed in as another address' : undefined}>
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
                <Button variant="ghost" onClick={() => disconnect.mutate(undefined, { onSuccess: () => setOpen(false) })}>
                  Disconnect
                </Button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
