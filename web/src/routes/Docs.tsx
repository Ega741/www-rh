/** `/docs`: quick start, SDK snippets, MCP config, headers, aliases, credit & 402, budgets, chain, receipts. */
import { Link } from 'react-router';
import { config, publicGatewayUrl } from '../config.js';
import { Card, Code } from '../components/ui.jsx';
import { useDeployment } from '../hooks/useDeployment.js';
import { fmtUsd } from '../lib/amounts.js';
import {
  ALIAS_DOCS,
  BUDGET_DOC,
  CREDIT_DOC,
  HEADER_DOCS,
  INSUFFICIENT_CREDIT_BODY,
  MCP_BUILD_COMMAND,
  REPO_PLACEHOLDER,
  anthropicNodeSnippet,
  anthropicPythonSnippet,
  claudeCodeMcpCommand,
  curlMessagesSnippet,
  curlSnippet,
  mcpBinPath,
  mcpEnvSnippet,
  mcpHttpConfig,
  mcpStdioConfig,
  nodeOpenAiSnippet,
  openAiBaseUrl,
  priceHistorySnippet,
  pythonOpenAiSnippet,
  splTokenBudgetSnippet,
  splTokenBurnSnippet,
  verifyReceiptSnippet,
} from '../lib/docs.js';

const TOC = [
  ['quick-start', 'Quick start'],
  ['sdks', 'SDKs'],
  ['mcp', 'MCP for agents'],
  ['headers', 'Headers'],
  ['aliases', 'Aliases & routing'],
  ['credit', 'Credit & 402'],
  ['budgets', 'Budgets = delegation'],
  ['chain', 'From the command line'],
  ['receipts', 'Receipts'],
] as const;

