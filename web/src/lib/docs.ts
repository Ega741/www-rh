/**
 * Code snippets and reference text for the Docs page and the landing (SPEC §7 `/docs`). All
 * take the public gateway base URL (no trailing slash) so the page always shows copy-pasteable
 * commands.
 */

/** Placeholder key used in snippets. */
export const KEY_PLACEHOLDER = 'bgl_YOUR_API_KEY';

/**
 * Placeholder for the path of a checkout of this repository. `@beagle/mcp` and `@beagle/shared`
 * are workspace packages, not published to npm, so the snippets run the built files in place.
 */
export const REPO_PLACEHOLDER = '<repo>';

/** The stdio MCP binary relative to the repository root (built by {@link MCP_BUILD_COMMAND}). */
export const MCP_BIN_PATH = 'packages/mcp/dist/bin.js';

/** The canonical-JSON / receipt-hash module relative to the repository root (built by `pnpm --filter @beagle/shared build`). */
export const SHARED_CANONICAL_PATH = 'packages/shared/dist/canonical.js';

/**
 * Build step the local MCP binary needs once. `@beagle/mcp` imports `@beagle/shared` through its
 * `dist/` (not committed) and a package filter does not build dependencies, so the shared package
 * is built explicitly first (pnpm orders the two topologically).
 */
export const MCP_BUILD_COMMAND = 'pnpm install && pnpm --filter @beagle/shared --filter @beagle/mcp build';

/** Absolute path of the stdio MCP binary inside `repo`. */
export function mcpBinPath(repo = REPO_PLACEHOLDER): string {
  return `${repo}/${MCP_BIN_PATH}`;
}

/** OpenAI-compatible base URL (`<base>/v1`). */
export function openAiBaseUrl(base: string): string {
  return `${base}/v1`;
}

/** curl against `/v1/chat/completions` with the `beagle/auto` alias. */
export function curlSnippet(base: string, model = 'beagle/auto'): string {
  return [
    `curl ${base}/v1/chat/completions \\`,
    `  -H "Authorization: Bearer ${KEY_PLACEHOLDER}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"model":"${model}","messages":[{"role":"user","content":"Say hi to Beagle."}]}'`,
  ].join('\n');
}

/** curl against the Anthropic-compatible `/v1/messages`. */
export function curlMessagesSnippet(base: string, model = 'beagle/auto'): string {
  return [
    `curl ${base}/v1/messages \\`,
    `  -H "x-api-key: ${KEY_PLACEHOLDER}" \\`,
    `  -H "anthropic-version: 2023-06-01" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"model":"${model}","max_tokens":256,"messages":[{"role":"user","content":"Say hi to Beagle."}]}'`,
  ].join('\n');
}

/** OpenAI Python SDK pointed at the gateway. */
export function pythonOpenAiSnippet(base: string): string {
  return [
    `from openai import OpenAI`,
    ``,
    `client = OpenAI(base_url="${openAiBaseUrl(base)}", api_key="${KEY_PLACEHOLDER}")`,
    `resp = client.chat.completions.create(`,
    `    model="beagle/auto",`,
    `    messages=[{"role": "user", "content": "Summarise this in one line: ..."}],`,
    `)`,
    `print(resp.choices[0].message.content)`,
    `print(resp.model)  # the catalog id that actually served the request`,
  ].join('\n');
}

/** OpenAI Node SDK pointed at the gateway. */
export function nodeOpenAiSnippet(base: string): string {
  return [
    `import OpenAI from "openai";`,
    ``,
    `const client = new OpenAI({ baseURL: "${openAiBaseUrl(base)}", apiKey: process.env.BEAGLE_API_KEY });`,
    `const stream = await client.chat.completions.create({`,
    `  model: "beagle/auto",`,
    `  messages: [{ role: "user", content: "Write a haiku about burning tokens." }],`,
    `  stream: true,`,
    `});`,
    `for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content ?? "");`,
  ].join('\n');
}

