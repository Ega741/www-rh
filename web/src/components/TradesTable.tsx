/**
 * Recent curve trades (REST history merged with live WS trades).
 *
 * @module components/TradesTable
 */
import { formatEth, formatPrice, formatTokens, timeAgo } from '../format';
import { useNow } from '../hooks/useTick';
import type { Trade } from '../lib/types';
import { AddressLink, Panel, TxLink } from './common';

/** Merges live and fetched trades, de-duplicated by `(txHash, logIndex)`, newest first. */
export function mergeTrades(live: readonly Trade[], fetched: readonly Trade[]): Trade[] {
  const byKey = new Map<string, Trade>();
  for (const t of [...fetched, ...live]) byKey.set(`${t.txHash}:${t.logIndex}`, t);
  return [...byKey.values()].sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex || b.timestamp - a.timestamp);
}

/** Props of {@link TradesTable}. */
export interface TradesTableProps {
  trades: Trade[];
  symbol: string;
  loading: boolean;
  error: boolean;
}

/** See module docs. */
export function TradesTable({ trades, symbol, loading, error }: TradesTableProps) {
  const now = useNow(10_000);
  return (
    <Panel title="recent trades" right={<span className="normal-case tracking-normal text-mute">{trades.length > 0 ? `${trades.length}` : ''}</span>}>
      {trades.length === 0 ? (
        <p className="px-3 py-4 text-dim">
          {loading ? 'Loading trades…' : error ? 'Trade history is served by the runner, which is not reachable right now.' : `No trades yet. The first buy of $${symbol} will show up here.`}
        </p>
      ) : (
        <div className="scroll-thin max-h-96 overflow-auto">
          <table className="w-full min-w-[640px] text-[12px] tabular-nums">
            <thead className="sticky top-0 bg-panel text-[11px] text-mute">
              <tr>
                <th className="px-3 py-1.5 text-left font-normal">time</th>
                <th className="px-3 py-1.5 text-left font-normal">side</th>
                <th className="px-3 py-1.5 text-left font-normal">account</th>
                <th className="px-3 py-1.5 text-right font-normal">ETH</th>
                <th className="px-3 py-1.5 text-right font-normal">${symbol}</th>
                <th className="px-3 py-1.5 text-right font-normal">price</th>
                <th className="px-3 py-1.5 text-right font-normal">tx</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={`${t.txHash}:${t.logIndex}`} className="border-t border-line">
                  <td className="px-3 py-1 text-dim">{t.timestamp > 0 ? timeAgo(t.timestamp, now) : `#${t.blockNumber}`}</td>
                  <td className={`px-3 py-1 ${t.isBuy ? 'text-acid' : 'text-danger'}`}>{t.isBuy ? 'buy' : 'sell'}</td>
                  <td className="px-3 py-1">
                    <AddressLink address={t.trader} />
                  </td>
                  <td className="px-3 py-1 text-right">{formatEth(t.ethAmountWei, { symbol: false })}</td>
                  <td className="px-3 py-1 text-right">{formatTokens(t.tokenAmount)}</td>
                  <td className="px-3 py-1 text-right text-dim">{t.priceWei > 0n ? formatPrice(t.priceWei, { symbol: false }) : '—'}</td>
                  <td className="px-3 py-1 text-right">
                    <TxLink hash={t.txHash} label="view" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
