/**
 * Wallet side of the agent tools (SPEC §6.1, §3.2, §3.4): the {@link WalletExecutor} interface, a
 * Keypair implementation over `@solana/web3.js`, and {@link buildUnsignedTransactions} for agents
 * that hold their own wallet and only need something to sign.
 *
 * Three on-chain actions, no custom program:
 * - **buyCompute** = `BurnChecked(tokenAccount, mint, owner, amount, decimals)` from the agent's token
 *   account of the mint (the ATA, or the largest account when the ATA is empty) plus
 *   `Memo("beagle:v1 ws=<workspace>")` when the credited workspace is not the owner. Final: the
 *   gateway credits the burn at its published price when it observes the transaction.
 * - **openBudget** = `ApproveChecked(tokenAccount, mint, delegate = operator, owner, cap, decimals)`:
 *   SPL semantics, one delegate per account, a new approval replaces the previous cap.
 * - **closeBudget** = `Revoke(tokenAccount, owner)` of the named account, else of the owner's
 *   account delegated to the operator (its open budget), else of the ATA-or-largest account.
 *
 * Every transaction is a legacy `Transaction` with `feePayer = owner` and a fresh blockhash; the
 * executor signs, `sendRawTransaction`s and `confirmTransaction`s with the blockhash /
 * `lastValidBlockHeight` strategy. Failures surface as {@link WalletError} codes
 * (`insufficient_tokens`, `insufficient_sol`, `blockhash_expired`, `tx_failed`, `chain_mismatch`,
 * `rpc_error`, …) and never contain the secret key.
 *
 * @module wallet
 */