/** Docs page. */
export function Docs() {
  const base = publicGatewayUrl();
  const dep = useDeployment();
  const chainCtx = { cluster: config.cluster, rpcUrl: config.rpcUrl, mint: dep.mint, operator: dep.operator, decimals: dep.decimals, symbol: dep.symbol };
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
          Gateway base URL for this deployment: <span className="font-mono text-fg">{base}</span>, Solana cluster <span className="font-mono text-fg">{config.cluster}</span>. Everything below is copy-pasteable with those values already filled in.
        </p>

        <h2 id="quick-start">Quick start</h2>
        <ol className="list-decimal pl-5">
          <li>
            <Link className="link" to="/app">
              Sign in
            </Link>{' '}
            with your Solana wallet (Sign-In-With-Solana: a signed message, no transaction), then burn {dep.symbol} on the Credits page or have an agent open a budget.
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
          The <span className="font-mono">beagle-mcp</span> server (workspace package <span className="font-mono">@beagle/mcp</span> of this repository, not published to npm) gives agents balance, models, quotes, inference, usage, compute purchase and budgets. It reads <span className="font-mono">BEAGLE_API_URL</span> and <span className="font-mono">BEAGLE_API_KEY</span>; with an optional <span className="font-mono">BEAGLE_AGENT_SECRET_KEY</span> (a Solana keypair as base58 or a solana-keygen JSON array, + <span className="font-mono">BEAGLE_RPC_URL</span>) the wallet tools execute burn + memo / approve / revoke themselves, otherwise they return unsigned transactions for the agent's own wallet to sign.
        </p>
        <p>
          Run it from a checkout: build once with <span className="font-mono text-fg">{MCP_BUILD_COMMAND}</span>, then launch <span className="font-mono text-fg">node {mcpBinPath()}</span>, replacing <span className="font-mono">{REPO_PLACEHOLDER}</span> with the path of the checkout. Without a checkout, use the Streamable HTTP config below: the gateway serves the same tools.
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
        <Code code={mcpEnvSnippet(base, config.rpcUrl)} lang="bash" title="shell" />

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
        <h3>How credit is computed</h3>
        <p>
          A purchase is any successful transaction that burns {dep.symbol} (SPL <span className="font-mono">Burn</span> / <span className="font-mono">BurnChecked</span> on the mint) from a token account you own. There is no custom program and nothing to approve: the gateway watches the mint's transactions and credits the token account owner. {CREDIT_DOC.sentence} With the mint's decimals:
        </p>
        <Code code={`${CREDIT_DOC.formula}\n// 6 decimals: ${CREDIT_DOC.sixDecimals}\n// ${CREDIT_DOC.example}`} lang="text" title="credit per burn" />
        <p>
          Every credit event stores the price point it was priced with (<span className="font-mono">pricePointId</span>, <span className="font-mono">priceE18</span>), and the price history is public, so anyone can recompute every credit from the burn amount. To credit a workspace other than the burning wallet, add an SPL Memo <span className="font-mono text-fg">{CREDIT_DOC.memo}</span> to the same transaction (the Credits page does this for "credit another workspace"). Burns quoting below the minimum credit{dep.minCreditMicro === undefined ? '' : ` (${fmtUsd(dep.minCreditMicro, { maxFractionDigits: 6 })})`} are recorded with no credit; burns observed while the price is stale are credited at the last point and flagged.
        </p>
        <Code code={priceHistorySnippet(base)} lang="bash" title="published price" />
        <h3>402</h3>
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
          .
        </p>

        <h2 id="budgets">Budgets = SPL delegation</h2>
        <p>
          A budget authorises the operator to burn from your token account as usage accrues, up to a cap, and nothing else. It is the plain SPL delegation of the Token program: one delegate per account, a new approval replaces the previous cap, <span className="font-mono">Revoke</span> clears it at any time, and every delegate burn decrements the delegated amount. No deadline: the budget lives until revoked or exhausted. The budget id is the token account address.
        </p>
        <Code code={`open:  ${BUDGET_DOC.open}\ndraw:  ${BUDGET_DOC.draw}\nclose: ${BUDGET_DOC.close}\n${BUDGET_DOC.headroom}`} lang="text" title="instructions" />
        <p>
          The operator's only signed instruction is a delegate <span className="font-mono">BurnChecked</span> bounded by the delegated amount, with the memo <span className="font-mono">{BUDGET_DOC.drawMemo}</span> naming the hash of the usage batch it settles; the indexer confirms each draw by that hash. After approving, register the token account with <span className="font-mono">POST /api/budgets/register</span> (the Budgets page and the MCP tools do; the gateway's scanner also finds delegations to the operator on its own).
        </p>

        <h2 id="chain">From the command line</h2>
        <p>
          Nothing here requires the web app: the Solana CLI (<span className="font-mono">spl-token</span> 5.x) can burn for credit and delegate a budget directly. Mint: <span className="font-mono text-fg">{dep.mint ?? '—'}</span>, operator: <span className="font-mono text-fg">{dep.operator ?? '—'}</span>, RPC: <span className="font-mono text-fg">{config.rpcUrl}</span>.
        </p>
        <Code code={splTokenBurnSnippet(chainCtx)} lang="bash" title="burn for credit" />
        <Code code={splTokenBudgetSnippet(chainCtx)} lang="bash" title="budget" />

        <h2 id="receipts">Receipts</h2>
        <p>
          Each request has a verifiable receipt at <span className="font-mono">/api/receipts/&lt;request id&gt;</span> returning <span className="font-mono">{'{ receipt, hash }'}</span>; <span className="font-mono">hash = sha256(canonicalJson(receipt))</span> and can be recomputed with <span className="font-mono">receiptHash</span> from <span className="font-mono">@beagle/shared/canonical</span> in this repository (every receipt page shows the script). Burns and draws of your workspace are listed by <span className="font-mono">GET /api/receipts</span> with their signature, slot, amount, credit and price point.
        </p>
        <Code code={verifyReceiptSnippet(base, 'req_…')} lang="typescript" title="verify.mjs" />
      </article>
    </div>
  );
}
