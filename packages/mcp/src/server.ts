/**
 * The Beagle MCP server (SPEC §6.3): ten tools and two resources over a {@link BeagleApi}, with an
 * optional {@link WalletExecutor} for the two tools that spend tokens on chain.
 *
 * Every tool returns its result both as pretty-printed JSON text and as `structuredContent`
 * (bigints serialized as decimal strings). Failures come back as `isError` results whose payload is
 * `{ error: { code, message, status? } }`, where `code` is the gateway error code when the gateway
 * produced the failure (`insufficient_credit`, `invalid_api_key`, …).
 *
 * @module server
 */
import { explorerTxUrl, chainById } from '@beagle/shared/chains';
import { formatPriceE18, formatTokenAmount, formatUsdMicro, parseTokenAmount, parseUsdToMicro } from '@beagle/shared/credit';
import { ALIASES, ALIAS_DESCRIPTIONS, TIER_ORDER, type Tier } from '@beagle/shared/models';
import type { BalanceDto, BudgetDto, ConfigDto, ModelDto, QuoteDto } from '@beagle/shared/api';
import type { ChatCompletionRequest } from '@beagle/shared/openai';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { getAddress, isAddress, type Address } from 'viem';
import { z } from 'zod';
import { BeagleApiError, type BeagleApi } from './api.js';
import { buildUnsignedSteps, creditFloor, DEFAULT_TOLERANCE_BPS, MAX_TOLERANCE_BPS, WalletError, type WalletExecutor } from './wallet.js';

/** Name and version reported in `initialize`. */
export const MCP_SERVER_INFO = { name: 'beagle', version: '0.1.0' } as const;

/** The ten tool names of SPEC §6.3, in table order. */
export const BEAGLE_TOOL_NAMES = [
  'beagle_balance',
  'beagle_models',
  'beagle_quote',
  'beagle_complete',
  'beagle_usage',
  'beagle_buy_compute',
  'beagle_open_budget',
  'beagle_budgets',
  'beagle_upgrade',
  'beagle_status',
] as const;

/** One of {@link BEAGLE_TOOL_NAMES}. */
export type BeagleToolName = (typeof BEAGLE_TOOL_NAMES)[number];

/** Resource URIs served by the server. */
export const BEAGLE_RESOURCE_URIS = { models: 'beagle://models', quickstart: 'beagle://quickstart' } as const;

/** Longest budget the desk accepts (`MAX_BUDGET_DURATION = 30 days`), in hours. */
export const MAX_BUDGET_HOURS = 720;

/** Options of {@link createBeagleMcpServer}. */
export interface BeagleMcpServerOptions {
  /** Signs `beagle_buy_compute` / `beagle_open_budget`; without it those tools return unsigned steps. */
  wallet?: WalletExecutor;
  /** After a burn, poll `balance()` until the credit shows up (default `true`). */
  waitForCredit?: boolean;
  /** How long to wait for the credit after the burn is mined, ms (default 60 000, SPEC §6.1 "up to 60 s"). */
  creditWaitMs?: number;
  /** Balance polling interval, ms (default 2 000). */
  pollIntervalMs?: number;
  /**
   * Total time budget of one `beagle_buy_compute` call, ms, measured from its start (default 45 000).
   * The credit poll stops when this or `creditWaitMs` runs out, whichever is first, so the result
   * (with `txHash`) reaches clients whose request timeout is the MCP SDK default of 60 s even when
   * the receipt took a while; progress notifications are sent meanwhile for clients that reset their
   * timeout on progress.
   */
  callBudgetMs?: number;
  /**
   * Default `workspace` of the wallet tools when the call omits it. Falls back to
   * `wallet.address`; the gateway's `/mcp` mount passes the key's workspace here.
   */
  workspace?: Address;
  /** Gateway URL shown in `beagle://quickstart` (default `http://localhost:8787`). */
  apiUrl?: string;
  /** How long `config()` is cached, ms (default 60 000). */
  configTtlMs?: number;
  /** Clock in unix ms (tests). */
  now?: () => number;
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
  txHash?: string;
}

