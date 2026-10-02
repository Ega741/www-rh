/**
 * Compute meter: vault balance in ETH / USD, burn per hour and runway (vs. the runner's target
 * runway), plus "feed the mind". The on-chain `mindBalance` is authoritative for the balance;
 * USD values use the ETH/USD price implied by the runner's compute endpoint / budget messages.
 * Pons mode (SPEC §9.5) adds the creator fees claimable from the Pons FeeEscrow and "Harvest".
 *
 * @module components/ComputeMeter
 */
import { TARGET_RUNWAY_DAYS, VENUE } from '../config';
import { formatDuration, formatEth, formatRunway, formatUsd, impliedEthUsd, runwayHours, weiToEth } from '../format';
import type { StreamState } from '../lib/stream';
import type { ComputeInfo, MindDetail } from '../lib/types';
import { FeedMind } from './FeedMind';
import { Panel, ProgressBar } from './common';
import { HarvestButton } from './pons/HarvestButton';

/** Derived numbers shown by the meter. */
export interface ComputeFigures {
  balanceWei: bigint;
  balanceUsd: number | null;
  burnUsdPerHour: number | null;
  runwayHours: number | null;
  ethUsd: number | null;
  spentUsd: number;
  unsettledUsd: number;
  availableUsd: number | null;
  tickIntervalMs: number | null;
}

/** Combines on-chain balance, REST compute data and the latest WS budget message. */
export function computeFigures(mind: MindDetail, compute: ComputeInfo | undefined, budget: StreamState['budget']): ComputeFigures {
  const ethUsd =
    (budget !== null ? impliedEthUsd(budget.balanceWei, budget.balanceUsd) : null) ??
    (compute !== undefined ? impliedEthUsd(compute.balanceWei, compute.balanceUsd) : null);
  const balanceWei = mind.mindBalanceWei;
  const balanceUsd = ethUsd !== null ? weiToEth(balanceWei) * ethUsd : balanceWei === 0n ? 0 : (budget?.balanceUsd ?? compute?.balanceUsd ?? null);
  const burn = budget?.burnUsdPerHour ?? compute?.burnUsdPerHour ?? null;
  const runway = balanceUsd !== null && burn !== null ? runwayHours(balanceUsd, burn) : (compute?.runwayHours ?? null);
  const ledger = compute?.ledger ?? [];
  return {
    balanceWei,
    balanceUsd,
    burnUsdPerHour: burn,
    runwayHours: runway,
    ethUsd,
    spentUsd: ledger.reduce((s, e) => s + e.costUsd, 0),
    unsettledUsd: compute?.unsettledUsd ?? ledger.filter((e) => !e.settled).reduce((s, e) => s + e.costUsd, 0),
    availableUsd: compute?.availableUsd ?? null,
    tickIntervalMs: compute?.tickIntervalMs ?? null,
  };
}

/** Props of {@link ComputeMeter}. */
export interface ComputeMeterProps {
  mind: MindDetail;
  compute: ComputeInfo | undefined;
  computeError: boolean;
  budget: StreamState['budget'];
  onFunded: () => void;
  /** Pons mode: creator fees claimable from the escrow (`registry.claimable`), live from chain. */
  claimableWei?: bigint | null;
}

