/**
 * Header wallet control: connect (injected / EIP-6963 wallets, WalletConnect when configured),
 * wrong-network switch, and a small account menu (balance, explorer, copy, disconnect).
 *
 * @module components/WalletButton
 */
import { useEffect, useRef, useState } from 'react';
import { useBalance, useConnect, useConnection, useConnectors, useDisconnect } from 'wagmi';
import { TARGET_CHAIN } from '../config';
import { formatEth, shortAddress } from '../format';
import { useChainSwitch } from '../hooks/useChainSwitch';
import { addressUrl } from '../lib/chain';
import { describeError } from '../lib/errors';
import { CopyButton, ExternalLink } from './common';

function useClickOutside(onOutside: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) onOutside();
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [onOutside]);
  return ref;
}

/** Connector picker used by the header button and by {@link ChainGuard}. */
export function ConnectMenu({ onDone }: { onDone?: () => void }) {
  const connectors = useConnectors();
  const connect = useConnect();
  // EIP-6963 wallets (MetaMask, Rabby, ...) are listed individually; the generic injected
  // connector is only shown when none was discovered but window.ethereum exists.
  const discovered = connectors.filter((c) => c.type === 'injected' && c.id !== 'injected');
  const hasLegacyProvider = typeof window !== 'undefined' && 'ethereum' in window && window.ethereum !== undefined;
  const visible = connectors.filter((c) => c.id !== 'injected' || (discovered.length === 0 && hasLegacyProvider));
  return (
    <div className="space-y-1">
      {visible.length === 0 && (
        <p className="text-dim">
          No wallet found. Install a browser wallet such as MetaMask or Rabby, then reload.
        </p>
      )}
      {visible.map((connector) => (
        <button
          key={connector.uid}
          type="button"
          className="btn w-full justify-start"
          disabled={connect.isPending}
          onClick={() =>
            connect.mutate(
              { connector, chainId: TARGET_CHAIN.id },
              { onSuccess: () => onDone?.() },
            )
          }
        >
          {connector.icon !== undefined && <img src={connector.icon} alt="" className="h-4 w-4" />}
          <span>{connector.id === 'injected' ? 'Browser wallet' : connector.name}</span>
        </button>
      ))}
      {connect.error !== null && <p className="text-[12px] text-danger">{describeError(connect.error)}</p>}
    </div>
  );
}

/** Header wallet button. */
export function WalletButton() {
  const connection = useConnection();
  const disconnect = useDisconnect();
  const chainSwitch = useChainSwitch();
  const [open, setOpen] = useState(false);
  const ref = useClickOutside(() => setOpen(false));
  const balance = useBalance({
    address: connection.address,
    chainId: TARGET_CHAIN.id,
    query: { enabled: connection.address !== undefined && !chainSwitch.wrongChain, refetchInterval: 10_000 },
  });

  if (connection.isConnected && chainSwitch.wrongChain) {
    return (
      <div className="flex flex-col items-end">
        <button type="button" className="btn btn-danger btn-sm" disabled={chainSwitch.pending} onClick={() => void chainSwitch.switchToTarget()}>
          {chainSwitch.pending ? 'Switching…' : `Switch to ${TARGET_CHAIN.name}`}
        </button>
        {chainSwitch.error !== null && <span className="mt-1 max-w-64 text-right text-[11px] text-danger">{chainSwitch.error}</span>}
      </div>
    );
  }

  return (
    <div className="relative" ref={ref}>
      {connection.isConnected && connection.address !== undefined ? (
        <button type="button" className="btn btn-sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-acid" />
          <span className="tabular-nums">{shortAddress(connection.address)}</span>
          {balance.data !== undefined && <span className="hidden text-dim sm:inline">{formatEth(balance.data.value, { maxFraction: 3 })}</span>}
        </button>
      ) : (
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          {connection.status === 'reconnecting' || connection.status === 'connecting' ? 'Connecting…' : 'Connect wallet'}
        </button>
      )}
      {open && (
        <div className="panel absolute right-0 z-30 mt-2 w-72 p-3 shadow-2xl shadow-black/60">
          {connection.isConnected && connection.address !== undefined ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-dim">account</span>
                <CopyButton value={connection.address} />
              </div>
              <p className="break-all text-[12px] tabular-nums">{connection.address}</p>
              <dl>
                <div className="kv">
                  <dt>network</dt>
                  <dd>{TARGET_CHAIN.name}</dd>
                </div>
                <div className="kv">
                  <dt>balance</dt>
                  <dd>{balance.data !== undefined ? formatEth(balance.data.value) : '…'}</dd>
                </div>
              </dl>
              <div className="flex gap-2">
                <ExternalLink href={addressUrl(connection.address)} className="btn btn-sm flex-1">
                  explorer
                </ExternalLink>
                <button
                  type="button"
                  className="btn btn-sm flex-1"
                  onClick={() => {
                    disconnect.mutate();
                    setOpen(false);
                  }}
                >
                  disconnect
                </button>
              </div>
            </div>
          ) : (
            <ConnectMenu onDone={() => setOpen(false)} />
          )}
        </div>
      )}
    </div>
  );
}