/** Anthropic Node SDK pointed at the gateway (`/v1/messages`). */
export function anthropicNodeSnippet(base: string): string {
  return [
    `import Anthropic from "@anthropic-ai/sdk";`,
    ``,
    `const client = new Anthropic({ baseURL: "${base}", apiKey: process.env.BEAGLE_API_KEY });`,
    `const msg = await client.messages.create({`,
    `  model: "beagle/best",`,
    `  max_tokens: 512,`,
    `  messages: [{ role: "user", content: "Explain budgets in two sentences." }],`,
    `});`,
    `console.log(msg.content);`,
  ].join('\n');
}

/** Anthropic Python SDK pointed at the gateway. */
export function anthropicPythonSnippet(base: string): string {
  return [
    `import anthropic`,
    ``,
    `client = anthropic.Anthropic(base_url="${base}", api_key="${KEY_PLACEHOLDER}")`,
    `msg = client.messages.create(`,
    `    model="beagle/best",`,
    `    max_tokens=512,`,
    `    messages=[{"role": "user", "content": "Explain budgets in two sentences."}],`,
    `)`,
    `print(msg.content[0].text)`,
  ].join('\n');
}

/**
 * MCP server config for Claude Desktop (`claude_desktop_config.json`) launching the `beagle-mcp`
 * stdio binary from a checkout (`node <repo>/packages/mcp/dist/bin.js`).
 */
export function mcpStdioConfig(base: string): string {
  const cfg = {
    mcpServers: {
      beagle: {
        command: 'node',
        args: [mcpBinPath()],
        env: { BEAGLE_API_URL: base, BEAGLE_API_KEY: KEY_PLACEHOLDER },
      },
    },
  };
  return JSON.stringify(cfg, null, 2);
}

/** `claude mcp add` command for Claude Code (stdio binary from a checkout). */
export function claudeCodeMcpCommand(base: string): string {
  return [
    `claude mcp add beagle \\`,
    `  -e BEAGLE_API_URL=${base} \\`,
    `  -e BEAGLE_API_KEY=${KEY_PLACEHOLDER} \\`,
    `  -- node ${mcpBinPath()}`,
  ].join('\n');
}

/** MCP over Streamable HTTP (`/mcp`) config, for clients that support remote servers. */
export function mcpHttpConfig(base: string): string {
  const cfg = {
    mcpServers: {
      beagle: {
        type: 'http',
        url: `${base}/mcp`,
        headers: { Authorization: `Bearer ${KEY_PLACEHOLDER}` },
      },
    },
  };
  return JSON.stringify(cfg, null, 2);
}

/** Shell lines for running `beagle-mcp` by hand from a checkout, with the optional agent wallet. */
export function mcpEnvSnippet(base: string, rpcUrl: string): string {
  return [
    `# once, from a checkout of this repository`,
    `${MCP_BUILD_COMMAND}`,
    ``,
    `export BEAGLE_API_URL=${base}`,
    `export BEAGLE_API_KEY=${KEY_PLACEHOLDER}`,
    `# optional: let the agent sign burn / approve / revoke itself (base58 secret key or a solana-keygen JSON array)`,
    `# export BEAGLE_AGENT_SECRET_KEY=...`,
    `# export BEAGLE_RPC_URL=${rpcUrl}`,
    `node ${MCP_BIN_PATH}`,
  ].join('\n');
}

/**
 * Node script recomputing a usage receipt hash with `@beagle/shared` from a checkout. The route
 * returns `{ receipt, hash }` (SPEC §5.9) and `hash = receiptHash(receipt)` covers the nested
 * receipt only, so the snippet hashes exactly that object.
 */
