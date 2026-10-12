/**
 * Shared test fixtures: an in-process OpenAI-compatible mock provider (mirrors
 * `scripts/mock-provider.mjs`), an in-memory fake Solana RPC with a scripted ledger of
 * signatures / transactions / accounts (shapes captured from a real validator under
 * `test/fixtures`), and a service factory bound to an in-memory database. No network anywhere.
 */
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEMO_PROGRAM_ID, TOKEN_PROGRAM_ID, resolveDeployment } from '@beagle/shared/addresses';
import { CLUSTERS } from '@beagle/shared/clusters';
import { encodeBase58 } from '@beagle/shared/solana';
import type { TransactionInstruction } from '@solana/web3.js';
import { createApp } from '../src/api/server.js';
import type {
  ChainContext,
  ChainReader,
  ChainWriter,
  ConfirmOutcome,
  RecentBlockhash,
  RpcAccountFilter,
  RpcParsedAccount,
  RpcParsedTransaction,
  RpcProgramAccount,
  RpcSignatureInfo,
  RpcSignatureStatus,
  SignedTransaction,
} from '../src/chain/rpc.js';
import { testConfig, type Config } from '../src/config.js';
import { silentLogger } from '../src/log.js';
import { createServices, type ServiceDeps, type Services } from '../src/services.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Loads a JSON fixture captured from `solana-test-validator` (jsonParsed shapes as web3.js serializes them). */
export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8')) as T;
}

/** Keys of the captured session (`meta.json`). */
export interface FixtureMeta {
  mint: string;
  operator: string;
  a1: string;
  a2: string;
  ata1: string;
  ata2: string;
  deployer: string;
  ataDeployer: string;
  sigs: { transferSig: string; burnSig: string; burnCheckedSig: string; approveSig: string; drawSig: string; twoSig: string; revokeSig: string };
  purchaseMemo: string;
  drawMemo: string;
  hash: string;
  slot: number;
  blockHeight: number;
}

export const META = fixture<FixtureMeta>('meta');
/** The localnet mint of the committed deployment (also the fixtures' mint). */
export const MINT = META.mint;
/** The deployment operator (`solana/keys/operator.json`). */
export const OPERATOR = META.operator;
/** Two agent wallets of the captured session. */
export const WS1 = META.a1;
export const WS2 = META.a2;
export const ATA1 = META.ata1;
export const ATA2 = META.ata2;

/** A deterministic base58 public key (32 bytes) for test wallets. */
export function testPubkey(seed: number): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = ((i * 53 + seed * 97 + 7) % 251) + 1;
  return encodeBase58(bytes);
}

/** A deterministic, well-formed base58 transaction signature (64 bytes). */
export function testSignature(seed: number): string {
  const bytes = new Uint8Array(64);
  for (let i = 0; i < 64; i++) bytes[i] = ((i * 31 + seed * 17 + 3) % 253) + 1;
  return encodeBase58(bytes);
}

// ---------------------------------------------------------------------------------------------
// Mock OpenAI-compatible provider

/** Options of {@link startMockProvider}. */
export interface MockOptions {
  /** Force an HTTP status for every request (0 = none). */
  status?: number;
  /** Fail the next N requests with `status` then recover. */
  failNext?: number;
  delayMs?: number;
  /** Return a tool call instead of text. */
  toolCall?: { name: string; arguments: string };
  /** Simulate a mid-stream disconnect after the first content chunk. */
  breakStream?: boolean;
}

/** Handle of a running mock provider. */
export interface MockProvider {
  url: string;
  requests: { path: string; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }[];
  options: MockOptions;
  close(): Promise<void>;
}

const approxTokens = (s: string): number => Math.max(1, Math.ceil(s.length / 4));
const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => (p as { text?: string })?.text ?? '').join(' ') : '';