import { MEMO_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@beagle/shared/addresses';
import { CLUSTERS, type Cluster } from '@beagle/shared/clusters';
import { formatTokenAmount } from '@beagle/shared/credit';
import { encodePurchaseMemo } from '@beagle/shared/memo';
import { isBase58Pubkey } from '@beagle/shared/solana';
import {
  createApproveCheckedInstruction,
  createBurnCheckedInstruction,
  createRevokeInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
  type Account as TokenAccountState,
} from '@solana/spl-token';
import {
  Connection,
  Keypair,
  PublicKey,
  SendTransactionError,
  Transaction,
  TransactionExpiredBlockheightExceededError,
  TransactionExpiredTimeoutError,
  TransactionInstruction,
  type AccountInfo,
  type BlockhashWithExpiryBlockHeight,
  type BlockheightBasedTransactionConfirmationStrategy,
  type Commitment,
  type RpcResponseAndContext,
  type SendOptions,
  type SignatureResult,
  type TokenAccountsFilter,
} from '@solana/web3.js';
import bs58 from 'bs58';

// ---------------------------------------------------------------------------------------------
// Types

/** The slice of `@solana/web3.js` `Connection` the wallet code uses; a `Connection` satisfies it, so do test fakes. */
export interface SolanaRpc {
  getLatestBlockhash(commitment?: Commitment): Promise<BlockhashWithExpiryBlockHeight>;
  sendRawTransaction(rawTransaction: Buffer | Uint8Array | Array<number>, options?: SendOptions): Promise<string>;
  confirmTransaction(strategy: BlockheightBasedTransactionConfirmationStrategy, commitment?: Commitment): Promise<RpcResponseAndContext<SignatureResult>>;
  getAccountInfo(publicKey: PublicKey, commitment?: Commitment): Promise<AccountInfo<Buffer> | null>;
  getTokenAccountsByOwner(
    owner: PublicKey,
    filter: TokenAccountsFilter,
    commitment?: Commitment,
  ): Promise<RpcResponseAndContext<ReadonlyArray<{ pubkey: PublicKey; account: AccountInfo<Buffer> }>>>;
  getBalance(publicKey: PublicKey, commitment?: Commitment): Promise<number>;
  getGenesisHash(): Promise<string>;
}

/** What the wallet flows need to know about the deployment (a subset of `ConfigDto`, SPEC §3.1). */
export interface WalletDeployment {
  cluster: Cluster;
  /** The BEAGLE mint (base58). */
  mint: string;
  /** Decimals of the mint (`BurnChecked` / `ApproveChecked` verify them on chain). */
  decimals: number;
  /** Token program owning the mint (default: the classic Token program). */
  tokenProgram?: string;
  /** The gateway's operator: delegate of every budget. `null` while the gateway has no operator key. */
  operator?: string | null;
  /** Memo program the gateway indexes (default: `MemoSq4…`, Solana's Memo v2; not the `Memo4c2p…` id `@solana/spl-memo` 0.3.x exports). */
  memoProgram?: string;
  /** Symbol for human-readable descriptions (default `BEAGLE`). */
  symbol?: string;
}

/** Input of {@link WalletExecutor.buyCompute}. */
export interface BuyComputeParams {
  /** Workspace (base58 public key) to credit; a memo is added when it differs from the signer. */
  workspace: string;
  /** Raw token units to burn (fits `u64`). */
  tokens: bigint;
}

/** Result of {@link WalletExecutor.buyCompute}. */
export interface BuyComputeResult {
  /** Transaction signature (base58). */
  signature: string;
  /** Slot the confirmation was observed at, when the RPC reported it. */
  slot?: number;
  /** The token account burned from. */
  tokenAccount: string;
  /** The memo attached, or `null` when the signer is the credited workspace. */
  memo: string | null;
}

/** Input of {@link WalletExecutor.openBudget}. */
export interface OpenBudgetParams {
  /** Cap in raw token units (fits `u64`): the amount delegated to the operator. */
  cap: bigint;
}

/** Result of {@link WalletExecutor.openBudget}. */
export interface OpenBudgetResult {
  signature: string;
  slot?: number;
  /** The delegated token account = the budget id (SPEC §3.4). */
  tokenAccount: string;
  /** Token balance of that account at the time of the approval (headroom = min(cap, balance)). */
  balance: bigint;
  /** The account's delegate before this approval replaced it (`null`: none); executors that do not read it leave it out. */
  previousDelegate?: string | null;
  previousDelegatedAmount?: bigint;
}

/** Input of {@link WalletExecutor.closeBudget}. */
export interface CloseBudgetParams {
  /** Token account to revoke the delegation of; default: the signer's account delegated to the operator, else its ATA-or-largest account. */
  tokenAccount?: string;
}

/** Result of {@link WalletExecutor.closeBudget}. */
export interface CloseBudgetResult {
  signature: string;
  slot?: number;
  tokenAccount: string;
  /** The delegation the Revoke cleared (`delegate: null`: the account had none, so nothing changed); executors that do not read it leave it out. */
  delegate?: string | null;
  delegatedAmount?: bigint;
}

/**
 * Executes the three wallet flows with a signing key. `address` (when known) is the token account
 * owner / fee payer and the default workspace of the MCP tools.
 */
export interface WalletExecutor {
  /** The signing public key (base58), if the executor knows it. */
  readonly address?: string;
  /** `BurnChecked` (+ `Memo` when `workspace ≠ address`); resolves once the transaction is confirmed. */
  buyCompute(params: BuyComputeParams): Promise<BuyComputeResult>;
  /** `ApproveChecked(tokenAccount, operator, cap)`; resolves once confirmed. Registration with the gateway is the caller's job. */
  openBudget(params: OpenBudgetParams): Promise<OpenBudgetResult>;
  /** `Revoke(tokenAccount)`; resolves once confirmed. */
  closeBudget(params: CloseBudgetParams): Promise<CloseBudgetResult>;
}

/** Thrown by the executor and the builders for invalid input, RPC trouble or failed transactions. */
export class WalletError extends Error {
  override readonly name = 'WalletError';
  /**
   * `invalid_address`, `invalid_amount`, `invalid_secret_key`, `not_configured`, `chain_mismatch`,
   * `chain_unavailable` (the gateway has no chain access), `ambiguous_token_account` (several
   * budgets, name one), `rpc_error`, `insufficient_tokens`, `insufficient_sol`, `blockhash_expired`,
   * `tx_failed`, `wallet_unavailable` (a lazy executor could not be set up).
   */
  readonly code: string;
  /** The transaction signature when one was sent. */
  readonly signature?: string;
  /** Program logs of a failed send / simulation, when the RPC returned them. */
  readonly logs?: string[];

  constructor(code: string, message: string, options: { signature?: string; logs?: string[]; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    if (options.signature !== undefined) this.signature = options.signature;
    if (options.logs !== undefined) this.logs = options.logs;
  }
}

/** Largest amount an SPL instruction carries (`u64`). */
export const U64_MAX = (1n << 64n) - 1n;

/** The fee payer needs at least this many lamports before the executor sends anything (one signature = 5 000). */
export const MIN_FEE_LAMPORTS = 10_000;

/** Genesis hashes of the public clusters; a localnet validator has a fresh one per ledger. */
export const GENESIS_HASHES: Readonly<Partial<Record<Cluster, string>>> = Object.freeze({
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
});

// ---------------------------------------------------------------------------------------------
// Validation helpers

/** Parses a base58 public key; throws `WalletError('invalid_address')`. */
export function pubkey(label: string, value: string): PublicKey {
  if (typeof value !== 'string' || !isBase58Pubkey(value.trim())) {
    throw new WalletError('invalid_address', `${label} is not a base58 Solana public key: ${JSON.stringify(value)}`);
  }
  return new PublicKey(value.trim());
}

/** Asserts a positive raw token amount that fits `u64`; throws `WalletError('invalid_amount')`. */
export function assertTokenAmount(label: string, value: bigint): void {
  if (typeof value !== 'bigint' || value <= 0n) throw new WalletError('invalid_amount', `${label} must be a positive bigint (got ${String(value)})`);
  if (value > U64_MAX) throw new WalletError('invalid_amount', `${label} exceeds u64 (got ${value.toString()})`);
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new WalletError('invalid_amount', `decimals must be an integer in [0, 255] (got ${String(decimals)})`);
  }
}

/**
 * Parses an agent secret key as the Solana tooling writes it: a JSON byte array (`solana-keygen`
 * file contents, 64 bytes) or base58 text (Phantom-style export, 64 bytes). A 32-byte seed is
 * accepted as a JSON array only: 32 bytes of base58 look exactly like a public key, and a pasted
 * address must not silently turn into an unrelated, unfunded wallet. The error message never
 * echoes the input.
 */
export function parseSecretKey(text: string): Uint8Array {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (trimmed === '') throw new WalletError('invalid_secret_key', 'the secret key is empty');
  let bytes: Uint8Array;
  if (trimmed.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new WalletError('invalid_secret_key', 'the secret key looks like a JSON array but does not parse');
    }
    if (!Array.isArray(parsed) || !parsed.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
      throw new WalletError('invalid_secret_key', 'the secret key JSON must be an array of bytes (0–255)');
    }
    bytes = Uint8Array.from(parsed as number[]);
  } else {
    try {
      bytes = bs58.decode(trimmed);
    } catch {
      throw new WalletError('invalid_secret_key', 'the secret key is neither a JSON byte array nor base58');
    }
    if (bytes.length === 32) {
      throw new WalletError(
        'invalid_secret_key',
        'the base58 value is 32 bytes, which is a public key (or a bare seed), not a secret key: export the 64-byte secret key from the wallet, or use the JSON byte array of a solana-keygen file',
      );
    }
  }
  if (bytes.length !== 64 && bytes.length !== 32) {
    throw new WalletError('invalid_secret_key', `the secret key must be 64 bytes (or a 32-byte seed as a JSON array), got ${bytes.length}`);
  }
  return bytes;
}

