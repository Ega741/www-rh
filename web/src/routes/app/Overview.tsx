/** `/app`: balance card, plan, 24 h usage, latest requests, token price, Buy credit CTA. */
import { Link } from 'react-router';
import { QueryGuard } from '../../components/QueryGuard.jsx';
import { Badge, Card, PageHeader, Stat, TableWrap } from '../../components/ui.jsx';
import { useSession } from '../../hooks/useSession.jsx';
import { fmtCompact, fmtCount, fmtPrice, fmtUsd } from '../../lib/amounts.js';
import { formatDateTime, relativeTime } from '../../lib/time.js';
import { useBalance, useUsageList, useUsageSummary } from '../../queries.js';

/** Overview page. */
export function Overview() {
  const session = useSession();
  const balance = useBalance();
  const summary = useUsageSummary('24h');
  const latest = useUsageList({ limit: 8 });
  const now = Date.now();
  const me = session.me;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Overview"
        lead={me === undefined ? undefined : <span className="font-mono">{me.workspace}</span>}
        actions={
          <Link to="/app/credits" className="btn-primary">
            Buy credit
          </Link>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Balance" className="lg:col-span-2">
          <QueryGuard query={balance}>
            {(b) => (
              <div className="grid gap-3 sm:grid-cols-4">
                <Stat label="Available" value={fmtUsd(b.availableMicro)} sub="balance − reserved + budget headroom" />
                <Stat label="Balance" value={fmtUsd(b.balanceMicro)} sub={b.balanceMicro < 0n ? 'negative: covered by a budget' : 'ledger total'} />
                <Stat label="Reserved" value={fmtUsd(b.reservedMicro)} sub="in-flight requests" />
                <Stat label="Budget headroom" value={fmtUsd(b.budgetHeadroomMicro)} sub="drawable from delegated budgets" />
              </div>
            )}
          </QueryGuard>
        </Card>
        <Card title="Plan">
          <QueryGuard query={balance}>
            {(b) => (
              <div className="space-y-2">
                <p className="flex items-center gap-2 text-lg font-semibold">
                  {b.plan === 'pro' ? <Badge tone="accent">Pro</Badge> : <Badge>Free</Badge>}
                  {b.plan === 'pro' && b.planUntil !== null ? <span className="text-xs text-muted">until {formatDateTime(b.planUntil)}</span> : null}
                </p>
                <p className="text-xs text-muted">{b.plan === 'pro' ? 'gpt-oss-120b, 128K house context, higher rate limit.' : 'Pro unlocks the large house model, 128K house context and a higher rate limit.'}</p>
                <p className="text-xs text-muted">
                  1 token = <span className="font-mono text-fg">{fmtPrice(b.price.priceE18)}</span> <span className="text-faint">(point #{b.price.pricePointId})</span> {b.price.stale ? <Badge tone="warn">stale</Badge> : null}
                </p>
                <Link to="/app/upgrades" className="link text-sm">
                  Upgrades →
                </Link>
              </div>
            )}
          </QueryGuard>
        </Card>
      </div>

      <Card
        title="Last 24 hours"
        actions={
          <Link to="/app/usage" className="link text-xs">
            Usage →
          </Link>
        }
      >
        <QueryGuard query={summary}>
          {(s) => (
            <div className="grid gap-3 sm:grid-cols-4">
              <Stat label="Requests" value={fmtCount(s.requests)} />
              <Stat label="Charged" value={fmtUsd(s.chargedMicro)} />
              <Stat label="Input tokens" value={fmtCompact(s.inputTokens)} />
              <Stat label="Output tokens" value={fmtCompact(s.outputTokens)} />
            </div>
          )}
        </QueryGuard>
      </Card>

      <Card title="Latest requests">
        <QueryGuard query={latest} isEmpty={(d) => d.pages.every((p) => p.rows.length === 0)} empty={<p className="py-6 text-center text-sm text-muted">No requests yet. Create a key and call the API.</p>}>
          {(d) => (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Request</th>
                    <th>Model</th>
                    <th>Paid by</th>
                    <th>Charged</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {d.pages[0]?.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="text-muted" title={formatDateTime(r.createdAt)}>
                        {relativeTime(r.createdAt, now)}
                      </td>
                      <td>
                        <Link className="link font-mono text-xs" to={`/app/receipts/${encodeURIComponent(r.id)}`}>
                          {r.id}
                        </Link>
                      </td>
                      <td className="font-mono text-xs">
                        {r.servedModel ?? r.requestedModel}
                        {r.servedModel !== null && r.servedModel !== r.requestedModel ? <span className="text-faint"> ← {r.requestedModel}</span> : null}
                      </td>
                      <td>{r.paidBy === null ? '—' : <Badge tone={r.paidBy === 'byok' ? 'info' : 'neutral'}>{r.paidBy}</Badge>}</td>
                      <td className="font-mono">{fmtUsd(r.chargedMicro)}</td>
                      <td>
                        <Badge tone={r.status === 'ok' ? 'ok' : 'err'}>{r.status === 'ok' ? 'ok' : r.errorCode ?? `${r.httpStatus}`}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </QueryGuard>
      </Card>
    </div>
  );
}
