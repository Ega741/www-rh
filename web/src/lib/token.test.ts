import { describe, expect, it } from 'vitest';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@beagle/shared/addresses';
import { TOKEN_ACCOUNT_SIZE } from '@beagle/shared/solana';
import { AccountLayout, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { associatedTokenAddress, delegatedHeadroom, missingTokenAccount, readTokenAccount } from './token.js';

const OWNER = 'BEJQY85xuHoT2NyAT5eXF9ftMv6RnSM7LQSujxm8BAbZ';
const MINT = 'HBJrfAHGsn7WQYk4FaBXv3wA7fVRL4ctSriSdj3UiDND';
const OPERATOR = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

function tokenAccountData(fields: { amount: bigint; delegate?: string; delegatedAmount?: bigint }): Buffer {
  const data = Buffer.alloc(TOKEN_ACCOUNT_SIZE);
  AccountLayout.encode(
    {
      mint: new PublicKey(MINT),
      owner: new PublicKey(OWNER),
      amount: fields.amount,
      delegateOption: fields.delegate === undefined ? 0 : 1,
      delegate: new PublicKey(fields.delegate ?? '11111111111111111111111111111111'),
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: fields.delegatedAmount ?? 0n,
      closeAuthorityOption: 0,
      closeAuthority: new PublicKey('11111111111111111111111111111111'),
    },
    data,
  );
  return data;
}

describe('token account helpers', () => {
  it('derives the ATA for either token program', () => {
    expect(associatedTokenAddress(MINT, OWNER)).toBe(getAssociatedTokenAddressSync(new PublicKey(MINT), new PublicKey(OWNER)).toBase58());
    expect(associatedTokenAddress(MINT, OWNER, TOKEN_2022_PROGRAM_ID)).toBe(getAssociatedTokenAddressSync(new PublicKey(MINT), new PublicKey(OWNER), false, new PublicKey(TOKEN_2022_PROGRAM_ID)).toBase58());
    expect(associatedTokenAddress(MINT, OWNER)).not.toBe(associatedTokenAddress(MINT, OWNER, TOKEN_2022_PROGRAM_ID));
  });
  it('reports a missing account as zero balance without delegate', () => {
    const ata = new PublicKey(associatedTokenAddress(MINT, OWNER));
    expect(readTokenAccount(ata, null)).toEqual(missingTokenAccount(ata.toBase58()));
    expect(missingTokenAccount('x')).toEqual({ address: 'x', exists: false, amount: 0n, delegate: null, delegatedAmount: 0n });
  });
  it('reads balance, delegate and delegated amount from account data', () => {
    const ata = new PublicKey(associatedTokenAddress(MINT, OWNER));
    const owner = new PublicKey(TOKEN_PROGRAM_ID);
    const plain = readTokenAccount(ata, { data: tokenAccountData({ amount: 1_500_000n }), executable: false, lamports: 2_039_280, owner });
    expect(plain).toEqual({ address: ata.toBase58(), exists: true, amount: 1_500_000n, delegate: null, delegatedAmount: 0n });
    const delegated = readTokenAccount(ata, { data: tokenAccountData({ amount: 1_500_000n, delegate: OPERATOR, delegatedAmount: 5_000_000n }), executable: false, lamports: 2_039_280, owner });
    expect(delegated).toMatchObject({ delegate: OPERATOR, delegatedAmount: 5_000_000n, amount: 1_500_000n });
    expect(() => readTokenAccount(ata, { data: tokenAccountData({ amount: 1n }), executable: false, lamports: 1, owner: new PublicKey(TOKEN_2022_PROGRAM_ID) })).toThrow();
  });
  it('headroom = min(delegatedAmount, balance) only while the operator is the delegate', () => {
    expect(delegatedHeadroom({ delegate: OPERATOR, delegatedAmount: 5n, amount: 10n }, OPERATOR)).toBe(5n);
    expect(delegatedHeadroom({ delegate: OPERATOR, delegatedAmount: 50n, amount: 10n }, OPERATOR)).toBe(10n);
    expect(delegatedHeadroom({ delegate: OWNER, delegatedAmount: 50n, amount: 10n }, OPERATOR)).toBe(0n);
    expect(delegatedHeadroom({ delegate: null, delegatedAmount: 0n, amount: 10n }, OPERATOR)).toBe(0n);
    expect(delegatedHeadroom({ delegate: OPERATOR, delegatedAmount: 5n, amount: 10n }, undefined)).toBe(0n);
  });
});