/** A `Keypair` from {@link parseSecretKey} text or raw bytes (64-byte secret key or 32-byte seed). */
export function keypairFromSecret(secret: string | Uint8Array): Keypair {
  const bytes = typeof secret === 'string' ? parseSecretKey(secret) : secret;
  try {
    return bytes.length === 32 ? Keypair.fromSeed(bytes) : Keypair.fromSecretKey(bytes);
  } catch (error) {
    throw new WalletError('invalid_secret_key', `the secret key is not a valid Ed25519 keypair (${errorMessage(error)})`);
  }
}

/** The most specific message an error offers. */
export function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const e = error as { message?: unknown; transactionMessage?: unknown };
    if (typeof e.transactionMessage === 'string') return e.transactionMessage;
    if (typeof e.message === 'string') return e.message;
  }
  return String(error);
}

function tokenProgramOf(deployment: WalletDeployment): PublicKey {
  return pubkey('deployment.tokenProgram', deployment.tokenProgram ?? TOKEN_PROGRAM_ID);
}

/**
 * An SPL Memo instruction (`text` as UTF-8) signed by `signer`, on the deployment's memo program
 * (by default `MemoSq4…`, Solana's Memo v2 — `spl-memo` crate 3.x — which the gateway indexes). Built by hand
 * on purpose: `@solana/spl-memo` 0.3.x's `createMemoInstruction` targets `Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH`,
 * which `solana-test-validator` does not ship and the indexer does not parse as `spl-memo`.
 */
export function createMemoInstruction(text: string, signer: PublicKey, memoProgram: string = MEMO_PROGRAM_ID): TransactionInstruction {
  return new TransactionInstruction({
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    programId: pubkey('deployment.memoProgram', memoProgram),
    data: Buffer.from(text, 'utf8'),
  });
}

// ---------------------------------------------------------------------------------------------
// Token account resolution

/** A token account of the mint owned by the wallet, as {@link resolveTokenAccount} finds it. */
export interface ResolvedTokenAccount {
  /** Token account address (base58). */
  address: string;
  /** The account owner (base58): the only signer SPL accepts for a burn, approval or revoke on it. */
  owner: string;
  /** Current token balance (raw units). */
  amount: bigint;
  /** `true` when it is the owner's associated token account. */
  isAta: boolean;
  /** Current delegate (base58) or `null`. */
  delegate: string | null;
  delegatedAmount: bigint;
}

/** Input of {@link resolveTokenAccount}. */
export interface ResolveTokenAccountInput {
  owner: string;
  deployment: WalletDeployment;
  /**
   * Raw units the caller is about to burn / delegate. The ATA is used when it holds at least this
   * much (and is not empty); otherwise the largest account of the mint is picked. With `0n` any
   * existing account does, funded ones first.
   */
  need: bigint;
  commitment?: Commitment;
}

function readTokenAccount(address: PublicKey, info: AccountInfo<Buffer> | null, programId: PublicKey, mint: PublicKey): TokenAccountState | undefined {
  if (info === null) return undefined;
  try {
    const account = unpackAccount(address, info, programId);
    return account.mint.equals(mint) ? account : undefined;
  } catch {
    return undefined;
  }
}

function describe(account: TokenAccountState, isAta: boolean): ResolvedTokenAccount {
  return {
    address: account.address.toBase58(),
    owner: account.owner.toBase58(),
    amount: account.amount,
    isAta,
    delegate: account.delegate === null ? null : account.delegate.toBase58(),
    delegatedAmount: account.delegatedAmount,
  };
}

/**
 * The token account of `deployment.mint` owned by `owner` to act on (SPEC §6.1): the associated
 * token account when it exists, holds `need` and is not empty, else the account with the largest
 * balance (the ATA again when every account is empty). Throws `insufficient_tokens` when the owner
 * has no account of the mint or none holds `need` (`need = 0n` only requires an account to exist),
 * `rpc_error` when the node cannot be read.
 */