/** Starts the mock provider on an ephemeral port. */
export async function startMockProvider(options: MockOptions = {}): Promise<MockProvider> {
  const state: MockProvider = { url: '', requests: [], options, close: async () => undefined };
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'openai/gpt-oss-20b', object: 'model', owned_by: 'mock' }] }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid json', type: 'invalid_request_error', code: null } }));
      return;
    }
    state.requests.push({ path: url.pathname, headers: req.headers, body });
    if (state.options.delayMs) await new Promise((r) => setTimeout(r, state.options.delayMs));
    let status = state.options.status ?? 0;
    if ((state.options.failNext ?? 0) > 0) {
      state.options.failNext = (state.options.failNext ?? 0) - 1;
      status = status || 500;
    }
    if (status) {
      res.writeHead(status, { 'content-type': 'application/json', ...(status === 429 ? { 'retry-after': '7' } : {}) });
      res.end(JSON.stringify({ error: { message: `mock forced ${status}`, type: status === 429 ? 'rate_limit_error' : 'server_error', code: null } }));
      return;
    }
    const messages = Array.isArray(body['messages']) ? (body['messages'] as { role?: string; content?: unknown }[]) : [];
    const lastUser = [...messages].reverse().find((m) => m?.role === 'user');
    const promptText = messages.map((m) => textOf(m?.content)).join('\n') + JSON.stringify(body['tools'] ?? '');
    const reply = `echo: ${textOf(lastUser?.content ?? '')}`.slice(0, 200);
    const usage = { prompt_tokens: approxTokens(promptText), completion_tokens: approxTokens(reply), total_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } };
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    const id = `chatcmpl-mock-${Math.random().toString(36).slice(2, 10)}`;
    const created = Math.floor(Date.now() / 1000);
    const model = typeof body['model'] === 'string' ? body['model'] : 'openai/gpt-oss-20b';
    const tool = state.options.toolCall;
    if (body['stream']) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (obj: unknown): void => void res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const chunk = (delta: unknown, finish: string | null = null): unknown => ({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] });
      send(chunk({ role: 'assistant', content: '' }));
      if (tool) {
        send(chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: tool.name, arguments: '' } }] }));
        const half = Math.ceil(tool.arguments.length / 2);
        const frame = `data: ${JSON.stringify(chunk({ tool_calls: [{ index: 0, function: { arguments: tool.arguments.slice(0, half) } }] }))}\n\n`;
        res.write(frame.slice(0, 10));
        await new Promise((r) => setTimeout(r, 5));
        res.write(frame.slice(10));
        send(chunk({ tool_calls: [{ index: 0, function: { arguments: tool.arguments.slice(half) } }] }));
        send(chunk({}, 'tool_calls'));
      } else {
        const words = reply.split(' ');
        send(chunk({ content: words[0] ?? '' }));
        if (state.options.breakStream) {
          await new Promise((r) => setTimeout(r, 50));
          res.socket?.destroy();
          return;
        }
        send(chunk({ content: ` ${words.slice(1).join(' ')}` }));
        send(chunk({}, 'stop'));
      }
      if ((body['stream_options'] as { include_usage?: boolean } | undefined)?.include_usage) send({ id, object: 'chat.completion.chunk', created, model, choices: [], usage });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id,
        object: 'chat.completion',
        created,
        model,
        choices: [
          {
            index: 0,
            message: tool ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: tool }] } : { role: 'assistant', content: reply },
            finish_reason: tool ? 'tool_calls' : 'stop',
          },
        ],
        usage,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  state.url = `http://127.0.0.1:${port}/v1`;
  state.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return state;
}

// ---------------------------------------------------------------------------------------------
// Fake Solana RPC

/** Inputs of {@link makeBurnTx}. */
export interface BurnTxInput {
  signature: string;
  slot: number;
  blockTime?: number | null;
  tokenAccount: string;
  owner: string;
  /** Burn authority (default the owner; the operator for draws). */
  authority?: string;
  amount: bigint;
  /** `burnChecked` (default) or plain `burn`. */
  checked?: boolean;
  memo?: string;
  mint?: string;
  /** Extra burns `{ amount, checked? }` appended after the first (same token account / authority). */
  extraBurns?: { amount: bigint; checked?: boolean }[];
  /** Put the memo instruction first (before the burn). */
  memoFirst?: boolean;
  err?: unknown;
}

