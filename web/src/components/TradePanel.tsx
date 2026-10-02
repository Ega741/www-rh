/**
 * Trade column: curve stats, buy / sell with on-chain `quoteBuy` / `quoteSell` reads (local
 * curve-math estimate while loading), slippage (default 1 %) and deadline settings,
 * approve-then-sell with an allowance check, the Graduate button once the curve is complete,
 * and Blockscout token / pool links after graduation (W4).
 *
 * @module components/TradePanel
 */
import { completionReserves } from '@www-rh/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { erc20Abi, formatUnits, zeroAddress, type Address } from 'viem';
import { useBalance, useConnection, useReadContract, useWriteContract } from 'wagmi';
import { LAUNCHPAD_ADDRESS, TARGET_CHAIN } from '../config';
import { formatBps, formatEth, formatPrice, formatTokens, parseAmount, progressPercent } from '../format';
import { useDebounced } from '../hooks/useDebounced';
import { useTxFlow } from '../hooks/useTxFlow';
import { mindLaunchpadAbi as launchpadAbi } from '@www-rh/shared';
import { addressUrl, tokenUrl } from '../lib/chain';
import { DEFAULT_DEADLINE_MINUTES, deadlineFromNow, estimateBuy, estimateSell, minOutWithSlippage, priceImpactBps, slippagePercentToBps } from '../lib/quote';
import type { MindDetail } from '../lib/types';
import { queryKeys } from '../queries';
import { ChainGuard } from './ChainGuard';
import { ExternalLink, Panel, ProgressBar, TxStatus } from './common';

const BUY_PRESETS = ['0.01', '0.05', '0.1', '0.5'] as const;
const SELL_PERCENTS = [25, 50, 75, 100] as const;

/** Props of {@link TradePanel}. */
export interface TradePanelProps {
  mind: MindDetail;
  /** Called after any confirmed transaction (refresh on-chain reads). */
  onTx: () => void;
}

