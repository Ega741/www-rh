/**
 * The Beagle MCP server (SPEC §6.3): eleven tools and two resources over a {@link BeagleApi}, with
 * an optional {@link WalletExecutor} for the three tools that act on chain (burn, approve, revoke).
 *
 * Every tool returns its result both as pretty-printed JSON text and as `structuredContent`
 * (bigints serialized as decimal strings). Failures come back as `isError` results whose payload is
 * `{ error: { code, message, status?, signature? } }`, where `code` is the gateway error code when
 * the gateway produced the failure (`insufficient_credit`, `invalid_api_key`, …) or a wallet code.
 *
 * Without a wallet the on-chain tools return unsigned legacy transactions (`feePayer = workspace`,
 * fresh blockhash, base64) for a wallet-capable agent to sign and send; that path needs an RPC
 * (`connection` / `rpcUrl`, default: the gateway's `rpcUrl` from `GET /api/config`).
 *
 * @module server
 */
import { explorerTxUrl, type ExplorerSite } from '@beagle/shared/clusters';
import { formatPriceE18, formatTokenAmount, formatUsdMicro, parseTokenAmount, parseUsdToMicro } from '@beagle/shared/credit';
import { ALIASES, ALIAS_DESCRIPTIONS, TIER_ORDER, type Tier } from '@beagle/shared/models';
import type { BalanceDto, BudgetDto, ConfigDto, CreditEventDto, ModelDto, PriceDto, QuoteDto } from '@beagle/shared/api';
import type { ChatCompletionRequest } from '@beagle/shared/openai';
import { isBase58Pubkey } from '@beagle/shared/solana';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { Connection } from '@solana/web3.js';
import { z } from 'zod';
import { BeagleApiError, type BeagleApi } from './api.js';
import { prepareUnsignedTransactions, WalletError, type SolanaRpc, type WalletDeployment, type WalletExecutor } from './wallet.js';

/** Name and version reported in `initialize`. */
export const MCP_SERVER_INFO = { name: 'beagle', version: '0.1.0' } as const;

/** The eleven tool names of SPEC §6.3, in table order. */
export const BEAGLE_TOOL_NAMES = [
  'beagle_balance',
  'beagle_models',
  'beagle_quote',
  'beagle_complete',
  'beagle_usage',
  'beagle_buy_compute',
  'beagle_open_budget',
  'beagle_close_budget',
  'beagle_budgets',
  'beagle_upgrade',
  'beagle_status',
] as const;

/** One of {@link BEAGLE_TOOL_NAMES}. */
export type BeagleToolName = (typeof BEAGLE_TOOL_NAMES)[number];

/** Resource URIs served by the server. */
export const BEAGLE_RESOURCE_URIS = { models: 'beagle://models', quickstart: 'beagle://quickstart' } as const;

/** Options of {@link createBeagleMcpServer}. */
export interface BeagleMcpServerOptions {
  /** Signs `beagle_buy_compute` / `beagle_open_budget` / `beagle_close_budget`; without it those tools return unsigned transactions. */
  wallet?: WalletExecutor;
  /** After a burn, poll `receipts()` / `balance()` until the credit shows up (default `true`). */
  waitForCredit?: boolean;
  /** How long to wait for the credit after the burn is confirmed, ms (default 60 000, SPEC §6.1 "up to 60 s"). */
  creditWaitMs?: number;
  /** Credit polling interval, ms (default 2 000). */
  pollIntervalMs?: number;
  /**
   * Total time budget of one `beagle_buy_compute` call, ms, measured from its start (default 45 000).
   * The credit poll stops when this or `creditWaitMs` runs out, whichever is first, so the result
   * (with the signature) reaches clients whose request timeout is the MCP SDK default of 60 s even
   * when confirmation took a while; progress notifications are sent meanwhile for clients that reset
   * their timeout on progress.
   */
  callBudgetMs?: number;
  /**
   * Default `workspace` of the on-chain tools when the call omits it (base58). Falls back to
   * `wallet.address`; the gateway's `/mcp` mount passes the key's workspace here.
   */
  workspace?: string;
  /** Gateway URL shown in `beagle://quickstart` (default `http://localhost:8787`). */
  apiUrl?: string;
  /** How long `config()` is cached, ms (default 60 000). */
  configTtlMs?: number;
  /** Clock in unix ms (tests). */
  now?: () => number;
  /** RPC for the unsigned path (token account lookup, blockhash); default: a `Connection` to `rpcUrl` or the gateway's `config.rpcUrl`. */
  connection?: SolanaRpc;
  /** JSON-RPC URL for the default connection (ignored when `connection` is given). */
  rpcUrl?: string;
}

/** Raised for bad tool input that zod cannot express (e.g. `usd` and `tokens` together). */
export class ToolInputError extends Error {
  override readonly name = 'ToolInputError';
  readonly code = 'invalid_request';
}

// ---------------------------------------------------------------------------------------------
// Serialization helpers

/** Recursively converts bigints to decimal strings and drops `undefined` members (JSON-safe). */
export function toWire(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toWire);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = toWire(v);
    }
    return out;
  }
  return value;
}

function ok(data: Record<string, unknown>): CallToolResult {
  const wire = toWire(data) as Record<string, unknown>;
  return { content: [{ type: 'text', text: JSON.stringify(wire, null, 2) }], structuredContent: wire };
}

/** Error payload of an `isError` result. */
export interface ToolErrorInfo {
  code: string;
  message: string;
  status?: number;
  /** Transaction signature when the failure happened after a send. */
  signature?: string;
  logs?: string[];
}

/** Maps any thrown value to the `{ code, message, status?, signature? }` payload of an `isError` result. */
export function toolErrorInfo(error: unknown): ToolErrorInfo {
  if (BeagleApiError.is(error)) return { code: error.code, message: error.message, status: error.status };
  if (error instanceof WalletError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.signature === undefined ? {} : { signature: error.signature }),
      ...(error.logs === undefined ? {} : { logs: error.logs }),
    };
  }
  if (error instanceof ToolInputError) return { code: error.code, message: error.message };
  if (error instanceof RangeError || error instanceof SyntaxError) return { code: 'invalid_request', message: error.message };
  if (error instanceof Error) return { code: 'internal_error', message: error.message };
  return { code: 'internal_error', message: String(error) };
}