export async function resolveTokenAccount(rpc: SolanaRpc, input: ResolveTokenAccountInput): Promise<ResolvedTokenAccount> {
  const owner = pubkey('owner', input.owner);
  const mint = pubkey('deployment.mint', input.deployment.mint);
  const programId = tokenProgramOf(input.deployment);
  const commitment = input.commitment ?? 'confirmed';
  const ata = getAssociatedTokenAddressSync(mint, owner, true, programId);
  const symbol = input.deployment.symbol ?? 'BEAGLE';
  const human = (raw: bigint): string => `${formatTokenAmount(raw, input.deployment.decimals, input.deployment.decimals)} ${symbol} (${raw.toString()} raw)`;

  let ataState: TokenAccountState | undefined;
  try {
    ataState = readTokenAccount(ata, await rpc.getAccountInfo(ata, commitment), programId, mint);
  } catch (error) {
    throw new WalletError('rpc_error', `reading token account ${ata.toBase58()} failed: ${errorMessage(error)}`, { cause: error });
  }
  // An empty ATA is not preferred over a funded account of the mint, even when nothing is needed (a budget on it would have no headroom).
  if (ataState !== undefined && ataState.amount >= input.need && ataState.amount > 0n) return describe(ataState, true);

  const accounts = await listTokenAccounts(rpc, owner, mint, programId, commitment);
  let best: TokenAccountState | undefined = ataState;
  for (const state of accounts) {
    if (best === undefined || state.amount > best.amount) best = state;
  }
  if (best === undefined) {
    throw new WalletError('insufficient_tokens', `${owner.toBase58()} has no token account of mint ${mint.toBase58()} (${symbol}); fund its associated token account first`);
  }
  if (best.amount < input.need) {
    throw new WalletError(
      'insufficient_tokens',
      `${owner.toBase58()} holds ${human(best.amount)} in its largest ${symbol} account (${best.address.toBase58()}), less than the ${human(input.need)} needed`,
    );
  }
  return describe(best, best.address.equals(ata));
}

/** Every token account of `mint` owned by `owner` (decoded; other programs' accounts skipped); throws `rpc_error`. */
async function listTokenAccounts(rpc: SolanaRpc, owner: PublicKey, mint: PublicKey, programId: PublicKey, commitment: Commitment): Promise<TokenAccountState[]> {
  let accounts: ReadonlyArray<{ pubkey: PublicKey; account: AccountInfo<Buffer> }>;
  try {
    accounts = (await rpc.getTokenAccountsByOwner(owner, { mint }, commitment)).value;
  } catch (error) {
    throw new WalletError('rpc_error', `listing token accounts of ${owner.toBase58()} failed: ${errorMessage(error)}`, { cause: error });
  }
  const states: TokenAccountState[] = [];
  for (const { pubkey: address, account } of accounts) {
    const state = readTokenAccount(address, account, programId, mint);
    if (state !== undefined) states.push(state);
  }
  return states;
}

/**
 * The token account whose delegation `closeBudget` revokes when the caller names none: the owner's
 * account delegated to the deployment's operator (its open budget; any delegate counts while the
 * operator is unknown), else the {@link resolveTokenAccount} default, whose Revoke then changes
 * nothing. Several delegated accounts are several budgets: `ambiguous_token_account` asks the
 * caller to name one.
 */
export async function resolveDelegatedTokenAccount(rpc: SolanaRpc, input: Omit<ResolveTokenAccountInput, 'need'>): Promise<ResolvedTokenAccount> {
  const owner = pubkey('owner', input.owner);
  const mint = pubkey('deployment.mint', input.deployment.mint);
  const programId = tokenProgramOf(input.deployment);
  const commitment = input.commitment ?? 'confirmed';
  const operator = input.deployment.operator === undefined || input.deployment.operator === null ? undefined : pubkey('deployment.operator', input.deployment.operator);
  const delegated = (await listTokenAccounts(rpc, owner, mint, programId, commitment)).filter(
    (state) => state.delegate !== null && (operator === undefined || state.delegate.equals(operator)),
  );
  if (delegated.length === 0) return resolveTokenAccount(rpc, { ...input, need: 0n });
  if (delegated.length > 1) {
    throw new WalletError(
      'ambiguous_token_account',
      `${owner.toBase58()} has ${delegated.length} token accounts delegated to the operator (${delegated.map((s) => s.address.toBase58()).join(', ')}): pass tokenAccount to say which budget to close`,
    );
  }
  const account = delegated[0]!;
  return describe(account, account.address.equals(getAssociatedTokenAddressSync(mint, owner, true, programId)));
}

// ---------------------------------------------------------------------------------------------
// Instruction / transaction building

/** Common fields of {@link UnsignedTransactionsInput}. */
interface TransactionInputBase {
  deployment: WalletDeployment;
  /** Fee payer and token account owner (base58): the wallet that will sign. */
  payer: string;
  /** Token account to act on (base58); resolved with {@link resolveTokenAccount} by the callers. */
  tokenAccount: string;
}

