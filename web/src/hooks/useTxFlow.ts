/**
 * Runs wallet transactions one step at a time (each step = one transaction = one wallet
 * confirmation) and tracks them with the pure reducer of `lib/steps.ts`: sign → pending →
 * confirmed, or failed. A step provides its instructions; the hook wraps them in a legacy
 * `Transaction` with a fresh blockhash, sends it through the wallet adapter's `sendTransaction`
 * (the wallet simulates, signs and submits) and confirms with the blockhash / lastValidBlockHeight
 * pair (SPEC §7).
 */
import { useCallback, useReducer } from 'react';
import { useConnection, useWallet } from '@solana/wallet-adapter-react';
import { Transaction, type TransactionInstruction } from '@solana/web3.js';
import { TransactionFailedError, WalletUnavailableError, describeError, errorLogs, errorSignature } from '../lib/errors.js';
import { EMPTY_FLOW, reduceFlow, type FlowState } from '../lib/steps.js';

/** One step to execute. */
export interface TxStep {
  id: string;
  label: string;
  /** Skip this step (nothing to do on chain). */
  skip?: boolean;
  /** Builds the instructions of this transaction (called when the step starts). */
  instructions(): TransactionInstruction[] | Promise<TransactionInstruction[]>;
  /** Called once the step is confirmed (refresh reads, register with the gateway). */
  onConfirmed?(signature: string): void | Promise<unknown>;
}

/** What {@link useTxFlow} returns. */
export interface TxFlow {
  state: FlowState;
  running: boolean;
  /** Runs `steps` in order; resolves the signature of the last transaction, or `undefined` when a step failed. */
  run(steps: TxStep[]): Promise<string | undefined>;
  reset(): void;
}

/** Commitment of the send preflight and the confirmation. */
export const TX_COMMITMENT = 'confirmed' as const;

/** Transaction flow runner bound to the wallet adapter and the cluster connection. */
export function useTxFlow(): TxFlow {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, connected } = useWallet();
  const [state, dispatch] = useReducer(reduceFlow, EMPTY_FLOW);

  const run = useCallback(
    async (steps: TxStep[]): Promise<string | undefined> => {
      dispatch({ type: 'init', steps: steps.map((s) => ({ id: s.id, label: s.label })) });
      let last: string | undefined;
      for (const step of steps) {
        if (step.skip === true) {
          dispatch({ type: 'skip', id: step.id });
          continue;
        }
        dispatch({ type: 'signing', id: step.id });
        let signature: string | undefined;
        try {
          if (!connected || publicKey === null) throw new WalletUnavailableError('Connect a wallet first');
          const instructions = await step.instructions();
          const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(TX_COMMITMENT);
          const tx = new Transaction({ feePayer: publicKey, blockhash, lastValidBlockHeight }).add(...instructions);
          signature = await sendTransaction(tx, connection, { preflightCommitment: TX_COMMITMENT });
          dispatch({ type: 'sent', id: step.id, signature });
          const result = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, TX_COMMITMENT);
          if (result.value.err !== null) throw new TransactionFailedError(signature, result.value.err);
          dispatch({ type: 'confirmed', id: step.id });
          last = signature;
          await step.onConfirmed?.(signature);
        } catch (e) {
          dispatch({ type: 'failed', id: step.id, error: describeError(e), signature: signature ?? errorSignature(e), logs: errorLogs(e) });
          return undefined;
        }
      }
      return last;
    },
    [connection, connected, publicKey, sendTransaction],
  );

  const reset = useCallback(() => dispatch({ type: 'reset' }), []);
  return { state, running: state.status === 'running', run, reset };
}
