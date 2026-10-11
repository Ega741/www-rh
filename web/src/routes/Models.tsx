/** `/models`: catalog table from `GET /api/models` plus aliases. */
import type { ModelDto } from '@beagle/shared/api';
import { TIER_ORDER, type Tier } from '@beagle/shared/models';
import { QueryGuard } from '../components/QueryGuard.jsx';
import { Badge, Card, Dot, PageHeader, TableWrap } from '../components/ui.jsx';
import { fmtContext, fmtPerMillion } from '../lib/amounts.js';
import { useModels } from '../queries.js';

const TIER_TONE: Record<Tier, 'accent' | 'info' | 'ok' | 'neutral'> = { frontier: 'accent', efficient: 'info', budget: 'ok', house: 'neutral' };

function caps(m: ModelDto): string {
  const list: string[] = [];
  if (m.capabilities.tools) list.push('tools');
  if (m.capabilities.vision) list.push('vision');
  if (m.capabilities.json) list.push('json');
  if (m.capabilities.reasoning) list.push('reasoning');
  return list.join(' · ');
}

/** Models & pricing page. */
export function Models() {
  const models = useModels();
  return (
    <div>
      <PageHeader title="Models & pricing" lead="Prices are what the gateway charges per 1M tokens (upstream snapshot plus the platform markup, µUSD rounded up per component). Availability reflects live provider health and your plan." />
      <QueryGuard query={models}>
        {(data) => (
          <div className="space-y-6">
            <Card>
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Tier</th>
                      <th>Context / max out</th>
                      <th>Input / 1M</th>
                      <th>Output / 1M</th>
                      <th>Cache read</th>
                      <th>Capabilities</th>
                      <th>Available</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.models]
                      .sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier) || a.id.localeCompare(b.id))
                      .map((m) => (
                        <tr key={m.id}>
                          <td>
                            <div className="font-medium">{m.displayName}</div>
                            <div className="font-mono text-xs text-muted">{m.id}</div>
                          </td>
                          <td>
                            <Badge tone={TIER_TONE[m.tier]}>{m.tier}</Badge>
                            {m.requiresPlan === 'pro' ? (
                              <Badge tone="warn" className="ml-1">
                                Pro
                              </Badge>
                            ) : null}
                            {!m.autoEligible ? (
                              <Badge className="ml-1" title="Only served when requested explicitly">
                                explicit
                              </Badge>
                            ) : null}
                          </td>
                          <td className="font-mono text-xs">
                            {fmtContext(m.contextWindow)} / {fmtContext(m.maxOutput)}
                          </td>
                          <td className="font-mono">{fmtPerMillion(m.price.inputPerM)}</td>
                          <td className="font-mono">{fmtPerMillion(m.price.outputPerM)}</td>
                          <td className="font-mono text-muted">{m.price.cacheReadPerM === undefined ? '—' : fmtPerMillion(m.price.cacheReadPerM)}</td>
                          <td className="text-xs text-muted">{caps(m)}</td>
                          <td>
                            <span className="inline-flex items-center gap-1.5 text-xs">
                              <Dot tone={m.available ? 'ok' : m.providerState === 'degraded' ? 'warn' : 'err'} />
                              {m.available ? 'yes' : m.providerState === 'down' ? 'provider down' : m.requiresPlan === 'pro' ? 'Pro plan' : 'no'}
                            </span>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </TableWrap>
            </Card>
            <Card title="Aliases">
              <ul className="grid gap-2 sm:grid-cols-2">
                {data.aliases.map((a) => (
                  <li key={a.id} className="rounded-lg border border-line bg-elevated/50 px-3 py-2">
                    <p className="font-mono text-sm text-accent">{a.id}</p>
                    <p className="mt-1 text-xs text-muted">{a.description}</p>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-xs text-faint">Bare upstream ids (e.g. <span className="font-mono">claude-sonnet-5-5</span>) resolve when unique. Notes on third-party prices: snapshot 2026-10; verify before relying on them.</p>
            </Card>
          </div>
        )}
      </QueryGuard>
    </div>
  );
}
