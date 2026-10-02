/**
 * Trade column in Pons mode (SPEC §9.5): stats from the Pons curve (`getReserves`,
 * `sellableTokens`, `realQuoteReserve / graduationThreshold`, `feeBps`, `creatorTaxBps`), buy
 * (`curve.buy{value}(quoteIn, minOut, account)`) and sell (approve the curve, then
 * `curve.sell(tokensIn, minOut, account)`) quoted with the local Pons curve mirror, a snipe-tax
 * warning during the launch window, phase labels bonding / graduating / graduated, and after
 * graduation "Trade on Pons" plus Uniswap / Blockscout links instead of the trade form.
 *
 * @module components/pons/PonsTradePanel
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { erc20Abi, formatUnits, zeroAddress, type Address } from 'viem';
import { useBalance, useConnection, useReadContract, useWriteContract } from 'wagmi';
import { REGISTRY_ADDRESS, TARGET_CHAIN } from '../../config';
import { formatBps, formatEth, formatPrice, formatTokens, parseAmount, shortAddress, shortHash } from '../../format';
import { useDebounced } from '../../hooks/useDebounced';
import { usePonsFactory } from '../../hooks/usePons';
import { useNow } from '../../hooks/useTick';
import { useTxFlow } from '../../hooks/useTxFlow';
import { addressUrl, tokenUrl } from '../../lib/chain';
import {
  DEFAULT_SNIPE_TAX_SECONDS,
  PonsGraduationPhase,
  ponsAddressesFor,
  ponsCurveAbi,
  ponsCurveExtrasAbi,
  ponsFactoryAbi,
  ponsMindRegistryAbi,
  ponsPhaseLabel,
  ponsTradeUrl,
  snipeWindow,
  tryPonsQuoteBuy,
  tryPonsQuoteSell,
  uniswapSwapUrl,
} from '../../lib/pons';
import { minOutWithSlippage, priceImpactBps, slippagePercentToBps } from '../../lib/quote';
import type { MindDetail, PonsLive } from '../../lib/types';
import { queryKeys, useLaunchConfigApi } from '../../queries';
import { ChainGuard } from '../ChainGuard';
import { ExternalLink, Panel, ProgressBar, TxStatus } from '../common';

const BUY_PRESETS = ['0.01', '0.05', '0.1', '0.5'] as const;
const SELL_PERCENTS = [25, 50, 75, 100] as const;

/** Props of {@link PonsTradePanel}. */
export interface PonsTradePanelProps {
  mind: MindDetail;
  live: PonsLive | null;
  /** Called after any confirmed transaction (refresh on-chain reads). */
  onTx: () => void;
}

