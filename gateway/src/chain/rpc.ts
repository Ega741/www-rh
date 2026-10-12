/**
 * Chain access (SPEC §5.4): the `ChainReader` / `ChainWriter` interfaces every worker depends on
 * (so tests inject an in-memory fake), their `@solana/web3.js` `Connection` implementations, the
 * resolved chain context (cluster, mint, operator, …) and small parsers over jsonParsed data.
 *
 * The reader speaks in **plain JSON**: exactly what `@solana/web3.js` returns once serialized
 * (`PublicKey` → base58 string), which is also what the raw JSON-RPC `jsonParsed` encoding sends.
 * Test fixtures under `test/fixtures` were captured from a local validator in that form.
 *
 * @module chain/rpc
 */
import { resolveDeployment, type ResolvedDeployment } from '@beagle/shared/addresses';
import { CLUSTERS, type Cluster } from '@beagle/shared/clusters';
import { DEFAULT_DECIMALS, encodeBase58, TOKEN_PROGRAM_PARSED_NAMES } from '@beagle/shared/solana';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionExpiredBlockheightExceededError,
  type Commitment,
  type Finality,
  type TransactionInstruction,
} from '@solana/web3.js';
import type { CommitmentLevel, Config } from '../config.js';
import type { Logger } from '../log.js';

// ---------------------------------------------------------------------------------------------
// Plain-JSON shapes of the jsonParsed RPC responses the gateway consumes

/** One instruction of a jsonParsed transaction (`parsed` present when the RPC knows the program). */
export interface RpcInstruction {
  programId: string;
  /** Parser name, e.g. `spl-token`, `spl-token-2022`, `spl-memo`, `system`. */
  program?: string;
  /** Program-specific parsed payload; a string for `spl-memo`. */
  parsed?: unknown;
  accounts?: string[];
  data?: string;
  stackHeight?: number | null;
}

/** `meta.preTokenBalances[]` / `postTokenBalances[]` entry. */
export interface RpcTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  programId?: string;
  uiTokenAmount: { amount: string; decimals: number; uiAmount: number | null; uiAmountString?: string };
}

/** `getTransaction(…, { encoding: 'jsonParsed' })`. */
export interface RpcParsedTransaction {
  slot: number;
  blockTime?: number | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: { pubkey: string; signer: boolean; writable: boolean; source?: string }[];
      instructions: RpcInstruction[];
      recentBlockhash: string;
    };
  };
  meta: {
    err: unknown;
    fee?: number;
    innerInstructions?: { index: number; instructions: RpcInstruction[] }[] | null;
    preTokenBalances?: RpcTokenBalance[] | null;
    postTokenBalances?: RpcTokenBalance[] | null;
    logMessages?: string[] | null;
  } | null;
  version?: 'legacy' | number | undefined;
}

/** `getSignaturesForAddress` entry. */
export interface RpcSignatureInfo {
  signature: string;
  slot: number;
  err: unknown;
  memo: string | null;
  blockTime?: number | null;
  confirmationStatus?: string;
}

/** `getSignatureStatuses` entry. */
export interface RpcSignatureStatus {
  slot: number;
  confirmations: number | null;
  err: unknown;
  confirmationStatus?: 'processed' | 'confirmed' | 'finalized';
}

/** A jsonParsed account; `data` is `null` when the RPC could not parse it (raw bytes). */
export interface RpcParsedAccount {
  lamports: number;
  owner: string;
  executable: boolean;
  data: { program: string; parsed: unknown; space: number } | null;
  space?: number;
}

/** A `getProgramAccounts` / `getTokenAccountsByOwner` entry. */
export interface RpcProgramAccount {
  pubkey: string;
  account: RpcParsedAccount;
}

/** `getProgramAccounts` filters (SPEC §3.4). */
export type RpcAccountFilter = { dataSize: number } | { memcmp: { offset: number; bytes: string } };

/** A recent blockhash and the last block height it is valid for. */
export interface RecentBlockhash {
  blockhash: string;
  lastValidBlockHeight: number;
}