/** What {@link buildUnsignedTransactions} / {@link buildTransaction} encode. */
export type UnsignedTransactionsInput =
  | (TransactionInputBase & {
      action: 'buyCompute';
      tokens: bigint;
      /** Workspace to credit; a memo is added when it differs from `payer`. */
      workspace: string;
    })
  | (TransactionInputBase & { action: 'openBudget'; cap: bigint })
  | (TransactionInputBase & { action: 'closeBudget' });

/** One serialized transaction for an external wallet to sign and send. */
export interface UnsignedTransaction {
  /** Legacy `Transaction` wire format, base64, no signatures (`feePayer` must sign). */
  base64: string;
  /** Human-readable purpose, e.g. `burn 1000 BEAGLE from 7Gf…; memo beagle:v1 ws=…`. */
  description: string;
}

/** The unsigned transaction request returned by the wallet tools when no signing key is configured (SPEC §6.1). */
export interface UnsignedTransactionRequest {
  unsigned: true;
  cluster: Cluster;
  transactions: UnsignedTransaction[];
  /** Fee payer of every transaction (base58). */
  feePayer: string;
  /** The blockhash the transactions carry and the last block height it is valid at. */
  blockhash: string;
  lastValidBlockHeight: number;
}

/** The instructions and the description of one action (shared by the executor and the unsigned builder). */
export function buildInstructions(input: UnsignedTransactionsInput): { instructions: TransactionInstruction[]; description: string; memo: string | null } {
  const payer = pubkey('payer', input.payer);
  const mint = pubkey('deployment.mint', input.deployment.mint);
  const tokenAccount = pubkey('tokenAccount', input.tokenAccount);
  const programId = tokenProgramOf(input.deployment);
  const decimals = input.deployment.decimals;
  assertDecimals(decimals);
  const symbol = input.deployment.symbol ?? 'BEAGLE';
  const human = (raw: bigint): string => `${formatTokenAmount(raw, decimals)} ${symbol}`;

  switch (input.action) {
    case 'buyCompute': {
      assertTokenAmount('tokens', input.tokens);
      const workspace = pubkey('workspace', input.workspace);
      const instructions = [createBurnCheckedInstruction(tokenAccount, mint, payer, input.tokens, decimals, [], programId)];
      let memo: string | null = null;
      if (!workspace.equals(payer)) {
        memo = encodePurchaseMemo({ workspace: workspace.toBase58() });
        instructions.push(createMemoInstruction(memo, payer, input.deployment.memoProgram));
      }
      const credit = memo === null ? `credit workspace ${payer.toBase58()} (the owner)` : `credit workspace ${workspace.toBase58()} via memo "${memo}"`;
      return {
        instructions,
        memo,
        description: `BurnChecked ${human(input.tokens)} from token account ${tokenAccount.toBase58()} (owner ${payer.toBase58()}) and ${credit}; final, credited at the gateway's published price when observed`,
      };
    }
    case 'openBudget': {
      assertTokenAmount('cap', input.cap);
      if (input.deployment.operator === undefined || input.deployment.operator === null) {
        throw new WalletError('not_configured', 'the gateway has no operator key, so budgets cannot be delegated');
      }
      const operator = pubkey('deployment.operator', input.deployment.operator);
      return {
        instructions: [createApproveCheckedInstruction(tokenAccount, mint, operator, payer, input.cap, decimals, [], programId)],
        memo: null,
        description: `ApproveChecked: delegate up to ${human(input.cap)} of token account ${tokenAccount.toBase58()} to the operator ${operator.toBase58()} (replaces any previous delegation; revocable with Revoke)`,
      };
    }
    case 'closeBudget':
      return {
        instructions: [createRevokeInstruction(tokenAccount, payer, [], programId)],
        memo: null,
        description: `Revoke the delegation of token account ${tokenAccount.toBase58()} (closes the budget)`,
      };
  }
}

/** A legacy `Transaction` with `feePayer = payer` and `blockhash`, ready to sign. */
export function buildTransaction(input: UnsignedTransactionsInput, blockhash: BlockhashWithExpiryBlockHeight): { transaction: Transaction; description: string; memo: string | null } {
  const { instructions, description, memo } = buildInstructions(input);
  const transaction = new Transaction({ feePayer: pubkey('payer', input.payer), blockhash: blockhash.blockhash, lastValidBlockHeight: blockhash.lastValidBlockHeight });
  transaction.add(...instructions);
  return { transaction, description, memo };
}

function serializeUnsigned(input: UnsignedTransactionsInput, blockhash: BlockhashWithExpiryBlockHeight): UnsignedTransactionRequest & { memo: string | null } {
  const { transaction, description, memo } = buildTransaction(input, blockhash);
  const base64 = transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
  return {
    unsigned: true,
    cluster: input.deployment.cluster,
    transactions: [{ base64, description }],
    feePayer: transaction.feePayer!.toBase58(),
    blockhash: blockhash.blockhash,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
    memo,
  };
}