/** See module docs. */
export function PonsTradePanel({ mind, live, onTx }: PonsTradePanelProps) {
  const queryClient = useQueryClient();
  const symbol = `$${mind.symbol}`;
  const label = ponsPhaseLabel(mind.phase);
  const afterTx = () => {
    onTx();
    void queryClient.invalidateQueries({ queryKey: queryKeys.mind(mind.token) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.trades(mind.token) });
  };
  return (
    <div className="space-y-4">
      <Panel title="pons curve" right={<span className="normal-case tracking-normal text-mute">{label}</span>}>
        <dl className="px-3 py-2 text-[12px]">
          <div className="kv">
            <dt>price</dt>
            <dd>{mind.phase === 'graduated' ? 'on Uniswap' : formatPrice(mind.priceWei)}</dd>
          </div>
          <div className="kv">
            <dt>market cap</dt>
            <dd>{mind.phase === 'graduated' ? '—' : formatEth(mind.marketCapWei, { maxFraction: 3 })}</dd>
          </div>
          <div className="kv">
            <dt>real reserve</dt>
            <dd>
              {formatEth(live?.realQuoteReserve ?? mind.realEthReserveWei, { maxFraction: 3, symbol: false })} /{' '}
              {live?.graduationThreshold != null ? formatEth(live.graduationThreshold, { maxFraction: 3 }) : '—'}
            </dd>
          </div>
          <div className="kv">
            <dt>left on the curve</dt>
            <dd>{live?.sellable != null ? `${formatTokens(live.sellable)} ${symbol}` : '—'}</dd>
          </div>
          <div className="kv">
            <dt>fee + creator tax</dt>
            <dd>
              {live?.feeBps != null ? formatBps(live.feeBps) : '—'} + {live?.creatorTaxBps != null ? formatBps(live.creatorTaxBps) : '—'}
            </dd>
          </div>
          <div className="kv">
            <dt>curve</dt>
            <dd>{live !== null ? <ExternalLink href={addressUrl(live.curve)}>{shortAddress(live.curve)}</ExternalLink> : '—'}</dd>
          </div>
        </dl>
        <div className="px-3 pb-3">
          <ProgressBar percent={mind.phase === 'bonding' ? mind.progressBps / 100 : 100} tone={mind.phase === 'graduated' ? 'violet' : mind.phase === 'complete' ? 'amber' : 'acid'} />
          <p className="mt-1 text-[11px] text-mute">
            {mind.phase === 'bonding'
              ? `${(mind.progressBps / 100).toFixed(2)}% to graduation (real reserve / threshold)`
              : mind.phase === 'complete'
                ? 'Graduating: the curve sold out and was swept; the Uniswap v4 pool is seeded next'
                : 'Graduated: liquidity lives in a locked Uniswap v4 pool'}
          </p>
          <p className="mt-1 text-[11px] text-mute">
            The creator tax and the creator share of the fee go to the mind&apos;s account in the Pons escrow; harvesting moves them into the vault.
          </p>
        </div>
      </Panel>

      {mind.phase === 'complete' && <GraduatingPanel mind={mind} live={live} onTx={afterTx} />}
      {mind.phase === 'graduated' && <GraduatedPanel mind={mind} />}
      {mind.phase === 'bonding' && live !== null && <PonsTradeForm mind={mind} live={live} onTx={afterTx} />}
      {mind.phase === 'bonding' && live === null && (
        <Panel title="trade">
          <p className="p-3 text-[12px] text-mute">Reading the Pons curve…</p>
        </Panel>
      )}
    </div>
  );
}

function GraduatingPanel({ mind, live, onTx }: { mind: MindDetail; live: PonsLive | null; onTx: () => void }) {
  const factory = usePonsFactory();
  const write = useWriteContract();
  const swept = live?.factoryPhase === PonsGraduationPhase.Swept;
  const tx = useTxFlow({
    onConfirmed: onTx,
    // Someone else seeded the pool (or settled the launch) first: refresh, no error.
    onRevert: (name) => {
      if (name === 'WrongGraduationPhase' || name === 'NothingToGraduate' || name === 'AlreadyGraduated') {
        onTx();
        return true;
      }
      return false;
    },
  });
  return (
    <Panel title="graduating">
      <div className="space-y-2 p-3 text-[12px]">
        <p className="text-dim">
          {swept
            ? `$${mind.symbol} sold out its curve and Pons swept it. The next step seeds its locked full-range Uniswap v4 pool; anyone can trigger it (the runner does after about 10 minutes).`
            : `$${mind.symbol} sold out its curve; the launch still has to be settled before its Uniswap v4 pool can be seeded. Anyone can do it.`}
        </p>
        <ChainGuard action="graduate" compact>
          {swept ? (
            <button
              type="button"
              className="btn btn-primary btn-sm w-full"
              disabled={tx.busy || REGISTRY_ADDRESS === null}
              onClick={() =>
                void tx.run(() =>
                  write.mutateAsync({ address: REGISTRY_ADDRESS as Address, abi: ponsMindRegistryAbi, functionName: 'createGraduatedPool', args: [mind.token], chainId: TARGET_CHAIN.id }),
                )
              }
            >
              {tx.busy ? 'Seeding…' : 'Seed the Uniswap pool'}
            </button>
          ) : (
            <button
              type="button"
              className="btn btn-primary btn-sm w-full"
              disabled={tx.busy || factory === null}
              onClick={() =>
                void tx.run(() => write.mutateAsync({ address: factory as Address, abi: ponsFactoryAbi, functionName: 'graduate', args: [mind.token], chainId: TARGET_CHAIN.id }))
              }
            >
              {tx.busy ? 'Settling…' : 'Settle the launch'}
            </button>
          )}
        </ChainGuard>
        <TxStatus tx={tx} labels={{ confirmed: swept ? 'Pool seeded.' : 'Launch settled.' }} />
        <PonsLinks token={mind.token} />
      </div>
    </Panel>
  );
}