/** See module docs. */
export function ComputeMeter({ mind, compute, computeError, budget, onFunded, claimableWei = null }: ComputeMeterProps) {
  const f = computeFigures(mind, compute, budget);
  const pons = VENUE === 'pons' && mind.pons !== null;
  const claimable = claimableWei ?? mind.pons?.claimableWei ?? null;
  const targetHours = TARGET_RUNWAY_DAYS * 24;
  const runwayPct = f.runwayHours === null ? (f.balanceWei > 0n ? 100 : 0) : Math.min(100, (f.runwayHours / targetHours) * 100);
  const tone = f.runwayHours !== null && f.runwayHours < 24 ? 'amber' : 'acid';
  return (
    <Panel
      title="compute"
      right={
        <span className="normal-case tracking-normal text-mute">
          {!pons ? 'paid by trading fees' : mind.pons?.left === true ? 'creator fees redirected; vault only' : 'paid by Pons creator fees'}
        </span>
      }
    >
      <div className="space-y-3 p-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[11px] text-mute">vault</p>
            <p className="text-lg text-fg tabular-nums">{formatEth(f.balanceWei)}</p>
            <p className="text-[12px] text-dim">{f.balanceUsd !== null ? `≈ ${formatUsd(f.balanceUsd)}` : 'USD value unavailable'}</p>
          </div>
          <div className="text-right">
            <p className="text-[11px] text-mute">runway</p>
            <p className={`text-lg tabular-nums ${tone === 'amber' ? 'text-amber' : 'text-acid'}`}>{formatRunway(f.runwayHours)}</p>
            <p className="text-[12px] text-dim">{f.burnUsdPerHour !== null ? `burn ${formatUsd(f.burnUsdPerHour)}/h` : 'burn unknown'}</p>
          </div>
        </div>
        {pons && (
          <div className="space-y-2 rounded border border-line p-2">
            <div className="flex items-end justify-between gap-3">
              <div>
                <p className="text-[11px] text-mute">claimable (Pons escrow)</p>
                <p className="text-fg tabular-nums">{claimable !== null ? formatEth(claimable) : '—'}</p>
                <p className="text-[11px] text-dim">
                  {claimable !== null && f.ethUsd !== null ? `≈ ${formatUsd(weiToEth(claimable) * f.ethUsd)} · ` : ''}
                  not in the vault until harvested
                </p>
              </div>
              <div className="text-right">
                <p className="text-[11px] text-mute">vault + claimable</p>
                <p className="text-fg tabular-nums">{formatEth(f.balanceWei + (claimable ?? 0n))}</p>
              </div>
            </div>
            <HarvestButton token={mind.token} claimableWei={claimable} onHarvested={onFunded} />
          </div>
        )}
        <div>
          <ProgressBar percent={runwayPct} tone={tone} />
          <p className="mt-1 text-[11px] text-mute">
            {f.runwayHours === null
              ? f.balanceWei > 0n
                ? 'Not burning right now: the vault is untouched until the mind thinks again.'
                : pons
                  ? 'Empty vault: the mind sleeps until someone feeds it or creator fees are harvested.'
                  : 'Empty vault: the mind sleeps until someone feeds it or trades its coin.'
              : `${formatRunway(f.runwayHours)} of thinking left at the current pace (the runner paces minds toward ${TARGET_RUNWAY_DAYS} days).`}
          </p>
        </div>
        {compute !== undefined && (
          <dl className="text-[12px]">
            <div className="kv">
              <dt>spent (last {compute.ledger.length} ticks)</dt>
              <dd>{formatUsd(f.spentUsd)}</dd>
            </div>
            <div className="kv">
              <dt>spent, not yet drawn</dt>
              <dd>{formatUsd(f.unsettledUsd)}</dd>
            </div>
            {f.availableUsd !== null && (
              <div className="kv">
                <dt>available for thinking</dt>
                <dd>{formatUsd(f.availableUsd)}</dd>
              </div>
            )}
            <div className="kv">
              <dt>pace</dt>
              <dd>{f.tickIntervalMs !== null && f.tickIntervalMs > 0 ? `a thought every ~${formatDuration(f.tickIntervalMs)}` : 'not scheduled'}</dd>
            </div>
          </dl>
        )}
        {computeError && <p className="text-[11px] text-mute">Burn and runway need the runner; the balance above is read from the chain.</p>}
        <div className="border-t border-line pt-3">
          <p className="mb-2 text-[11px] uppercase tracking-[0.12em] text-dim">feed the mind</p>
          <FeedMind token={mind.token} symbol={mind.symbol} ethUsd={f.ethUsd} burnUsdPerHour={f.burnUsdPerHour} onFunded={onFunded} />
        </div>
      </div>
    </Panel>
  );
}