function burnIx(input: { tokenAccount: string; mint: string; authority: string; amount: bigint; checked: boolean }): RpcParsedTransaction['transaction']['message']['instructions'][number] {
  const info = input.checked
    ? { account: input.tokenAccount, authority: input.authority, mint: input.mint, tokenAmount: { amount: input.amount.toString(), decimals: 6, uiAmount: Number(input.amount) / 1e6, uiAmountString: (Number(input.amount) / 1e6).toString() } }
    : { account: input.tokenAccount, amount: input.amount.toString(), authority: input.authority, mint: input.mint };
  return { parsed: { info, type: input.checked ? 'burnChecked' : 'burn' }, program: 'spl-token', programId: TOKEN_PROGRAM_ID, stackHeight: 1 };
}

/** Builds a jsonParsed burn transaction in the exact layout of `fixtures/tx-burnchecked-memo.json`. */
export function makeBurnTx(input: BurnTxInput): RpcParsedTransaction {
  const mint = input.mint ?? MINT;
  const authority = input.authority ?? input.owner;
  const burns = [{ amount: input.amount, checked: input.checked ?? true }, ...(input.extraBurns ?? []).map((b) => ({ amount: b.amount, checked: b.checked ?? true }))];
  const instructions = burns.map((b) => burnIx({ tokenAccount: input.tokenAccount, mint, authority, amount: b.amount, checked: b.checked }));
  if (input.memo !== undefined) {
    const memoIx = { parsed: input.memo, program: 'spl-memo', programId: MEMO_PROGRAM_ID, stackHeight: 1 };
    if (input.memoFirst) instructions.unshift(memoIx);
    else instructions.splice(1, 0, memoIx);
  }
  const total = burns.reduce((s, b) => s + b.amount, 0n);
  const pre = 100_000_000_000n;
  const accountKeys = [
    { pubkey: authority, signer: true, source: 'transaction', writable: true },
    { pubkey: input.tokenAccount, signer: false, source: 'transaction', writable: true },
    { pubkey: mint, signer: false, source: 'transaction', writable: true },
    ...(input.memo === undefined ? [] : [{ pubkey: MEMO_PROGRAM_ID, signer: false, source: 'transaction', writable: false }]),
    { pubkey: TOKEN_PROGRAM_ID, signer: false, source: 'transaction', writable: false },
  ];
  const balance = (amount: bigint) => ({
    accountIndex: 1,
    mint,
    owner: input.owner,
    programId: TOKEN_PROGRAM_ID,
    uiTokenAmount: { amount: amount.toString(), decimals: 6, uiAmount: Number(amount) / 1e6, uiAmountString: (Number(amount) / 1e6).toString() },
  });
  return {
    blockTime: input.blockTime === undefined ? 1_791_808_152 : input.blockTime,
    meta: {
      err: input.err ?? null,
      fee: 5000,
      innerInstructions: [],
      logMessages: [],
      preTokenBalances: [balance(pre)],
      postTokenBalances: [balance(pre - total)],
    },
    slot: input.slot,
    transaction: { message: { accountKeys, instructions, recentBlockhash: 'F8xnY7JPhFVNvzEqBaDGyQ7CmSqdAwWs82Fr9k8TciJ7' }, signatures: [input.signature] },
    version: 'legacy',
  };
}

