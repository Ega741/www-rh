/**
 * Gate for write actions: renders `children` only when a wallet is connected to the target
 * chain and the launchpad (curve mode) or registry (Pons mode) address is configured; otherwise
 * shows the next step (connect, switch / add Robinhood Chain, or a configuration notice).
 *
 * @module components/ChainGuard
 */
import { useState, type ReactNode } from 'react';
import { useConnection } from 'wagmi';
import { CORE_ADDRESS, CORE_ENV_VAR, CORE_LABEL, TARGET_CHAIN, VENUE } from '../config';
import { useChainSwitch } from '../hooks/useChainSwitch';
import { ConnectMenu } from './WalletButton';

/** Props of {@link ChainGuard}. */
export interface ChainGuardProps {
  children: ReactNode;
  /** Verb shown in the prompts, e.g. "trade", "create a coin". */
  action?: string;
  /** Render the prompts as compact single buttons. */
  compact?: boolean;
  /** Sit inside a row next to an input: short labels, no full width. */
  inline?: boolean;
}

/** See module docs. */
export function ChainGuard({ children, action = 'continue', compact = false, inline = false }: ChainGuardProps) {
  const connection = useConnection();
  const chainSwitch = useChainSwitch();
  const [picking, setPicking] = useState(false);

  if (CORE_ADDRESS === null) {
    if (inline) return <span className="self-center text-[11px] text-amber">{CORE_LABEL} not configured</span>;
    return (
      <p className="rounded border border-amber/40 bg-amber/5 p-2 text-[12px] text-amber">
        No {VENUE === 'pons' ? 'PonsMindRegistry' : 'launchpad'} is configured for {TARGET_CHAIN.name}. Set {CORE_ENV_VAR} (or sync contracts/deployments) to
        enable on-chain actions.
      </p>
    );
  }

  if (!connection.isConnected) {
    if (picking) return <ConnectMenu onDone={() => setPicking(false)} />;
    if (inline) {
      return (
        <button type="button" className="btn btn-primary btn-sm shrink-0" onClick={() => setPicking(true)}>
          Connect
        </button>
      );
    }
    return (
      <button type="button" className={`btn btn-primary w-full ${compact ? 'btn-sm' : ''}`} onClick={() => setPicking(true)}>
        Connect wallet to {action}
      </button>
    );
  }

  if (chainSwitch.wrongChain) {
    if (inline) {
      return (
        <button type="button" className="btn btn-danger btn-sm shrink-0" disabled={chainSwitch.pending} onClick={() => void chainSwitch.switchToTarget()} title={chainSwitch.error ?? undefined}>
          {chainSwitch.pending ? 'Switching…' : 'Switch network'}
        </button>
      );
    }
    return (
      <div>
        <button type="button" className={`btn btn-danger w-full ${compact ? 'btn-sm' : ''}`} disabled={chainSwitch.pending} onClick={() => void chainSwitch.switchToTarget()}>
          {chainSwitch.pending ? 'Switching…' : `Switch to ${TARGET_CHAIN.name}`}
        </button>
        {!compact && (
          <p className="mt-1 text-[11px] text-dim">Your wallet will be asked to add {TARGET_CHAIN.name} (chain id {TARGET_CHAIN.id}) if it does not know it yet.</p>
        )}
        {chainSwitch.error !== null && <p className="mt-1 text-[12px] text-danger">{chainSwitch.error}</p>}
      </div>
    );
  }

  return <>{children}</>;
}