/** Read-only chain access used by the indexer, the budget scanner, the drawer and the price service. */
export interface ChainReader {
  /** Newest first; `until` is exclusive, `before` pages backwards. */
  getSignaturesForAddress(address: string, options: { before?: string; until?: string; limit: number }): Promise<RpcSignatureInfo[]>;
  /** jsonParsed, `maxSupportedTransactionVersion: 0`; `null` when unknown at the commitment. */
  getParsedTransaction(signature: string): Promise<RpcParsedTransaction | null>;
  getSlot(): Promise<number>;
  getBlockHeight(): Promise<number>;
  /** `searchTransactionHistory: true`; `null` for unknown signatures. */
  getSignatureStatuses(signatures: readonly string[]): Promise<(RpcSignatureStatus | null)[]>;
  /** jsonParsed; `null` for accounts that do not exist. */
  getMultipleParsedAccounts(addresses: readonly string[]): Promise<(RpcParsedAccount | null)[]>;
  getParsedProgramAccounts(programId: string, filters: readonly RpcAccountFilter[]): Promise<RpcProgramAccount[]>;
  getParsedTokenAccountsByOwner(owner: string, mint: string): Promise<RpcProgramAccount[]>;
  /** Lamports. */
  getBalance(address: string): Promise<bigint>;
  getLatestBlockhash(): Promise<RecentBlockhash>;
}

/** Outcome of {@link ChainWriter.confirm}. */
export type ConfirmOutcome = { status: 'confirmed' } | { status: 'failed'; err: unknown } | { status: 'expired' } | { status: 'timeout' };

/** Operator-signed writes (legacy transactions, `feePayer = operator`). */
export interface ChainWriter {
  /** The operator public key (base58). */
  readonly address: string;
  /** Signs `[instructions]` with the operator key and sends it; returns the signature. */
  signAndSend(instructions: readonly TransactionInstruction[], recent: RecentBlockhash): Promise<string>;
  /** Waits for `signature` with the blockhash/height strategy, at most `timeoutMs`. */
  confirm(signature: string, recent: RecentBlockhash, timeoutMs: number): Promise<ConfirmOutcome>;
}

/** Static chain facts (SPEC §3.1): resolved from the deployment record and the env, with or without RPC access. */
export interface ChainInfo {
  cluster: Cluster;
  deployment: ResolvedDeployment;
  rpcUrl: string;
  commitment: CommitmentLevel;
  /** The BEAGLE mint; `undefined` when neither the deployment record nor `MINT_ADDRESS` names one. */
  mint: string | undefined;
  /** Decimals of the mint (from the deployment, verified against the mint account at boot). */
  decimals: number;
  symbol: string;
  tokenProgram: string;
  memoProgram: string;
  /** The delegate of every budget / authority of every draw; `undefined` when neither a key nor a deployment names one. */
  operator: string | undefined;
  /** `true` when `OPERATOR_SECRET_KEY` is configured (the gateway can sign draws). */
  operatorKeyConfigured: boolean;
  /** Explorer base URL. */
  explorer: string;
}

/** Everything chain-related the workers need: {@link ChainInfo} plus RPC access. */
export interface ChainContext extends ChainInfo {
  mint: string;
  reader: ChainReader;
  writer: ChainWriter | undefined;
}

/** Thrown when the config names a chain the gateway cannot serve. */
export class ChainConfigError extends Error {
  override readonly name = 'ChainConfigError';
}

// ---------------------------------------------------------------------------------------------
// Parsers