/** Builds a jsonParsed SPL token account in the layout of `fixtures/token-accounts-delegated.json`. */
export function makeTokenAccount(input: { mint?: string; owner: string; amount: bigint; delegate?: string; delegatedAmount?: bigint; programId?: string }): RpcParsedAccount {
  const mint = input.mint ?? MINT;
  const ui = (a: bigint) => ({ amount: a.toString(), decimals: 6, uiAmount: Number(a) / 1e6, uiAmountString: (Number(a) / 1e6).toString() });
  const info: Record<string, unknown> = { isNative: false, mint, owner: input.owner, state: 'initialized', tokenAmount: ui(input.amount) };
  if (input.delegate !== undefined) {
    info['delegate'] = input.delegate;
    info['delegatedAmount'] = ui(input.delegatedAmount ?? 0n);
  }
  return {
    data: { parsed: { info, type: 'account' }, program: 'spl-token', space: 165 },
    executable: false,
    lamports: 2_039_280,
    owner: input.programId ?? TOKEN_PROGRAM_ID,
    space: 165,
  };
}

/** Mutable fake RPC for indexer / scanner / drawer tests: a scripted ledger plus the writer side. */
export class FakeRpc implements ChainReader, ChainWriter {
  slot = 200;
  blockHeight = 200;
  readonly address: string;
  /** Newest first (what `getSignaturesForAddress(mint)` returns). */
  signatures: RpcSignatureInfo[] = [];
  transactions = new Map<string, RpcParsedTransaction>();
  accounts = new Map<string, RpcParsedAccount | null>();
  /** Overrides of `getSignatureStatuses` (default: known transactions are `finalized`, unknown → null). */
  statuses = new Map<string, RpcSignatureStatus | null>();
  balances = new Map<string, bigint>();
  blockhash: RecentBlockhash = { blockhash: 'D9xXKaQ8SQZfLgWpomSxv9VZMDfZrCxhJYdYxXKoWn1z', lastValidBlockHeight: 400 };
  /** Transactions handed to `send` (signed ones that the fake node accepted). */
  sent: { signature: string; instructions: TransactionInstruction[]; recent: RecentBlockhash }[] = [];
  /** Everything `sign` produced, whether or not `send` accepted it. */
  signed: { signature: string; instructions: TransactionInstruction[]; recent: RecentBlockhash }[] = [];
  confirmOutcome: ConfirmOutcome = { status: 'confirmed' };
  /** Thrown by `send` (a `TransactionRejectedError` models an RPC rejection, anything else a network failure). */
  failSend: Error | undefined;
  failConfirm: Error | undefined;
  calls: { method: string; args: unknown[] }[] = [];
  private nextSig = 1;

  constructor(operator: string = OPERATOR) {
    this.address = operator;
  }

  /** Registers a transaction as the newest entry of the mint's signature list. */
  addTransaction(tx: RpcParsedTransaction, extra: Partial<RpcSignatureInfo> = {}): string {
    const signature = tx.transaction.signatures[0] as string;
    this.transactions.set(signature, tx);
    this.signatures.unshift({ signature, slot: tx.slot, err: tx.meta?.err ?? null, memo: null, blockTime: tx.blockTime ?? null, confirmationStatus: 'confirmed', ...extra });
    if (tx.slot > this.slot) {
      this.slot = tx.slot;
      this.blockHeight = tx.slot;
    }
    return signature;
  }

  /** Lists a signature without a fetchable transaction (not yet available at the commitment). */
  addPendingSignature(signature: string, slot: number): void {
    this.signatures.unshift({ signature, slot, err: null, memo: null, blockTime: null, confirmationStatus: 'confirmed' });
  }

  /** A fresh, well-formed signature. */
  newSignature(): string {
    return testSignature(1000 + this.nextSig++);
  }

  async getSignaturesForAddress(address: string, options: { before?: string; until?: string; limit: number }): Promise<RpcSignatureInfo[]> {
    this.calls.push({ method: 'getSignaturesForAddress', args: [address, options] });
    let list = this.signatures;
    if (options.before !== undefined) {
      const i = list.findIndex((s) => s.signature === options.before);
      list = i === -1 ? [] : list.slice(i + 1);
    }
    const out: RpcSignatureInfo[] = [];
    for (const s of list) {
      if (s.signature === options.until) break;
      out.push({ ...s });
      if (out.length >= options.limit) break;
    }
    return out;
  }

