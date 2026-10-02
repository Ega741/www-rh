/**
 * Compute draw receipts (W6): each on-chain `drawCompute` carries a `receiptHash`; the runner
 * serves the canonical receipt object (R2) so the browser can re-hash it and show whether it
 * matches. Also lists the most recent ticks of the compute ledger.
 *
 * @module components/ReceiptsList
 */
import { formatEth, formatUsd, shortHash, timeAgo } from '../format';
import { useNow } from '../hooks/useTick';
import { verifyReceipt } from '../lib/receipts';
import type { ComputeInfo } from '../lib/types';
import { CopyButton, Panel, TxLink } from './common';

function statusClass(status: string): string {
  if (status === 'confirmed') return 'text-acid';
  if (status === 'failed') return 'text-danger';
  if (status === 'dry_run') return 'text-amber';
  return 'text-dim';
}

function VerifyBadge({ result }: { result: ReturnType<typeof verifyReceipt> }) {
  if (result === 'verified') return <span className="chip border-acid/40 text-acid" title="keccak256(canonical receipt JSON) equals the on-chain receiptHash">hash verified</span>;
  if (result === 'mismatch') return <span className="chip border-danger/50 text-danger" title="The served receipt does not hash to receiptHash">hash mismatch</span>;
  return <span className="chip" title="The runner did not serve the full receipt object">not verifiable</span>;
}

/** See module docs. */
export function ReceiptsList({ compute, error }: { compute: ComputeInfo | undefined; error: boolean }) {
  const now = useNow(30_000);
  const receipts = compute?.receipts ?? [];
  const recentTicks = (compute?.ledger ?? []).slice().sort((a, b) => b.tickId - a.tickId).slice(0, 8);
  return (
    <Panel title="compute receipts">
      <div className="space-y-3 p-3">
        {error && compute === undefined ? (
          <p className="text-dim">Receipts are served by the runner, which is not reachable right now.</p>
        ) : receipts.length === 0 ? (
          <p className="text-dim">
            Nothing drawn from the vault yet. The runner settles spent compute in batches; every draw sends ETH to the compute treasury and anchors a
            receipt hash on-chain that anyone can check here.
          </p>
        ) : (
          <ul className="space-y-2">
            {receipts.map((r) => (
              <li key={r.receiptHash} className="rounded border border-line p-2 text-[12px]">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-fg tabular-nums">{formatEth(r.amountWei)}</span>
                  <VerifyBadge result={verifyReceipt(r)} />
                </div>
                <p className="text-dim">
                  {r.fromTickId !== null && r.toTickId !== null ? `ticks #${r.fromTickId}–#${r.toTickId}` : 'ticks'}
                  {r.tickCount !== null && ` (${r.tickCount})`}
                  {r.costUsd !== null && ` · ${formatUsd(r.costUsd)}`}
                  {r.createdAt !== null && ` · ${timeAgo(r.createdAt, now)}`}
                </p>
                <p className="flex flex-wrap items-center gap-x-2 text-mute">
                  <span title={r.receiptHash}>receipt {shortHash(r.receiptHash, 10)}</span>
                  <CopyButton value={r.receiptHash} />
                  {r.status !== null && <span className={statusClass(r.status)}>{r.status.replace('_', ' ')}</span>}
                  {r.txHash !== null ? (
                    <span>
                      tx <TxLink hash={r.txHash} />
                    </span>
                  ) : (
                    r.status === null && <span>not drawn yet</span>
                  )}
                </p>
              </li>
            ))}
          </ul>
        )}
        {recentTicks.length > 0 && (
          <div>
            <p className="mb-1 text-[11px] uppercase tracking-[0.12em] text-dim">recent ticks</p>
            <table className="w-full text-[11px] tabular-nums">
              <thead className="text-mute">
                <tr>
                  <th className="text-left font-normal">tick</th>
                  <th className="text-left font-normal">model</th>
                  <th className="text-right font-normal">in / cached / out</th>
                  <th className="text-right font-normal">cost</th>
                </tr>
              </thead>
              <tbody>
                {recentTicks.map((t) => (
                  <tr key={t.tickId} className="text-dim" title={t.error ?? (t.stopReason !== null ? `stop: ${t.stopReason}` : undefined)}>
                    <td>
                      #{t.tickId}
                      {t.error !== null && <span className="ml-1 text-danger">!</span>}
                    </td>
                    <td className="max-w-24 truncate">{t.model.replace(/^claude-/, '')}</td>
                    <td className="text-right">
                      {t.inputTokens} / {t.cacheReadTokens} / {t.outputTokens}
                    </td>
                    <td className={`text-right ${!t.settled ? 'text-fg' : ''}`}>{formatUsd(t.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Panel>
  );
}
