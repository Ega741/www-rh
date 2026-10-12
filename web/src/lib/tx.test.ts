import { describe, expect, it } from 'vitest';
import { MEMO_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@beagle/shared/addresses';
import { parseMemo } from '@beagle/shared/memo';
import { decodeInstruction, isApproveCheckedInstruction, isBurnCheckedInstruction, isRevokeInstruction, TokenInstruction } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { buildApproveInstructions, buildBurnInstructions, buildMemoInstruction, buildPurchaseInstructions, buildRevokeInstructions, purchaseMemoFor, toPublicKey, U64_MAX } from './tx.js';

const OWNER = 'BEJQY85xuHoT2NyAT5eXF9ftMv6RnSM7LQSujxm8BAbZ';
const MINT = 'HBJrfAHGsn7WQYk4FaBXv3wA7fVRL4ctSriSdj3UiDND';
const ATA = 'So11111111111111111111111111111111111111112';
const OPERATOR = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const OTHER = '11111111111111111111111111111111';

describe('toPublicKey', () => {
  it('accepts base58 keys and PublicKey instances, rejects the rest with TypeError', () => {
    expect(toPublicKey(OWNER).toBase58()).toBe(OWNER);
    const pk = new PublicKey(MINT);
    expect(toPublicKey(pk)).toBe(pk);
    expect(() => toPublicKey('0xabc', 'mint')).toThrow(/mint is not a base58/);
  });
});

describe('buildBurnInstructions', () => {
  it('builds BurnChecked on the classic Token program by default', () => {
    const [burn, extra] = buildBurnInstructions({ tokenAccount: ATA, mint: MINT, owner: OWNER, amount: 1_000_000_000n, decimals: 6 });
    expect(extra).toBeUndefined();
    expect(burn).toBeDefined();
    const decoded = decodeInstruction(burn as NonNullable<typeof burn>);
    expect(isBurnCheckedInstruction(decoded)).toBe(true);
    if (!isBurnCheckedInstruction(decoded)) throw new Error('unreachable');
    expect(decoded.programId.toBase58()).toBe(TOKEN_PROGRAM_ID);
    expect(decoded.keys.account.pubkey.toBase58()).toBe(ATA);
    expect(decoded.keys.mint.pubkey.toBase58()).toBe(MINT);
    expect(decoded.keys.owner.pubkey.toBase58()).toBe(OWNER);
    expect(decoded.keys.owner.isSigner).toBe(true);
    expect(decoded.data).toMatchObject({ instruction: TokenInstruction.BurnChecked, amount: 1_000_000_000n, decimals: 6 });
  });
  it('targets Token-2022 when asked and appends a signed memo on the indexed Memo program', () => {
    const ixs = buildBurnInstructions({ tokenAccount: ATA, mint: MINT, owner: OWNER, amount: 5n, decimals: 6, tokenProgram: TOKEN_2022_PROGRAM_ID, memo: 'beagle:v1 ws=' + OTHER });
    expect(ixs).toHaveLength(2);
    const [burn, memo] = ixs as [NonNullable<(typeof ixs)[0]>, NonNullable<(typeof ixs)[1]>];
    const decoded = decodeInstruction(burn, new PublicKey(TOKEN_2022_PROGRAM_ID));
    expect(decoded.programId.toBase58()).toBe(TOKEN_2022_PROGRAM_ID);
    expect(isBurnCheckedInstruction(decoded)).toBe(true);
    expect(memo.programId.toBase58()).toBe(MEMO_PROGRAM_ID);
    expect(memo.keys).toEqual([{ pubkey: new PublicKey(OWNER), isSigner: true, isWritable: false }]);
    expect(new TextDecoder().decode(memo.data)).toBe('beagle:v1 ws=' + OTHER);
  });
  it('rejects zero, negative and oversized amounts and bad decimals', () => {
    expect(() => buildBurnInstructions({ tokenAccount: ATA, mint: MINT, owner: OWNER, amount: 0n, decimals: 6 })).toThrow(/amount must be > 0/);
    expect(() => buildBurnInstructions({ tokenAccount: ATA, mint: MINT, owner: OWNER, amount: U64_MAX + 1n, decimals: 6 })).toThrow(/exceeds u64/);
    expect(() => buildBurnInstructions({ tokenAccount: ATA, mint: MINT, owner: OWNER, amount: 1n, decimals: 6.5 })).toThrow(/decimals/);
    expect(buildBurnInstructions({ tokenAccount: ATA, mint: MINT, owner: OWNER, amount: U64_MAX, decimals: 6 })).toHaveLength(1);
  });
});

describe('buildPurchaseInstructions', () => {
  it('adds no memo when the owner is the credited workspace', () => {
    expect(buildPurchaseInstructions({ tokenAccount: ATA, mint: MINT, owner: OWNER, amount: 1n, decimals: 6, workspace: OWNER })).toHaveLength(1);
    expect(purchaseMemoFor(OWNER, OWNER)).toBeUndefined();
  });
  it('adds beagle:v1 ws=<workspace> when crediting another workspace', () => {
    const ixs = buildPurchaseInstructions({ tokenAccount: ATA, mint: MINT, owner: OWNER, amount: 1n, decimals: 6, workspace: OTHER, memoProgram: MEMO_PROGRAM_ID });
    expect(ixs).toHaveLength(2);
    const memo = new TextDecoder().decode((ixs[1] as NonNullable<(typeof ixs)[1]>).data);
    expect(parseMemo(memo)).toEqual({ kind: 'purchase', workspace: OTHER });
    expect(purchaseMemoFor(OWNER, OTHER)).toBe(memo);
  });
  it('rejects an invalid workspace', () => {
    expect(() => buildPurchaseInstructions({ tokenAccount: ATA, mint: MINT, owner: OWNER, amount: 1n, decimals: 6, workspace: 'nope' })).toThrow(/workspace/);
  });
});

describe('buildMemoInstruction', () => {
  it('bounds the memo size', () => {
    expect(() => buildMemoInstruction({ text: '' })).toThrow(/1–256/);
    expect(() => buildMemoInstruction({ text: 'é'.repeat(129) })).toThrow(/got 258/);
    expect(buildMemoInstruction({ text: 'x'.repeat(256) }).keys).toEqual([]);
  });
});

describe('buildApproveInstructions / buildRevokeInstructions', () => {
  it('delegates the cap to the operator with ApproveChecked', () => {
    const [ix] = buildApproveInstructions({ tokenAccount: ATA, mint: MINT, delegate: OPERATOR, owner: OWNER, cap: 42n, decimals: 6 });
    const decoded = decodeInstruction(ix as NonNullable<typeof ix>);
    expect(isApproveCheckedInstruction(decoded)).toBe(true);
    if (!isApproveCheckedInstruction(decoded)) throw new Error('unreachable');
    expect(decoded.keys.account.pubkey.toBase58()).toBe(ATA);
    expect(decoded.keys.mint.pubkey.toBase58()).toBe(MINT);
    expect(decoded.keys.delegate.pubkey.toBase58()).toBe(OPERATOR);
    expect(decoded.keys.owner.pubkey.toBase58()).toBe(OWNER);
    expect(decoded.data).toMatchObject({ instruction: TokenInstruction.ApproveChecked, amount: 42n, decimals: 6 });
    expect(() => buildApproveInstructions({ tokenAccount: ATA, mint: MINT, delegate: OPERATOR, owner: OWNER, cap: 0n, decimals: 6 })).toThrow(/cap must be > 0/);
  });
  it('revokes on the right token program', () => {
    const [ix] = buildRevokeInstructions({ tokenAccount: ATA, owner: OWNER, tokenProgram: TOKEN_2022_PROGRAM_ID });
    const decoded = decodeInstruction(ix as NonNullable<typeof ix>, new PublicKey(TOKEN_2022_PROGRAM_ID));
    expect(isRevokeInstruction(decoded)).toBe(true);
    if (!isRevokeInstruction(decoded)) throw new Error('unreachable');
    expect(decoded.keys.account.pubkey.toBase58()).toBe(ATA);
    expect(decoded.keys.owner.pubkey.toBase58()).toBe(OWNER);
    expect(decoded.keys.owner.isSigner).toBe(true);
    expect(buildRevokeInstructions({ tokenAccount: ATA, owner: OWNER })[0]?.programId.toBase58()).toBe(TOKEN_PROGRAM_ID);
  });
});
