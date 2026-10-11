/** `/app/receipts/:id`: receipt fields, canonical JSON, hash check, verify-locally snippet. */
import { Link, useParams } from 'react-router';
import type { ReceiptDto } from '@beagle/shared/api';
import { canonicalJson, receiptHash } from '@beagle/shared/canonical';
import { HashText } from '../../components/Hash.jsx';
import { QueryGuard } from '../../components/QueryGuard.jsx';
import { Badge, Card, Code, Note, PageHeader, Row } from '../../components/ui.jsx';
import { publicGatewayUrl } from '../../config.js';
import { fmtCount, fmtPerMillion, fmtUsd } from '../../lib/amounts.js';
import { verifyReceiptSnippet } from '../../lib/docs.js';
import { formatDateTime } from '../../lib/time.js';
import { useReceipt } from '../../queries.js';

function stripHash(r: ReceiptDto): Omit<ReceiptDto, 'hash'> {
  const { hash: _hash, ...rest } = r;
  return rest;
}

/** Receipt page. */
export function Receipt() {
  const { id } = useParams<{ id: string }>();
  const receipt = useReceipt(id);
  const base = publicGatewayUrl();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Usage receipt"
        lead={
          <>
            <span className="font-mono">{id}</span> · a verifiable record of one request: who paid, which model served it, token counts, upstream cost, markup and the charged amount. Amounts here are raw µUSD (1 USD = 1,000,000 µUSD) so the hash can be recomputed exactly.
          </>
        }
        actions={
          <Link to="/app/usage" className="btn-secondary">
            ← Usage
          </Link>
        }
      />
      <QueryGuard query={receipt}>
        {(r) => {
          const body = stripHash(r);
          const canonical = canonicalJson(body);
          const recomputed = receiptHash(body);
          const ok = recomputed.toLowerCase() === r.hash.toLowerCase();
          return (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card title="Receipt">
                <dl>
                  <Row label="Request id" mono>
                    {r.requestId}
                  </Row>
                  <Row label="Workspace" mono>
                    {r.workspace}
                  </Row>
                  <Row label="Created">{formatDateTime(r.createdAt)}</Row>
                  <Row label="Endpoint" mono>
                    {r.endpoint}
                  </Row>
                  <Row label="Requested model" mono>
                    {r.requestedModel}
                  </Row>
                  <Row label="Served model" mono>
                    {r.servedModel} <Badge>{r.provider}</Badge>
                  </Row>
                  <Row label="Paid by">
                    <Badge tone={r.paidBy === 'byok' ? 'info' : 'neutral'}>{r.paidBy}</Badge>
                  </Row>
                  <Row label="Tokens" mono>
                    in {fmtCount(r.usage.inputTokens)} · out {fmtCount(r.usage.outputTokens)} · cache read {fmtCount(r.usage.cacheReadTokens)} · cache write {fmtCount(r.usage.cacheWriteTokens)}
                  </Row>
                  <Row label="Price / 1M" mono>
                    in {fmtPerMillion(r.price.inputPerM)} · out {fmtPerMillion(r.price.outputPerM)}
                    {r.price.cacheReadPerM !== undefined ? ` · cache read ${fmtPerMillion(r.price.cacheReadPerM)}` : ''}
                    {r.price.cacheWritePerM !== undefined ? ` · cache write ${fmtPerMillion(r.price.cacheWritePerM)}` : ''}
                  </Row>
                  <Row label="Upstream cost" mono>
                    {r.upstreamCostMicro.toString()} µUSD ({fmtUsd(r.upstreamCostMicro)})
                  </Row>
                  <Row label="Markup" mono>
                    {r.markupBps} bps
                  </Row>
                  <Row label="Charged" mono>
                    {r.chargedMicro.toString()} µUSD ({fmtUsd(r.chargedMicro)})
                  </Row>
                  <Row label="Route reasons">
                    <ul className="list-disc pl-4 text-xs text-muted">
                      {r.routeReasons.map((reason, i) => (
                        <li key={i}>{reason}</li>
                      ))}
                    </ul>
                  </Row>
                  <Row label="Hash" mono>
                    <HashText hash={r.hash} />
                  </Row>
                </dl>
              </Card>
              <div className="space-y-4">
                <Note tone={ok ? 'ok' : 'err'} title={ok ? 'Hash verified in your browser' : 'Hash mismatch'}>
                  {ok ? (
                    <>
                      <span className="font-mono">sha256(canonicalJson(receipt))</span> recomputed locally equals the hash the gateway returned.
                    </>
                  ) : (
                    <>
                      Locally recomputed <span className="font-mono">{recomputed}</span> differs from the server hash. Do not trust this receipt.
                    </>
                  )}
                </Note>
                <Card title="Canonical JSON (hashed bytes)">
                  <Code code={canonical} lang="json" title="RFC 8785-style, sorted keys, bigint as strings" />
                </Card>
                <Card title="Verify locally">
                  <Code code={verifyReceiptSnippet(base, r.requestId)} lang="typescript" title="node (npm i @beagle/shared)" />
                </Card>
              </div>
            </div>
          );
        }}
      </QueryGuard>
    </div>
  );
}
