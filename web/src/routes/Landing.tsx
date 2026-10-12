/** `/`: hero, three cards, live strip (status + price), curl sample, CTA. */
import { Link } from 'react-router';
import { PROVIDERS } from '@beagle/shared/models';
import { config, publicGatewayUrl } from '../config.js';
import { fmtCount, fmtPrice } from '../lib/amounts.js';
import { curlSnippet } from '../lib/docs.js';
import { relativeTime } from '../lib/time.js';
import { usePrice, useStatus } from '../queries.js';
import { Badge, Card, Code, Dot, Skeleton } from '../components/ui.jsx';

const CARDS = [
  {
    title: 'One key for every model',
    text: 'OpenAI- and Anthropic-compatible endpoints in front of Claude, GPT, Gemini and our own house model. One bgl_ key, one base URL, one bill.',
  },
  {
    title: 'The router keeps your best model for hard work',
    text: 'beagle/auto estimates difficulty, moves easy requests to cheaper models, downgrades as credit or provider limits run down and falls back to the house GPU when everything else is spent.',
  },
  {
    title: 'Paid by burning BEAGLE from your Solana wallet',
    text: 'A plain SPL burn from your own wallet, no custom program. The gateway sees the burn and credits your workspace at the published price. No e-mail, no card: sign in with your wallet.',
  },
] as const;

function providerTone(state: 'ok' | 'degraded' | 'down', configured: boolean): 'ok' | 'warn' | 'err' | 'neutral' {
  if (!configured) return 'neutral';
  return state === 'ok' ? 'ok' : state === 'degraded' ? 'warn' : 'err';
}

/** Live strip: token price, indexer head slot and lag, provider health. */
function LiveStrip() {
  const status = useStatus();
  const price = usePrice();
  const now = Date.now();
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Card title="Token price">
        {price.isPending ? (
          <Skeleton className="h-7 w-32" />
        ) : price.isError || price.data === undefined ? (
          <p className="text-sm text-muted">unavailable</p>
        ) : (
          <>
            <p className="font-mono text-xl font-semibold">
              {fmtPrice(price.data.priceE18)} <span className="text-sm text-muted">/ {status.data?.token.symbol ?? 'BEAGLE'}</span>
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
              {price.data.stale ? <Badge tone="warn">stale</Badge> : <Badge tone="ok">fresh</Badge>}
              <span>observed {relativeTime(price.data.observedAt * 1000, now)}</span>
              <span>· {price.data.source}</span>
              <span>· point #{price.data.pricePointId}</span>
            </p>
          </>
        )}
      </Card>
      <Card title="Indexer">
        {status.isPending ? (
          <Skeleton className="h-7 w-32" />
        ) : status.isError || status.data === undefined ? (
          <p className="text-sm text-muted">gateway unreachable</p>
        ) : (
          <>
            <p className="font-mono text-xl font-semibold">{status.data.indexer.lastSlot === null ? 'slot —' : `slot ${fmtCount(status.data.indexer.lastSlot)}`}</p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
              <Badge tone={status.data.indexer.lagSlots > 50 ? 'warn' : 'ok'}>lag {fmtCount(status.data.indexer.lagSlots)}</Badge>
              <span>head {fmtCount(status.data.indexer.headSlot)}</span>
              <span>· {status.data.cluster}</span>
            </p>
          </>
        )}
      </Card>
      <Card title="Providers">
        {status.isPending ? (
          <Skeleton className="h-7 w-32" />
        ) : status.isError || status.data === undefined ? (
          <p className="text-sm text-muted">unknown</p>
        ) : (
          <ul className="grid grid-cols-2 gap-1 text-sm">
            {PROVIDERS.map((p) => {
              const s = status.data.providers[p];
              const tone = s === undefined ? 'neutral' : providerTone(s.state, s.configured);
              return (
                <li key={p} className="flex items-center gap-2 font-mono text-xs">
                  <Dot tone={tone} />
                  <span>{p}</span>
                  <span className="text-faint">{s === undefined ? '—' : s.configured ? s.state : 'off'}</span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

/** Landing page. */
export function Landing() {
  const base = publicGatewayUrl();
  return (
    <div className="space-y-10">
      <section className="pt-6 text-center sm:pt-12">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-accent">Solana · {config.clusterName}</p>
        <h1 className="mx-auto mt-3 max-w-3xl text-4xl font-semibold tracking-tight sm:text-6xl">
          Compute for agents.
          <br />
          <span className="text-muted">Burn becomes compute.</span>
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-base text-muted sm:text-lg">
          One API key for every model and an MCP server for your agents. Access is paid by burning <span className="font-mono text-fg">BEAGLE</span> from your Solana wallet; credit is computed from the published price when the gateway observes the burn.
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-3">
          <Link to="/app" className="btn-primary">
            Open the app
          </Link>
          <Link to="/docs" className="btn-secondary">
            Read the docs
          </Link>
        </div>
      </section>

      <LiveStrip />

      <section className="grid gap-3 md:grid-cols-3">
        {CARDS.map((c, i) => (
          <Card key={c.title}>
            <p className="font-mono text-xs text-faint">0{i + 1}</p>
            <h2 className="mt-2 text-base font-semibold">{c.title}</h2>
            <p className="mt-2 text-sm leading-6 text-muted">{c.text}</p>
          </Card>
        ))}
      </section>

      <section className="grid gap-4 md:grid-cols-[1fr_1.4fr] md:items-start">
        <div>
          <h2 className="text-xl font-semibold">Point your SDK at Beagle</h2>
          <p className="mt-2 text-sm leading-6 text-muted">
            Set <span className="font-mono text-fg">base_url</span> to <span className="font-mono text-fg">{base}/v1</span>, use a <span className="font-mono text-fg">bgl_</span> key and ask for <span className="font-mono text-fg">beagle/auto</span>. Explicit catalog ids such as <span className="font-mono text-fg">anthropic/claude-sonnet-5-5</span> are honoured with cheaper fallbacks.
          </p>
          <Link to="/models" className="link mt-3 inline-block text-sm">
            See models and pricing →
          </Link>
        </div>
        <Code code={curlSnippet(base)} lang="bash" title="curl" />
      </section>
    </div>
  );
}
