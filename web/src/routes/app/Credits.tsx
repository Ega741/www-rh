/**
 * `/app/credits`: amount in USD or tokens, live on-chain quote, wallet balance/allowance,
 * Approve → Burn with progress + explorer links, then poll `/api/receipts` and `/api/balance`
 * until the credit lands. The credit goes to the signed-in workspace by default (SPEC §7), even
 * when the connected wallet that pays the burn is another account.
 *
 * The burn goes through `burnForCreditMin(workspace, amount, minUsdMicro)` with the floor derived
 * from the live quote and the chosen price tolerance (default 1 %): a price post landing between
 * the quote and the transaction reverts `SlippageExceeded` instead of crediting less. The approve
 * is cumulative (`allowance + amount`) so open budgets of the wallet keep their allowance.
 */
import { useEffect, useRef, useState } from 'react';
import { useConnection, usePublicClient, useWriteContract } from 'wagmi';
import type { Hex } from 'viem';
import { CREDIT_DESK_ABI, ERC20_ABI } from '@beagle/shared/abi';
import { AmountInput } from '../../components/AmountInput.jsx';
import { AddressText, TxLink } from '../../components/Hash.jsx';
import { QueryGuard } from '../../components/QueryGuard.jsx';
import { StepList } from '../../components/StepList.jsx';
import { Badge, Button, Card, Field, Input, Note, PageHeader, Segmented, Skeleton, Stat, TableWrap } from '../../components/ui.jsx';
import { config } from '../../config.js';
import { useChainGuard } from '../../hooks/useChainGuard.js';
import { useDesk } from '../../hooks/useDesk.js';
import { useDeskParams, useQuote } from '../../hooks/useQuote.js';
import { useSession } from '../../hooks/useSession.jsx';
import { useToast } from '../../hooks/useToast.jsx';
import { useTokenAccount } from '../../hooks/useTokenAccount.js';
import { useTxFlow } from '../../hooks/useTxFlow.js';
import { convertAmount, fmtPrice, fmtTokens, fmtUsd, parseAmount, type AmountMode } from '../../lib/amounts.js';
import { sameAddress } from '../../lib/explorer.js';
import { IDLE_WATCH, WATCH_POLL_MS, observeBalance, observeEvents, restartWatch, startWatch, type WatchState } from '../../lib/poll.js';
import { defaultTargetWorkspace } from '../../lib/session.js';
import { DEFAULT_TOLERANCE_BPS, SHARED_ALLOWANCE_NOTE, TOLERANCE_CHOICES_BPS, TOLERANCE_HELP, approveLabel, describeBlocker, failedWith, formatBps, planBurn } from '../../lib/steps.js';
import { ageSeconds, formatDuration, formatUnixSeconds } from '../../lib/time.js';
import { parseAddressInput } from '../../lib/validate.js';
import { invalidateBalances, useBalance, useCreditEvents, usePrice } from '../../queries.js';
import { useQueryClient } from '@tanstack/react-query';