/** The facts of an SPL token account the budget layer needs. */
export interface TokenAccountState {
  address: string;
  mint: string;
  owner: string;
  amount: bigint;
  delegate: string | null;
  delegatedAmount: bigint;
  /** The owning token program. */
  programId: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function amountOf(v: unknown): bigint | undefined {
  if (!isRecord(v) || typeof v['amount'] !== 'string' || !/^\d+$/.test(v['amount'])) return undefined;
  return BigInt(v['amount']);
}

/** Parses a jsonParsed SPL token account (Token or Token-2022); `undefined` for anything else. */
export function parseTokenAccount(address: string, account: RpcParsedAccount | null | undefined): TokenAccountState | undefined {
  if (account === null || account === undefined || account.data === null) return undefined;
  if (!(TOKEN_PROGRAM_PARSED_NAMES as readonly string[]).includes(account.data.program)) return undefined;
  const parsed = account.data.parsed;
  if (!isRecord(parsed) || parsed['type'] !== 'account' || !isRecord(parsed['info'])) return undefined;
  const info = parsed['info'];
  const amount = amountOf(info['tokenAmount']);
  if (typeof info['mint'] !== 'string' || typeof info['owner'] !== 'string' || amount === undefined) return undefined;
  const delegate = typeof info['delegate'] === 'string' ? info['delegate'] : null;
  return {
    address,
    mint: info['mint'],
    owner: info['owner'],
    amount,
    delegate,
    delegatedAmount: delegate === null ? 0n : (amountOf(info['delegatedAmount']) ?? 0n),
    programId: account.owner,
  };
}

/** Parses a jsonParsed SPL mint account; `undefined` for anything else. */
export function parseMintAccount(account: RpcParsedAccount | null | undefined): { decimals: number; supply: bigint; programId: string } | undefined {
  if (account === null || account === undefined || account.data === null) return undefined;
  if (!(TOKEN_PROGRAM_PARSED_NAMES as readonly string[]).includes(account.data.program)) return undefined;
  const parsed = account.data.parsed;
  if (!isRecord(parsed) || parsed['type'] !== 'mint' || !isRecord(parsed['info'])) return undefined;
  const info = parsed['info'];
  if (typeof info['decimals'] !== 'number' || typeof info['supply'] !== 'string') return undefined;
  return { decimals: info['decimals'], supply: BigInt(info['supply']), programId: account.owner };
}

// ---------------------------------------------------------------------------------------------
// web3.js implementations

/** `PublicKey` → base58 everywhere (web3.js objects serialize to their base58 form). */
function plain<T>(value: unknown): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function accountToPlain(info: { lamports: number; owner: PublicKey; executable: boolean; data: unknown; space?: number } | null): RpcParsedAccount | null {
  if (info === null) return null;
  const data = info.data;
  const parsed = isRecord(data) && typeof data['program'] === 'string' && 'parsed' in data ? data : null;
  return {
    lamports: info.lamports,
    owner: info.owner.toBase58(),
    executable: info.executable,
    data: parsed === null ? null : plain(parsed),
    ...(info.space === undefined ? {} : { space: info.space }),
  };
}

/** `@solana/web3.js`-backed {@link ChainReader}. */
export function createConnectionReader(connection: Connection, commitment: CommitmentLevel): ChainReader {
  const finality: Finality = commitment;
  return {
    async getSignaturesForAddress(address, options) {
      const list = await connection.getSignaturesForAddress(new PublicKey(address), { ...options }, finality);
      return plain<RpcSignatureInfo[]>(list);
    },
    async getParsedTransaction(signature) {
      const tx = await connection.getParsedTransaction(signature, { commitment: finality, maxSupportedTransactionVersion: 0 });
      return tx === null ? null : plain<RpcParsedTransaction>(tx);
    },
    getSlot: () => connection.getSlot(commitment),
    getBlockHeight: () => connection.getBlockHeight(commitment),
    async getSignatureStatuses(signatures) {
      if (signatures.length === 0) return [];
      const r = await connection.getSignatureStatuses([...signatures], { searchTransactionHistory: true });
      return r.value.map((s) => (s === null ? null : plain<RpcSignatureStatus>(s)));
    },
    async getMultipleParsedAccounts(addresses) {
      if (addresses.length === 0) return [];
      const r = await connection.getMultipleParsedAccounts(
        addresses.map((a) => new PublicKey(a)),
        { commitment },
      );
      return r.value.map(accountToPlain);
    },
    async getParsedProgramAccounts(programId, filters) {
      const list = await connection.getParsedProgramAccounts(new PublicKey(programId), { commitment, filters: [...filters] });
      return list.map((e) => ({ pubkey: e.pubkey.toBase58(), account: accountToPlain(e.account) as RpcParsedAccount }));
    },
    async getParsedTokenAccountsByOwner(owner, mint) {
      const r = await connection.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) }, commitment);
      return r.value.map((e) => ({ pubkey: e.pubkey.toBase58(), account: accountToPlain(e.account) as RpcParsedAccount }));
    },
    async getBalance(address) {
      return BigInt(await connection.getBalance(new PublicKey(address), commitment));
    },
    async getLatestBlockhash() {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash(commitment);
      return { blockhash, lastValidBlockHeight };
    },
  };
}

