/**
 * `/app/credits`: amount in USD or tokens, live on-chain quote, wallet balance/allowance,
 * Approve → Burn with progress + explorer links, then poll `/api/balance` until the credit lands.
 */
import { useEffect, useRef, useState } from 'react';
import { useConnection, useWriteContract } from 'wagmi';
import { getAddress } from 'viem';
import { CREDIT_DESK_ABI, ERC20_ABI } from '@beagle/shared/abi';
import { AmountInput } from '../../components/AmountInput.jsx';
import { AddressText, TxLink } from '../../components/Hash.jsx';
import { QueryGuard } from '../../components/QueryGuard.jsx';
import { StepList } from '../../components/StepList.jsx';
import { Badge, Button, Card, Field, Input, Note, PageHeader, Skeleton, Stat, TableWrap } from '../../components/ui.jsx';
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
import { IDLE_WATCH, observeBalance, startWatch, type WatchState } from '../../lib/poll.js';
import { describeBlocker, planBurn } from '../../lib/steps.js';
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

  const parsed = parseAmount(input, mode, decimals);
  const priceE18 = params.priceE18 ?? apiPrice.data?.priceE18;
  const converted = parsed.ok && priceE18 !== undefined ? convertAmount(mode, parsed.value, priceE18, decimals) : undefined;
  const tokens = converted?.tokens;
  const quote = useQuote(desk, tokens);
  const account = useTokenAccount(token?.address, address, desk);

  const defaultWorkspace = address ?? (me === undefined ? undefined : getAddress(me.workspace));
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
  const [watch, setWatch] = useState<WatchState>(IDLE_WATCH);
  const watchRef = useRef(watch);
  watchRef.current = watch;
  const balance = useBalance(watch.status === 'watching' ? 2000 : undefined);
  const events = useCreditEvents(10);

  useEffect(() => {
    const w = watchRef.current;
    const data = balance.data;
    if (w.status !== 'watching' || data === undefined) return;
    const next = observeBalance(w, data.balanceMicro);
    if (next !== w) setWatch(next);
    if (next.status === 'landed') {
      toast.push({ kind: 'success', title: 'Credit landed', message: `Balance is now ${fmtUsd(data.balanceMicro)}` });
      void invalidateBalances(client);
    } else if (next.status === 'timeout') {
      toast.push({ kind: 'warning', title: 'Still waiting for the indexer', message: 'The burn is confirmed on chain; the ledger will update once the indexer catches up.' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balance.dataUpdatedAt]);

  const onBurn = async () => {
    if (!plan.canRun || tokens === undefined || workspace === undefined || desk === undefined || token === undefined) return;
    const before = balance.data?.balanceMicro ?? me?.balanceMicro ?? 0n;
    const expected = quote.usdMicro;
    setWatch(IDLE_WATCH);
    const ok = await flow.run([
      {
        id: 'approve',
        label: `Approve ${fmtTokens(tokens, decimals, symbol)} for the credit desk`,
        skip: !plan.needsApprove,
        write: () => write.mutateAsync({ abi: ERC20_ABI, address: token.address, functionName: 'approve', args: [desk, tokens], chainId: config.chainId }),
        onConfirmed: () => account.refetch(),
      },
      {
        id: 'burn',
        label: `Burn ${fmtTokens(tokens, decimals, symbol)}${expected === undefined ? '' : ` for ${fmtUsd(expected)}`} of credit`,
        write: () => write.mutateAsync({ abi: CREDIT_DESK_ABI, address: desk, functionName: 'burnForCredit', args: [workspace, tokens], chainId: config.chainId }),
        onConfirmed: () => Promise.all([account.refetch(), client.invalidateQueries({ queryKey: ['receipts'] })]),
      },
    ]);
    if (ok) {
      if (creditsOwnWorkspace) setWatch(startWatch(before, expected));
      else toast.push({ kind: 'success', title: 'Burn confirmed', message: 'The credited workspace will see the balance once the indexer processes the event.' });
      setInput('');
    }
  };

  const priceAge = params.priceUpdatedAt === undefined ? undefined : ageSeconds(params.priceUpdatedAt, Date.now());

  return (
    <div className="space-y-6">
      <PageHeader title="Credits" lead={`Burn ${symbol} through the CreditDesk contract. The contract quotes the burn in USD from the on-chain price and the gateway credits your workspace exactly the emitted amount.`} />

      {deskError !== undefined ? <Note tone="err" title="Contracts not configured">{deskError}</Note> : null}

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
                    Credits go to {workspace === undefined ? 'your workspace' : <AddressText address={workspace} />}.
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
                {firstBlocker !== undefined ? <span className="text-xs text-muted">{describeBlocker(firstBlocker, blockerCtx)}</span> : plan.needsApprove ? <span className="text-xs text-muted">Two wallet confirmations: approve, then burn.</span> : <span className="text-xs text-muted">Allowance is sufficient: one confirmation.</span>}
                {guard.wrongChain ? (
                  <Button size="sm" busy={guard.switching} onClick={() => void guard.switchToAppChain().catch(() => undefined)}>
                    Switch chain
                  </Button>
                ) : null}
              </div>

              <StepList flow={flow.state} />
              {flow.state.status === 'failed' ? (
                <Button size="sm" variant="ghost" onClick={flow.reset}>
                  Dismiss
                </Button>
              ) : null}

              {watch.status === 'watching' ? (
                <Note tone="info" title="Waiting for the indexer to credit the burn…">
                  Polling your balance every 2 s (attempt {watch.attempts + 1}). Indexer lag shows on the landing page.
                </Note>
              ) : watch.status === 'landed' ? (
                <Note tone="ok" title="Credit landed">
                  Balance: <span className="font-mono">{balance.data === undefined ? '—' : fmtUsd(balance.data.balanceMicro)}</span>
                </Note>
              ) : watch.status === 'timeout' ? (
                <Note tone="warn" title="Indexer is lagging">
                  The burn is final on chain. The ledger credit appears as soon as the gateway indexes the block.
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