/** Credits page. */
export function Credits() {
  const session = useSession();
  const me = session.me;
  const { address, isConnected } = useConnection();
  const guard = useChainGuard();
  const toast = useToast();
  const client = useQueryClient();
  const { desk, token, loading: deskLoading, error: deskError } = useDesk();
  const decimals = token?.decimals ?? 18;
  const symbol = token?.symbol ?? 'BEAGLE';
  const params = useDeskParams(desk, token?.decimals);
  const apiPrice = usePrice();

  const [mode, setMode] = useState<AmountMode>('usd');
  const [input, setInput] = useState('');
  const [otherWorkspace, setOtherWorkspace] = useState(false);
  const [workspaceInput, setWorkspaceInput] = useState('');
  const [toleranceBps, setToleranceBps] = useState<number>(DEFAULT_TOLERANCE_BPS);

  const parsed = parseAmount(input, mode, decimals);
  const priceE18 = params.priceE18 ?? apiPrice.data?.priceE18;
  const converted = parsed.ok && priceE18 !== undefined ? convertAmount(mode, parsed.value, priceE18, decimals) : undefined;
  const tokens = converted?.tokens;
  const quote = useQuote(desk, tokens);
  const account = useTokenAccount(token?.address, address, desk);

  const defaultWorkspace = defaultTargetWorkspace(me?.workspace, address);
  const workspace = otherWorkspace ? parseAddressInput(workspaceInput) : defaultWorkspace;
  const creditsOwnWorkspace = workspace !== undefined && me !== undefined && sameAddress(workspace, me.workspace);

  const priceStale = params.priceError === 'PriceStale' || quote.revert === 'PriceStale' || apiPrice.data?.stale === true;
  const priceAvailable = params.priceError !== 'PriceUnavailable' && quote.revert !== 'PriceUnavailable' && (params.priceE18 !== undefined || params.loading || apiPrice.data !== undefined);

  const plan = planBurn({
    connected: isConnected,
    rightChain: !guard.wrongChain,
    deskKnown: desk !== undefined && token !== undefined,
    paused: params.paused,
    workspaceValid: workspace !== undefined,
    amount: tokens,
    usdMicro: quote.usdMicro,
    toleranceBps,
    priceAvailable,
    priceStale,
    minBurn: params.minBurn,
    balance: account.balance,
    allowance: account.allowance,
  });
  const blockerCtx = { chainName: config.chain.name, ...(params.minBurn === undefined ? {} : { minBurnText: fmtTokens(params.minBurn, decimals, symbol) }) };
  const firstBlocker = plan.blockers[0];

  const flow = useTxFlow();
  const write = useWriteContract();
  const publicClient = usePublicClient({ chainId: config.chainId });
  const slippage = failedWith(flow.state, 'SlippageExceeded');
  const [watch, setWatch] = useState<WatchState>(IDLE_WATCH);
  const watchRef = useRef(watch);
  watchRef.current = watch;
  const watching = watch.status === 'watching';
  const balance = useBalance(watching ? WATCH_POLL_MS : undefined);
  const events = useCreditEvents(10, watching ? WATCH_POLL_MS : undefined);

  const settle = (next: WatchState, w: WatchState) => {
    if (next !== w) setWatch(next);
    if (next.status === 'landed') {
      toast.push({ kind: 'success', title: 'Credit landed', message: balance.data === undefined ? 'The ledger shows the purchase.' : `Balance is now ${fmtUsd(balance.data.balanceMicro)}` });
      void invalidateBalances(client);
    } else if (next.status === 'timeout') {
      toast.push({ kind: 'warning', title: 'Still waiting for the indexer', message: 'The burn is confirmed on chain; the ledger will update once the indexer catches up.' });
    }
  };

  useEffect(() => {
    const w = watchRef.current;
    const data = balance.data;
    if (w.status !== 'watching' || data === undefined) return;
    settle(observeBalance(w, data.balanceMicro), w);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balance.dataUpdatedAt]);

  useEffect(() => {
    const w = watchRef.current;
    const rows = events.data?.rows;
    if (w.status !== 'watching' || rows === undefined) return;
    settle(observeEvents(w, rows), w);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events.dataUpdatedAt]);

  const onBurn = async () => {
    if (!plan.canRun || tokens === undefined || workspace === undefined || desk === undefined || token === undefined) return;
    const expected = quote.usdMicro;
    const minUsdMicro = plan.minUsdMicro;
    // Both are set when `canRun`: `quote_pending` blocks without a quote, `allowance_unknown` without an allowance.
    if (expected === undefined || minUsdMicro === undefined) return;
    const approveAmount = plan.approveAmount ?? tokens;
    const before = balance.data?.balanceMicro ?? me?.balanceMicro ?? 0n;
    let burnHash: Hex | undefined;
    setWatch(IDLE_WATCH);
    const ok = await flow.run([
      {
        id: 'approve',
        label: approveLabel(approveAmount, account.allowance, tokens, decimals, symbol),
        skip: !plan.needsApprove,
        write: () => write.mutateAsync({ abi: ERC20_ABI, address: token.address, functionName: 'approve', args: [desk, approveAmount], chainId: config.chainId }),
        onConfirmed: () => account.refetch(),
      },
      {
        id: 'burn',
        label: `Burn ${fmtTokens(tokens, decimals, symbol)} for ${fmtUsd(expected)} of credit (floor ${fmtUsd(minUsdMicro)}, −${formatBps(toleranceBps)})`,
        simulate: publicClient === undefined ? undefined : () => publicClient.simulateContract({ account: address, abi: CREDIT_DESK_ABI, address: desk, functionName: 'burnForCreditMin', args: [workspace, tokens, minUsdMicro] }),
        write: async () => {
          burnHash = await write.mutateAsync({ abi: CREDIT_DESK_ABI, address: desk, functionName: 'burnForCreditMin', args: [workspace, tokens, minUsdMicro], chainId: config.chainId });
          return burnHash;
        },
        onConfirmed: () => Promise.all([account.refetch(), client.invalidateQueries({ queryKey: ['receipts'] })]),
      },
    ]);
    if (ok) {
      if (creditsOwnWorkspace) setWatch(startWatch(before, expected, burnHash));
      else toast.push({ kind: 'success', title: 'Burn confirmed', message: 'The credited workspace will see the balance once the indexer processes the event.' });
      setInput('');
    }
  };

  const priceAge = params.priceUpdatedAt === undefined ? undefined : ageSeconds(params.priceUpdatedAt, Date.now());

  return (
    <div className="space-y-6">
      <PageHeader title="Credits" lead={`Burn ${symbol} through the CreditDesk contract. The contract quotes the burn in USD from the on-chain price and the gateway credits your workspace exactly the emitted amount.`} />

      {deskError !== undefined ? <Note tone="err" title="Credit desk unavailable">{deskError}</Note> : null}

      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <Card title="Buy credit">
          {deskLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : (
            <div className="space-y-4">
              <AmountInput
                id="burn-amount"
                label="Amount"
                value={input}
                mode={mode}
                symbol={symbol}
                onChange={setInput}
                onModeChange={(m) => {
                  setMode(m);
                  setInput('');
                }}
                error={input.trim() !== '' && !parsed.ok ? parsed.error : undefined}
                converted={
                  converted === undefined
                    ? priceE18 === undefined
                      ? 'Waiting for the on-chain price…'
                      : undefined
                    : mode === 'usd'
                      ? `≈ ${fmtTokens(converted.tokens, decimals, symbol)} burned`
                      : `≈ ${fmtUsd(converted.usdMicro)} of credit`
                }
                disabled={flow.running}
              />

              <div className="rounded-lg border border-line bg-elevated/50 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-muted">Live quote (desk.quote)</span>
                  {quote.loading ? (
                    <Skeleton className="h-4 w-20" />
                  ) : quote.usdMicro !== undefined && tokens !== undefined ? (
                    <span className="font-mono">
                      {fmtTokens(tokens, decimals, symbol)} → <span className="text-accent">{fmtUsd(quote.usdMicro)}</span>
                    </span>
                  ) : quote.error !== undefined ? (
                    <span className="text-xs text-err">{quote.error}</span>
                  ) : (
                    <span className="font-mono text-faint">—</span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span>
                    1 {symbol} = <span className="font-mono text-fg">{priceE18 === undefined ? '—' : fmtPrice(priceE18)}</span>
                  </span>
                  {priceAge !== undefined ? <span>· price updated {formatDuration(priceAge)} ago</span> : null}
                  {params.maxPriceAge !== undefined ? <span>· max age {formatDuration(params.maxPriceAge)}</span> : null}
                  {priceStale ? <Badge tone="warn">stale</Badge> : null}
                  {params.paused === true ? <Badge tone="err">paused</Badge> : null}
                  {params.minBurn !== undefined && params.minBurn > 0n ? <span>· min burn {fmtTokens(params.minBurn, decimals, symbol)}</span> : null}
                </div>
              </div>

              <div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="label mb-0">Price tolerance</span>
                  <Segmented
                    ariaLabel="Price tolerance"
                    value={String(toleranceBps)}
                    onChange={(v) => setToleranceBps(Number(v))}
                    options={TOLERANCE_CHOICES_BPS.map((bps) => ({ value: String(bps), label: formatBps(bps) }))}
                  />
                </div>
                <p className="mt-1 text-xs text-muted">
                  {TOLERANCE_HELP}
                  {plan.minUsdMicro !== undefined && quote.usdMicro !== undefined && tokens !== undefined ? (
                    <>
                      {' '}
                      Floor for this burn: <span className="font-mono text-fg">{fmtUsd(plan.minUsdMicro)}</span> of credit (quote {fmtUsd(quote.usdMicro)} − {formatBps(toleranceBps)}).
                    </>
                  ) : null}
                </p>
              </div>

              <div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={otherWorkspace} onChange={(e) => setOtherWorkspace(e.target.checked)} disabled={flow.running} />
                  Credit another workspace
                </label>
                {otherWorkspace ? (
                  <div className="mt-2">
                    <Field label="Workspace address" error={workspaceInput.trim() !== '' && workspace === undefined ? 'Not a valid address (check the EIP-55 checksum)' : undefined} htmlFor="burn-workspace">
                      <Input id="burn-workspace" mono placeholder="0x…" value={workspaceInput} onChange={(e) => setWorkspaceInput(e.target.value)} disabled={flow.running} />
                    </Field>
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-muted">
                    Credits go to {workspace === undefined ? 'your workspace' : <AddressText address={workspace} />}
                    {session.walletMismatch && address !== undefined ? (
                      <>
                        {' '}
                        (your signed-in workspace); the tokens are burned from the connected wallet <AddressText address={address} />.
                      </>
                    ) : (
                      '.'
                    )}
                  </p>
                )}
              </div>

              {priceStale ? (
                <Note tone="warn" title="Price is stale">
                  The desk rejects burns while the price is older than its maximum age. Wait for the poster to publish a fresh price.
                </Note>
              ) : null}
              {params.paused === true ? (
                <Note tone="err" title="Credit desk paused">
                  Burns and budgets are disabled by the operator right now.
                </Note>
              ) : null}

              <div className="flex flex-wrap items-center gap-3">
                <Button variant="primary" busy={flow.running} disabled={!plan.canRun} reason={firstBlocker === undefined ? undefined : describeBlocker(firstBlocker, blockerCtx)} onClick={() => void onBurn()}>
                  {plan.needsApprove ? 'Approve → Burn' : 'Burn for credit'}
                </Button>
                {firstBlocker !== undefined ? <span className="text-xs text-muted">{describeBlocker(firstBlocker, blockerCtx)}</span> : plan.needsApprove ? <span className="text-xs text-muted">Two wallet confirmations: approve (your current allowance + this amount), then burn.</span> : <span className="text-xs text-muted">One wallet confirmation: burn.</span>}
                {guard.wrongChain ? (
                  <Button size="sm" busy={guard.switching} onClick={() => void guard.switchToAppChain().catch(() => undefined)}>
                    Switch chain
                  </Button>
                ) : null}
              </div>
              {plan.canRun && !plan.needsApprove ? <p className="text-xs text-muted">{SHARED_ALLOWANCE_NOTE}</p> : null}

              <StepList flow={flow.state} />
              {slippage !== undefined ? (
                <Note
                  tone="warn"
                  title="Price moved before the transaction landed"
                  actions={
                    <Button
                      size="sm"
                      onClick={() => {
                        flow.reset();
                        void quote.refetch();
                      }}
                    >
                      Re-quote
                    </Button>
                  }
                >
                  The desk compared the quote at inclusion time with your floor and refused to burn for less (details on the step above). Re-quote to refresh the price, then burn again or pick a wider tolerance.
                </Note>
              ) : flow.state.status === 'failed' ? (
                <Button size="sm" variant="ghost" onClick={flow.reset}>
                  Dismiss
                </Button>
              ) : null}

              {watch.status === 'watching' ? (
                <Note tone="info" title="Waiting for the indexer to credit the burn…">
                  Polling your credit events and balance every {WATCH_POLL_MS / 1000} s (attempt {watch.attempts + 1}). Indexer lag shows on the landing page.
                </Note>
              ) : watch.status === 'landed' ? (
                <Note tone="ok" title="Credit landed">
                  Balance: <span className="font-mono">{balance.data === undefined ? '—' : fmtUsd(balance.data.balanceMicro)}</span>
                </Note>
              ) : watch.status === 'timeout' ? (
                <Note
                  tone="warn"
                  title="Indexer is lagging"
                  actions={
                    <Button size="sm" onClick={() => setWatch(restartWatch(watch))}>
                      Check again
                    </Button>
                  }
                >
                  The burn is final on chain{watch.txHash === undefined ? '' : <> (<TxLink hash={watch.txHash} />)</>}. The ledger credit appears as soon as the gateway indexes the block.
                </Note>
              ) : null}
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card title="Wallet">
            {!isConnected ? (
              <p className="text-sm text-muted">Connect a wallet to see its {symbol} balance and allowance.</p>
            ) : account.loading ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <Stat label={`${symbol} balance`} value={account.balance === undefined ? '—' : fmtTokens(account.balance, decimals)} />
                <Stat label="Allowance → desk" value={account.allowance === undefined ? '—' : fmtTokens(account.allowance, decimals)} />
              </div>
            )}
            {account.error !== undefined ? <p className="mt-2 text-xs text-err">{account.error}</p> : null}
            <dl className="mt-3 space-y-1 text-xs text-muted">
              <div className="flex justify-between gap-2">
                <dt>Credit desk</dt>
                <dd>{desk === undefined ? '—' : <AddressText address={desk} />}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Token</dt>
                <dd>{token === undefined ? '—' : <AddressText address={token.address} />}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Burn mode</dt>
                <dd className="font-mono">{token === undefined ? '—' : token.nativeBurn ? 'burn()' : 'transfer to 0x…dEaD'}</dd>
              </div>
            </dl>
          </Card>

          <Card title="Workspace balance">
            <QueryGuard query={balance}>
              {(b) => (
                <div className="grid grid-cols-2 gap-3">
                  <Stat label="Available" value={fmtUsd(b.availableMicro)} />
                  <Stat label="Balance" value={fmtUsd(b.balanceMicro)} />
                </div>
              )}
            </QueryGuard>
          </Card>
        </div>
      </div>

      <Card title="Recent credit events">
        <QueryGuard query={events} isEmpty={(d) => d.rows.length === 0} empty={<p className="py-6 text-center text-sm text-muted">No burns or draws indexed for this workspace yet.</p>}>
          {(d) => (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Kind</th>
                    <th>Burned</th>
                    <th>Credited</th>
                    <th>Price</th>
                    <th>Receipt</th>
                    <th>Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((e) => (
                    <tr key={`${e.txHash}:${e.logIndex}`}>
                      <td className="text-muted">{formatUnixSeconds(e.blockTime)}</td>
                      <td>
                        <Badge tone={e.kind === 'purchase' ? 'accent' : 'info'}>{e.kind === 'purchase' ? 'burn' : `draw #${e.budgetId ?? '?'}`}</Badge>
                      </td>
                      <td className="font-mono">{fmtTokens(e.tokenAmount, decimals, symbol)}</td>
                      <td className="font-mono text-accent">{fmtUsd(e.usdMicro)}</td>
                      <td className="font-mono text-muted">{fmtPrice(e.priceE18)}</td>
                      <td className="font-mono text-muted">#{e.receiptId}</td>
                      <td>
                        <TxLink hash={e.txHash} />
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