  async getParsedTransaction(signature: string): Promise<RpcParsedTransaction | null> {
    this.calls.push({ method: 'getParsedTransaction', args: [signature] });
    const tx = this.transactions.get(signature);
    return tx === undefined ? null : (JSON.parse(JSON.stringify(tx)) as RpcParsedTransaction);
  }

  async getSlot(): Promise<number> {
    return this.slot;
  }

  async getBlockHeight(): Promise<number> {
    return this.blockHeight;
  }

  async getSignatureStatuses(signatures: readonly string[]): Promise<(RpcSignatureStatus | null)[]> {
    this.calls.push({ method: 'getSignatureStatuses', args: [[...signatures]] });
    return signatures.map((s) => {
      if (this.statuses.has(s)) return this.statuses.get(s) ?? null;
      const tx = this.transactions.get(s);
      return tx === undefined ? null : { slot: tx.slot, confirmations: null, err: tx.meta?.err ?? null, confirmationStatus: 'finalized' };
    });
  }

  async getMultipleParsedAccounts(addresses: readonly string[]): Promise<(RpcParsedAccount | null)[]> {
    this.calls.push({ method: 'getMultipleParsedAccounts', args: [[...addresses]] });
    return addresses.map((a) => {
      const acct = this.accounts.get(a);
      return acct === undefined || acct === null ? null : (JSON.parse(JSON.stringify(acct)) as RpcParsedAccount);
    });
  }

  private tokenAccounts(): RpcProgramAccount[] {
    const out: RpcProgramAccount[] = [];
    for (const [pubkey, account] of this.accounts) {
      if (account !== null && account.data !== null && account.data.program === 'spl-token') out.push({ pubkey, account: JSON.parse(JSON.stringify(account)) as RpcParsedAccount });
    }
    return out;
  }

  async getParsedProgramAccounts(programId: string, filters: readonly RpcAccountFilter[]): Promise<RpcProgramAccount[]> {
    this.calls.push({ method: 'getParsedProgramAccounts', args: [programId, filters] });
    return this.tokenAccounts().filter(({ account }) => {
      if (account.owner !== programId) return false;
      const info = (account.data?.parsed as { info: Record<string, unknown> }).info;
      return filters.every((f) => {
        if ('dataSize' in f) return account.space === f.dataSize;
        if (f.memcmp.offset === 0) return info['mint'] === f.memcmp.bytes;
        if (f.memcmp.offset === 76) return info['delegate'] === f.memcmp.bytes;
        return false;
      });
    });
  }

  async getParsedTokenAccountsByOwner(owner: string, mint: string): Promise<RpcProgramAccount[]> {
    this.calls.push({ method: 'getParsedTokenAccountsByOwner', args: [owner, mint] });
    return this.tokenAccounts().filter(({ account }) => {
      const info = (account.data?.parsed as { info: Record<string, unknown> }).info;
      return info['owner'] === owner && info['mint'] === mint;
    });
  }

  async getBalance(address: string): Promise<bigint> {
    return this.balances.get(address) ?? 0n;
  }

  async getLatestBlockhash(): Promise<RecentBlockhash> {
    return { ...this.blockhash };
  }

  sign(instructions: readonly TransactionInstruction[], recent: RecentBlockhash): SignedTransaction {
    const signature = this.newSignature();
    this.signed.push({ signature, instructions: [...instructions], recent });
    return { signature, serialized: new TextEncoder().encode(signature) };
  }

  async send(tx: SignedTransaction): Promise<string> {
    if (this.failSend) throw this.failSend;
    const entry = this.signed.find((s) => s.signature === tx.signature);
    this.sent.push({ signature: tx.signature, instructions: entry?.instructions ?? [], recent: entry?.recent ?? { ...this.blockhash } });
    return tx.signature;
  }