/**
 * Encodes one action as an unsigned legacy transaction (`feePayer = payer`, the given blockhash,
 * serialized with `requireAllSignatures: false`) for an external wallet to sign and send.
 * The token account must already be resolved ({@link resolveTokenAccount}); see
 * {@link prepareUnsignedTransactions} for the version that does it.
 */
export function buildUnsignedTransactions(input: UnsignedTransactionsInput, blockhash: BlockhashWithExpiryBlockHeight): UnsignedTransactionRequest {
  const { memo: _memo, ...request } = serializeUnsigned(input, blockhash);
  return request;
}

/** Common fields of {@link PrepareUnsignedInput}. */
interface PrepareInputBase {
  deployment: WalletDeployment;
  /** Fee payer and token account owner (base58): the wallet that will sign. */
  payer: string;
  /** Token account to act on; resolved from `payer` when omitted. */
  tokenAccount?: string;
}

/** Input of {@link prepareUnsignedTransactions}: like {@link UnsignedTransactionsInput} but the token account is optional. */
export type PrepareUnsignedInput =
  | (PrepareInputBase & { action: 'buyCompute'; tokens: bigint; workspace: string })
  | (PrepareInputBase & { action: 'openBudget'; cap: bigint })
  | (PrepareInputBase & { action: 'closeBudget' });

/** Fetches a fresh blockhash; throws `rpc_error`. */
export async function latestBlockhash(rpc: SolanaRpc, commitment: Commitment = 'confirmed'): Promise<BlockhashWithExpiryBlockHeight> {
  try {
    return await rpc.getLatestBlockhash(commitment);
  } catch (error) {
    throw new WalletError('rpc_error', `fetching a recent blockhash failed: ${errorMessage(error)}`, { cause: error });
  }
}

/**
 * Resolves the token account (unless given) and a fresh blockhash over `rpc`, then
 * {@link buildUnsignedTransactions}. For `buyCompute` the account must hold the tokens; for
 * `openBudget` any account of the mint does (the ATA when it is funded); for `closeBudget` it is
 * the account delegated to the operator ({@link resolveDelegatedTokenAccount}).
 */
export async function prepareUnsignedTransactions(
  rpc: SolanaRpc,
  input: PrepareUnsignedInput,
  options: { commitment?: Commitment } = {},
): Promise<UnsignedTransactionRequest & { tokenAccount: ResolvedTokenAccount; memo: string | null }> {
  const commitment = options.commitment ?? 'confirmed';
  const need = input.action === 'buyCompute' ? input.tokens : 0n;
  if (input.action === 'buyCompute') assertTokenAmount('tokens', input.tokens);
  if (input.action === 'openBudget') assertTokenAmount('cap', input.cap);
  const tokenAccount =
    input.tokenAccount !== undefined
      ? await describeTokenAccount(rpc, input.tokenAccount, input.deployment, commitment)
      : input.action === 'closeBudget'
        ? await resolveDelegatedTokenAccount(rpc, { owner: input.payer, deployment: input.deployment, commitment })
        : await resolveTokenAccount(rpc, { owner: input.payer, deployment: input.deployment, need, commitment });
  const blockhash = await latestBlockhash(rpc, commitment);
  const full: UnsignedTransactionsInput = { ...input, tokenAccount: tokenAccount.address };
  return { ...serializeUnsigned(full, blockhash), tokenAccount };
}

/** Reads one token account of the mint; throws `invalid_address` when it is not one. */
export async function describeTokenAccount(rpc: SolanaRpc, address: string, deployment: WalletDeployment, commitment: Commitment = 'confirmed'): Promise<ResolvedTokenAccount> {
  const key = pubkey('tokenAccount', address);
  const mint = pubkey('deployment.mint', deployment.mint);
  const programId = tokenProgramOf(deployment);
  let info: AccountInfo<Buffer> | null;
  try {
    info = await rpc.getAccountInfo(key, commitment);
  } catch (error) {
    throw new WalletError('rpc_error', `reading token account ${key.toBase58()} failed: ${errorMessage(error)}`, { cause: error });
  }
  const state = readTokenAccount(key, info, programId, mint);
  if (state === undefined) {
    throw new WalletError('invalid_address', `${key.toBase58()} is not a token account of mint ${mint.toBase58()}`);
  }
  const ata = getAssociatedTokenAddressSync(mint, state.owner, true, programId);
  return describe(state, ata.equals(key));
}

// ---------------------------------------------------------------------------------------------
// Keypair executor

/** Options of {@link createKeypairWalletExecutor}. */
export interface KeypairWalletExecutorOptions {
  /** The agent keypair: `Keypair`, raw secret bytes, or text as {@link parseSecretKey} reads it. */
  secretKey: Keypair | Uint8Array | string;
  deployment: WalletDeployment;
  /** JSON-RPC URL (ignored when `connection` is given). */
  rpcUrl?: string;
  /** An existing connection or a test fake; overrides `rpcUrl`. */
  connection?: SolanaRpc;
  /** Commitment for reads, sends and confirmations (default `confirmed`). */
  commitment?: Commitment;
  /** Extra `sendRawTransaction` options (default: preflight at `commitment`, 3 retries). */
  sendOptions?: SendOptions;
}

