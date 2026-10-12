/**
 * Turns thrown values (wallet adapter, `@solana/web3.js`, the API client, plain errors) into short
 * English messages for toasts and inline notes. SPL Token program errors (custom codes in a
 * transaction error or in simulation logs) get specific text; a wallet dismissal is recognised
 * across the adapters' varied messages.
 */
import { SendTransactionError, TransactionExpiredBlockheightExceededError, TransactionExpiredTimeoutError, type TransactionError } from '@solana/web3.js';
import { WalletError, WalletNotConnectedError, WalletSendTransactionError, WalletSignInError, WalletSignMessageError, WalletSignTransactionError } from '@solana/wallet-adapter-base';
import { ApiError } from './apiError.js';

/** SPL Token program error codes (`TokenError` in the program) worth a sentence. */
export const TOKEN_ERROR_TEXT: Readonly<Record<number, string>> = {
  0: 'The account is not rent-exempt',
  1: 'Insufficient token balance',
  2: 'Invalid mint',
  3: 'The token account does not belong to this mint',
  4: 'Owner does not match: the connected wallet does not own this token account',
  5: 'The mint has a fixed supply',
  6: 'The account is already in use',
  9: 'The token account is not initialized',
  12: 'Invalid instruction',
  13: 'Invalid account state',
  14: 'Arithmetic overflow',
  17: 'The token account is frozen',
  18: 'Decimals do not match the mint',
};

/** Thrown by `useTxFlow` when a sent transaction confirmed with an error (`SignatureResult.err`). */
export class TransactionFailedError extends Error {
  override readonly name = 'TransactionFailedError';
  readonly signature: string;
  readonly chainError: TransactionError;
  constructor(signature: string, chainError: TransactionError) {
    super(describeTransactionError(chainError));
    this.signature = signature;
    this.chainError = chainError;
  }
}

/** Thrown by `useTxFlow` when the wallet is not connected or cannot sign. */
export class WalletUnavailableError extends Error {
  override readonly name = 'WalletUnavailableError';
}

const REJECT_RE = /reject|denied|declined|cancel|dismiss|closed the (wallet|window)|user (refused|abort)/i;

/** `true` when the user dismissed the wallet prompt (sign, send or connect). */
export function isUserRejection(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const e = err as { message?: unknown; code?: unknown; error?: unknown; name?: unknown };
  if (e.code === 4001 || (typeof e.error === 'object' && e.error !== null && (e.error as { code?: unknown }).code === 4001)) return true;
  const message = typeof e.message === 'string' ? e.message : '';
  if (err instanceof WalletSignTransactionError || err instanceof WalletSendTransactionError || err instanceof WalletSignMessageError) {
    return REJECT_RE.test(message) || (e.error instanceof Error && REJECT_RE.test(e.error.message));
  }
  return REJECT_RE.test(message) && (e.name === 'WalletError' || /wallet/i.test(message) || /user/i.test(message));
}

/**
 * `true` for adapter errors that a page flow already reports inline (`useTxFlow` shows the failed
 * step, `useSession.signIn` its own toast): the adapter also emits them as `error` events, and the
 * global handler must not toast them a second time. Connection / readiness errors stay global.
 */
export function isFlowHandledWalletError(err: unknown): boolean {
  return err instanceof WalletSendTransactionError || err instanceof WalletSignTransactionError || err instanceof WalletSignMessageError || err instanceof WalletSignInError;
}

/** The SPL Token custom error code of `err` (`{ InstructionError: [i, { Custom: n }] }`), if any. */
export function customErrorCode(err: TransactionError | undefined | null): number | undefined {
  if (err === undefined || err === null || typeof err !== 'object') return undefined;
  const ie = (err as { InstructionError?: unknown }).InstructionError;
  if (!Array.isArray(ie) || ie.length < 2) return undefined;
  const inner = ie[1] as unknown;
  if (typeof inner === 'object' && inner !== null && typeof (inner as { Custom?: unknown }).Custom === 'number') return (inner as { Custom: number }).Custom;
  return undefined;
}