/** Maps any thrown value to the `{ code, message, status? }` payload of an `isError` result. */
export function toolErrorInfo(error: unknown): ToolErrorInfo {
  if (BeagleApiError.is(error)) return { code: error.code, message: error.message, status: error.status };
  if (error instanceof WalletError) return { code: error.code, message: error.message, ...(error.txHash === undefined ? {} : { txHash: error.txHash }) };
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
 * Numbers are taken at their shortest round-trip representation, so `0.1` is exactly `1e17` raw.
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
const ADDRESS_SCHEMA = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x address');

interface ResolvedAmount {
  tokens: bigint;
  usdMicro: bigint;
  quote: QuoteDto;
}

/** Human-readable summary of a balance (`"$12.34 available; plan free; 1 BEAGLE = $0.0100"`). */
export function balanceSummary(balance: BalanceDto, symbol: string): string {
  const plan = balance.plan === 'pro' && balance.planUntil !== null ? `pro until ${new Date(balance.planUntil).toISOString()}` : balance.plan;
  const price = balance.price.priceE18 === 0n ? 'price unavailable' : `1 ${symbol} = ${formatPriceE18(balance.price.priceE18, { minFractionDigits: 4 })}${balance.price.stale ? ' (stale)' : ''}`;
  return `${formatUsdMicro(balance.availableMicro)} available; plan ${plan}; ${price}`;
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

/** Open, unexpired and not stalled: the gateway's predicate for headroom that counts as available credit. */
function budgetCountsAsHeadroom(budget: BudgetDto, nowMs: number): boolean {
  return !budget.closed && budget.stalledReason === null && budget.deadline * 1000 > nowMs;
}

function budgetRow(budget: BudgetDto, decimals: number, symbol: string, nowMs: number): Record<string, unknown> {
  return {
    ...budget,
    capFormatted: `${formatTokenAmount(budget.cap, decimals)} ${symbol}`,
    drawnFormatted: `${formatTokenAmount(budget.drawn, decimals)} ${symbol}`,
    headroomFormatted: `${formatTokenAmount(budget.headroomTokens, decimals)} ${symbol} (${formatUsdMicro(budget.headroomMicro)})`,
    deadlineIso: new Date(budget.deadline * 1000).toISOString(),
    active: !budget.closed && budget.deadline * 1000 > nowMs,
    countsAsHeadroom: budgetCountsAsHeadroom(budget, nowMs),
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

Beagle is compute for agents on Robinhood Chain: one API key for every model, paid for by burning BEAGLE.
Credit is tracked in µUSD (1 USD = 1,000,000 µUSD); every response reports its cost and your remaining balance.

## 1. Check credit

Call \`beagle_balance\`. \`availableMicro\` = balance − reservations + budget headroom. Requests need credit
unless the route is served through your own provider key (BYOK).

## 2. Get credit

- \`beagle_buy_compute\` with \`usd\` or \`tokens\`: burns BEAGLE through the CreditDesk contract (approve + burnForCreditMin).
  The contract emits the USD value at the on-chain price and the gateway credits exactly that amount once indexed.
  The burn carries a credit floor of quote − \`tolerance_bps\` (default 100 = 1 %): if a price change lands first and the
  burn would credit less, it reverts with SlippageExceeded and costs only gas; re-quote and retry.
- \`beagle_open_budget\` with \`usd\`/\`tokens\` and \`hours\` (≤ 720): approve + openBudget. The operator draws from the
  budget as usage accrues, never above the cap; the headroom counts as available credit right away.
- Without an agent wallet both tools return unsigned transaction steps (\`to\`, \`data\`, \`value\`) to sign yourself.

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
      'Beagle gives agents one API key for every model, paid for by burning BEAGLE on Robinhood Chain. ' +
      'Check beagle_balance before spending; beagle_complete costs credit; beagle_buy_compute and beagle_open_budget spend tokens on chain. ' +
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
      return { symbol: config.token?.symbol ?? 'BEAGLE', decimals: config.token?.decimals ?? 18 };
    } catch {
      return { symbol: 'BEAGLE', decimals: 18 };
    }
  }

  function requireDeployment(config: ConfigDto): { creditDesk: Address; token: Address; symbol: string; decimals: number } {
    if (config.creditDesk === null || config.token === null) {
      throw new BeagleApiError(503, 'not_configured', 'the gateway has no CreditDesk deployment configured for this chain');
    }
    return {
      creditDesk: config.creditDesk as Address,
      token: config.token.address as Address,
      symbol: config.token.symbol,
      decimals: config.token.decimals,
    };
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
   * Where the wallet tools' `workspace` came from: the call (`input`), the server configuration
   * (`configured`: `BEAGLE_WORKSPACE` or the key's workspace on `/mcp`), or the agent wallet address
   * (`agent_wallet`), which is a guess: the API key may belong to a different workspace.
   */
  type WorkspaceSource = 'input' | 'configured' | 'agent_wallet';

  function resolveWorkspace(input: string | undefined): { address: Address; source: WorkspaceSource } {
    const [ws, source]: [string | undefined, WorkspaceSource] =
      input !== undefined ? [input, 'input'] : opts.workspace !== undefined ? [opts.workspace, 'configured'] : [wallet?.address, 'agent_wallet'];
    if (ws === undefined) {
      throw new ToolInputError(
        'workspace is required: pass the 0x address of the workspace to credit (your API key belongs to one). No agent wallet is configured, so it cannot be inferred.',
      );
    }
    if (!isAddress(ws, { strict: false })) throw new ToolInputError(`workspace is not an address: ${JSON.stringify(ws)}`);
    return { address: getAddress(ws), source };
  }

  function workspaceWarning(source: WorkspaceSource, address: Address): string {
    return source === 'agent_wallet'
      ? ` Warning: workspace defaulted to the agent wallet ${address}, which is not necessarily the workspace of this API key (set BEAGLE_WORKSPACE or pass workspace to be explicit); credit on another workspace is reachable only by signing in as it.`
      : '';
  }

  function txUrl(config: ConfigDto, txHash: string): string | null {
    if (config.explorer !== null && config.explorer !== '') return `${config.explorer.replace(/\/+$/, '')}/tx/${txHash}`;
    const chain = chainById(config.chainId);
    return chain === undefined ? null : (explorerTxUrl(chain, txHash) ?? null);
  }

  // ---- read-only tools -----------------------------------------------------------------------

  server.registerTool(
    'beagle_balance',
    {
      title: 'Balance',
      description:
        "Show the workspace's credit: available µUSD (balance − reserved + budget headroom), plan and the current BEAGLE price. " +
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
        "Convert between BEAGLE tokens and USD at the CreditDesk's current on-chain price. Pass usd (e.g. 5 or \"2.50\") or tokens (whole tokens, e.g. 1000). " +
        'Free. Use it before beagle_buy_compute or beagle_open_budget to size a purchase.',
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
          updatedAtIso: new Date(quote.updatedAt * 1000).toISOString(),
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
        "List the workspace's on-chain budgets: cap, drawn, remaining headroom in tokens and USD, deadline, stalled reason (price, allowance, draw_failed) and draws. Free.",
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    () =>
      run(async () => {
        const [budgets, token] = await Promise.all([api.budgets(), tokenInfo()]);
        const nowMs = now();
        const rows = budgets.map((b) => budgetRow(b, token.decimals, token.symbol, nowMs));
        // Same predicate as the gateway ledger (open, unexpired, not stalled) so the total matches /api/balance.budgetHeadroomMicro.
        const headroom = budgets.filter((b) => budgetCountsAsHeadroom(b, nowMs)).reduce((sum, b) => sum + b.headroomMicro, 0n);
        return { budgets: rows, count: rows.length, headroomMicro: headroom, headroom: formatUsdMicro(headroom) };
      }),
  );

  server.registerTool(
    'beagle_status',
    {
      title: 'Status',
      description:
        'Gateway status: chain and CreditDesk, indexer height and lag, provider health, house model, operator mode and version, ' +
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
        return { ...status, upgradePrices };
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

  server.registerTool(
    'beagle_buy_compute',
    {
      title: 'Buy compute',
      description:
        'Buy credit by burning BEAGLE through the CreditDesk (approve + burnForCreditMin). Pass usd (credit wanted) or tokens (whole BEAGLE to burn); the on-chain price sets the rate. ' +
        `The burn carries a credit floor of quote − tolerance_bps (default ${DEFAULT_TOLERANCE_BPS} = 1 %): if a price change lands before the transaction and the contract would credit less, it reverts with SlippageExceeded and costs only gas (nothing is burned; error code slippage_exceeded) — re-quote and retry, or raise tolerance_bps. ` +
        (wallet === undefined
          ? 'No agent wallet is configured here, so this returns unsigned transaction steps (to, data, value) for your own wallet to sign in order; pass workspace to name the account to credit.'
          : `This signs and sends with the agent wallet (approving current allowance + amount so open budgets keep theirs), waits for the burn to be mined and polls the balance until the credit appears, returning within about ${Math.round(callBudgetMs / 1000)} s either way (credited: false means not visible yet, not failed). ` +
            'If the call times out on your side the burn may still have gone through: check beagle_balance / beagle_usage (or the explorer) before retrying, never retry blindly.') +
        ' Irreversible: burned tokens are gone and credit is not refundable.',
      inputSchema: {
        usd: AMOUNT_SCHEMA.optional().describe('Credit to buy, in USD (number or decimal string).'),
        tokens: AMOUNT_SCHEMA.optional().describe('Whole tokens to burn (number or decimal string).'),
        workspace: ADDRESS_SCHEMA.optional().describe('Workspace (0x address) to credit; defaults to the configured workspace, else the agent wallet address (a guess: see workspaceSource in the result).'),
        tolerance_bps: z
          .number()
          .int()
          .min(0)
          .max(MAX_TOLERANCE_BPS)
          .optional()
          .describe(
            `Slippage tolerance of the credit floor in basis points, 0–${MAX_TOLERANCE_BPS} (default ${DEFAULT_TOLERANCE_BPS} = 1 %). The burn reverts, costing only gas, if the on-chain quote at inclusion would credit less than quote − tolerance; 0 demands exactly the quoted amount.`,
          ),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    ({ usd, tokens, workspace, tolerance_bps }, extra) =>
      run(async () => {
        const started = now();
        const progress = progressReporter(extra);
        const config = await getConfig();
        const dep = requireDeployment(config);
        const amount = await resolveAmount({ usd, tokens }, dep.decimals);
        const { address: ws, source: workspaceSource } = resolveWorkspace(workspace);
        const tokensFormatted = `${formatTokenAmount(amount.tokens, dep.decimals)} ${dep.symbol}`;
        // Credit floor (policy): quote − ceil(quote · tolerance / 10 000); the desk reverts rather than credit less.
        const toleranceBps = tolerance_bps ?? DEFAULT_TOLERANCE_BPS;
        const minUsdMicro = creditFloor(amount.usdMicro, toleranceBps);
        const floorText = `${formatUsdMicro(minUsdMicro)} (quote − ${toleranceBps} bps)`;
        const common = {
          workspace: ws,
          workspaceSource,
          tokens: amount.tokens,
          tokensFormatted,
          usdMicro: amount.usdMicro,
          usd: formatUsdMicro(amount.usdMicro),
          minUsdMicro,
          minUsd: formatUsdMicro(minUsdMicro),
          toleranceBps,
          priceE18: amount.quote.priceE18,
          chainId: config.chainId,
          creditDesk: dep.creditDesk,
          token: dep.token,
        };
        if (wallet === undefined) {
          const unsigned = buildUnsignedSteps({
            action: 'buyCompute',
            chainId: config.chainId,
            deployment: { creditDesk: dep.creditDesk, token: dep.token },
            workspace: ws,
            tokens: amount.tokens,
            minUsdMicro,
            tokenSymbol: dep.symbol,
            tokenDecimals: dep.decimals,
          });
          return {
            ...unsigned,
            ...common,
            note:
              `Sign and send the steps in order on chain ${config.chainId}. The gateway credits ${formatUsdMicro(amount.usdMicro)} (at the price the contract reads when mined) once the CreditPurchased event is indexed. ` +
              `The burnForCreditMin step carries a credit floor of ${floorText}: if the price moves and the burn would credit less, it reverts with SlippageExceeded and costs only gas; re-quote and build new steps. ` +
              'If this wallet has open budgets, approve your current allowance + the amount: the burn spends the allowance their headroom depends on.' +
              workspaceWarning(workspaceSource, ws),
          };
        }
        const before = await api.balance();
        await progress(`burning ${tokensFormatted} for workspace ${ws}: approve + burnForCreditMin (credit floor ${floorText}), waiting for the receipt`);
        const result = await wallet.buyCompute({ workspace: ws, tokens: amount.tokens, minUsdMicro });
        // The event's usdMicro is the exact credit the gateway books (SPEC §9); the balance poll only tells whether it is visible yet.
        let creditedMicro: bigint | null = result.usdMicro ?? null;
        let credited = false;
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
              // Bound the poll itself: a slow balance() must not push the call past the deadline.
              const current = await Promise.race([api.balance(), sleep(remaining).then(() => undefined)]);
              if (current === undefined) break;
              balanceMicro = current.balanceMicro;
              availableMicro = current.availableMicro;
              if (current.balanceMicro > floor) {
                credited = true;
                if (creditedMicro === null) creditedMicro = current.balanceMicro - floor;
                break;
              }
              if (current.balanceMicro < floor) floor = current.balanceMicro;
            } catch {
              // transient API error while polling; keep waiting
            }
            await progress(`burn mined (tx ${result.txHash}); waiting for the gateway to index the credit (poll ${polls})`);
          }
        }
        const emitted = creditedMicro === null ? formatUsdMicro(amount.usdMicro) : formatUsdMicro(creditedMicro);
        return {
          executed: true,
          txHash: result.txHash,
          ...(result.approveTxHash === undefined ? {} : { approveTxHash: result.approveTxHash }),
          ...(result.receiptId === undefined ? {} : { receiptId: result.receiptId }),
          ...common,
          ...(result.priceE18 === undefined ? {} : { priceE18: result.priceE18 }),
          explorerTxUrl: txUrl(config, result.txHash),
          credited,
          creditedMicro,
          balanceMicro,
          availableMicro,
          available: formatUsdMicro(availableMicro),
          elapsedMs: now() - started,
          note:
            (credited
              ? `Credited ${emitted}.`
              : waitForCredit
                ? `The burn is mined (tx ${result.txHash}) and the contract emitted ${emitted} of credit, but it is not visible on this API key's workspace yet: indexer lag, or the credited workspace differs from the key's. Do not burn again; check beagle_balance shortly.`
                : `The burn is mined (tx ${result.txHash}); the credit (${emitted}) appears once the indexer sees the event. Do not burn again.`) +
            workspaceWarning(workspaceSource, ws),
        };
      }),
  );

  server.registerTool(
    'beagle_open_budget',
    {
      title: 'Open budget',
      description:
        `Authorize a budget: approve BEAGLE and open an on-chain budget (cap in usd or tokens, hours 1–${MAX_BUDGET_HOURS}) that the operator draws from as usage accrues, never above the cap; ` +
        'the headroom counts as available credit right away and nothing is burned until used. ' +
        (wallet === undefined
          ? 'No agent wallet is configured here, so this returns unsigned transaction steps for your own wallet; pass workspace to name the account the budget pays for.'
          : 'This signs and sends with the agent wallet and returns the budget id.') +
        ' Close it any time from the dashboard or with closeBudget.',
      inputSchema: {
        usd: AMOUNT_SCHEMA.optional().describe('Cap in USD (number or decimal string).'),
        tokens: AMOUNT_SCHEMA.optional().describe('Cap in whole tokens (number or decimal string).'),
        hours: z.number().int().min(1).max(MAX_BUDGET_HOURS).describe(`Budget lifetime in hours (max ${MAX_BUDGET_HOURS} = 30 days).`),
        workspace: ADDRESS_SCHEMA.optional().describe('Workspace (0x address) the budget pays for; defaults to the configured workspace, else the agent wallet address (a guess: see workspaceSource in the result).'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    ({ usd, tokens, hours, workspace }) =>
      run(async () => {
        const config = await getConfig();
        const dep = requireDeployment(config);
        const amount = await resolveAmount({ usd, tokens }, dep.decimals);
        const { address: ws, source: workspaceSource } = resolveWorkspace(workspace);
        // Leave a margin at the maximum so a slow inclusion never trips `deadline > now + 30 days`.
        const margin = hours === MAX_BUDGET_HOURS ? 300 : 0;
        const deadline = BigInt(Math.floor(now() / 1000) + hours * 3600 - margin);
        const common = {
          workspace: ws,
          workspaceSource,
          cap: amount.tokens,
          capFormatted: `${formatTokenAmount(amount.tokens, dep.decimals)} ${dep.symbol}`,
          usdMicro: amount.usdMicro,
          usd: formatUsdMicro(amount.usdMicro),
          priceE18: amount.quote.priceE18,
          hours,
          deadline,
          deadlineIso: new Date(Number(deadline) * 1000).toISOString(),
          chainId: config.chainId,
          creditDesk: dep.creditDesk,
          token: dep.token,
        };
        if (wallet === undefined) {
          const unsigned = buildUnsignedSteps({
            action: 'openBudget',
            chainId: config.chainId,
            deployment: { creditDesk: dep.creditDesk, token: dep.token },
            workspace: ws,
            cap: amount.tokens,
            deadline,
            tokenSymbol: dep.symbol,
            tokenDecimals: dep.decimals,
          });
          return {
            ...unsigned,
            ...common,
            note:
              `Sign and send the steps in order on chain ${config.chainId}. Keep the allowance and token balance in the wallet: the headroom is min(cap − drawn, allowance, balance), ` +
              'and the allowance is shared by every budget of this wallet, so approve your current allowance + the cap when other budgets are open.' +
              workspaceWarning(workspaceSource, ws),
          };
        }
        const result = await wallet.openBudget({ workspace: ws, cap: amount.tokens, deadline });
        return {
          executed: true,
          txHash: result.txHash,
          ...(result.approveTxHash === undefined ? {} : { approveTxHash: result.approveTxHash }),
          budgetId: result.budgetId,
          ...common,
          explorerTxUrl: txUrl(config, result.txHash),
          note:
            `Budget ${result.budgetId.toString()} opened${result.approveTxHash === undefined ? '' : ' (allowance raised by the cap on top of what was there)'}. Keep the allowance and token balance in the wallet; the gateway shows the headroom in beagle_budgets after indexing.` +
            workspaceWarning(workspaceSource, ws),
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