/** See module docs. */
export function TradePanel({ mind, onTx }: TradePanelProps) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('');
  const [slippage, setSlippage] = useState('1');
  const [deadline, setDeadline] = useState(String(DEFAULT_DEADLINE_MINUTES));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const queryClient = useQueryClient();
  const { address } = useConnection();
  const launchpad = LAUNCHPAD_ADDRESS ?? zeroAddress;
  const hasLaunchpad = LAUNCHPAD_ADDRESS !== null;
  const bonding = mind.phase === 'bonding';

  const debounced = useDebounced(amount, 250);
  const parsed = parseAmount(debounced);
  const live = parseAmount(amount);
  const slippageBps = slippagePercentToBps(slippage);
  const deadlineMinutes = Number(deadline);
  const deadlineValid = Number.isFinite(deadlineMinutes) && deadlineMinutes >= 1 && deadlineMinutes <= 1440;

  const lp = { address: launchpad, abi: launchpadAbi, chainId: TARGET_CHAIN.id } as const;
  const feeParams = useReadContract({ ...lp, functionName: 'feeParams', query: { enabled: hasLaunchpad, staleTime: 60_000 } });
  const paused = useReadContract({ ...lp, functionName: 'paused', query: { enabled: hasLaunchpad, refetchInterval: 30_000 } });
  const ethBalance = useBalance({ address, chainId: TARGET_CHAIN.id, query: { enabled: address !== undefined, refetchInterval: 10_000 } });
  const tokenBalance = useReadContract({
    address: mind.token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address ?? zeroAddress],
    chainId: TARGET_CHAIN.id,
    query: { enabled: address !== undefined, refetchInterval: 10_000 },
  });
  const allowance = useReadContract({
    address: mind.token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [address ?? zeroAddress, launchpad],
    chainId: TARGET_CHAIN.id,
    query: { enabled: address !== undefined && hasLaunchpad && side === 'sell' },
  });
  const quoteEnabled = hasLaunchpad && bonding && parsed !== null && parsed > 0n;
  const buyQuote = useReadContract({ ...lp, functionName: 'quoteBuy', args: [mind.token, parsed ?? 0n], query: { enabled: quoteEnabled && side === 'buy', refetchInterval: 2_000 } });
  const sellQuote = useReadContract({ ...lp, functionName: 'quoteSell', args: [mind.token, parsed ?? 0n], query: { enabled: quoteEnabled && side === 'sell', refetchInterval: 2_000 } });

  const tradeFeeBps = feeParams.data !== undefined ? BigInt(feeParams.data.tradeFeeBps) : 100n;
  const reserves = { realEthReserve: mind.realEthReserveWei, tokensSold: mind.tokensSold };
  const stale = live !== parsed;

  let outAmount: bigint | null = null;
  let feeAmount: bigint | null = null;
  let ethUsed: bigint | null = null;
  let source: 'chain' | 'estimate' | null = null;
  if (parsed !== null && parsed > 0n && bonding) {
    if (side === 'buy') {
      if (buyQuote.data !== undefined) {
        [outAmount, ethUsed, feeAmount] = buyQuote.data;
        source = 'chain';
      } else {
        const est = estimateBuy(reserves, parsed, tradeFeeBps);
        if (est !== null) {
          outAmount = est.tokensOut;
          ethUsed = est.ethUsed;
          feeAmount = est.fee;
          source = 'estimate';
        }
      }
    } else if (sellQuote.data !== undefined) {
      [outAmount, feeAmount] = sellQuote.data;
      source = 'chain';
    } else {
      const est = estimateSell(reserves, parsed, tradeFeeBps);
      if (est !== null) {
        outAmount = est.ethOut;
        feeAmount = est.fee;
        source = 'estimate';
      }
    }
  }
  const minOut = outAmount !== null && slippageBps !== null ? minOutWithSlippage(outAmount, slippageBps) : null;
  const impact =
    parsed !== null && outAmount !== null && outAmount > 0n
      ? side === 'buy'
        ? priceImpactBps(mind.priceWei, (ethUsed ?? parsed) - (feeAmount ?? 0n), outAmount)
        : priceImpactBps(mind.priceWei, outAmount + (feeAmount ?? 0n), parsed)
      : null;
  const insufficient =
    parsed !== null &&
    (side === 'buy'
      ? ethBalance.data !== undefined && parsed > ethBalance.data.value
      : tokenBalance.data !== undefined && parsed > tokenBalance.data);
  const needsApproval = side === 'sell' && parsed !== null && parsed > 0n && allowance.data !== undefined && allowance.data < parsed;
  const sellExceedsCurve = side === 'sell' && parsed !== null && parsed > mind.tokensSold;

  const write = useWriteContract();
  const afterTx = () => {
    onTx();
    void tokenBalance.refetch();
    void allowance.refetch();
    void ethBalance.refetch();
    void queryClient.invalidateQueries({ queryKey: queryKeys.mind(mind.token) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.trades(mind.token) });
  };
  const tradeTx = useTxFlow({
    onConfirmed: () => {
      setAmount('');
      afterTx();
    },
  });
  const approveTx = useTxFlow({ onConfirmed: () => void allowance.refetch() });
  // A WrongPhase revert on graduate means someone else graduated first: refetch, no error (SPEC §7).
  const phaseTx = useTxFlow({
    onConfirmed: afterTx,
    onRevert: (name) => {
      if (name !== 'WrongPhase' || mind.phase !== 'complete') return false;
      afterTx();
      return true;
    },
  });
  const mockGraduator = mind.phase === 'graduated' && (mind.positionId === null || mind.positionId === 0n);

  const canTrade =
    hasLaunchpad && bonding && !stale && parsed !== null && parsed > 0n && minOut !== null && deadlineValid && !insufficient && !sellExceedsCurve && !tradeTx.busy;

  function trade() {
    if (!canTrade || parsed === null || minOut === null) return;
    const dl = deadlineFromNow(deadlineMinutes);
    if (side === 'buy') {
      void tradeTx.run(() =>
        write.mutateAsync({ ...lp, address: LAUNCHPAD_ADDRESS as Address, functionName: 'buy', args: [mind.token, minOut, dl], value: parsed }),
      );
    } else {
      void tradeTx.run(() =>
        write.mutateAsync({ ...lp, address: LAUNCHPAD_ADDRESS as Address, functionName: 'sell', args: [mind.token, parsed, minOut, dl] }),
      );
    }
  }

  function approve() {
    if (parsed === null || !hasLaunchpad) return;
    void approveTx.run(() =>
      write.mutateAsync({ address: mind.token, abi: erc20Abi, functionName: 'approve', args: [launchpad, parsed], chainId: TARGET_CHAIN.id }),
    );
  }

  const target = completionReserves().realEthReserve;
  const symbol = `$${mind.symbol}`;

  return (
    <div className="space-y-4">
      <Panel title="curve">
        <dl className="px-3 py-2 text-[12px]">
          <div className="kv">
            <dt>price</dt>
            <dd>{mind.phase === 'graduated' ? 'on the DEX' : formatPrice(mind.priceWei)}</dd>
          </div>
          <div className="kv">
            <dt>market cap</dt>
            <dd>{mind.phase === 'graduated' ? '—' : formatEth(mind.marketCapWei, { maxFraction: 3 })}</dd>
          </div>
          <div className="kv">
            <dt>real reserve</dt>
            <dd>
              {formatEth(mind.realEthReserveWei, { maxFraction: 3, symbol: false })} / {formatEth(target, { maxFraction: 2 })}
            </dd>
          </div>
          <div className="kv">
            <dt>sold on curve</dt>
            <dd>{formatTokens(mind.tokensSold)} / 800M</dd>
          </div>
        </dl>
        <div className="px-3 pb-3">
          <ProgressBar percent={mind.phase === 'bonding' ? progressPercent(mind.tokensSold) : 100} tone={mind.phase === 'graduated' ? 'violet' : mind.phase === 'complete' ? 'amber' : 'acid'} />
          <p className="mt-1 text-[11px] text-mute">
            {mind.phase === 'bonding'
              ? `${progressPercent(mind.tokensSold).toFixed(2)}% to graduation`
              : mind.phase === 'complete'
                ? 'Curve sold out: ready to graduate'
                : 'Graduated: liquidity lives on the DEX'}
          </p>
        </div>
      </Panel>

      {mind.phase === 'complete' && (
        <Panel title="graduation">
          <div className="space-y-2 p-3">
            <p className="text-[12px] text-dim">
              All 800M curve tokens are sold. Anyone can graduate the coin: the reserve (minus the graduation fee, part of which goes to the mind's
              vault) and the 200M LP tokens seed a full-range pool that stays locked forever.
            </p>
            <ChainGuard action="graduate">
              <button
                type="button"
                className="btn btn-primary w-full"
                disabled={phaseTx.busy}
                onClick={() => void phaseTx.run(() => write.mutateAsync({ ...lp, address: LAUNCHPAD_ADDRESS as Address, functionName: 'graduate', args: [mind.token] }))}
              >
                {phaseTx.busy ? 'Graduating…' : 'Graduate'}
              </button>
            </ChainGuard>
            <TxStatus tx={phaseTx} labels={{ confirmed: 'Graduated.' }} />
          </div>
        </Panel>
      )}

      {mind.phase === 'graduated' && (
        <Panel title={mockGraduator ? 'graduated' : 'dex'}>
          <div className="space-y-2 p-3 text-[12px]">
            <p className="text-dim">
              {mockGraduator
                ? `The curve is closed. This launchpad uses the MockGraduator, so ${symbol} has no DEX pool: the liquidity is held by the graduator contract.`
                : `The curve is closed. ${symbol} now trades against WETH in its full-range DEX pool.`}
            </p>
            <div className="flex flex-wrap gap-2">
              <ExternalLink href={tokenUrl(mind.token)} className="btn btn-sm">
                token on explorer
              </ExternalLink>
              {mind.pool !== null && (
                <ExternalLink href={addressUrl(mind.pool)} className="btn btn-sm">
                  {mockGraduator ? 'MockGraduator (no DEX)' : 'pool on explorer'}
                </ExternalLink>
              )}
            </div>
            <p className="text-dim">LP fees belong to the mind: harvesting sends the ETH side to its vault and burns the token side. Anyone can trigger it.</p>
            <ChainGuard action="harvest" compact>
              <button
                type="button"
                className="btn btn-sm w-full"
                disabled={phaseTx.busy}
                onClick={() => void phaseTx.run(() => write.mutateAsync({ ...lp, address: LAUNCHPAD_ADDRESS as Address, functionName: 'harvest', args: [mind.token] }))}
              >
                {phaseTx.busy ? 'Harvesting…' : 'Harvest fees'}
              </button>
            </ChainGuard>
            <TxStatus tx={phaseTx} labels={{ confirmed: 'Harvested.' }} />
          </div>
        </Panel>
      )}

      {bonding && (
        <Panel
          title="trade"
          right={
            <button type="button" className="text-[11px] normal-case tracking-normal text-mute hover:text-fg" onClick={() => setSettingsOpen((o) => !o)}>
              slippage {slippageBps !== null ? formatBps(slippageBps) : '?'} · {deadlineValid ? `${deadlineMinutes}m` : '?'}
            </button>
          }
        >
          <div className="space-y-3 p-3">
            <div className="grid grid-cols-2 gap-1 rounded border border-line p-0.5" role="tablist">
              {(['buy', 'sell'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  role="tab"
                  aria-selected={side === s}
                  onClick={() => {
                    setSide(s);
                    setAmount('');
                    tradeTx.reset();
                  }}
                  className={`rounded py-1.5 ${side === s ? (s === 'buy' ? 'bg-acid/15 text-acid' : 'bg-danger/15 text-danger') : 'text-dim'}`}
                >
                  {s}
                </button>
              ))}
            </div>

            {settingsOpen && (
              <div className="grid grid-cols-2 gap-2 rounded border border-line p-2">
                <label>
                  <span className="label">slippage %</span>
                  <input className={`field py-1 ${slippageBps === null ? 'field-error' : ''}`} inputMode="decimal" value={slippage} onChange={(e) => setSlippage(e.target.value)} />
                </label>
                <label>
                  <span className="label">deadline min</span>
                  <input className={`field py-1 ${!deadlineValid ? 'field-error' : ''}`} inputMode="numeric" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
                </label>
              </div>
            )}

            {paused.data === true && side === 'buy' && (
              <p className="text-[12px] text-amber">The launchpad is paused: buying is disabled, selling still works.</p>
            )}

            <div>
              <div className="mb-1 flex justify-between text-[11px] text-mute">
                <span>{side === 'buy' ? 'you pay' : 'you sell'}</span>
                <span>
                  balance{' '}
                  {side === 'buy'
                    ? ethBalance.data !== undefined
                      ? formatEth(ethBalance.data.value)
                      : '—'
                    : tokenBalance.data !== undefined
                      ? `${formatTokens(tokenBalance.data)} ${symbol}`
                      : '—'}
                </span>
              </div>
              <label className="relative block">
                <span className="sr-only">Amount</span>
                <input
                  className={`field pr-16 text-[15px] ${amount !== '' && live === null ? 'field-error' : ''}`}
                  inputMode="decimal"
                  placeholder="0.0"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-[12px] text-mute">{side === 'buy' ? 'ETH' : symbol}</span>
              </label>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {side === 'buy'
                  ? BUY_PRESETS.map((p) => (
                      <button key={p} type="button" className="chip hover:text-fg" onClick={() => setAmount(p)}>
                        {p}
                      </button>
                    ))
                  : SELL_PERCENTS.map((p) => (
                      <button
                        key={p}
                        type="button"
                        className="chip hover:text-fg disabled:opacity-40"
                        disabled={tokenBalance.data === undefined || tokenBalance.data === 0n}
                        onClick={() => {
                          if (tokenBalance.data === undefined) return;
                          const v = (tokenBalance.data * BigInt(p)) / 100n;
                          setAmount(formatUnits(v, 18));
                        }}
                      >
                        {p === 100 ? 'max' : `${p}%`}
                      </button>
                    ))}
              </div>
            </div>

            <dl className="rounded border border-line px-2 py-1 text-[12px]">
              <div className="kv">
                <dt>{side === 'buy' ? 'you receive ≈' : 'you get ≈'}</dt>
                <dd className={stale ? 'opacity-50' : ''}>
                  {outAmount === null ? '—' : side === 'buy' ? `${formatTokens(outAmount)} ${symbol}` : formatEth(outAmount)}
                </dd>
              </div>
              <div className="kv">
                <dt>minimum after slippage</dt>
                <dd>{minOut === null ? '—' : side === 'buy' ? formatTokens(minOut) : formatEth(minOut)}</dd>
              </div>
              <div className="kv">
                <dt>fee ({formatBps(tradeFeeBps)})</dt>
                <dd>{feeAmount === null ? '—' : formatEth(feeAmount)}</dd>
              </div>
              <div className="kv">
                <dt>price impact</dt>
                <dd className={impact !== null && impact > 500n ? 'text-amber' : ''}>{impact === null ? '—' : formatBps(impact)}</dd>
              </div>
              {source === 'estimate' && <p className="pb-1 text-[11px] text-mute">estimate from curve math; waiting for the on-chain quote</p>}
            </dl>

            {side === 'buy' && ethUsed !== null && parsed !== null && ethUsed < parsed && (
              <p className="text-[12px] text-amber">This buy completes the curve: only {formatEth(ethUsed)} is used and {formatEth(parsed - ethUsed)} is refunded.</p>
            )}
            {insufficient && <p className="text-[12px] text-danger">Not enough {side === 'buy' ? 'ETH' : symbol}.</p>}
            {sellExceedsCurve && <p className="text-[12px] text-danger">You can sell at most the amount sold on the curve.</p>}

            <ChainGuard action="trade">
              {needsApproval ? (
                <div className="space-y-1">
                  <button type="button" className="btn w-full" disabled={approveTx.busy || insufficient} onClick={approve}>
                    {approveTx.busy ? 'Approving…' : `Approve ${formatTokens(parsed ?? 0n)} ${symbol}`}
                  </button>
                  <p className="text-[11px] text-mute">Step 1 of 2: allow the launchpad to take exactly this amount. Then sell.</p>
                  <TxStatus tx={approveTx} labels={{ confirmed: 'Approved. Now sell.' }} />
                </div>
              ) : (
                <button
                  type="button"
                  className={`btn w-full py-2.5 ${side === 'buy' ? 'btn-primary' : 'btn-danger'}`}
                  disabled={!canTrade || (side === 'buy' && paused.data === true)}
                  onClick={trade}
                >
                  {tradeTx.phase === 'signing'
                    ? 'Confirm in your wallet…'
                    : tradeTx.phase === 'pending'
                      ? 'Waiting for confirmation…'
                      : side === 'buy'
                        ? `Buy ${symbol}`
                        : `Sell ${symbol}`}
                </button>
              )}
            </ChainGuard>
            <TxStatus tx={tradeTx} labels={{ confirmed: side === 'buy' ? 'Bought.' : 'Sold.' }} />
          </div>
        </Panel>
      )}
    </div>
  );
}