export function verifyReceiptSnippet(base: string, requestId: string): string {
  return [
    `// pnpm --filter @beagle/shared build, then: node verify.mjs`,
    `import { receiptHash } from "${REPO_PLACEHOLDER}/${SHARED_CANONICAL_PATH}";`,
    ``,
    `const res = await fetch("${base}/api/receipts/${requestId}", {`,
    `  headers: { Authorization: "Bearer ${KEY_PLACEHOLDER}" },`,
    `});`,
    `const { receipt, hash } = await res.json();`,
    `console.log(receiptHash(receipt) === hash ? "receipt verified" : "MISMATCH");`,
  ].join('\n');
}

/** The 402 body the gateway returns when credit runs out (SPEC §5.7). */
export const INSUFFICIENT_CREDIT_BODY = JSON.stringify(
  {
    error: {
      message: 'Insufficient credit: burn BEAGLE on the Credits page or open a budget.',
      type: 'insufficient_credit',
      code: 'insufficient_credit',
      param: null,
    },
  },
  null,
  2,
);

/** Facts of the deployment the chain snippets mention. */
export interface ChainDocContext {
  /** `localnet` | `devnet` | `mainnet-beta`. */
  cluster: string;
  /** JSON-RPC endpoint (`--url` of the CLI snippets). */
  rpcUrl: string;
  mint: string | undefined;
  operator: string | undefined;
  decimals: number;
  symbol: string;
}

const MINT_PLACEHOLDER = '<mint>';
const OPERATOR_PLACEHOLDER = '<operator>';

/** `spl-token` CLI lines that burn for credit without the web app (SPEC §3.2; the memo is optional). */
export function splTokenBurnSnippet(ctx: ChainDocContext): string {
  const mint = ctx.mint ?? MINT_PLACEHOLDER;
  return [
    `# your token account of the mint (the ATA): spl-token 5.x`,
    `spl-token --url ${ctx.rpcUrl} address --token ${mint} --verbose`,
    `# burn 1000 ${ctx.symbol} (final; credit = amount × published price when the gateway observes it)`,
    `spl-token --url ${ctx.rpcUrl} burn <token-account> 1000`,
    `# or, to credit another workspace, attach the memo from a script:`,
    `#   BurnChecked(tokenAccount, mint, owner, amount, decimals) + Memo("beagle:v1 ws=<workspace>")`,
  ].join('\n');
}

/** `spl-token` CLI lines that open / close a budget by delegation (SPEC §3.4). */
export function splTokenBudgetSnippet(ctx: ChainDocContext): string {
  const operator = ctx.operator ?? OPERATOR_PLACEHOLDER;
  return [
    `# delegate a cap of 500 ${ctx.symbol} to the operator (a new approve replaces the previous cap)`,
    `spl-token --url ${ctx.rpcUrl} approve <token-account> 500 ${operator}`,
    `# tell the gateway (the scanner also finds it on its own within a minute)`,
    `curl -X POST ${'${BEAGLE_API_URL}'}/api/budgets/register \\`,
    `  -H "Authorization: Bearer ${KEY_PLACEHOLDER}" -H "Content-Type: application/json" \\`,
    `  -d '{"tokenAccount":"<token-account>"}'`,
    `# close: clear the delegation`,
    `spl-token --url ${ctx.rpcUrl} revoke <token-account>`,
  ].join('\n');
}

/** Bash lines reading the published price history (SPEC §3.3) to recompute a credit. */
export function priceHistorySnippet(base: string): string {
  return [
    `curl ${base}/api/price            # current point: { pricePointId, priceE18, observedAt, stale, source, … }`,
    `curl "${base}/api/price/history?limit=100"`,
    `# credit of a burn = floor(tokenAmount × priceE18 / 10^(decimals + 12)) µUSD, with the point the event names`,
  ].join('\n');
}

