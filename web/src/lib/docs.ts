/**
 * Code snippets for the Docs page and the landing (SPEC §7 `/docs`). All take the public gateway
 * base URL (no trailing slash) so the page always shows copy-pasteable commands.
 */

/** Placeholder key used in snippets. */
export const KEY_PLACEHOLDER = 'bgl_YOUR_API_KEY';

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

/** MCP server config for Claude Desktop (`claude_desktop_config.json`) using the `beagle-mcp` stdio binary. */
export function mcpStdioConfig(base: string): string {
  const cfg = {
    mcpServers: {
      beagle: {
        command: 'npx',
        args: ['-y', '@beagle/mcp'],
        env: { BEAGLE_API_URL: base, BEAGLE_API_KEY: KEY_PLACEHOLDER },
      },
    },
  };
  return JSON.stringify(cfg, null, 2);
}

/** `claude mcp add` command for Claude Code (stdio binary). */
export function claudeCodeMcpCommand(base: string): string {
  return [
    `claude mcp add beagle \\`,
    `  -e BEAGLE_API_URL=${base} \\`,
    `  -e BEAGLE_API_KEY=${KEY_PLACEHOLDER} \\`,
    `  -- npx -y @beagle/mcp`,
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

/** Environment lines for running `beagle-mcp` by hand, with the optional agent wallet. */
export function mcpEnvSnippet(base: string): string {
  return [
    `export BEAGLE_API_URL=${base}`,
    `export BEAGLE_API_KEY=${KEY_PLACEHOLDER}`,
    `# optional: let the agent sign approve/burn/openBudget itself`,
    `# export BEAGLE_AGENT_PRIVATE_KEY=0x...`,
    `# export BEAGLE_RPC_URL=https://rpc.mainnet.chain.robinhood.com`,
    `beagle-mcp`,
  ].join('\n');
}

/** Node script recomputing a usage receipt hash with `@beagle/shared`. */
export function verifyReceiptSnippet(base: string, requestId: string): string {
  return [
    `import { receiptHash } from "@beagle/shared/canonical";`,
    ``,
    `const res = await fetch("${base}/api/receipts/${requestId}", {`,
    `  headers: { Authorization: "Bearer ${KEY_PLACEHOLDER}" },`,
    `});`,
    `const { hash, ...receipt } = await res.json();`,
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
  { name: 'x-beagle-balance-micro', direction: 'response', text: 'Workspace balance in µUSD after settlement. Streaming responses send it as a final SSE comment `: beagle cost=… balance=…`.' },
  { name: 'x-beagle-route', direction: 'response', text: 'Routing reasons joined by `; ` (why this model, which fallbacks were considered).' },
];

/** Alias → description rows for the docs page. */
export const ALIAS_DOCS: readonly { id: string; text: string }[] = [
  { id: 'beagle/auto', text: 'Difficulty-based tier: frontier for hard prompts, efficient or budget for easy ones; downgrades as credit or provider limits run down; house model when everything else is unavailable.' },
  { id: 'beagle/best', text: 'Frontier tier first, cheaper fallbacks afterwards.' },
  { id: 'beagle/cheap', text: 'Budget tier first, then the house model.' },
  { id: 'beagle/house', text: "The project's own vLLM model (gpt-oss-20b; gpt-oss-120b with Pro)." },
];
