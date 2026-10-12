/**
 * Pure transaction builders (SPEC §3.2, §3.4, §7): the instruction lists of the three user
 * actions, returned as `TransactionInstruction[]` so `useTxFlow` can wrap them in one transaction
 * with a fresh blockhash and the wallet adapter signs once.
 *
 * - purchase = `BurnChecked(tokenAccount, mint, owner, amount, decimals)` + `Memo("beagle:v1
 *   ws=<workspace>")` when the credited workspace is not the token account owner;
 * - budget = `ApproveChecked(tokenAccount, mint, delegate = operator, owner, cap, decimals)`;
 * - close = `Revoke(tokenAccount, owner)`.
 *
 * The memo goes to the Memo program the gateway indexes (`MemoSq4…` from `@beagle/shared`, the
 * deployment's `memoProgram`), not the id `@solana/spl-memo` exports (the local validator lacks it).
 */
import { MEMO_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@beagle/shared/addresses';
import { encodePurchaseMemo, MEMO_MAX_BYTES, memoByteLength } from '@beagle/shared/memo';
import { isBase58Pubkey } from '@beagle/shared/solana';
import { createApproveCheckedInstruction, createBurnCheckedInstruction, createRevokeInstruction } from '@solana/spl-token';
import { PublicKey, TransactionInstruction } from '@solana/web3.js';

/** `u64` upper bound: SPL token amounts must fit it. */
export const U64_MAX = (1n << 64n) - 1n;

/** Parses a base58 public key; throws `TypeError` (not web3's generic error) on anything else. */
export function toPublicKey(value: string | PublicKey, label = 'public key'): PublicKey {
  if (value instanceof PublicKey) return value;
  if (!isBase58Pubkey(value)) throw new TypeError(`${label} is not a base58 Solana public key: ${JSON.stringify(value)}`);
  return new PublicKey(value);
}

function assertAmount(amount: bigint, label: string): bigint {
  if (amount <= 0n) throw new RangeError(`${label} must be > 0 (got ${amount})`);
  if (amount > U64_MAX) throw new RangeError(`${label} exceeds u64`);
  return amount;
}

function assertDecimals(decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new RangeError(`decimals must be an integer in [0, 255] (got ${decimals})`);
  return decimals;
}

/** Fields naming the token account and the program that owns it. */
export interface TokenAccountRef {
  /** The token account (the owner's ATA in the normal case). */
  tokenAccount: string | PublicKey;
  /** Account owner (the connected wallet; it signs). */
  owner: string | PublicKey;
  /** Token program owning the mint (default: the classic Token program). */
  tokenProgram?: string | PublicKey | undefined;
}

/** Inputs of {@link buildMemoInstruction}. */
export interface MemoParams {
  text: string;
  /** Signers the memo program verifies (the owner, so the memo is provably the burner's). */
  signers?: readonly (string | PublicKey)[];
  /** Memo program id (default: the one the gateway indexes). */
  memoProgram?: string | PublicKey | undefined;
}

/** SPL Memo instruction with UTF-8 `text` (≤ 256 bytes). */
export function buildMemoInstruction(params: MemoParams): TransactionInstruction {
  const bytes = memoByteLength(params.text);
  if (bytes === 0 || bytes > MEMO_MAX_BYTES) throw new RangeError(`memo must be 1–${MEMO_MAX_BYTES} UTF-8 bytes (got ${bytes})`);
  return new TransactionInstruction({
    programId: toPublicKey(params.memoProgram ?? MEMO_PROGRAM_ID, 'memoProgram'),
    keys: (params.signers ?? []).map((s) => ({ pubkey: toPublicKey(s, 'memo signer'), isSigner: true, isWritable: false })),
    data: Buffer.from(new TextEncoder().encode(params.text)),
  });
}

/** Inputs of {@link buildBurnInstructions}. */
export interface BurnParams extends TokenAccountRef {
  mint: string | PublicKey;
  /** Raw token units. */
  amount: bigint;
  decimals: number;
  /** Optional memo text appended after the burn. */
  memo?: string | undefined;
  memoProgram?: string | PublicKey | undefined;
}

/** `[BurnChecked, Memo?]`. */
export function buildBurnInstructions(params: BurnParams): TransactionInstruction[] {
  const owner = toPublicKey(params.owner, 'owner');
  const ixs = [
    createBurnCheckedInstruction(
      toPublicKey(params.tokenAccount, 'tokenAccount'),
      toPublicKey(params.mint, 'mint'),
      owner,
      assertAmount(params.amount, 'amount'),
      assertDecimals(params.decimals),
      [],
      toPublicKey(params.tokenProgram ?? TOKEN_PROGRAM_ID, 'tokenProgram'),
    ),
  ];
  if (params.memo !== undefined) {
    ixs.push(buildMemoInstruction({ text: params.memo, signers: [owner], ...(params.memoProgram === undefined ? {} : { memoProgram: params.memoProgram }) }));
  }
  return ixs;
}

/** Inputs of {@link buildPurchaseInstructions}. */
export interface PurchaseParams extends Omit<BurnParams, 'memo'> {
  /** Workspace to credit (base58). A memo is added only when it is not the owner. */
  workspace: string;
}

/**
 * A credit purchase: the burn, plus `beagle:v1 ws=<workspace>` when crediting a workspace other
 * than the burning wallet (SPEC §3.2: without a memo the credit goes to the token account owner).
 */
export function buildPurchaseInstructions(params: PurchaseParams): TransactionInstruction[] {
  const owner = toPublicKey(params.owner, 'owner');
  const { workspace, ...burn } = params;
  if (!isBase58Pubkey(workspace)) throw new TypeError(`workspace is not a base58 Solana public key: ${JSON.stringify(workspace)}`);
  const memo = workspace === owner.toBase58() ? undefined : encodePurchaseMemo({ workspace });
  return buildBurnInstructions({ ...burn, ...(memo === undefined ? {} : { memo }) });
}

/** The memo text a purchase would carry, or `undefined` when none is needed (for labels). */
export function purchaseMemoFor(owner: string, workspace: string): string | undefined {
  return owner === workspace ? undefined : encodePurchaseMemo({ workspace });
}

/** Inputs of {@link buildApproveInstructions}. */
export interface ApproveParams extends TokenAccountRef {
  mint: string | PublicKey;
  /** The operator (delegate). */
  delegate: string | PublicKey;
  /** Cap in raw token units. */
  cap: bigint;
  decimals: number;
}

/** `[ApproveChecked]`: delegates `cap` to the operator (a new approval replaces the previous cap). */
export function buildApproveInstructions(params: ApproveParams): TransactionInstruction[] {
  return [
    createApproveCheckedInstruction(
      toPublicKey(params.tokenAccount, 'tokenAccount'),
      toPublicKey(params.mint, 'mint'),
      toPublicKey(params.delegate, 'delegate'),
      toPublicKey(params.owner, 'owner'),
      assertAmount(params.cap, 'cap'),
      assertDecimals(params.decimals),
      [],
      toPublicKey(params.tokenProgram ?? TOKEN_PROGRAM_ID, 'tokenProgram'),
    ),
  ];
}

/** `[Revoke]`: clears the delegation (closes the budget). */
export function buildRevokeInstructions(params: TokenAccountRef): TransactionInstruction[] {
  return [createRevokeInstruction(toPublicKey(params.tokenAccount, 'tokenAccount'), toPublicKey(params.owner, 'owner'), [], toPublicKey(params.tokenProgram ?? TOKEN_PROGRAM_ID, 'tokenProgram'))];
}