/** Text for a confirmed-but-failed transaction. */
export function describeTransactionError(err: TransactionError): string {
  if (typeof err === 'string') return err === 'InsufficientFundsForFee' ? 'Not enough SOL to pay the transaction fee' : `Transaction failed: ${err}`;
  const code = customErrorCode(err);
  if (code !== undefined) return TOKEN_ERROR_TEXT[code] ?? `Transaction failed: program error ${code}`;
  const ie = (err as { InstructionError?: unknown }).InstructionError;
  if (Array.isArray(ie) && typeof ie[1] === 'string') return `Transaction failed: ${ie[1]}`;
  return 'Transaction failed on chain';
}

const LOG_PATTERNS: readonly [RegExp, string][] = [
  [/insufficient funds/i, 'Insufficient token balance'],
  [/insufficient lamports|InsufficientFundsForFee|debit an account but found no record of a prior credit/i, 'Not enough SOL to pay the transaction fee'],
  [/owner does not match/i, 'Owner does not match: the connected wallet does not own this token account'],
  [/Account not associated with this Mint|MintMismatch/i, 'The token account does not belong to this mint'],
  [/Account is frozen/i, 'The token account is frozen'],
  [/could not find account|AccountNotFound|invalid account data for instruction/i, 'Token account not found (no BEAGLE was ever received by this wallet)'],
  [/Blockhash not found|block height exceeded/i, 'The transaction expired before it was processed; try again'],
];

/** Explains simulation / send failures from the program logs; `undefined` when nothing is recognised. */
export function describeLogs(logs: readonly string[] | undefined, message = ''): string | undefined {
  const text = `${logs?.join('\n') ?? ''}\n${message}`;
  for (const [re, out] of LOG_PATTERNS) if (re.test(text)) return out;
  const custom = /custom program error: 0x([0-9a-f]+)/i.exec(text);
  if (custom !== null) {
    const code = Number.parseInt(custom[1] as string, 16);
    return TOKEN_ERROR_TEXT[code] ?? `Program error ${code}`;
  }
  return undefined;
}

/** Program logs carried by `err` (`SendTransactionError`), for a details disclosure. */
export function errorLogs(err: unknown): readonly string[] | undefined {
  if (err instanceof SendTransactionError) return err.logs;
  const inner = (err as { error?: unknown } | null)?.error;
  if (inner instanceof SendTransactionError) return inner.logs;
  return undefined;
}

/** Signature of a failed transaction when the error knows it. */
export function errorSignature(err: unknown): string | undefined {
  if (err instanceof TransactionFailedError) return err.signature;
  if (err instanceof TransactionExpiredBlockheightExceededError || err instanceof TransactionExpiredTimeoutError) return err.signature;
  return undefined;
}

/** Short, user-facing description of `err`. */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    return err.code === `http_${err.status}` ? err.message : `${err.message} (${err.code})`;
  }
  if (isUserRejection(err)) return 'Request rejected in the wallet';
  if (err instanceof TransactionFailedError || err instanceof WalletUnavailableError) return err.message;
  if (err instanceof TransactionExpiredBlockheightExceededError) return 'The transaction expired before confirmation (its blockhash is too old); check the explorer and try again';
  if (err instanceof TransactionExpiredTimeoutError) return 'Timed out waiting for confirmation; check the explorer before retrying';
  if (err instanceof SendTransactionError) {
    return describeLogs(err.logs, err.message) ?? `Transaction rejected by the RPC: ${err.transactionError.message}`;
  }
  if (err instanceof WalletNotConnectedError) return 'Connect a wallet first';
  if (err instanceof WalletError) {
    const inner = err.error;
    if (inner instanceof SendTransactionError) return describeLogs(inner.logs, inner.message) ?? `Transaction rejected by the RPC: ${inner.transactionError.message}`;
    const fromLogs = describeLogs(undefined, err.message);
    if (fromLogs !== undefined) return fromLogs;
    if (err.message !== '') return err.message;
    if (inner instanceof Error && inner.message !== '') return inner.message;
    return err.name;
  }
  if (err instanceof Error) {
    const fromLogs = describeLogs(undefined, err.message);
    if (fromLogs !== undefined) return fromLogs;
    return err.message === '' ? err.name : err.message;
  }
  if (typeof err === 'string') return err;
  return 'Something went wrong';
}