  async confirm(): Promise<ConfirmOutcome> {
    if (this.failConfirm) throw this.failConfirm;
    return this.confirmOutcome;
  }

  /** A {@link ChainContext} over this fake (localnet deployment facts). */
  context(options: { writer?: boolean; operator?: string | undefined } = {}): ChainContext {
    const withWriter = options.writer ?? true;
    const operator = 'operator' in options ? options.operator : this.address;
    return {
      cluster: 'localnet',
      deployment: resolveDeployment('localnet', {}),
      rpcUrl: CLUSTERS.localnet.rpcUrl,
      publicRpcUrl: CLUSTERS.localnet.rpcUrl,
      commitment: 'confirmed',
      mint: MINT,
      decimals: 6,
      symbol: 'BEAGLE',
      tokenProgram: TOKEN_PROGRAM_ID,
      memoProgram: MEMO_PROGRAM_ID,
      operator,
      operatorKeyConfigured: withWriter,
      explorer: CLUSTERS.localnet.explorer,
      reader: this,
      writer: withWriter ? this : undefined,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Harness

/** Test harness: services + app over an in-memory DB. */
export interface Harness {
  config: Config;
  services: Services;
  app: ReturnType<typeof createApp>;
  mock: MockProvider | undefined;
  /** The fake RPC behind `services.chain` (when the harness was built with one). */
  rpc: FakeRpc | undefined;
  /** Credits `workspace` with `micro` µUSD via an admin adjustment. */
  credit(workspace: string, micro: bigint): void;
  /** Creates an API key for `workspace`. */
  key(workspace: string): string;
  /** Creates a session token for `workspace`. */
  session(workspace: string): string;
  close(): Promise<void>;
}

/** Options of {@link makeHarness}. */
export interface HarnessOptions {
  /** A fake RPC to enable the chain workers (default: chain disabled). */
  rpc?: FakeRpc;
  /** Give the fake context a writer (default true when `rpc` is set). */
  writer?: boolean;
}

/**
 * Builds a harness. `env` overrides the test env (manual price `$0.01` by default); `deps` go to
 * `createServices`; `withMock` starts the mock house provider.
 */
export async function makeHarness(env: Record<string, string | undefined> = {}, deps: ServiceDeps = {}, withMock = true, options: HarnessOptions = {}): Promise<Harness> {
  const mock = withMock ? await startMockProvider() : undefined;
  const config = testConfig({ INITIAL_PRICE_USD: '0.01', ...(mock === undefined ? {} : { HOUSE_BASE_URL: mock.url }), ...env });
  const chain = options.rpc === undefined ? null : options.rpc.context({ writer: options.writer ?? true });
  const services = createServices(config, { logger: silentLogger, chain, ...deps });
  const app = createApp(services);
  return {
    config,
    services,
    app,
    mock,
    rpc: options.rpc,
    credit: (workspace, micro) => void services.ledger.adjust(workspace, micro, 'test credit'),
    key: (workspace) => services.apiKeys.create(workspace, 'test').key,
    session: (workspace) => {
      services.repos.workspaces.ensure(workspace, services.now());
      return services.sessions.create(workspace).token;
    },
    close: async () => {
      services.close();
      await mock?.close();
    },
  };
}

/** Parses an SSE body into its frames (`data:` payloads and comment lines). */
export function parseSse(text: string): { data: string[]; comments: string[]; events: string[] } {
  const data: string[] = [];
  const comments: string[] = [];
  const events: string[] = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('data: ')) data.push(line.slice(6));
    else if (line.startsWith(': ')) comments.push(line.slice(2));
    else if (line.startsWith('event: ')) events.push(line.slice(7));
  }
  return { data, comments, events };
}

/** JSON request helper for `app.request`. */
export function jsonRequest(method: string, path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://gw${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? null : JSON.stringify(body) });
}
