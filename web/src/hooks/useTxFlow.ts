/**
 * Runs a sequence of wallet transactions (approve → burnForCreditMin, approve → openBudget) and
 * tracks each step with the pure reducer of `lib/steps.ts`: sign → pending → confirmed, or failed.
 * A step may carry a `simulate` dry run: it is awaited before the wallet prompt (so a sure revert
 * such as `SlippageExceeded` is decoded instead of costing a signature) and re-run after an
 * on-chain revert to explain it.
 */
import { useCallback, useReducer } from 'react';
import { usePublicClient } from 'wagmi';
import type { Hex } from 'viem';
import { config } from '../config.js';
import { describeError, revertName } from '../lib/errors.js';
import { EMPTY_FLOW, reduceFlow, type FlowState } from '../lib/steps.js';

/** One step to execute. */
export interface TxStep {
  id: string;
  label: string;
  /** Skip this step (e.g. allowance already sufficient). */
  skip?: boolean;
  /**
   * Dry run of the call (`publicClient.simulateContract`), rejecting with the decoded contract error.
   * Awaited before {@link write}; re-run when the mined transaction reverted, to name the reason.
   */
  simulate?: (() => Promise<unknown>) | undefined;
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

/**
 * Dry run before the wallet prompt. A decoded contract revert (`SlippageExceeded`, `PriceStale`,
 * `BurnTooSmall`, …) is fatal: the transaction would fail and the message is better than a
 * wallet's. Anything else (RPC hiccup, undecodable failure) defers to the wallet's own estimate.
 */
async function preflight(simulate: () => Promise<unknown>): Promise<void> {
  try {
    await simulate();
  } catch (e) {
    if (revertName(e) !== undefined) throw e;
  }
}

/**
 * Why a mined transaction reverted: the decoded contract error of a re-simulation when the step
 * has one and it still reverts with a custom error, else a generic error.
 */
async function explainRevert(step: TxStep): Promise<unknown> {
  if (step.simulate !== undefined) {
    try {
      await step.simulate();
    } catch (e) {
      if (revertName(e) !== undefined) return e;
    }
  }
  return new Error('Transaction reverted on chain');
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
          if (step.simulate !== undefined) await preflight(step.simulate);
          const hash = await step.write();
          dispatch({ type: 'sent', id: step.id, hash });
          if (client === undefined) throw new Error('No RPC client for the app chain');
          const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 180_000 });
          if (receipt.status !== 'success') throw await explainRevert(step);
          dispatch({ type: 'confirmed', id: step.id });
          await step.onConfirmed?.();
        } catch (e) {
          dispatch({ type: 'failed', id: step.id, error: describeError(e), revert: revertName(e) });
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