function fail(error: unknown): CallToolResult {
  const info = toolErrorInfo(error);
  const wire = { error: info };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(wire, null, 2) }], structuredContent: wire };
}

async function run(fn: () => Promise<Record<string, unknown>>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (error) {
    return fail(error);
  }
}

// ---------------------------------------------------------------------------------------------
// Amount helpers

/** Parses a USD amount given as a number (`2.5`) or string (`"2.50"`, `"$2.5"`) into µUSD (> 0). */
export function usdInputToMicro(input: number | string): bigint {
  let micro: bigint;
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input <= 0) throw new ToolInputError(`usd must be a positive number (got ${input})`);
    micro = parseUsdToMicro(input.toFixed(6));
  } else {
    try {
      micro = parseUsdToMicro(input);
    } catch (error) {
      throw new ToolInputError(`usd: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (micro <= 0n) throw new ToolInputError('usd must be greater than zero (at least $0.000001)');
  return micro;
}

/**
 * The shortest decimal string that round-trips to `n` (what `String(n)` gives), with exponent forms
 * expanded (`1e21` → `"1000000000000000000000"`, `1.5e-7` → `"0.00000015"`). Unlike `toFixed(18)`
 * this does not print binary float noise (`0.1` stays `"0.1"`, not `"0.100000000000000006"`).
 */
export function numberToDecimalString(n: number): string {
  const s = String(n);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s);
  if (m === null) return s;
  const sign = m[1] ?? '';
  const int = m[2] ?? '0';
  const frac = m[3] ?? '';
  const exp = Number(m[4]);
  const digits = int + frac;
  const point = int.length + exp;
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * Parses a whole-token amount (`1000`, `0.1`, `"1000.5"`) into raw units with `decimals` (> 0).
 * Numbers are taken at their shortest round-trip representation, so `0.1` is exactly `100000` raw
 * with 6 decimals.
 */
export function tokenInputToRaw(input: number | string, decimals: number): bigint {
  let raw: bigint;
  const text = typeof input === 'number' ? (Number.isFinite(input) ? numberToDecimalString(input) : 'NaN') : input;
  try {
    raw = parseTokenAmount(text, decimals);
  } catch (error) {
    throw new ToolInputError(`tokens: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw <= 0n) throw new ToolInputError('tokens must be greater than zero');
  return raw;
}

const AMOUNT_SCHEMA = z.union([z.number(), z.string()]);
const ADDRESS_SCHEMA = z.string().refine(isBase58Pubkey, { message: 'expected a base58 Solana public key (32 bytes)' });

interface ResolvedAmount {
  tokens: bigint;
  usdMicro: bigint;
  quote: QuoteDto;
}

/** Human-readable summary of a balance (`"$12.34 available; plan free; 1 BEAGLE = $0.0100"`, `(stale)` appended while the price is stale). */
export function balanceSummary(balance: BalanceDto, symbol: string): string {
  const plan = balance.plan === 'pro' && balance.planUntil !== null ? `pro until ${new Date(balance.planUntil).toISOString()}` : balance.plan;
  const price = balance.price.priceE18 === 0n ? 'price unavailable' : `1 ${symbol} = ${formatPriceE18(balance.price.priceE18, { minFractionDigits: 4 })}${balance.price.stale ? ' (stale)' : ''}`;
  return `${formatUsdMicro(balance.availableMicro)} available; plan ${plan}; ${price}`;
}

/** `"3 min ago"` style age of a price point (`observedAt` is unix seconds). */
export function priceAge(price: Pick<PriceDto, 'observedAt'>, nowMs: number): string {
  const seconds = Math.max(0, Math.floor(nowMs / 1000) - price.observedAt);
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86_400)} d ago`;
}

/** The warning the on-chain tools attach while the published price is stale (SPEC §3.3), else `undefined`. */
export function staleWarning(price: PriceDto, nowMs: number): string | undefined {
  if (!price.stale) return undefined;
  return (
    `The published price (point ${price.pricePointId}, ${formatPriceE18(price.priceE18, { minFractionDigits: 4 })} per token, observed ${priceAge(price, nowMs)}) is STALE: ` +
    `older than ${price.maxAgeS} s. A burn observed now is credited at this last point and flagged priceStale; the quote may not reflect the market. Consider waiting for a fresh point.`
  );
}

function priceHuman(perMillion: number): string {
  return `${formatUsdMicro(BigInt(perMillion))}/1M`;
}

function modelRow(model: ModelDto): Record<string, unknown> {
  return {
    ...model,
    priceHuman: {
      input: priceHuman(model.price.inputPerM),
      output: priceHuman(model.price.outputPerM),
      ...(model.price.cacheReadPerM === undefined ? {} : { cacheRead: priceHuman(model.price.cacheReadPerM) }),
      ...(model.price.cacheWritePerM === undefined ? {} : { cacheWrite: priceHuman(model.price.cacheWritePerM) }),
    },
  };
}

/** Open and not stalled: the gateway's predicate for headroom that counts as available credit. */
function budgetCountsAsHeadroom(budget: BudgetDto): boolean {
  return !budget.closed && budget.stalledReason === null;
}

function budgetRow(budget: BudgetDto, decimals: number, symbol: string): Record<string, unknown> {
  return {
    ...budget,
    capFormatted: `${formatTokenAmount(budget.cap, decimals)} ${symbol}`,
    balanceFormatted: `${formatTokenAmount(budget.balance, decimals)} ${symbol}`,
    headroomFormatted: `${formatTokenAmount(budget.headroomTokens, decimals)} ${symbol} (${formatUsdMicro(budget.headroomMicro)})`,
    lifetime: budget.closed ? 'closed' : 'until revoked',
    active: !budget.closed,
    countsAsHeadroom: budgetCountsAsHeadroom(budget),
    drawCount: budget.draws.length,
  };
}

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * Sends `notifications/progress` for the in-flight request when the client asked for it (sent a
 * `progressToken`), so clients with `resetTimeoutOnProgress` keep a long purchase alive. Failures
 * to notify never fail the tool.
 */
function progressReporter(extra: ToolExtra | undefined): (message: string) => Promise<void> {
  const token = extra?._meta?.progressToken;
  if (token === undefined || extra === undefined) return async () => undefined;
  let progress = 0;
  return async (message) => {
    progress += 1;
    try {
      await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress, message } });
    } catch {
      // the client may have gone away; the tool result still carries everything
    }
  };
}

/** Markdown table of the catalog for `beagle://models`. */
export function modelsMarkdown(models: readonly ModelDto[]): string {
  const lines = [
    '# Beagle models',
    '',
    'Prices are USD per 1M tokens (credit is charged at these prices plus the gateway markup; BYOK routes are free).',
    '',
    '| id | tier | provider | context | max output | input | output | tools | vision | json | reasoning | available | plan |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  const yes = (b: boolean): string => (b ? 'yes' : 'no');
  for (const tier of TIER_ORDER) {
    for (const m of models.filter((x) => x.tier === tier)) {
      lines.push(
        `| \`${m.id}\` | ${m.tier} | ${m.provider} | ${m.contextWindow.toLocaleString('en-US')} | ${m.maxOutput.toLocaleString('en-US')} | ${formatUsdMicro(BigInt(m.price.inputPerM))} | ${formatUsdMicro(BigInt(m.price.outputPerM))} | ${yes(m.capabilities.tools)} | ${yes(m.capabilities.vision)} | ${yes(m.capabilities.json)} | ${yes(m.capabilities.reasoning)} | ${m.available ? 'yes' : `no (${m.providerState})`} | ${m.requiresPlan ?? 'free'} |`,
      );
    }
  }
  lines.push('', '## Aliases', '');
  for (const alias of ALIASES) lines.push(`- \`${alias}\`: ${ALIAS_DESCRIPTIONS[alias]}`);
  return lines.join('\n');
}

/** The quick start served at `beagle://quickstart`. */
export function quickstartMarkdown(apiUrl: string): string {
  const base = apiUrl.replace(/\/+$/, '');
  return `# Beagle quick start

Beagle is compute for agents on Solana: one API key for every model, paid for by burning BEAGLE (an SPL token).
Credit is tracked in µUSD (1 USD = 1,000,000 µUSD); every response reports its cost and your remaining balance.

## 1. Check credit

Call \`beagle_balance\`. \`availableMicro\` = balance − reservations + budget headroom. Requests need credit
unless the route is served through your own provider key (BYOK).

## 2. Get credit

- \`beagle_buy_compute\` with \`usd\` or \`tokens\`: a plain SPL \`BurnChecked\` of BEAGLE from your token account
  (plus a memo \`beagle:v1 ws=<workspace>\` when crediting another workspace). The gateway indexes the burn and credits
  its USD value at the **published price point in force when it observes the burn** (\`beagle_quote\` shows the current
  point; the tool warns while the price is stale). A burn is final and not refundable.
- \`beagle_open_budget\` with \`usd\`/\`tokens\`: \`ApproveChecked\` that delegates up to the cap to the gateway operator
  (no deadline, lives until revoked), then registers the token account. The operator burns from it as usage accrues,
  never above the cap, with a receipt hash in each burn's memo; the headroom (min(cap, balance)) counts as credit
  right away. A new approval replaces the previous cap. \`beagle_close_budget\` revokes it.
- Without an agent wallet these tools return unsigned legacy transactions (base64, fee payer = your workspace, fresh
  blockhash) to sign and send yourself.

## 3. Run inference

\`beagle_complete\` with \`prompt\` (or \`messages\`), optional \`model\` (default \`beagle/auto\`), \`max_tokens\`, \`difficulty\`.
Aliases: \`beagle/auto\` (difficulty-based tier, downgrades as credit runs low), \`beagle/best\`, \`beagle/cheap\`, \`beagle/house\`.
Explicit ids like \`anthropic/claude-sonnet-5-5\` are honoured with cheaper fallbacks.

Direct HTTP (OpenAI-compatible):

\`\`\`bash
curl ${base}/v1/chat/completions \\
  -H "Authorization: Bearer $BEAGLE_API_KEY" -H "content-type: application/json" \\
  -d '{"model":"beagle/auto","messages":[{"role":"user","content":"hello"}]}'
\`\`\`

OpenAI SDKs: \`base_url = "${base}/v1"\`. Anthropic SDKs: \`baseURL = "${base}"\` (\`/v1/messages\`).
Response headers: \`x-beagle-model\`, \`x-beagle-provider\`, \`x-beagle-paid-by\`, \`x-beagle-cost-micro\`, \`x-beagle-balance-micro\`, \`x-beagle-route\`.

## 4. When credit runs out

The gateway answers \`402 insufficient_credit\`; tools return \`isError\` with that code. Buy compute or open a budget and retry.

## 5. Upgrades

\`beagle_upgrade\` buys \`pro\` (30 days: large house model, 128K house context, higher rate limit) or \`warm\` GPU hours with credit.
`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Explorer link of a transaction per the gateway's cluster / RPC / explorer base. */
export function explorerLink(config: Pick<ConfigDto, 'cluster' | 'rpcUrl' | 'explorer'>, signature: string): string {
  const site: ExplorerSite = /solscan/i.test(config.explorer) ? 'solscan' : 'solana';
  return explorerTxUrl(config.cluster, signature, { site, rpcUrl: config.rpcUrl });
}

/** The {@link WalletDeployment} a `ConfigDto` describes. */
export function walletDeployment(config: ConfigDto): WalletDeployment {
  return {
    cluster: config.cluster,
    mint: config.mint,
    decimals: config.decimals,
    tokenProgram: config.tokenProgram,
    operator: config.operator,
    memoProgram: config.memoProgram,
    symbol: config.symbol,
  };
}

// ---------------------------------------------------------------------------------------------
// Server

/**
 * Builds the Beagle MCP server over `api`. Connect it to any transport
 * (`StdioServerTransport`, Streamable HTTP, `InMemoryTransport`).
 */
export function createBeagleMcpServer(api: BeagleApi, opts: BeagleMcpServerOptions = {}): McpServer {
  const wallet = opts.wallet;
  const waitForCredit = opts.waitForCredit ?? true;
  const creditWaitMs = opts.creditWaitMs ?? 60_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 2_000;
  const callBudgetMs = opts.callBudgetMs ?? 45_000;
  const configTtlMs = opts.configTtlMs ?? 60_000;
  const now = opts.now ?? (() => Date.now());
  const apiUrl = opts.apiUrl ?? 'http://localhost:8787';

  const server = new McpServer(MCP_SERVER_INFO, {
    instructions:
      'Beagle gives agents one API key for every model, paid for by burning BEAGLE (an SPL token on Solana). ' +
      'Check beagle_balance before spending; beagle_complete costs credit; beagle_buy_compute burns tokens (final), beagle_open_budget delegates tokens to the operator (revocable with beagle_close_budget). ' +
      'Read beagle://quickstart for the flow.',
  });

  let configCache: { at: number; value: ConfigDto } | undefined;
  async function getConfig(): Promise<ConfigDto> {
    if (configCache !== undefined && now() - configCache.at < configTtlMs) return configCache.value;
    const value = await api.config();
    configCache = { at: now(), value };
    return value;
  }

  async function tokenInfo(): Promise<{ symbol: string; decimals: number }> {
    try {
      const config = await getConfig();
      return { symbol: config.symbol, decimals: config.decimals };
    } catch {
      return { symbol: 'BEAGLE', decimals: 6 };
    }
  }

  let rpcCache: { url: string; rpc: SolanaRpc } | undefined;
  /** The RPC of the unsigned path: the injected connection, else one `Connection` per RPC URL. */
  function getRpc(config: ConfigDto): SolanaRpc {
    if (opts.connection !== undefined) return opts.connection;
    const url = opts.rpcUrl ?? config.rpcUrl;
    if (rpcCache?.url === url) return rpcCache.rpc;
    const rpc: SolanaRpc = new Connection(url, 'confirmed');
    rpcCache = { url, rpc };
    return rpc;
  }

  async function resolveAmount(input: { usd?: number | string | undefined; tokens?: number | string | undefined }, decimals: number): Promise<ResolvedAmount> {
    const hasUsd = input.usd !== undefined;
    const hasTokens = input.tokens !== undefined;
    if (hasUsd === hasTokens) throw new ToolInputError('pass exactly one of usd or tokens');
    if (hasUsd) {
      const usdMicro = usdInputToMicro(input.usd!);
      const quote = await api.quote({ usdMicro });
      return { tokens: quote.tokens, usdMicro: quote.usdMicro, quote };
    }
    const tokens = tokenInputToRaw(input.tokens!, decimals);
    const quote = await api.quote({ tokens });
    return { tokens: quote.tokens, usdMicro: quote.usdMicro, quote };
  }

  /**
   * Where the on-chain tools' `workspace` came from: the call (`input`), the server configuration
   * (`configured`: `BEAGLE_WORKSPACE` or the key's workspace on `/mcp`), or the agent wallet address
   * (`agent_wallet`), which is a guess: the API key may belong to a different workspace.
   */
  type WorkspaceSource = 'input' | 'configured' | 'agent_wallet';

  function resolveWorkspace(input: string | undefined): { address: string; source: WorkspaceSource } {
    const [ws, source]: [string | undefined, WorkspaceSource] =
      input !== undefined ? [input, 'input'] : opts.workspace !== undefined ? [opts.workspace, 'configured'] : [wallet?.address, 'agent_wallet'];
    if (ws === undefined) {
      throw new ToolInputError(
        'workspace is required: pass the base58 public key of the workspace to credit (your API key belongs to one). No agent wallet is configured, so it cannot be inferred.',
      );
    }
    const trimmed = ws.trim();
    if (!isBase58Pubkey(trimmed)) throw new ToolInputError(`workspace is not a base58 Solana public key: ${JSON.stringify(ws)}`);
    return { address: trimmed, source };
  }

  function workspaceWarning(source: WorkspaceSource, address: string): string {
    return source === 'agent_wallet'
      ? ` Warning: workspace defaulted to the agent wallet ${address}, which is not necessarily the workspace of this API key (set BEAGLE_WORKSPACE or pass workspace to be explicit); credit on another workspace is reachable only by signing in as it.`
      : '';
  }

  /** The signer of the unsigned path: `payer` from the call, else the resolved workspace (SPEC §6.1 `feePayer = workspace`). */
  function resolvePayer(payer: string | undefined, workspace: string): string {
    if (payer === undefined) return workspace;
    const trimmed = payer.trim();
    if (!isBase58Pubkey(trimmed)) throw new ToolInputError(`payer is not a base58 Solana public key: ${JSON.stringify(payer)}`);
    return trimmed;
  }

  /** `GET /api/price` for the stale warning; a failure to read it is not fatal (the quote carries `stale` too). */
  async function priceWarnings(quote: QuoteDto): Promise<{ price: PriceDto | null; warnings: string[] }> {
    const warnings: string[] = [];
    let price: PriceDto | null = null;
    try {
      price = await api.price();
      const warning = staleWarning(price, now());
      if (warning !== undefined) warnings.push(warning);
    } catch {
      if (quote.stale) warnings.push(`The published price point ${quote.pricePointId} used for this quote is STALE; a burn observed now is credited at it and flagged priceStale.`);
    }
    return { price, warnings };
  }

  // ---- read-only tools -----------------------------------------------------------------------

  server.registerTool(
    'beagle_balance',
    {
      title: 'Balance',
      description:
        "Show the workspace's credit: available µUSD (balance − reserved + budget headroom), plan and the current published BEAGLE price (with its staleness). " +
        'Free. Call it before spending to know what you can afford.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    () =>
      run(async () => {
        const [balance, token] = await Promise.all([api.balance(), tokenInfo()]);
        return {
          ...balance,
          available: formatUsdMicro(balance.availableMicro),
          balance: formatUsdMicro(balance.balanceMicro),
          summary: balanceSummary(balance, token.symbol),
          ...(balance.price.stale ? { warning: staleWarning(balance.price, now()) } : {}),
        };
      }),
  );

  server.registerTool(
    'beagle_models',
    {
      title: 'Models',
      description:
        'List the model catalog with prices (µUSD per 1M tokens), live availability, Pro gating and the beagle/* aliases. ' +
        'Free. Filter by tier (frontier, efficient, budget, house) to shortlist.',
      inputSchema: { tier: z.enum(TIER_ORDER).optional().describe('Only models of this tier.') },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ tier }) =>
      run(async () => {
        const models = await api.models();
        const filtered = tier === undefined ? models : models.filter((m) => m.tier === (tier as Tier));
        return {
          models: filtered.map(modelRow),
          aliases: ALIASES.map((id) => ({ id, description: ALIAS_DESCRIPTIONS[id] })),
          tiers: TIER_ORDER,
          count: filtered.length,
        };
      }),
  );

  server.registerTool(
    'beagle_quote',
    {
      title: 'Quote',
      description:
        "Convert between BEAGLE tokens and USD at the gateway's current published price point. Pass usd (e.g. 5 or \"2.50\") or tokens (whole tokens, e.g. 1000). " +
        'Free. Use it before beagle_buy_compute or beagle_open_budget to size a purchase; stale: true means the point is older than the gateway allows.',
      inputSchema: {
        usd: AMOUNT_SCHEMA.optional().describe('USD amount to price in tokens (number or decimal string).'),
        tokens: AMOUNT_SCHEMA.optional().describe('Whole tokens to price in USD (number or decimal string).'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ usd, tokens }) =>
      run(async () => {
        const token = await tokenInfo();
        const { quote } = await resolveAmount({ usd, tokens }, token.decimals);
        return {
          ...quote,
          tokensFormatted: `${formatTokenAmount(quote.tokens, token.decimals)} ${token.symbol}`,
          usd: formatUsdMicro(quote.usdMicro),
          usdPerToken: formatPriceE18(quote.priceE18, { minFractionDigits: 4 }),
          ...(quote.stale ? { warning: `price point ${quote.pricePointId} is stale; the gateway credits burns at it until a fresh point is published` } : {}),
        };
      }),
  );

  server.registerTool(
    'beagle_usage',
    {
      title: 'Usage',
      description:
        'Recent requests (newest first) and a summary (requests, charged µUSD, tokens, by model, by day) over a 24h, 7d or 30d window. Free.',
      inputSchema: {
        limit: z.number().int().min(1).max(200).optional().describe('Rows to return (default 50).'),
        window: z.enum(['24h', '7d', '30d']).optional().describe('Summary window (default 24h).'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ limit, window }) =>
      run(async () => {
        const result = await api.usage({ ...(limit === undefined ? {} : { limit }), ...(window === undefined ? {} : { window }) });
        return {
          summary: { ...result.summary, charged: formatUsdMicro(result.summary.chargedMicro) },
          rows: result.rows,
          text: `${result.summary.requests} requests in ${result.summary.window}, ${formatUsdMicro(result.summary.chargedMicro)} charged, ${result.summary.inputTokens} in / ${result.summary.outputTokens} out tokens`,
        };
      }),
  );

  server.registerTool(
    'beagle_budgets',
    {
      title: 'Budgets',
      description:
        "List the workspace's delegation budgets (one per token account approved to the operator): cap = delegated amount, token balance, remaining headroom in tokens and USD, stalled reason (price, revoked, exhausted, draw_failed) and draws. Free.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    () =>
      run(async () => {
        const [budgets, token] = await Promise.all([api.budgets(), tokenInfo()]);
        const rows = budgets.map((b) => budgetRow(b, token.decimals, token.symbol));
        // Same predicate as the gateway ledger (open, not stalled) so the total matches /api/balance.budgetHeadroomMicro.
        const headroom = budgets.filter(budgetCountsAsHeadroom).reduce((sum, b) => sum + b.headroomMicro, 0n);
        return { budgets: rows, count: rows.length, headroomMicro: headroom, headroom: formatUsdMicro(headroom) };
      }),
  );

  server.registerTool(
    'beagle_status',
    {
      title: 'Status',
      description:
        'Gateway status: cluster and mint, indexer cursor and lag, the published price point, provider health, house model, operator (budget delegate) and version, ' +
        'plus upgradePrices (pro period and warm hour, in µUSD and formatted) for beagle_upgrade. Free.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    () =>
      run(async () => {
        const status = await api.status();
        let upgradePrices: Record<string, unknown> | null = null;
        try {
          const config = await getConfig();
          upgradePrices = {
            pro: { priceMicro: config.pro.priceMicro, price: formatUsdMicro(config.pro.priceMicro), days: config.pro.days },
            warm: { hourPriceMicro: config.warmHourPriceMicro, hourPrice: formatUsdMicro(config.warmHourPriceMicro) },
          };
        } catch {
          // status still answers when config() is unavailable
        }
        return {
          ...status,
          priceAge: priceAge(status.price, now()),
          upgradePrices,
        };
      }),
  );

  // ---- inference ---------------------------------------------------------------------------

  server.registerTool(
    'beagle_complete',
    {
      title: 'Complete',
      description:
        'Run a chat completion through the Beagle router (default model beagle/auto; explicit catalog ids and beagle/best, beagle/cheap, beagle/house work too). ' +
        'Costs credit: provider price plus markup, charged per token, unless the route is BYOK. Returns the text, the served model, the cost in µUSD and the remaining balance. ' +
        'If the call times out on your side the gateway may still have served and charged it: check beagle_usage before retrying.',
      inputSchema: {
        prompt: z.string().optional().describe('Single user message (use this or messages).'),
        messages: z
          .array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.string() }))
          .optional()
          .describe('Full conversation (use this or prompt).'),
        system: z.string().optional().describe('System prompt prepended to the conversation.'),
        model: z.string().optional().describe('Catalog id or alias; default beagle/auto.'),
        max_tokens: z.number().int().positive().optional().describe('Completion budget in tokens.'),
        difficulty: z.number().min(0).max(1).optional().describe('Override the routing difficulty estimate (0 easy … 1 hard).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ prompt, messages, system, model, max_tokens, difficulty }) =>
      run(async () => {
        const convo: ChatCompletionRequest['messages'] = [];
        if (system !== undefined && system !== '') convo.push({ role: 'system', content: system });
        if (messages !== undefined && messages.length > 0) convo.push(...messages);
        else if (prompt !== undefined) convo.push({ role: 'user', content: prompt });
        else throw new ToolInputError('pass prompt or messages');
        const req: ChatCompletionRequest = {
          model: model === undefined || model === '' ? 'beagle/auto' : model,
          messages: convo,
          ...(max_tokens === undefined ? {} : { max_tokens }),
        };
        const res = await api.complete(req, difficulty === undefined ? {} : { difficulty });
        const choice = res.choices[0];
        const meta = res.beagle;
        let balanceMicro = meta?.balanceMicro ?? null;
        if (balanceMicro === null) {
          try {
            balanceMicro = (await api.balance()).balanceMicro;
          } catch {
            balanceMicro = null;
          }
        }
        const costMicro = meta?.costMicro ?? null;
        return {
          text: choice?.message.content ?? '',
          model: res.model,
          provider: meta?.provider ?? res.model.split('/')[0] ?? null,
          paidBy: meta?.paidBy ?? null,
          costMicro,
          cost: costMicro === null ? null : formatUsdMicro(costMicro),
          balanceMicro,
          balance: balanceMicro === null ? null : formatUsdMicro(balanceMicro),
          finishReason: choice?.finish_reason ?? 'stop',
          requestId: res.id,
          usage: res.usage,
          ...(choice?.message.tool_calls === undefined ? {} : { toolCalls: choice.message.tool_calls }),
          ...(meta === undefined || meta.route.length === 0 ? {} : { route: meta.route }),
        };
      }),
  );

  // ---- spending tools ------------------------------------------------------------------------

  server.registerTool(
    'beagle_upgrade',
    {
      title: 'Upgrade',
      description:
        "Buy an upgrade with credit: 'pro' (30 days per unit: large house model, 128K house context, higher rate limit) or 'warm' (quantity = hours of warm house GPU, 1–168). " +
        'Charged to the balance immediately; fails with insufficient_credit when short. Check the prices in beagle_status (upgradePrices) and your credit in beagle_balance first.',
      inputSchema: {
        kind: z.enum(['pro', 'warm']).describe("'pro' or 'warm'."),
        quantity: z.number().int().min(1).max(168).optional().describe('Pro periods or warm hours (default 1).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    ({ kind, quantity }) =>
      run(async () => {
        const upgrade = await api.upgrade(kind, quantity ?? 1);
        return {
          ...upgrade,
          amount: formatUsdMicro(upgrade.amountMicro),
          startsAtIso: new Date(upgrade.startsAt).toISOString(),
          endsAtIso: new Date(upgrade.endsAt).toISOString(),
        };
      }),
  );

  const UNSIGNED_HINT =
    'No agent wallet is configured here, so this returns unsigned legacy transactions (base64, fee payer = the workspace or payer, fresh blockhash) for your own wallet to sign and send; pass payer when the signing wallet is not the workspace.';

  server.registerTool(
    'beagle_buy_compute',
    {
      title: 'Buy compute',
      description:
        'Buy credit by burning BEAGLE: a plain SPL BurnChecked from your token account of the mint (plus a memo naming the workspace when it is not the signer). Pass usd (credit wanted) or tokens (whole BEAGLE to burn). ' +
        'Credit is computed from the published price point when the gateway observes the burn (not the quote shown here); the result warns when that price is stale, and burns quoting below the gateway minimum are refused because they would earn nothing. ' +
        (wallet === undefined
          ? UNSIGNED_HINT
          : `This signs and sends with the agent wallet, waits for confirmation and polls the receipts / balance until the credit appears, returning within about ${Math.round(callBudgetMs / 1000)} s either way (credited: false means not visible yet, not failed). ` +
            'If the call times out on your side the burn may still have gone through: check beagle_balance / beagle_usage (or the explorer link) before retrying, never retry blindly.') +
        ' Irreversible: burned tokens are gone and credit is not refundable.',
      inputSchema: {
        usd: AMOUNT_SCHEMA.optional().describe('Credit to buy, in USD (number or decimal string).'),
        tokens: AMOUNT_SCHEMA.optional().describe('Whole tokens to burn (number or decimal string).'),
        workspace: ADDRESS_SCHEMA.optional().describe('Workspace (base58 public key) to credit; defaults to the configured workspace, else the agent wallet address (a guess: see workspaceSource in the result).'),
        payer: ADDRESS_SCHEMA.optional().describe('Unsigned path only: the wallet that will sign and pay (token account owner); defaults to workspace.'),
        tokenAccount: ADDRESS_SCHEMA.optional().describe('Unsigned path only: token account to burn from; default: the payer’s associated token account (or its largest account of the mint).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    ({ usd, tokens, workspace, payer, tokenAccount }, extra) =>
      run(async () => {
        const started = now();
        const progress = progressReporter(extra);
        const config = await getConfig();
        const deployment = walletDeployment(config);
        const amount = await resolveAmount({ usd, tokens }, config.decimals);
        const { address: ws, source: workspaceSource } = resolveWorkspace(workspace);
        const tokensFormatted = `${formatTokenAmount(amount.tokens, config.decimals)} ${config.symbol}`;
        if (amount.usdMicro < config.minCreditMicro) {
          throw new ToolInputError(
            `${tokensFormatted} quotes ${formatUsdMicro(amount.usdMicro)}, below the gateway minimum credit of ${formatUsdMicro(config.minCreditMicro)}: the burn would be recorded with no credit. Burn more.`,
          );
        }
        const { price, warnings } = await priceWarnings(amount.quote);
        const common = {
          workspace: ws,
          workspaceSource,
          tokens: amount.tokens,
          tokensFormatted,
          usdMicro: amount.usdMicro,
          usd: formatUsdMicro(amount.usdMicro),
          priceE18: amount.quote.priceE18,
          pricePointId: amount.quote.pricePointId,
          priceStale: price?.stale ?? amount.quote.stale,
          cluster: config.cluster,
          mint: config.mint,
          warnings,
        };
        if (wallet === undefined) {
          const signer = resolvePayer(payer, ws);
          const prepared = await prepareUnsignedTransactions(getRpc(config), {
            action: 'buyCompute',
            deployment,
            payer: signer,
            tokens: amount.tokens,
            workspace: ws,
            ...(tokenAccount === undefined ? {} : { tokenAccount }),
          });
          const { tokenAccount: account, memo, ...unsigned } = prepared;
          return {
            ...unsigned,
            tokenAccount: account.address,
            tokenAccountBalance: account.amount,
            memo,
            ...common,
            note:
              `Sign with ${signer} and send on ${config.cluster} before block height ${prepared.lastValidBlockHeight} (otherwise call again for a fresh blockhash). ` +
              `The gateway credits ${formatUsdMicro(amount.usdMicro)} at point ${amount.quote.pricePointId} if it observes the burn before the price changes (the price in force at observation applies). ` +
              (memo === null ? 'No memo: the token account owner is the credited workspace.' : `The memo "${memo}" credits workspace ${ws}.`) +
              workspaceWarning(workspaceSource, ws),
          };
        }
        const before = await api.balance();
        await progress(`burning ${tokensFormatted} for workspace ${ws}: BurnChecked${ws === wallet.address ? '' : ' + memo'}, waiting for confirmation`);
        const result = await wallet.buyCompute({ workspace: ws, tokens: amount.tokens });
        let credited = false;
        let creditedMicro: bigint | null = null;
        let receipt: CreditEventDto | null = null;
        let balanceMicro = before.balanceMicro;
        let availableMicro = before.availableMicro;
        // Lowest balance seen so far: a concurrent debit must not mask the credit (compare against the floor, not `before`).
        let floor = before.balanceMicro;
        if (waitForCredit) {
          const deadline = Math.min(now() + creditWaitMs, started + callBudgetMs);
          let polls = 0;
          while (now() < deadline && !(extra?.signal.aborted ?? false)) {
            await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - now())));
            const remaining = deadline - now();
            if (remaining <= 0) break;
            polls += 1;
            try {
              // Bound the poll itself: a slow gateway must not push the call past the deadline.
              const poll = Promise.all([api.receipts({ limit: 25 }).catch(() => null), api.balance()]);
              const current = await Promise.race([poll, sleep(remaining).then(() => undefined)]);
              if (current === undefined) break;
              const [receipts, balance] = current;
              balanceMicro = balance.balanceMicro;
              availableMicro = balance.availableMicro;
              const row = receipts?.rows.find((r) => r.signature === result.signature);
              if (row !== undefined) {
                receipt = row;
                credited = true;
                creditedMicro = row.usdMicro;
                break;
              }
              if (balance.balanceMicro > floor) {
                credited = true;
                creditedMicro = balance.balanceMicro - floor;
                break;
              }
              if (balance.balanceMicro < floor) floor = balance.balanceMicro;
            } catch {
              // transient API error while polling; keep waiting
            }
            await progress(`burn confirmed (${result.signature}); waiting for the gateway to index the credit (poll ${polls})`);
          }
        }
        const expected = formatUsdMicro(amount.usdMicro);
        return {
          executed: true,
          signature: result.signature,
          ...(result.slot === undefined ? {} : { slot: result.slot }),
          tokenAccount: result.tokenAccount,
          memo: result.memo,
          explorerUrl: explorerLink(config, result.signature),
          ...common,
          ...(receipt === null ? {} : { pricePointId: receipt.pricePointId ?? amount.quote.pricePointId, priceStale: receipt.priceStale, priceE18: receipt.priceE18, receipt }),
          credited,
          creditedMicro,
          balanceMicro,
          availableMicro,
          available: formatUsdMicro(availableMicro),
          elapsedMs: now() - started,
          note:
            (credited
              ? `Credited ${formatUsdMicro(creditedMicro ?? 0n)}${receipt === null ? '' : ` at price point ${receipt.pricePointId ?? '?'}${receipt.priceStale ? ' (stale price)' : ''}`}.`
              : waitForCredit
                ? `The burn is confirmed (${result.signature}) but the credit (about ${expected}) is not visible on this API key's workspace yet: indexer lag, or the credited workspace differs from the key's. Do not burn again; check beagle_balance shortly.`
                : `The burn is confirmed (${result.signature}); the credit (about ${expected}) appears once the indexer sees it. Do not burn again.`) +
            workspaceWarning(workspaceSource, ws),
        };
      }),
  );

  server.registerTool(
    'beagle_open_budget',
    {
      title: 'Open budget',
      description:
        'Authorize a budget: SPL ApproveChecked that delegates up to the cap (in usd or tokens) of your BEAGLE token account to the gateway operator, then register the account with the gateway. ' +
        'The operator burns from it as usage accrues, never above the cap, with a receipt hash in every burn memo; the headroom (min(cap, token balance) at the current price) counts as available credit right away and nothing is burned until used. ' +
        'No deadline: the budget lives until revoked (beagle_close_budget) or exhausted. SPL allows one delegate per token account, so a new approval REPLACES the previous cap rather than adding to it. ' +
        (wallet === undefined ? UNSIGNED_HINT + ' After sending, register the token account (POST /api/budgets/register) or wait for the gateway scanner.' : 'This signs and sends with the agent wallet and registers the budget.'),
      inputSchema: {
        usd: AMOUNT_SCHEMA.optional().describe('Cap in USD (number or decimal string), converted at the current price.'),
        tokens: AMOUNT_SCHEMA.optional().describe('Cap in whole tokens (number or decimal string).'),
        workspace: ADDRESS_SCHEMA.optional().describe('Workspace (base58 public key) the budget pays for; defaults to the configured workspace, else the agent wallet address (a guess: see workspaceSource in the result).'),
        payer: ADDRESS_SCHEMA.optional().describe('Unsigned path only: the wallet that will sign (token account owner); defaults to workspace.'),
        tokenAccount: ADDRESS_SCHEMA.optional().describe('Unsigned path only: token account to delegate; default: the payer’s associated token account of the mint.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    ({ usd, tokens, workspace, payer, tokenAccount }) =>
      run(async () => {
        const config = await getConfig();
        if (config.operator === null) {
          throw new BeagleApiError(503, 'not_configured', 'the gateway has no operator key, so budgets are disabled');
        }
        const deployment = walletDeployment(config);
        const amount = await resolveAmount({ usd, tokens }, config.decimals);
        const { address: ws, source: workspaceSource } = resolveWorkspace(workspace);
        const { warnings } = await priceWarnings(amount.quote);
        const capFormatted = `${formatTokenAmount(amount.tokens, config.decimals)} ${config.symbol}`;
        const common = {
          workspace: ws,
          workspaceSource,
          cap: amount.tokens,
          capFormatted,
          usdMicro: amount.usdMicro,
          usd: formatUsdMicro(amount.usdMicro),
          priceE18: amount.quote.priceE18,
          pricePointId: amount.quote.pricePointId,
          operator: config.operator,
          cluster: config.cluster,
          mint: config.mint,
          warnings,
        };
        if (wallet === undefined) {
          const signer = resolvePayer(payer, ws);
          const prepared = await prepareUnsignedTransactions(getRpc(config), {
            action: 'openBudget',
            deployment,
            payer: signer,
            cap: amount.tokens,
            ...(tokenAccount === undefined ? {} : { tokenAccount }),
          });
          const { tokenAccount: account, memo: _memo, ...unsigned } = prepared;
          return {
            ...unsigned,
            tokenAccount: account.address,
            tokenAccountBalance: account.amount,
            ...common,
            register: { tokenAccount: account.address, ...(ws === signer ? {} : { workspace: ws }) },
            note:
              `Sign with ${signer} and send on ${config.cluster} before block height ${prepared.lastValidBlockHeight}. ` +
              `Then POST /api/budgets/register with the register object (or wait for the scanner). Headroom = min(cap ${capFormatted}, token balance ${formatTokenAmount(account.amount, config.decimals)} ${config.symbol}) at the current price; keep tokens in the account.` +
              (account.delegatedAmount > 0n ? ` This replaces the existing delegation of ${formatTokenAmount(account.delegatedAmount, config.decimals)} ${config.symbol} to ${account.delegate ?? '?'}.` : '') +
              workspaceWarning(workspaceSource, ws),
          };
        }
        const result = await wallet.openBudget({ cap: amount.tokens });
        let registered = false;
        let budget: BudgetDto | null = null;
        let registerError: string | null = null;
        try {
          budget = await api.registerBudget({ tokenAccount: result.tokenAccount, ...(ws === wallet.address ? {} : { workspace: ws }) });
          registered = true;
        } catch (error) {
          registerError = toolErrorInfo(error).message;
        }
        const balanceFormatted = `${formatTokenAmount(result.balance, config.decimals)} ${config.symbol}`;
        return {
          executed: true,
          signature: result.signature,
          ...(result.slot === undefined ? {} : { slot: result.slot }),
          tokenAccount: result.tokenAccount,
          tokenAccountBalance: result.balance,
          explorerUrl: explorerLink(config, result.signature),
          ...common,
          registered,
          budget,
          registerError,
          note:
            `Delegated up to ${capFormatted} of token account ${result.tokenAccount} to the operator ${config.operator}` +
            (registered ? ' and registered the budget.' : ` (registration failed: ${registerError ?? '?'}; the gateway scanner will pick it up).`) +
            ` Headroom = min(cap, token balance ${balanceFormatted}) at the current price${result.balance < amount.tokens ? ' — the balance is below the cap, so the headroom is limited by it; top the account up to use the full cap' : ''}. Revoke any time with beagle_close_budget.` +
            workspaceWarning(workspaceSource, ws),
        };
      }),
  );

  server.registerTool(
    'beagle_close_budget',
    {
      title: 'Close budget',
      description:
        'Close a budget: SPL Revoke clears the delegation of the token account, so the operator can no longer burn from it (the gateway marks the budget closed, reason revoked). ' +
        'Usage already served but not yet drawn stays owed. ' +
        (wallet === undefined ? UNSIGNED_HINT : 'This signs and sends with the agent wallet.'),
      inputSchema: {
        tokenAccount: ADDRESS_SCHEMA.optional().describe('Token account (= budget id from beagle_budgets) to revoke; default: the signer’s associated token account of the mint.'),
        payer: ADDRESS_SCHEMA.optional().describe('Unsigned path only: the token account owner that will sign; defaults to the configured workspace.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    ({ tokenAccount, payer }) =>
      run(async () => {
        const config = await getConfig();
        const deployment = walletDeployment(config);
        if (wallet === undefined) {
          const { address: ws } = resolveWorkspace(undefined);
          const signer = resolvePayer(payer, ws);
          const prepared = await prepareUnsignedTransactions(getRpc(config), {
            action: 'closeBudget',
            deployment,
            payer: signer,
            ...(tokenAccount === undefined ? {} : { tokenAccount }),
          });
          const { tokenAccount: account, memo: _memo, ...unsigned } = prepared;
          return {
            ...unsigned,
            tokenAccount: account.address,
            delegate: account.delegate,
            delegatedAmount: account.delegatedAmount,
            cluster: config.cluster,
            note:
              `Sign with ${signer} and send on ${config.cluster} before block height ${prepared.lastValidBlockHeight}.` +
              (account.delegate === null ? ' Note: the account currently has no delegate, so the Revoke changes nothing.' : ` Revokes the delegation of ${formatTokenAmount(account.delegatedAmount, config.decimals)} ${config.symbol} to ${account.delegate}.`),
          };
        }
        const result = await wallet.closeBudget(tokenAccount === undefined ? {} : { tokenAccount });
        return {
          executed: true,
          signature: result.signature,
          ...(result.slot === undefined ? {} : { slot: result.slot }),
          tokenAccount: result.tokenAccount,
          explorerUrl: explorerLink(config, result.signature),
          cluster: config.cluster,
          note: `Revoked the delegation of token account ${result.tokenAccount}; the gateway shows the budget as closed (revoked) after its next scan.`,
        };
      }),
  );

  // ---- resources -----------------------------------------------------------------------------

  server.registerResource(
    'models',
    BEAGLE_RESOURCE_URIS.models,
    { title: 'Beagle models', description: 'The model catalog as a markdown table with prices and availability.', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: modelsMarkdown(await api.models()) }] }),
  );

  server.registerResource(
    'quickstart',
    BEAGLE_RESOURCE_URIS.quickstart,
    { title: 'Beagle quick start', description: 'How to check credit, buy compute, run inference and handle 402s.', mimeType: 'text/markdown' },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: quickstartMarkdown(apiUrl) }] }),
  );

  return server;
}