/** How a burn becomes credit (SPEC §1, §3.2). */
export const CREDIT_DOC = {
  /** The integer formula the gateway applies (`decimals` from the mint). */
  formula: 'usdMicro = floor(tokenAmount × priceE18 / 10^(decimals + 12))',
  /** For a 6-decimal mint the exponent collapses to 18. */
  sixDecimals: 'usdMicro = tokenAmount × priceE18 / 1e18',
  /** Worked example at $0.01 per token. */
  example: '1000 BEAGLE (1_000_000_000 raw, 6 decimals) at priceE18 = 1e16 ($0.01) → 10_000_000 µUSD = $10',
  /** The memo that redirects the credit. */
  memo: 'beagle:v1 ws=<workspace public key>',
  /** The sentence every client shows. */
  sentence: 'Credit is computed from the published price when the gateway observes the burn.',
} as const;

/** Budgets as SPL delegation (SPEC §3.4). */
export const BUDGET_DOC = {
  open: 'ApproveChecked(tokenAccount, mint, delegate = operator, owner, cap, decimals)',
  draw: '[BurnChecked(tokenAccount, mint, authority = operator, amount, decimals), Memo("beagle:draw v1 ws=<workspace> h=<receiptHash>")]',
  close: 'Revoke(tokenAccount, owner)',
  headroom: 'headroom = min(delegatedAmount, balance) while delegate == operator',
  drawMemo: 'beagle:draw v1 ws=<workspace> h=0x<sha256 of the settled batch>',
} as const;

/** One row of the header reference table. */
export interface HeaderDoc {
  name: string;
  direction: 'request' | 'response';
  text: string;
}

/** Request / response headers of the inference API (SPEC §5.8). */
export const HEADER_DOCS: readonly HeaderDoc[] = [
  { name: 'Authorization: Bearer bgl_…', direction: 'request', text: 'API key. `x-api-key: bgl_…` is accepted too (Anthropic SDK style).' },
  { name: 'x-beagle-difficulty', direction: 'request', text: 'Override the difficulty estimate with a number in [0, 1]; drives the tier `beagle/auto` picks.' },
  { name: 'x-beagle-fallback', direction: 'request', text: '`none` | `cheaper` (default) | `any`. Fallback never silently upgrades price class unless you opt into `any`.' },
  { name: 'x-beagle-request-id', direction: 'response', text: 'Request id (`req_…`). Fetch the verifiable receipt at `/api/receipts/<id>`.' },
  { name: 'x-beagle-model', direction: 'response', text: 'Catalog id of the model that served the request (also the `model` field of the body).' },
  { name: 'x-beagle-provider', direction: 'response', text: 'Upstream provider: anthropic | openai | google | house.' },
  { name: 'x-beagle-paid-by', direction: 'response', text: '`credit` or `byok` (your own provider key, no credit consumed).' },
  { name: 'x-beagle-cost-micro', direction: 'response', text: 'Charged amount in µUSD (integer).' },
  { name: 'x-beagle-balance-micro', direction: 'response', text: 'Workspace balance in µUSD after settlement. Streaming responses send it as a final SSE comment `: beagle cost=… balance=…`. Also sent on 402.' },
  { name: 'x-beagle-route', direction: 'response', text: 'Routing reasons joined by `; ` (why this model, which fallbacks were considered).' },
  { name: 'x-beagle-credits-url', direction: 'response', text: 'On 402 `insufficient_credit`: URL of the Credits page to top up (`<web origin>/app/credits`).' },
];

/** Alias → description rows for the docs page. */
export const ALIAS_DOCS: readonly { id: string; text: string }[] = [
  { id: 'beagle/auto', text: 'Difficulty-based tier: frontier for hard prompts, efficient or budget for easy ones; downgrades as credit or provider limits run down; house model when everything else is unavailable.' },
  { id: 'beagle/best', text: 'Frontier tier first, cheaper fallbacks afterwards.' },
  { id: 'beagle/cheap', text: 'Budget tier first, then the house model.' },
  { id: 'beagle/house', text: "The project's own vLLM model (gpt-oss-20b; gpt-oss-120b with Pro)." },
];
