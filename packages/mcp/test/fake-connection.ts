/**
 * Scripted `@solana/web3.js` `Connection` fake for the wallet tests: in-memory token accounts
 * (encoded with the real `AccountLayout`), a fixed blockhash, a mint account, SOL balances, and
 * `sendRawTransaction` that decodes and keeps every transaction so tests can inspect the
 * instructions with `@solana/spl-token`'s `decodeInstruction`.
 */
import { AccountLayout, ACCOUNT_SIZE, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey, Transaction, type AccountInfo, type RpcResponseAndContext, type SendOptions, type SignatureResult } from '@solana/web3.js';
import bs58 from 'bs58';
import type { SolanaRpc } from '../src/wallet.js';

/** Deterministic test keys (seeded keypairs). */
export const AGENT_KEYPAIR = Keypair.fromSeed(new Uint8Array(32).fill(7));
export const AGENT = AGENT_KEYPAIR.publicKey.toBase58();
export const MINT_KEYPAIR = Keypair.fromSeed(new Uint8Array(32).fill(1));
export const MINT = MINT_KEYPAIR.publicKey.toBase58();
export const OPERATOR_KEYPAIR = Keypair.fromSeed(new Uint8Array(32).fill(2));
export const OPERATOR = OPERATOR_KEYPAIR.publicKey.toBase58();
export const OTHER_WORKSPACE_KEYPAIR = Keypair.fromSeed(new Uint8Array(32).fill(3));
export const OTHER_WORKSPACE = OTHER_WORKSPACE_KEYPAIR.publicKey.toBase58();
export const PAYER_KEYPAIR = Keypair.fromSeed(new Uint8Array(32).fill(4));
export const PAYER = PAYER_KEYPAIR.publicKey.toBase58();

export const BLOCKHASH = bs58.encode(new Uint8Array(32).fill(9));
export const LAST_VALID_BLOCK_HEIGHT = 1_000;
export const LOCALNET_GENESIS = bs58.encode(new Uint8Array(32).fill(5));

/** A token account the fake node holds. */
export interface FakeTokenAccount {
  address: string;
  mint: string;
  owner: string;
  amount: bigint;
  delegate?: string;
  delegatedAmount?: bigint;
  /** Token program owning the account (default: the classic Token program). */
  programId?: string;
}

export interface FakeConnectionOptions {
  genesisHash?: string;
  blockhash?: { blockhash: string; lastValidBlockHeight: number };
  /** Whether the mint account exists (default true) and which program owns it. */
  mintExists?: boolean;
  mintOwner?: string;
  tokenAccounts?: FakeTokenAccount[];
  /** Lamports of every system account (default 1 SOL). */
  lamports?: number;
  /** Scripted send: return a signature or throw; default: the transaction's own signature. */
  send?: (transaction: Transaction, raw: Buffer) => string | Promise<string>;
  /** Scripted confirmation; default: confirmed at slot 42 without error. */
  confirm?: (signature: string) => RpcResponseAndContext<SignatureResult> | Promise<RpcResponseAndContext<SignatureResult>>;
  /** Per-method injected failure (thrown on every call of that method). */
  fail?: Partial<Record<keyof SolanaRpc, Error>>;
}

export interface SentTransaction {
  raw: Buffer;
  transaction: Transaction;
  signature: string;
}

export interface FakeConnection extends SolanaRpc {
  options: FakeConnectionOptions;
  calls: Array<{ method: keyof SolanaRpc; args: unknown[] }>;
  sent: SentTransaction[];
  callsTo(method: keyof SolanaRpc): number;
}

/** Encodes a token account as the Token program stores it. */
export function encodeTokenAccount(account: FakeTokenAccount): AccountInfo<Buffer> {
  const data = Buffer.alloc(ACCOUNT_SIZE);
  const delegate = account.delegate === undefined ? undefined : new PublicKey(account.delegate);
  AccountLayout.encode(
    {
      mint: new PublicKey(account.mint),
      owner: new PublicKey(account.owner),
      amount: account.amount,
      delegateOption: delegate === undefined ? 0 : 1,
      delegate: delegate ?? PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: delegate === undefined ? 0n : (account.delegatedAmount ?? 0n),
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data,
  );
  return { data, owner: new PublicKey(account.programId ?? TOKEN_PROGRAM_ID.toBase58()), lamports: 2_039_280, executable: false };
}

export function createFakeConnection(options: FakeConnectionOptions = {}): FakeConnection {
  const calls: FakeConnection['calls'] = [];
  const sent: SentTransaction[] = [];
  const opts: FakeConnectionOptions = { ...options };

  function record(method: keyof SolanaRpc, args: unknown[]): void {
    calls.push({ method, args });
    const failure = opts.fail?.[method];
    if (failure !== undefined) throw failure;
  }

  function find(address: PublicKey): FakeTokenAccount | undefined {
    return (opts.tokenAccounts ?? []).find((a) => a.address === address.toBase58());
  }

  return {
    options: opts,
    calls,
    sent,
    callsTo: (method) => calls.filter((c) => c.method === method).length,

    async getLatestBlockhash(commitment) {
      record('getLatestBlockhash', [commitment]);
      return opts.blockhash ?? { blockhash: BLOCKHASH, lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT };
    },

    async sendRawTransaction(raw, sendOptions?: SendOptions) {
      record('sendRawTransaction', [sendOptions]);
      const buffer = Buffer.from(raw as Uint8Array);
      const transaction = Transaction.from(buffer);
      if (!transaction.verifySignatures()) throw new Error('fake node: transaction signature verification failure');
      const signature = opts.send === undefined ? bs58.encode(transaction.signature!) : await opts.send(transaction, buffer);
      sent.push({ raw: buffer, transaction, signature });
      return signature;
    },

    async confirmTransaction(strategy, commitment) {
      record('confirmTransaction', [strategy, commitment]);
      if (opts.confirm !== undefined) return opts.confirm(strategy.signature);
      return { context: { slot: 42 }, value: { err: null } };
    },

    async getAccountInfo(publicKey, commitment) {
      record('getAccountInfo', [publicKey.toBase58(), commitment]);
      if (publicKey.toBase58() === MINT) {
        if (opts.mintExists === false) return null;
        return { data: Buffer.alloc(82), owner: new PublicKey(opts.mintOwner ?? TOKEN_PROGRAM_ID.toBase58()), lamports: 1_461_600, executable: false };
      }
      const account = find(publicKey);
      return account === undefined ? null : encodeTokenAccount(account);
    },

    async getTokenAccountsByOwner(owner, filter, commitment) {
      record('getTokenAccountsByOwner', [owner.toBase58(), filter, commitment]);
      const mint = 'mint' in filter ? filter.mint.toBase58() : undefined;
      const value = (opts.tokenAccounts ?? [])
        .filter((a) => a.owner === owner.toBase58() && (mint === undefined || a.mint === mint))
        .map((a) => ({ pubkey: new PublicKey(a.address), account: encodeTokenAccount(a) }));
      return { context: { slot: 41 }, value };
    },

    async getBalance(publicKey, commitment) {
      record('getBalance', [publicKey.toBase58(), commitment]);
      return opts.lamports ?? 1_000_000_000;
    },

    async getGenesisHash() {
      record('getGenesisHash', []);
      return opts.genesisHash ?? LOCALNET_GENESIS;
    },
  };
}
