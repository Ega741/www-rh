import { describe, expect, it } from 'vitest';
import { SendTransactionError, TransactionExpiredBlockheightExceededError } from '@solana/web3.js';
import { WalletNotConnectedError, WalletSendTransactionError, WalletSignMessageError, WalletSignTransactionError } from '@solana/wallet-adapter-base';
import { ApiError } from './apiError.js';
import { TransactionFailedError, WalletUnavailableError, customErrorCode, describeError, describeLogs, describeTransactionError, errorLogs, errorSignature, isUserRejection } from './errors.js';

const SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

describe('user rejection', () => {
  it('recognises the adapters’ varied messages and the wallets’ 4001 rejection codes', () => {
    expect(isUserRejection(new WalletSignTransactionError('User rejected the request.'))).toBe(true);
    expect(isUserRejection(new WalletSendTransactionError('Transaction cancelled'))).toBe(true);
    expect(isUserRejection(new WalletSignMessageError('Signature request denied'))).toBe(true);
    expect(isUserRejection(new WalletSignTransactionError('', Object.assign(new Error('User rejected'), { code: 4001 })))).toBe(true);
    expect(isUserRejection({ code: 4001, message: 'x' })).toBe(true);
    expect(isUserRejection(new WalletSignTransactionError('Simulation failed'))).toBe(false);
    expect(isUserRejection(new Error('rejected'))).toBe(false);
    expect(isUserRejection(null)).toBe(false);
    expect(describeError(new WalletSignTransactionError('User rejected the request.'))).toBe('Request rejected in the wallet');
  });
});

describe('chain errors', () => {
  it('decodes SPL Token custom codes from a confirmed failure', () => {
    expect(customErrorCode({ InstructionError: [0, { Custom: 1 }] })).toBe(1);
    expect(customErrorCode('AccountNotFound')).toBeUndefined();
    expect(customErrorCode({ InstructionError: [0, 'InvalidArgument'] })).toBeUndefined();
    expect(describeTransactionError({ InstructionError: [0, { Custom: 1 }] })).toBe('Insufficient token balance');
    expect(describeTransactionError({ InstructionError: [0, { Custom: 4 }] })).toMatch(/Owner does not match/);
    expect(describeTransactionError({ InstructionError: [1, { Custom: 999 }] })).toBe('Transaction failed: program error 999');
    expect(describeTransactionError({ InstructionError: [0, 'InvalidArgument'] })).toBe('Transaction failed: InvalidArgument');
    expect(describeTransactionError('InsufficientFundsForFee')).toBe('Not enough SOL to pay the transaction fee');
    expect(describeTransactionError({})).toBe('Transaction failed on chain');
    const failed = new TransactionFailedError(SIG, { InstructionError: [0, { Custom: 17 }] });
    expect(describeError(failed)).toBe('The token account is frozen');
    expect(errorSignature(failed)).toBe(SIG);
  });
  it('explains simulation logs', () => {
    expect(describeLogs(['Program log: Instruction: BurnChecked', 'Program log: Error: insufficient funds'])).toBe('Insufficient token balance');
    expect(describeLogs(['Program log: Error: owner does not match'])).toMatch(/Owner does not match/);
    expect(describeLogs(['Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA failed: custom program error: 0x12'])).toBe('Decimals do not match the mint');
    expect(describeLogs(['custom program error: 0x7b'])).toBe('Program error 123');
    expect(describeLogs(undefined, 'Transaction simulation failed: Attempt to debit an account but found no record of a prior credit.')).toBe('Not enough SOL to pay the transaction fee');
    expect(describeLogs(undefined, 'Blockhash not found')).toMatch(/expired/);
    expect(describeLogs(['Program log: ok'])).toBeUndefined();
  });
  it('describes SendTransactionError from its logs, falling back to the RPC message', () => {
    const err = new SendTransactionError({ action: 'simulate', signature: SIG, transactionMessage: 'Transaction simulation failed: Error processing Instruction 0: custom program error: 0x1', logs: ['Program log: Error: insufficient funds'] });
    expect(describeError(err)).toBe('Insufficient token balance');
    expect(errorLogs(err)).toEqual(['Program log: Error: insufficient funds']);
    const unknown = new SendTransactionError({ action: 'send', signature: SIG, transactionMessage: 'something odd', logs: ['Program log: x'] });
    expect(describeError(unknown)).toBe('Transaction rejected by the RPC: something odd');
    const wrapped = new WalletSendTransactionError('failed', err);
    expect(describeError(wrapped)).toBe('Insufficient token balance');
    expect(errorLogs(wrapped)).toEqual(['Program log: Error: insufficient funds']);
    expect(errorLogs(new Error('x'))).toBeUndefined();
  });
  it('explains expiry and wallet errors', () => {
    const expired = new TransactionExpiredBlockheightExceededError(SIG);
    expect(describeError(expired)).toMatch(/expired before confirmation/);
    expect(errorSignature(expired)).toBe(SIG);
    expect(describeError(new WalletNotConnectedError())).toBe('Connect a wallet first');
    expect(describeError(new WalletUnavailableError('This wallet cannot sign messages'))).toBe('This wallet cannot sign messages');
    expect(describeError(new WalletSignTransactionError('Insufficient funds'))).toBe('Insufficient token balance');
    expect(describeError(new WalletSignTransactionError('Ledger locked'))).toBe('Ledger locked');
    expect(describeError(new WalletSignTransactionError('', new Error('inner detail')))).toBe('inner detail');
  });
  it('api and plain errors', () => {
    expect(describeError(new ApiError(402, 'insufficient_credit', 'Insufficient credit'))).toBe('Insufficient credit (insufficient_credit)');
    expect(describeError(new ApiError(500, 'http_500', 'Internal Server Error'))).toBe('Internal Server Error');
    expect(describeError(new Error('boom'))).toBe('boom');
    expect(describeError(new Error('Transaction simulation failed: insufficient lamports 0, need 5000'))).toBe('Not enough SOL to pay the transaction fee');
    expect(describeError('text')).toBe('text');
    expect(describeError(42)).toBe('Something went wrong');
    expect(errorSignature(new Error('x'))).toBeUndefined();
  });
});
