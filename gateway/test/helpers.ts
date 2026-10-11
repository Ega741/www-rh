/**
 * Shared test fixtures: an in-process OpenAI-compatible mock provider (mirrors
 * `scripts/mock-provider.mjs`), a fake chain reader/writer, and a service factory bound to an
 * in-memory database. No network access anywhere.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Address, Hex } from 'viem';
import { createApp } from '../src/api/server.js';
import type { BlockInfo, ChainContext, ChainReader, ChainWriter, DeskLog, ReceiptInfo } from '../src/chain/clients.js';
import { testConfig, type Config } from '../src/config.js';
import { silentLogger } from '../src/log.js';
import { createServices, type ServiceDeps, type Services } from '../src/services.js';
import { anvilChain } from '@beagle/shared/chains';

/** Well-known anvil accounts. */
export const WS1 = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
export const WS2 = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
export const DESK: Address = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
export const TOKEN: Address = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

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
        // split the arguments across two frames, one of them split mid-way to exercise partial frames
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

/** Mutable fake chain for indexer / drawer / headroom tests. */
export class FakeChain implements ChainReader, ChainWriter {
  head = 0n;
  blocks = new Map<string, BlockInfo>();
  logs: DeskLog[] = [];
  priceE18 = 10n ** 16n; // $0.01
  priceUpdatedAt = Math.floor(Date.now() / 1000);
  maxAge = 3600;
  priceFailure: 'stale' | 'unavailable' | undefined;
  allowances = new Map<string, bigint>();
  balances = new Map<string, bigint>();
  draws: { budgetId: bigint; tokens: bigint; receiptHash: Hex; txHash: Hex }[] = [];
  receiptStatus: 'success' | 'reverted' = 'success';
  /** Receipts `getTransactionReceipt` answers with (tests populate it; absent = not mined). */
  receipts = new Map<string, ReceiptInfo>();
  failDraw: Error | undefined;
  /** When set, `waitForReceipt` rejects with it (RPC failure / timeout). */
  failReceipt: Error | undefined;
  readonly address: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
  private nextTx = 1;

  /** Appends a block with `logs` and returns its number. */
  mine(logs: Omit<DeskLog, 'blockNumber' | 'blockHash' | 'transactionHash' | 'logIndex'>[] = [], hashSalt = ''): bigint {
    this.head += 1n;
    const number = this.head;
    const hash = `0x${(number.toString(16) + hashSalt).padStart(64, 'a')}` as Hex;
    this.blocks.set(number.toString(), { number, hash, timestamp: BigInt(1_700_000_000 + Number(number)) });
    logs.forEach((l, i) => this.logs.push({ ...l, blockNumber: number, blockHash: hash, transactionHash: this.txHash(), logIndex: i }));
    return number;
  }

  txHash(): Hex {
    return `0x${(this.nextTx++).toString(16).padStart(64, 'b')}` as Hex;
  }

  /** Replaces block `number` with a different hash and drops its logs (simulated reorg). */
  reorg(number: bigint): void {
    const hash = `0x${(number.toString(16) + 'ff').padStart(64, 'c')}` as Hex;
    this.blocks.set(number.toString(), { number, hash, timestamp: BigInt(1_700_000_000 + Number(number)) });
    this.logs = this.logs.filter((l) => l.blockNumber !== number);
  }

  async getBlockNumber(): Promise<bigint> {
    return this.head;
  }
  async getBlock(number: bigint): Promise<BlockInfo | undefined> {
    return this.blocks.get(number.toString());
  }
  async getLogs(fromBlock: bigint, toBlock: bigint): Promise<DeskLog[]> {
    return this.logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
  }
  async getTransactionReceipt(hash: Hex): Promise<ReceiptInfo | undefined> {
    return this.receipts.get(hash.toLowerCase());
  }
  async quote(amount: bigint): Promise<{ usdMicro: bigint; priceE18: bigint; updatedAt: number }> {
    if (this.priceFailure !== undefined) {
      const { PriceError } = await import('../src/chain/clients.js');
      throw new PriceError(this.priceFailure, `price ${this.priceFailure}`);
    }
    return { usdMicro: (amount * this.priceE18) / 10n ** 30n, priceE18: this.priceE18, updatedAt: this.priceUpdatedAt };
  }
  async latestPrice(): Promise<{ priceE18: bigint; updatedAt: number }> {
    return { priceE18: this.priceFailure === 'unavailable' ? 0n : this.priceE18, updatedAt: this.priceUpdatedAt };
  }
  async maxPriceAge(): Promise<number> {
    return this.maxAge;
  }
  async allowance(owner: Address): Promise<bigint> {
    return this.allowances.get(owner.toLowerCase()) ?? 0n;
  }
  async balanceOf(owner: Address): Promise<bigint> {
    return this.balances.get(owner.toLowerCase()) ?? 0n;
  }
  async priceSourceBounds(): Promise<{ maxStepBps: number; minInterval: number }> {
    return { maxStepBps: 2500, minInterval: 60 };
  }
  async draw(budgetId: bigint, tokens: bigint, receiptHash: Hex): Promise<Hex> {
    if (this.failDraw) throw this.failDraw;
    const txHash = this.txHash();
    this.draws.push({ budgetId, tokens, receiptHash, txHash });
    return txHash;
  }
  async postPrice(priceE18: bigint): Promise<Hex> {
    this.priceE18 = priceE18;
    return this.txHash();
  }
  async waitForReceipt(): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint }> {
    if (this.failReceipt) throw this.failReceipt;
    return { status: this.receiptStatus, blockNumber: this.head };
  }

  /** A {@link ChainContext} over this fake. */
  context(withWriter = true): ChainContext {
    return {
      chainId: 31337,
      chain: anvilChain,
      deployment: { chainId: 31337, overridden: [], creditDesk: DESK, token: TOKEN, tokenSymbol: 'BEAGLE', tokenDecimals: 18, nativeBurn: true, priceSourceKind: 'manual', deployBlock: 0 },
      creditDesk: DESK,
      token: { address: TOKEN, symbol: 'BEAGLE', decimals: 18, nativeBurn: true },
      priceSource: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
      explorer: undefined,
      startBlock: 1,
      reader: this,
      writer: withWriter ? this : undefined,
      publicClient: undefined,
    };
  }
}

/** Test harness: services + app over an in-memory DB. */
export interface Harness {
  config: Config;
  services: Services;
  app: ReturnType<typeof createApp>;
  mock: MockProvider | undefined;
  /** Credits `workspace` with `micro` µUSD via an admin adjustment. */
  credit(workspace: string, micro: bigint): void;
  /** Creates an API key for `workspace`. */
  key(workspace: string): string;
  /** Creates a session token for `workspace`. */
  session(workspace: string): string;
  close(): Promise<void>;
}

/** Builds a harness. `env` overrides the test env; `deps` go to `createServices`. */
export async function makeHarness(env: Record<string, string | undefined> = {}, deps: ServiceDeps = {}, withMock = true): Promise<Harness> {
  const mock = withMock ? await startMockProvider() : undefined;
  const config = testConfig({ ...(mock === undefined ? {} : { HOUSE_BASE_URL: mock.url }), ...env });
  const services = createServices(config, { logger: silentLogger, chain: null, ...deps });
  const app = createApp(services);
  return {
    config,
    services,
    app,
    mock,
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