/** `@solana/web3.js`-backed {@link ChainWriter} signing with the operator keypair. */
export function createConnectionWriter(connection: Connection, keypair: Keypair, commitment: CommitmentLevel): ChainWriter {
  return {
    address: keypair.publicKey.toBase58(),
    async signAndSend(instructions, recent) {
      const tx = new Transaction({ feePayer: keypair.publicKey, blockhash: recent.blockhash, lastValidBlockHeight: recent.lastValidBlockHeight });
      tx.add(...instructions);
      tx.sign(keypair);
      return connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3, preflightCommitment: commitment as Commitment });
    },
    async confirm(signature, recent, timeoutMs) {
      const abort = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<ConfirmOutcome>((resolve) => {
        timer = setTimeout(() => {
          abort.abort();
          resolve({ status: 'timeout' });
        }, timeoutMs);
      });
      const wait = connection
        .confirmTransaction({ signature, blockhash: recent.blockhash, lastValidBlockHeight: recent.lastValidBlockHeight, abortSignal: abort.signal }, commitment)
        .then((r): ConfirmOutcome => (r.value.err === null ? { status: 'confirmed' } : { status: 'failed', err: r.value.err }))
        .catch((e: unknown): ConfirmOutcome => {
          if (e instanceof TransactionExpiredBlockheightExceededError) return { status: 'expired' };
          if (abort.signal.aborted) return { status: 'timeout' };
          throw e;
        });
      try {
        return await Promise.race([wait, timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
}

/**
 * Resolves the static chain facts from the deployment record and the env (`MINT_ADDRESS`,
 * `TOKEN_PROGRAM`, `RPC_URL`, `OPERATOR_SECRET_KEY`). Never touches the network. Throws
 * `TypeError` (from `resolveDeployment`) on malformed overrides.
 */
export function resolveChainInfo(config: Config, logger?: Logger): ChainInfo {
  const deployment = resolveDeployment(config.cluster.name, {
    mint: config.cluster.mint,
    tokenProgram: config.cluster.tokenProgram,
    rpcUrl: config.cluster.rpcUrl,
    wsUrl: config.cluster.wsUrl,
  });
  const keyOperator = config.operator.secretKey === undefined ? undefined : encodeBase58(config.operator.secretKey.subarray(32));
  const operator = keyOperator ?? deployment.operator;
  if (keyOperator !== undefined && deployment.operator !== undefined && keyOperator !== deployment.operator) {
    logger?.warn('OPERATOR_SECRET_KEY does not match the deployment operator: budgets delegated to the recorded operator cannot be drawn', {
      keyOperator,
      deploymentOperator: deployment.operator,
    });
  }
  return {
    cluster: config.cluster.name,
    deployment,
    rpcUrl: deployment.rpcUrl,
    commitment: config.cluster.commitment,
    mint: deployment.mint,
    decimals: deployment.decimals ?? DEFAULT_DECIMALS,
    symbol: deployment.symbol ?? 'BEAGLE',
    tokenProgram: deployment.tokenProgram,
    memoProgram: deployment.memoProgram,
    operator,
    operatorKeyConfigured: keyOperator !== undefined,
    explorer: CLUSTERS[config.cluster.name].explorer,
  };
}

/**
 * Builds the {@link ChainContext} from the config, or `undefined` when no mint is known for the
 * cluster (no committed deployment and no `MINT_ADDRESS`): chain workers are then disabled.
 */
export function createChainContext(config: Config, logger: Logger): ChainContext | undefined {
  const info = resolveChainInfo(config, logger);
  if (info.mint === undefined) {
    logger.warn('no mint known for this cluster (no deployment record, MINT_ADDRESS unset): chain workers are disabled', { cluster: config.cluster.name });
    return undefined;
  }
  const keypair = config.operator.secretKey === undefined ? undefined : Keypair.fromSecretKey(config.operator.secretKey);
  const connection = new Connection(info.rpcUrl, { commitment: config.cluster.commitment, wsEndpoint: info.deployment.wsUrl });
  return {
    ...info,
    mint: info.mint,
    reader: createConnectionReader(connection, config.cluster.commitment),
    writer: keypair === undefined ? undefined : createConnectionWriter(connection, keypair, config.cluster.commitment),
  };
}

/**
 * Reads the mint account and reconciles `decimals` / `tokenProgram` with the context (the
 * deployment record may be stale or absent). Logs on mismatch; never throws.
 */
export async function verifyMint(chain: ChainContext, logger: Logger): Promise<void> {
  let account: RpcParsedAccount | null | undefined;
  try {
    [account] = await chain.reader.getMultipleParsedAccounts([chain.mint]);
  } catch (e) {
    logger.warn('mint check skipped: RPC unavailable', { mint: chain.mint, rpcUrl: chain.rpcUrl, error: e });
    return;
  }
  const mint = parseMintAccount(account);
  if (mint === undefined) {
    logger.warn('mint account not found or not an SPL mint on this cluster', { mint: chain.mint, cluster: chain.cluster });
    return;
  }
  if (mint.decimals !== chain.decimals) {
    logger.warn('mint decimals differ from the deployment record; using the chain value', { mint: chain.mint, recorded: chain.decimals, actual: mint.decimals });
    chain.decimals = mint.decimals;
  }
  if (mint.programId !== chain.tokenProgram) {
    logger.warn('mint token program differs from the deployment record; using the chain value', { mint: chain.mint, recorded: chain.tokenProgram, actual: mint.programId });
    chain.tokenProgram = mint.programId;
  }
}