/** Options of {@link createLazyWalletExecutor}. */
export interface LazyWalletExecutorOptions {
  /** The signing public key (base58), known up front without any network call. */
  address: string;
  /**
   * Builds the real executor; called on the first wallet operation and again on every later
   * operation until one build succeeds. Its failures surface as `WalletError('wallet_unavailable')`,
   * except a `WalletError` it throws itself (e.g. `chain_unavailable`), which passes through as is.
   */
  build: () => Promise<WalletExecutor>;
}

/**
 * A {@link WalletExecutor} that defers building the real one until a wallet tool is called, so a
 * stdio server can connect its transport before the gateway is reachable and recover from a
 * gateway that is down at startup. `address` is available immediately for workspace defaulting.
 */
export function createLazyWalletExecutor(options: LazyWalletExecutorOptions): WalletExecutor {
  const address = pubkey('address', options.address).toBase58();
  let inner: WalletExecutor | undefined;
  async function resolve(): Promise<WalletExecutor> {
    if (inner !== undefined) return inner;
    try {
      inner = await options.build();
    } catch (error) {
      if (error instanceof WalletError) throw error;
      throw new WalletError(
        'wallet_unavailable',
        `the agent wallet could not be set up (${errorMessage(error)}); nothing was sent. Retry once the gateway is reachable, or sign the unsigned transactions yourself.`,
        { cause: error },
      );
    }
    return inner;
  }
  return {
    address,
    buyCompute: async (params) => (await resolve()).buyCompute(params),
    openBudget: async (params) => (await resolve()).openBudget(params),
    closeBudget: async (params) => (await resolve()).closeBudget(params),
  };
}

/** Maps a send / simulation failure onto a {@link WalletError}; SPL "insufficient funds" (custom error 1) → `insufficient_tokens`. */
function sendError(error: unknown, label: string): WalletError {
  const message = errorMessage(error);
  const logs = error instanceof SendTransactionError ? error.logs : undefined;
  const withLogs = logs === undefined ? {} : { logs };
  const text = `${message}${logs === undefined || logs.length === 0 ? '' : ` | logs: ${logs.join(' | ')}`}`;
  if (/insufficient funds for (fee|rent)|found no record of a prior credit|insufficient lamports/i.test(text)) {
    return new WalletError('insufficient_sol', `${label}: the fee payer has no SOL for the transaction fee (${message}); airdrop or transfer a little SOL to it`, { ...withLogs, cause: error });
  }
  if (/custom program error: 0x1\b|insufficient funds/i.test(text)) {
    return new WalletError('insufficient_tokens', `${label}: the token account holds less than the amount (${message})`, { ...withLogs, cause: error });
  }
  if (/blockhash not found/i.test(text)) {
    return new WalletError('blockhash_expired', `${label}: the blockhash expired before the transaction was accepted (${message}); nothing was sent, retry`, { ...withLogs, cause: error });
  }
  return new WalletError('tx_failed', `${label} failed: ${text}`, { ...withLogs, cause: error });
}

/**
 * A {@link WalletExecutor} signing with a `Keypair` over a `Connection`. Before the first
 * transaction it checks that the RPC node is on the deployment's cluster (genesis hash for the
 * public clusters) and that the mint exists there (`chain_mismatch` otherwise), then for every
 * action: resolve the token account, check the fee payer's SOL, build, sign, `sendRawTransaction`
 * (preflight on), `confirmTransaction` with the blockhash strategy.
 */
