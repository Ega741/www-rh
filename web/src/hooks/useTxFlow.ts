/**
 * Transaction lifecycle around `useWriteContract` + `useWaitForTransactionReceipt` (W5):
 * `idle → signing → pending → confirmed | reverted | error`.
 *
 * Usage: `const write = useWriteContract(); const tx = useTxFlow({ onConfirmed });`
 * then `tx.run(() => write.mutateAsync({ abi, address, functionName, args, ... }))` — the closure
 * keeps wagmi's per-call ABI typing.
 *
 * @module hooks/useTxFlow
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Hex, TransactionReceipt } from 'viem';
import { useWaitForTransactionReceipt } from 'wagmi';
import { TARGET_CHAIN } from '../config';
import { describeError, isUserRejection, revertErrorName } from '../lib/errors';

/** Lifecycle phase of a transaction. */
export type TxPhase = 'idle' | 'signing' | 'pending' | 'confirmed' | 'reverted' | 'error';

/** Return value of {@link useTxFlow}. */
export interface TxFlow {
  phase: TxPhase;
  hash: Hex | undefined;
  receipt: TransactionReceipt | undefined;
  error: string | null;
  busy: boolean;
  /** Sends a transaction produced by `send` and tracks it until mined. Resolves to the hash, or `null` on failure. */
  run: (send: () => Promise<Hex>) => Promise<Hex | null>;
  reset: () => void;
}

/** Options of {@link useTxFlow}. */
export interface TxFlowOptions {
  /** Fires once per successful receipt. */
  onConfirmed?: (receipt: TransactionReceipt) => void;
  /**
   * Called with the custom error name when sending fails with a contract revert (simulation);
   * return `true` to treat it as handled (phase back to `idle`, no error shown).
   */
  onRevert?: (errorName: string) => boolean;
}

/** Tracks one transaction at a time. */
export function useTxFlow(options: TxFlowOptions = {}): TxFlow {
  const [phase, setPhase] = useState<TxPhase>('idle');
  const [hash, setHash] = useState<Hex | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const onConfirmed = useRef(options.onConfirmed);
  onConfirmed.current = options.onConfirmed;
  const onRevert = useRef(options.onRevert);
  onRevert.current = options.onRevert;
  const handled = useRef<Hex | null>(null);

  const wait = useWaitForTransactionReceipt({
    hash,
    chainId: TARGET_CHAIN.id,
    query: { enabled: hash !== undefined },
  });

  useEffect(() => {
    if (hash === undefined || handled.current === hash) return;
    if (wait.isSuccess) {
      handled.current = hash;
      if (wait.data.status === 'success') {
        setPhase('confirmed');
        onConfirmed.current?.(wait.data);
      } else {
        setPhase('reverted');
        setError('The transaction was mined but reverted.');
      }
    } else if (wait.isError) {
      handled.current = hash;
      setPhase('error');
      setError(describeError(wait.error));
    }
  }, [hash, wait.isSuccess, wait.isError, wait.data, wait.error]);

  const run = useCallback(async (send: () => Promise<Hex>): Promise<Hex | null> => {
    setError(null);
    setHash(undefined);
    setPhase('signing');
    try {
      const h = await send();
      setHash(h);
      setPhase('pending');
      return h;
    } catch (e) {
      const name = revertErrorName(e);
      if (name !== null && onRevert.current?.(name) === true) {
        setPhase('idle');
        return null;
      }
      setPhase(isUserRejection(e) ? 'idle' : 'error');
      setError(describeError(e));
      return null;
    }
  }, []);

  const reset = useCallback(() => {
    setPhase('idle');
    setHash(undefined);
    setError(null);
  }, []);

  return {
    phase,
    hash,
    receipt: wait.data,
    error,
    busy: phase === 'signing' || phase === 'pending',
    run,
    reset,
  };
}
