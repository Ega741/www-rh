/** `/app/usage`: summary tiles (window selector), by-model bars, by-day columns, paginated table. */
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Bars, Columns } from '../../components/Bars.jsx';
import { QueryGuard } from '../../components/QueryGuard.jsx';
import { Badge, Button, Card, Input, PageHeader, Segmented, Select, Stat, TableWrap } from '../../components/ui.jsx';
import { fmtCompact, fmtCount, fmtUsd } from '../../lib/amounts.js';
import { formatDateTime } from '../../lib/time.js';
import { averageCharge, dayBars, modelBars } from '../../lib/usage.js';
import { USAGE_WINDOWS, isUsageWindow, windowLabel, type UsageWindow } from '../../lib/windows.js';
import { useUsageList, useUsageSummary } from '../../queries.js';
import { shortRequestId } from '../../lib/explorer.js';

const WINDOW_OPTIONS = USAGE_WINDOWS.map((w) => ({ value: w, label: w }));

/** Usage page. */
export function Usage() {
  const [search, setSearch] = useSearchParams();
  const window: UsageWindow = isUsageWindow(search.get('window')) ? (search.get('window') as UsageWindow) : '7d';
  const model = search.get('model') ?? '';
  const statusParam = search.get('status');
  const status = statusParam === 'ok' || statusParam === 'error' ? statusParam : undefined;
  const [modelDraft, setModelDraft] = useState(model);

  const summary = useUsageSummary(window);
  const list = useUsageList({ limit: 50, ...(model === '' ? {} : { model }), ...(status === undefined ? {} : { status }) });

  const setParam = (key: string, value: string | undefined) => {
    const next = new URLSearchParams(search);
    if (value === undefined || value === '') next.delete(key);
    else next.set(key, value);
    setSearch(next, { replace: true });
  };

  const onFilter = (e: FormEvent) => {
    e.preventDefault();
    setParam('model', modelDraft.trim());
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Usage" lead="Every request is metered: tokens, upstream cost and what was charged (upstream cost plus the platform markup; BYOK requests cost nothing unless a BYOK fee is configured)." actions={<Segmented ariaLabel="Summary window" value={window} options={WINDOW_OPTIONS} onChange={(w) => setParam('window', w)} />} />

      <Card title={windowLabel(window)}>
        <QueryGuard query={summary}>
          {(s) => (
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label="Requests" value={fmtCount(s.requests)} />
              <Stat label="Charged" value={fmtUsd(s.chargedMicro)} />
              <Stat label="Upstream cost" value={fmtUsd(s.upstreamCostMicro)} sub="before markup" />
              <Stat label="Avg / request" value={fmtUsd(averageCharge(s.chargedMicro, s.requests))} />
              <Stat label="Input tokens" value={fmtCompact(s.inputTokens)} />
              <Stat label="Output tokens" value={fmtCompact(s.outputTokens)} />
            </div>
          )}
        </QueryGuard>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Charged by model">
          <QueryGuard query={summary}>{(s) => <Bars bars={modelBars(s.byModel)} format={(b) => fmtUsd(b.value)} ariaLabel="Charged by model" />}</QueryGuard>
        </Card>
        <Card title="Charged by day (UTC)">
          <QueryGuard query={summary}>{(s) => <Columns bars={dayBars(s.byDay, window, new Date())} format={(b) => fmtUsd(b.value)} ariaLabel="Charged by day" />}</QueryGuard>
        </Card>
      </div>

      <Card
        title="Requests"
        actions={
          <form onSubmit={onFilter} className="flex flex-wrap items-center gap-2">
            <Input mono placeholder="filter model id" value={modelDraft} onChange={(e) => setModelDraft(e.target.value)} className="w-48 py-1 text-xs" aria-label="Filter by model" />
            <Select value={status ?? ''} onChange={(e) => setParam('status', e.target.value)} className="w-28 py-1 text-xs" aria-label="Filter by status">
              <option value="">any status</option>
              <option value="ok">ok</option>
              <option value="error">error</option>
            </Select>
            <Button type="submit" size="sm">
              Filter
            </Button>
            {model !== '' || status !== undefined ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setModelDraft('');
                  setSearch(new URLSearchParams(window === '7d' ? {} : { window }), { replace: true });
                }}
              >
                Clear
              </Button>
            ) : null}
          </form>
        }
      >
        <QueryGuard query={list} isEmpty={(d) => d.pages.every((p) => p.rows.length === 0)} empty={<p className="py-6 text-center text-sm text-muted">No requests match.</p>}>
          {(d) => (
            <>
              <TableWrap>
                <table className="table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Request id</th>
                      <th>Model (requested → served)</th>
                      <th>Provider</th>
                      <th>Paid by</th>
                      <th>Tokens in / out</th>
                      <th>Charged</th>
                      <th>Latency</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.pages.flatMap((p) => p.rows).map((r) => (
                      <tr key={r.id}>
                        <td className="text-muted">{formatDateTime(r.createdAt)}</td>
                        <td>
                          <Link className="link font-mono text-xs" title={r.id} to={`/app/receipts/${encodeURIComponent(r.id)}`}>
                            {shortRequestId(r.id)}
                          </Link>
                        </td>
                        <td className="font-mono text-xs">
                          {r.requestedModel}
                          {r.servedModel !== null && r.servedModel !== r.requestedModel ? <span className="text-muted"> → {r.servedModel}</span> : null}
                          {r.stream ? <Badge className="ml-1">stream</Badge> : null}
                        </td>
                        <td className="text-xs">{r.provider ?? '—'}</td>
                        <td>{r.paidBy === null ? '—' : <Badge tone={r.paidBy === 'byok' ? 'info' : 'neutral'}>{r.paidBy}</Badge>}</td>
                        <td className="font-mono text-xs">
                          {fmtCompact(r.inputTokens)} / {fmtCompact(r.outputTokens)}
                          {r.cacheReadTokens > 0 ? <span className="text-faint"> · cache {fmtCompact(r.cacheReadTokens)}</span> : null}
                        </td>
                        <td className="font-mono">{fmtUsd(r.chargedMicro)}</td>
                        <td className="font-mono text-xs text-muted">{r.latencyMs} ms</td>
                        <td>
                          <Badge tone={r.status === 'ok' ? 'ok' : 'err'} title={r.errorCode ?? undefined}>
                            {r.status === 'ok' ? 'ok' : r.errorCode ?? `${r.httpStatus}`}
                          </Badge>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
              {list.hasNextPage ? (
                <div className="mt-3 text-center">
                  <Button busy={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                    Load more
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </QueryGuard>
      </Card>
    </div>
  );
}
