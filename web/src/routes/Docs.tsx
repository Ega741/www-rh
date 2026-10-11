/** `/docs`: quick start, SDK snippets, MCP config, headers, aliases, 402 semantics. */
import { Link } from 'react-router';
import { publicGatewayUrl } from '../config.js';
import { Card, Code } from '../components/ui.jsx';
import {
  ALIAS_DOCS,
  HEADER_DOCS,
  INSUFFICIENT_CREDIT_BODY,
  anthropicNodeSnippet,
  anthropicPythonSnippet,
  claudeCodeMcpCommand,
  curlMessagesSnippet,
  curlSnippet,
  mcpEnvSnippet,
  mcpHttpConfig,
  mcpStdioConfig,
  nodeOpenAiSnippet,
  openAiBaseUrl,
  pythonOpenAiSnippet,
} from '../lib/docs.js';

const TOC = [
  ['quick-start', 'Quick start'],
  ['sdks', 'SDKs'],
  ['mcp', 'MCP for agents'],
  ['headers', 'Headers'],
  ['aliases', 'Aliases & routing'],
  ['credit', 'Credit & 402'],
] as const;

/** Docs page. */
export function Docs() {
  const base = publicGatewayUrl();
  return (
    <div className="grid gap-8 lg:grid-cols-[12rem_1fr]">
      <aside className="lg:sticky lg:top-20 lg:self-start">
        <p className="card-title mb-2">On this page</p>
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-sm lg:flex-col">
          {TOC.map(([id, label]) => (
            <li key={id}>
              <a className="text-muted hover:text-fg" href={`#${id}`}>
                {label}
              </a>
            </li>
          ))}
        </ul>
      </aside>

      <article className="prose-doc min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">Docs</h1>
        <p>
          Gateway base URL for this deployment: <span className="font-mono text-fg">{base}</span>. Everything below is copy-pasteable with that URL already filled in.
        </p>

        <h2 id="quick-start">Quick start</h2>
        <ol className="list-decimal pl-5">
          <li>
            <Link className="link" to="/app">
              Sign in
            </Link>{' '}
            with your wallet (SIWE), then burn BEAGLE on the Credits page or have an agent open a budget.
          </li>
          <li>
            Create an API key on the Keys page. Keys look like <span className="font-mono">bgl_…</span> and are shown once.
          </li>
          <li>Call the OpenAI-compatible endpoint:</li>
        </ol>
        <Code code={curlSnippet(base)} lang="bash" title="chat completions" />
        <p>
          Or the Anthropic-compatible <span className="font-mono">/v1/messages</span>:
        </p>
        <Code code={curlMessagesSnippet(base)} lang="bash" title="messages" />
        <p>
          <span className="font-mono">GET {base}/v1/models</span> lists every model your key may use (with tier, price, availability) and the four aliases.
        </p>

        <h2 id="sdks">SDKs</h2>
        <h3>OpenAI SDK</h3>
        <p>
          Set <span className="font-mono">base_url</span> to <span className="font-mono text-fg">{openAiBaseUrl(base)}</span>. Streaming, tools, JSON mode, images and <span className="font-mono">reasoning_effort</span> pass through.
        </p>
        <div className="grid gap-3 xl:grid-cols-2">
          <Code code={pythonOpenAiSnippet(base)} lang="python" title="python" />
          <Code code={nodeOpenAiSnippet(base)} lang="typescript" title="node" />
        </div>
        <h3>Anthropic SDK</h3>
        <p>
          Set <span className="font-mono">baseURL</span> to <span className="font-mono text-fg">{base}</span> (the SDK appends <span className="font-mono">/v1/messages</span>). Any catalog id or alias works as <span className="font-mono">model</span>.
        </p>
        <div className="grid gap-3 xl:grid-cols-2">
          <Code code={anthropicPythonSnippet(base)} lang="python" title="python" />
          <Code code={anthropicNodeSnippet(base)} lang="typescript" title="node" />
        </div>

        <h2 id="mcp">MCP for agents</h2>
        <p>
          The <span className="font-mono">beagle-mcp</span> server (package <span className="font-mono">@beagle/mcp</span>) gives agents balance, models, quotes, inference, usage, compute purchase and budgets. It reads <span className="font-mono">BEAGLE_API_URL</span> and <span className="font-mono">BEAGLE_API_KEY</span>; with an optional <span className="font-mono">BEAGLE_AGENT_PRIVATE_KEY</span> (+ <span className="font-mono">BEAGLE_RPC_URL</span>) the wallet tools execute approve → burn / openBudget themselves, otherwise they return unsigned transactions.
        </p>
        <h3>Claude Desktop</h3>
        <Code code={mcpStdioConfig(base)} lang="json" title="claude_desktop_config.json" />
        <h3>Claude Code</h3>
        <Code code={claudeCodeMcpCommand(base)} lang="bash" title="terminal" />
        <h3>Remote (Streamable HTTP)</h3>
        <p>
          The gateway also serves the same tools at <span className="font-mono text-fg">{base}/mcp</span> (stateless, API key in the header). Wallet tools return unsigned transaction requests there.
        </p>
        <Code code={mcpHttpConfig(base)} lang="json" title="mcp.json" />
        <h3>By hand</h3>
        <Code code={mcpEnvSnippet(base)} lang="bash" title="shell" />

        <h2 id="headers">Headers</h2>
        <Card>
          <table className="table">
            <thead>
              <tr>
                <th>Header</th>
                <th>Direction</th>
                <th>Meaning</th>
              </tr>
            </thead>
            <tbody>
              {HEADER_DOCS.map((h) => (
                <tr key={h.name}>
                  <td className="font-mono text-xs">{h.name}</td>
                  <td className="text-xs text-muted">{h.direction}</td>
                  <td className="whitespace-normal text-xs text-muted">{h.text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <h2 id="aliases">Aliases & routing</h2>
        <ul className="list-disc pl-5">
          {ALIAS_DOCS.map((a) => (
            <li key={a.id}>
              <span className="font-mono text-fg">{a.id}</span> — {a.text}
            </li>
          ))}
        </ul>
        <p>
          Explicit ids (<span className="font-mono">anthropic/claude-opus-5-5</span>, <span className="font-mono">openai/gpt-5.5</span>, …) are honoured; if the provider is down the gateway falls back to cheaper models unless <span className="font-mono">x-beagle-fallback: none</span>. Routing reasons are returned in <span className="font-mono">x-beagle-route</span>. Requests served through your own provider keys (<Link className="link" to="/app/providers">BYOK</Link>) consume no credit.
        </p>

        <h2 id="credit">Credit & 402</h2>
        <p>
          Every credit-paid request reserves an estimate, then settles the real upstream cost plus the platform markup. When <span className="font-mono">available = balance − reserved + budgetHeadroom</span> drops below the minimum reserve, inference returns <span className="font-mono">402</span> with this body and the headers <span className="font-mono">x-beagle-balance-micro</span> and <span className="font-mono">x-beagle-credits-url</span>:
        </p>
        <Code code={INSUFFICIENT_CREDIT_BODY} lang="json" title="402 insufficient_credit" />
        <p>
          <span className="font-mono">/v1/messages</span> uses the Anthropic envelope with <span className="font-mono">type: invalid_request_error</span> and a message starting <span className="font-mono">insufficient_credit:</span>. Top up by burning on the{' '}
          <Link className="link" to="/app/credits">
            Credits page
          </Link>{' '}
          or by letting an agent{' '}
          <Link className="link" to="/app/budgets">
            open a budget
          </Link>
          . Each request has a verifiable receipt at <span className="font-mono">/api/receipts/&lt;request id&gt;</span>; its hash is <span className="font-mono">sha256(canonicalJson(receipt))</span> and can be recomputed with <span className="font-mono">@beagle/shared</span>.
        </p>
      </article>
    </div>
  );
}