export function createKeypairWalletExecutor(options: KeypairWalletExecutorOptions): WalletExecutor {
  const keypair = options.secretKey instanceof Keypair ? options.secretKey : keypairFromSecret(options.secretKey);
  const deployment = options.deployment;
  const mint = pubkey('deployment.mint', deployment.mint);
  const tokenProgram = tokenProgramOf(deployment);
  assertDecimals(deployment.decimals);
  const commitment = options.commitment ?? 'confirmed';
  const rpc: SolanaRpc = options.connection ?? new Connection(options.rpcUrl ?? CLUSTERS[deployment.cluster].rpcUrl, commitment);
  const sendOptions: SendOptions = { skipPreflight: false, preflightCommitment: commitment, maxRetries: 3, ...(options.sendOptions ?? {}) };
  const address = keypair.publicKey.toBase58();

  let clusterVerified = false;
  /** One-time sanity check of the RPC endpoint against the deployment (a wrong `BEAGLE_RPC_URL` would otherwise fail obscurely at preflight). */
  async function assertCluster(): Promise<void> {
    if (clusterVerified) return;
    const expectedGenesis = GENESIS_HASHES[deployment.cluster];
    if (expectedGenesis !== undefined) {
      let genesis: string;
      try {
        genesis = await rpc.getGenesisHash();
      } catch (error) {
        throw new WalletError('rpc_error', `reading the genesis hash failed: ${errorMessage(error)}`, { cause: error });
      }
      if (genesis !== expectedGenesis) {
        throw new WalletError('chain_mismatch', `the RPC node's genesis hash ${genesis} is not ${deployment.cluster}'s (${expectedGenesis}); check BEAGLE_RPC_URL`);
      }
    }
    let info: AccountInfo<Buffer> | null;
    try {
      info = await rpc.getAccountInfo(mint, commitment);
    } catch (error) {
      throw new WalletError('rpc_error', `reading the mint account failed: ${errorMessage(error)}`, { cause: error });
    }
    if (info === null) {
      throw new WalletError('chain_mismatch', `mint ${mint.toBase58()} does not exist on the RPC node (cluster ${deployment.cluster}); check BEAGLE_RPC_URL`);
    }
    if (!info.owner.equals(tokenProgram)) {
      throw new WalletError('chain_mismatch', `mint ${mint.toBase58()} is owned by ${info.owner.toBase58()}, not the configured token program ${tokenProgram.toBase58()}`);
    }
    clusterVerified = true;
  }

  async function assertSol(): Promise<void> {
    let lamports: number;
    try {
      lamports = await rpc.getBalance(keypair.publicKey, commitment);
    } catch (error) {
      throw new WalletError('rpc_error', `reading the SOL balance of ${address} failed: ${errorMessage(error)}`, { cause: error });
    }
    if (lamports < MIN_FEE_LAMPORTS) {
      throw new WalletError('insufficient_sol', `${address} holds ${lamports} lamports, below the ${MIN_FEE_LAMPORTS} needed for a transaction fee; airdrop or transfer a little SOL to it`);
    }
  }

  /** Sign, send and confirm; returns the signature and the confirmation slot. */
  async function sendAndConfirm(transaction: Transaction, label: string): Promise<{ signature: string; slot?: number }> {
    transaction.sign(keypair);
    const raw = transaction.serialize();
    let signature: string;
    try {
      signature = await rpc.sendRawTransaction(raw, sendOptions);
    } catch (error) {
      throw sendError(error, label);
    }
    const strategy: BlockheightBasedTransactionConfirmationStrategy = {
      signature,
      blockhash: transaction.recentBlockhash!,
      lastValidBlockHeight: transaction.lastValidBlockHeight!,
    };
    let result: RpcResponseAndContext<SignatureResult>;
    try {
      result = await rpc.confirmTransaction(strategy, commitment);
    } catch (error) {
      if (error instanceof TransactionExpiredBlockheightExceededError || error instanceof TransactionExpiredTimeoutError) {
        throw new WalletError(
          'blockhash_expired',
          `${label}: transaction ${signature} was not confirmed before its blockhash expired. It may still have landed: check the explorer before retrying, never resend blindly.`,
          { signature, cause: error },
        );
      }
      throw new WalletError('rpc_error', `${label}: waiting for confirmation of ${signature} failed: ${errorMessage(error)}`, { signature, cause: error });
    }
    if (result.value.err !== null) {
      throw new WalletError('tx_failed', `${label}: transaction ${signature} failed on chain: ${JSON.stringify(result.value.err)}`, { signature });
    }
    const slot = result.context?.slot;
    return { signature, ...(typeof slot === 'number' ? { slot } : {}) };
  }

  async function run(input: UnsignedTransactionsInput, label: string): Promise<{ signature: string; slot?: number; memo: string | null }> {
    await assertCluster();
    await assertSol();
    const blockhash = await latestBlockhash(rpc, commitment);
    const { transaction, memo } = buildTransaction(input, blockhash);
    const sent = await sendAndConfirm(transaction, label);
    return { ...sent, memo };
  }

  return {
    address,

    async buyCompute({ workspace, tokens }) {
      const ws = pubkey('workspace', workspace).toBase58();
      assertTokenAmount('tokens', tokens);
      await assertCluster();
      const account = await resolveTokenAccount(rpc, { owner: address, deployment, need: tokens, commitment });
      const { signature, slot, memo } = await run({ action: 'buyCompute', deployment, payer: address, tokenAccount: account.address, tokens, workspace: ws }, 'burn');
      return { signature, ...(slot === undefined ? {} : { slot }), tokenAccount: account.address, memo };
    },

    async openBudget({ cap }) {
      assertTokenAmount('cap', cap);
      await assertCluster();
      // Any account of the mint can be delegated (the ATA when it exists); the headroom is min(cap, balance).
      const account = await resolveTokenAccount(rpc, { owner: address, deployment, need: 0n, commitment });
      const { signature, slot } = await run({ action: 'openBudget', deployment, payer: address, tokenAccount: account.address, cap }, 'approve');
      return {
        signature,
        ...(slot === undefined ? {} : { slot }),
        tokenAccount: account.address,
        balance: account.amount,
        previousDelegate: account.delegate,
        previousDelegatedAmount: account.delegatedAmount,
      };
    },

    async closeBudget({ tokenAccount }) {
      await assertCluster();
      const account =
        tokenAccount === undefined
          ? await resolveDelegatedTokenAccount(rpc, { owner: address, deployment, commitment })
          : await describeTokenAccount(rpc, tokenAccount, deployment, commitment);
      const { signature, slot } = await run({ action: 'closeBudget', deployment, payer: address, tokenAccount: account.address }, 'revoke');
      return { signature, ...(slot === undefined ? {} : { slot }), tokenAccount: account.address, delegate: account.delegate, delegatedAmount: account.delegatedAmount };
    },
  };
}
