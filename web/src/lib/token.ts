/**
 * Pure SPL token-account helpers: the associated token address of a wallet and the fields the
 * pages read from a fetched account (balance, delegate, delegated amount), for both token
 * programs. The RPC call itself lives in `hooks/useTokenAccount.ts`.
 */
import { TOKEN_PROGRAM_ID } from '@beagle/shared/addresses';
import { getAssociatedTokenAddressSync, unpackAccount } from '@solana/spl-token';
import type { AccountInfo, PublicKey } from '@solana/web3.js';
import { toPublicKey } from './tx.js';

/** What the pages need from a token account. */
export interface TokenAccountView {
  /** The account address (base58). */
  address: string;
  /** `false` when the account does not exist on chain (no tokens were ever received). */
  exists: boolean;
  /** Raw token balance (0 for a missing account). */
  amount: bigint;
  /** Current delegate (base58) or `null`. */
  delegate: string | null;
  /** `delegatedAmount` (0 without a delegate). */
  delegatedAmount: bigint;
}

/** The ATA of `owner` for `mint` under `tokenProgram` (base58 in, base58 out). */
export function associatedTokenAddress(mint: string, owner: string, tokenProgram: string = TOKEN_PROGRAM_ID): string {
  return getAssociatedTokenAddressSync(toPublicKey(mint, 'mint'), toPublicKey(owner, 'owner'), false, toPublicKey(tokenProgram, 'tokenProgram')).toBase58();
}

/** The view of a missing account. */
export function missingTokenAccount(address: string): TokenAccountView {
  return { address, exists: false, amount: 0n, delegate: null, delegatedAmount: 0n };
}

/**
 * Reads a fetched account (`getAccountInfo`) into a {@link TokenAccountView}; `null` info means
 * the account does not exist. Throws when the data is not a token account of `tokenProgram`
 * (`unpackAccount` checks the owner program and the layout, Token-2022 extensions included).
 */
export function readTokenAccount(address: PublicKey, info: AccountInfo<Buffer> | null, tokenProgram: string = TOKEN_PROGRAM_ID): TokenAccountView {
  if (info === null) return missingTokenAccount(address.toBase58());
  const account = unpackAccount(address, info, toPublicKey(tokenProgram, 'tokenProgram'));
  const delegate = account.delegate === null ? null : account.delegate.toBase58();
  return {
    address: address.toBase58(),
    exists: true,
    amount: account.amount,
    delegate,
    delegatedAmount: delegate === null ? 0n : account.delegatedAmount,
  };
}

/**
 * Tokens the operator may still burn from an account (SPEC §3.4): `min(delegatedAmount, balance)`
 * while the delegate is the operator, else 0.
 */
export function delegatedHeadroom(view: Pick<TokenAccountView, 'delegate' | 'delegatedAmount' | 'amount'>, operator: string | undefined): bigint {
  if (operator === undefined || view.delegate !== operator) return 0n;
  return view.delegatedAmount < view.amount ? view.delegatedAmount : view.amount;
}