function GraduatedPanel({ mind }: { mind: MindDetail }) {
  const poolManager = ponsAddressesFor(TARGET_CHAIN.id)?.poolManager ?? null;
  return (
    <Panel title="uniswap">
      <div className="space-y-2 p-3 text-[12px]">
        <p className="text-dim">
          The curve is closed. ${mind.symbol} trades against ETH in its locked full-range Uniswap v4 pool. Pool fees keep flowing to the mind: the
          Pons hook credits the creator share to the mind account, and harvesting moves it into the vault.
        </p>
        {mind.pons?.poolId != null && (
          <p className="text-mute">
            pool id <span title={mind.pons.poolId}>{shortHash(mind.pons.poolId, 10)}</span>
            {poolManager !== null && (
              <>
                {' '}
                · <ExternalLink href={addressUrl(poolManager)}>PoolManager</ExternalLink>
              </>
            )}
          </p>
        )}
        <PonsLinks token={mind.token} />
      </div>
    </Panel>
  );
}

/** "Trade on Pons" + Uniswap + Blockscout links. */
function PonsLinks({ token }: { token: Address }) {
  const uniswap = uniswapSwapUrl(token, TARGET_CHAIN.id);
  const explorer = tokenUrl(token);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ExternalLink href={ponsTradeUrl()} className="btn btn-primary btn-sm hover:no-underline">
        Trade on Pons
      </ExternalLink>
      {uniswap !== null && (
        <ExternalLink href={uniswap} className="btn btn-sm hover:no-underline">
          Uniswap
        </ExternalLink>
      )}
      {explorer !== null ? (
        <ExternalLink href={explorer} className="btn btn-sm hover:no-underline">
          Blockscout
        </ExternalLink>
      ) : (
        <span className="text-[11px] text-mute">no block explorer for {TARGET_CHAIN.name}</span>
      )}
    </div>
  );
}

function SnipeWarning({ live }: { live: PonsLive }) {
  const { address } = useConnection();
  const now = useNow(1_000);
  const near = live.launchedAt !== null && now / 1000 - live.launchedAt < 120;
  const settings = useLaunchConfigApi(near);
  const curveWindow = useReadContract({
    address: live.curve,
    abi: ponsCurveExtrasAbi,
    functionName: 'snipeTaxSeconds',
    chainId: TARGET_CHAIN.id,
    query: { enabled: near, staleTime: Infinity, retry: false },
  });
  const seconds = curveWindow.data !== undefined ? Number(curveWindow.data) : (settings.data?.snipeTaxSeconds ?? DEFAULT_SNIPE_TAX_SECONDS);
  const w = snipeWindow(live.launchedAt, seconds, now);
  const mine = useReadContract({
    address: live.curve,
    abi: ponsCurveExtrasAbi,
    functionName: 'currentSnipeTaxBps',
    args: [address ?? zeroAddress],
    chainId: TARGET_CHAIN.id,
    query: { enabled: w.active && address !== undefined, refetchInterval: 1_000, retry: false },
  });
  if (!w.active) return null;
  return (
    <div className="rounded border border-danger/50 bg-danger/10 p-2 text-[12px] text-danger" role="alert">
      <p className="font-bold">Snipe tax active: {w.remainingSeconds}s left</p>
      <p>
        Buys in the first {seconds}s after launch pay a Pons snipe tax of up to 99%, decaying to zero (the creator is exempt).
        {mine.data !== undefined && ` Your current snipe tax: ${formatBps(mine.data)}.`} The quote below ignores it, so a taxed buy fails on slippage
        instead of paying it. Wait for the window to close.
      </p>
    </div>
  );
}

