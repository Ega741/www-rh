/**
 * Runs a sequence of wallet transactions (approve → burn, approve → openBudget) and tracks each
 * step with the pure reducer of `lib/steps.ts`: sign → pending → confirmed, or failed.
 */
import { useCallback, useReducer } from 'react';
import { usePublicClient } from 'wagmi';
import type { Hex } from 'viem';
import { config } from '../config.js';
import { describeError } from '../lib/errors.js';
import { EMPTY_FLOW, reduceFlow, type FlowState } from '../lib/steps.js';

/** One step to execute. */
export interface TxStep {
  id: string;
  label: string;
  /** Skip this step (e.g. allowance already sufficient). */
  skip?: boolean;
  /** Sends the transaction and resolves with its hash. */
  write(): Promise<Hex>;
  /** Called once the step is confirmed (refresh reads). */
  onConfirmed?(): void | Promise<unknown>;
}

/** What {@link useTxFlow} returns. */
export interface TxFlow {
  state: FlowState;
  running: boolean;
  /** Runs `steps` in order; resolves `true` when every step confirmed. */
  run(steps: TxStep[]): Promise<boolean>;
  reset(): void;
}

/** Transaction flow runner bound to the app chain's public client. */
export function useTxFlow(): TxFlow {
  const client = usePublicClient({ chainId: config.chainId });
  const [state, dispatch] = useReducer(reduceFlow, EMPTY_FLOW);

  const run = useCallback(
    async (steps: TxStep[]): Promise<boolean> => {
      dispatch({ type: 'init', steps: steps.map((s) => ({ id: s.id, label: s.label })) });
      for (const step of steps) {
        if (step.skip === true) {
          dispatch({ type: 'skip', id: step.id });
          continue;
        }
        dispatch({ type: 'signing', id: step.id });
        try {
          const hash = await step.write();
          dispatch({ type: 'sent', id: step.id, hash });
          if (client === undefined) throw new Error('No RPC client for the app chain');
          const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 180_000 });
          if (receipt.status !== 'success') throw new Error('Transaction reverted on chain');
          dispatch({ type: 'confirmed', id: step.id });
          await step.onConfirmed?.();
        } catch (e) {
          dispatch({ type: 'failed', id: step.id, error: describeError(e) });
          return false;
        }
      }
      return true;
    },
    [client],
  );

  const reset = useCallback(() => dispatch({ type: 'reset' }), []);
  return { state, running: state.status === 'running', run, reset };
}