function PonsTradeForm({ mind, live, onTx }: { mind: MindDetail; live: PonsLive; onTx: () => void }) {
  const [side, setSide] = useState<'buy' | 'sell'>('buy');
  const [amount, setAmount] = useState('');
  const [slippage, setSlippage] = useState('1');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { address } = useConnection();
  const write = useWriteContract();
  const symbol = `$${mind.symbol}`;
  const debounced = useDebounced(amount, 250);
  const parsed = parseAmount(debounced);
  const typed = parseAmount(amount);
  const stale = typed !== parsed;
  const slippageBps = slippagePercentToBps(slippage);

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
    args: [address ?? zeroAddress, live.curve],
    chainId: TARGET_CHAIN.id,
    query: { enabled: address !== undefined && side === 'sell' },
  });

  const ready = live.quoteReserve !== null && live.tokenReserve !== null && live.feeBps !== null && live.creatorTaxBps !== null && (side === 'sell' || live.sellable !== null);
  const reserves = { quoteReserve: live.quoteReserve ?? 0n, tokenReserve: live.tokenReserve ?? 0n };
  const fees = { feeBps: BigInt(live.feeBps ?? 0), taxBps: BigInt(live.creatorTaxBps ?? 0) };
  const amountOk = parsed !== null && parsed > 0n;
  const buy = side === 'buy' && ready && amountOk ? tryPonsQuoteBuy({ quoteIn: parsed, ...reserves, sellable: live.sellable ?? 0n, ...fees }) : null;
  const sell = side === 'sell' && ready && amountOk ? tryPonsQuoteSell({ tokensIn: parsed, ...reserves, ...fees }) : null;
  const outAmount = side === 'buy' ? (buy?.tokensOut ?? null) : (sell?.quoteOut ?? null);
  const feeAmount = side === 'buy' ? (buy !== null ? buy.fee + buy.tax : null) : sell !== null ? sell.fee + sell.tax : null;
  const minOut = outAmount !== null && slippageBps !== null ? minOutWithSlippage(outAmount, slippageBps) : null;
  const impact =
    side === 'buy'
      ? buy !== null
        ? priceImpactBps(mind.priceWei, buy.spent - buy.fee - buy.tax, buy.tokensOut)
        : null
      : sell !== null && parsed !== null
        ? priceImpactBps(mind.priceWei, sell.grossQuoteOut, parsed)
        : null;
  const insufficient =
    parsed !== null &&
    (side === 'buy' ? ethBalance.data !== undefined && parsed > ethBalance.data.value : tokenBalance.data !== undefined && parsed > tokenBalance.data);
  const needsApproval = side === 'sell' && amountOk && allowance.data !== undefined && parsed !== null && allowance.data < parsed;
  const noLiquidity = side === 'sell' && live.readyToGraduate === true;

  const approveTx = useTxFlow({ onConfirmed: () => void allowance.refetch() });
  const tradeTx = useTxFlow({
    onConfirmed: () => {
      setAmount('');
      approveTx.reset();
      onTx();
      void tokenBalance.refetch();
      void allowance.refetch();
      void ethBalance.refetch();
    },
  });

  const canTrade = !stale && amountOk && minOut !== null && !insufficient && !noLiquidity && !tradeTx.busy && address !== undefined;

  function trade() {
    if (!canTrade || parsed === null || minOut === null || address === undefined) return;
    if (side === 'buy') {
      void tradeTx.run(() =>
        write.mutateAsync({ address: live.curve, abi: ponsCurveAbi, functionName: 'buy', args: [parsed, minOut, address], value: parsed, chainId: TARGET_CHAIN.id }),
      );
    } else {
      void tradeTx.run(() => write.mutateAsync({ address: live.curve, abi: ponsCurveAbi, functionName: 'sell', args: [parsed, minOut, address], chainId: TARGET_CHAIN.id }));
    }
  }

  function approve() {
    if (parsed === null) return;
    void approveTx.run(() => write.mutateAsync({ address: mind.token, abi: erc20Abi, functionName: 'approve', args: [live.curve, parsed], chainId: TARGET_CHAIN.id }));
  }

  return (
    <Panel
      title="trade on the pons curve"
      right={
        <button type="button" className="text-[11px] normal-case tracking-normal text-mute hover:text-fg" onClick={() => setSettingsOpen((o) => !o)}>
          slippage {slippageBps !== null ? formatBps(slippageBps) : '?'}
        </button>
      }
    >
      <div className="space-y-3 p-3">
        <SnipeWarning live={live} />
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
                approveTx.reset();
              }}
              className={`rounded py-1.5 ${side === s ? (s === 'buy' ? 'bg-acid/15 text-acid' : 'bg-danger/15 text-danger') : 'text-dim'}`}
            >
              {s}
            </button>
          ))}
        </div>

        {settingsOpen && (
          <label className="block rounded border border-line p-2">
            <span className="label">slippage %</span>
            <input className={`field py-1 ${slippageBps === null ? 'field-error' : ''}`} inputMode="decimal" value={slippage} onChange={(e) => setSlippage(e.target.value)} />
            <span className="mt-1 block text-[11px] text-mute">The Pons curve has no deadline parameter; only the minimum output protects the trade.</span>
          </label>
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
              className={`field pr-16 text-[15px] ${amount !== '' && typed === null ? 'field-error' : ''}`}
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
                      setAmount(formatUnits((tokenBalance.data * BigInt(p)) / 100n, 18));
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
            <dd className={stale ? 'opacity-50' : ''}>{outAmount === null ? '—' : side === 'buy' ? `${formatTokens(outAmount)} ${symbol}` : formatEth(outAmount)}</dd>
          </div>
          <div className="kv">
            <dt>minimum after slippage</dt>
            <dd>{minOut === null ? '—' : side === 'buy' ? formatTokens(minOut) : formatEth(minOut)}</dd>
          </div>
          <div className="kv">
            <dt>
              fee + creator tax ({live.feeBps !== null ? formatBps(live.feeBps) : '?'} + {live.creatorTaxBps !== null ? formatBps(live.creatorTaxBps) : '?'})
            </dt>
            <dd>{feeAmount === null ? '—' : formatEth(feeAmount)}</dd>
          </div>
          <div className="kv">
            <dt>price impact</dt>
            <dd className={impact !== null && impact > 500n ? 'text-amber' : ''}>{impact === null ? '—' : formatBps(impact)}</dd>
          </div>
          <p className="pb-1 text-[11px] text-mute">quoted locally from the curve&apos;s live reserves (Pons has no on-chain quote view)</p>
        </dl>

        {buy !== null && buy.refund > 0n && (
          <p className="text-[12px] text-amber">
            This buy sells out the curve: only {formatEth(buy.spent)} is used and {formatEth(buy.refund)} is refunded. The curve then graduates to Uniswap.
          </p>
        )}
        {amountOk && ready && outAmount === null && <p className="text-[12px] text-danger">The curve cannot price this amount.</p>}
        {insufficient && <p className="text-[12px] text-danger">Not enough {side === 'buy' ? 'ETH' : symbol}.</p>}
        {noLiquidity && <p className="text-[12px] text-amber">The curve sold out; selling reopens on Uniswap after graduation.</p>}

        <ChainGuard action="trade">
          {needsApproval ? (
            <div className="space-y-1">
              <button type="button" className="btn w-full" disabled={approveTx.busy || insufficient} onClick={approve}>
                {approveTx.busy ? 'Approving…' : `Approve ${formatTokens(parsed ?? 0n)} ${symbol}`}
              </button>
              <p className="text-[11px] text-mute">Step 1 of 2: allow the Pons curve to take exactly this amount. Then sell.</p>
            </div>
          ) : (
            <button type="button" className={`btn w-full py-2.5 ${side === 'buy' ? 'btn-primary' : 'btn-danger'}`} disabled={!canTrade} onClick={trade}>
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
        {side === 'sell' && <TxStatus tx={approveTx} labels={{ confirmed: 'Approved. Now sell.' }} />}
        <TxStatus tx={tradeTx} labels={{ confirmed: side === 'buy' ? 'Bought.' : 'Sold.' }} />
      </div>
    </Panel>
  );
}
