/**
 * `/app/credits`: amount in USD or tokens, live conversion at the published price (`/api/price`,
 * refreshed every 15 s, disabled while stale), wallet token balance (the ATA, with a "no token
 * account" state), one wallet confirmation (`BurnChecked` + optional memo naming another
 * workspace), confirmation by blockhash / last valid block height, then polling `/api/receipts`
 * and `/api/balance` until the indexer credits the burn (SPEC §3.2, §7). The credit goes to the
 * signed-in workspace by default, even when the connected wallet that burns is another account.
 */
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useWallet } from '@solana/wallet-adapter-react';
import { AmountInput } from '../../components/AmountInput.jsx';
import { AddressText, TxLink } from '../../components/Hash.jsx';
import { QueryGuard } from '../../components/QueryGuard.jsx';
import { StepList } from '../../components/StepList.jsx';
import { Badge, Button, Card, Field, Input, Note, PageHeader, Skeleton, Stat, TableWrap } from '../../components/ui.jsx';
import { useDeployment } from '../../hooks/useDeployment.js';
import { useSession } from '../../hooks/useSession.jsx';
import { useToast } from '../../hooks/useToast.jsx';
import { useInvalidateTokenAccounts, useTokenAccount } from '../../hooks/useTokenAccount.js';
import { useTxFlow } from '../../hooks/useTxFlow.js';
import { convertAmount, fmtPrice, fmtTokens, fmtUsd, parseAmount, type AmountMode } from '../../lib/amounts.js';
import { sameAddress, shortAddress } from '../../lib/explorer.js';
import { IDLE_WATCH, WATCH_POLL_MS, observeBalance, observeEvents, restartWatch, startWatch, type WatchState } from '../../lib/poll.js';
import { defaultTargetWorkspace } from '../../lib/session.js';
import { describeBlocker, minCreditTokens, planBurn } from '../../lib/steps.js';
import { ageSeconds, formatDuration, formatUnixSeconds } from '../../lib/time.js';
import { buildPurchaseInstructions, purchaseMemoFor } from '../../lib/tx.js';
import { parseAddressInput } from '../../lib/validate.js';
import { invalidateBalances, useBalance, useCreditEvents, usePrice } from '../../queries.js';

/** The sentence every client shows (SPEC §3.2). */
const OBSERVED_SENTENCE = 'Credit is computed from the published price when the gateway observes the burn.';

/** Credits page. */
export function Credits() {
  const session = useSession();
  const me = session.me;
  const { publicKey, connected } = useWallet();
  const address = publicKey?.toBase58();
  const toast = useToast();
  const client = useQueryClient();
  const dep = useDeployment();
  const { mint, decimals, symbol, tokenProgram, memoProgram, minCreditMicro } = dep;
  const apiPrice = usePrice();
  const price = apiPrice.data;
  const priceE18 = price === undefined || price.priceE18 <= 0n ? undefined : price.priceE18;
  const priceStale = price?.stale === true;
  const priceAvailable = priceE18 !== undefined;

  const [mode, setMode] = useState<AmountMode>('usd');
  const [input, setInput] = useState('');
  const [otherWorkspace, setOtherWorkspace] = useState(false);
  const [workspaceInput, setWorkspaceInput] = useState('');

  const parsed = parseAmount(input, mode, decimals);
  const converted = parsed.ok && priceE18 !== undefined ? convertAmount(mode, parsed.value, priceE18, decimals) : undefined;
  const tokens = converted?.tokens;
  const usdMicro = converted?.usdMicro;
  const account = useTokenAccount(mint, address, tokenProgram);
  const invalidateTokenAccounts = useInvalidateTokenAccounts();

  const defaultWorkspace = defaultTargetWorkspace(me?.workspace, address);
  const workspace = otherWorkspace ? parseAddressInput(workspaceInput) : defaultWorkspace;
  const creditsOwnWorkspace = workspace !== undefined && me !== undefined && sameAddress(workspace, me.workspace);
  const memo = address !== undefined && workspace !== undefined ? purchaseMemoFor(address, workspace) : undefined;

  const plan = planBurn({
    connected,
    deploymentKnown: mint !== undefined,
    configMismatch: dep.mismatch !== undefined,
    workspaceValid: workspace !== undefined,
    accountKnown: account.settled,
    hasTokenAccount: account.account?.exists === true,
    balance: account.balance,
    amount: tokens,
    usdMicro,
    priceAvailable,
    priceStale,
    minCreditMicro,
  });
  const minTokens = minCreditMicro === undefined ? undefined : minCreditTokens(minCreditMicro, priceE18, decimals);
  const minCreditText = minCreditMicro === undefined ? undefined : `${fmtUsd(minCreditMicro, { maxFractionDigits: 6 })}${minTokens === undefined ? '' : ` ≈ ${fmtTokens(minTokens, decimals, symbol, 6)}`}`;
  const blockerCtx = { symbol, minCreditText };
  const firstBlocker = plan.blockers[0];

  const flow = useTxFlow();
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
      toast.push({ kind: 'warning', title: 'Still waiting for the indexer', message: 'The burn is confirmed on chain; the ledger will update once the indexer observes it.' });
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
    const tokenAccount = account.address;
    if (!plan.canRun || tokens === undefined || usdMicro === undefined || workspace === undefined || mint === undefined || address === undefined || tokenAccount === undefined) return;
    const expected = usdMicro;
    const before = balance.data?.balanceMicro ?? me?.balanceMicro ?? 0n;
    setWatch(IDLE_WATCH);
    const signature = await flow.run([
      {
        id: 'burn',
        label: `Burn ${fmtTokens(tokens, decimals, symbol)} ≈ ${fmtUsd(expected)} of credit${memo === undefined ? '' : ` for ${shortAddress(workspace)} (memo)`}`,
        instructions: () => buildPurchaseInstructions({ tokenAccount, mint, owner: address, amount: tokens, decimals, tokenProgram, memoProgram, workspace }),
        onConfirmed: () => Promise.all([invalidateTokenAccounts(), client.invalidateQueries({ queryKey: ['receipts'] })]),
      },
    ]);
    if (signature !== undefined) {
      if (creditsOwnWorkspace) setWatch(startWatch(before, expected, signature));
      else toast.push({ kind: 'success', title: 'Burn confirmed', message: 'The credited workspace will see the balance once the indexer observes the burn.' });
      setInput('');
    }
  };

  const priceAge = price === undefined ? undefined : ageSeconds(price.observedAt, Date.now());

  return (
    <div className="space-y-6">
      <PageHeader title="Credits" lead={`Burn ${symbol} from your Solana wallet with a plain SPL burn: no custom program, no approval. The gateway indexes the burn and credits your workspace at its published price. A burn is final.`} />

      {dep.error !== undefined ? <Note tone="err" title="Deployment unavailable">{dep.error}</Note> : null}

      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <Card title="Buy credit">
          {dep.loading ? (
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
                    ? apiPrice.isPending
                      ? 'Waiting for the published price…'
                      : priceE18 === undefined
                        ? 'Token price is unavailable'
                        : undefined
                    : mode === 'usd'
                      ? `≈ ${fmtTokens(converted.tokens, decimals, symbol)} burned`
                      : `≈ ${fmtUsd(converted.usdMicro)} of credit`
                }
                disabled={flow.running}
              />

              <div className="rounded-lg border border-line bg-elevated/50 px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-muted">Published price</span>
                  {apiPrice.isPending ? (
                    <Skeleton className="h-4 w-20" />
                  ) : price !== undefined ? (
                    <span className="font-mono">
                      1 {symbol} = <span className="text-accent">{fmtPrice(price.priceE18)}</span>
                    </span>
                  ) : (
                    <span className="text-xs text-err">unavailable</span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                  {price !== undefined ? (
                    <>
                      <span>point #{price.pricePointId}</span>
                      <span>· {price.source}</span>
                      {priceAge !== undefined ? <span>· observed {formatDuration(priceAge)} ago</span> : null}
                      <span>· max age {formatDuration(price.maxAgeS)}</span>
                      {priceStale ? <Badge tone="warn">stale</Badge> : <Badge tone="ok">fresh</Badge>}
                    </>
                  ) : null}
                  {minCreditText !== undefined ? <span>· minimum {minCreditText}</span> : null}
                </div>
                <p className="mt-1 text-xs text-muted">{OBSERVED_SENTENCE} The event records the price point it was priced with; the figures above are what applies if the point does not change before then.</p>
              </div>

              <div>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={otherWorkspace} onChange={(e) => setOtherWorkspace(e.target.checked)} disabled={flow.running} />
                  Credit another workspace
                </label>
                {otherWorkspace ? (
                  <div className="mt-2">
                    <Field label="Workspace public key" error={workspaceInput.trim() !== '' && workspace === undefined ? 'Not a valid Solana public key (base58, 32 bytes)' : undefined} hint={memo === undefined ? undefined : <span className="font-mono">memo: {memo}</span>} htmlFor="burn-workspace">
                      <Input id="burn-workspace" mono placeholder="base58 public key" value={workspaceInput} onChange={(e) => setWorkspaceInput(e.target.value)} disabled={flow.running} />
                    </Field>
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-muted">
                    Credits go to {workspace === undefined ? 'your workspace' : <AddressText address={workspace} />}
                    {session.walletMismatch && address !== undefined ? (
                      <>
                        {' '}
                        (your signed-in workspace, named in the burn's memo); the tokens are burned from the connected wallet <AddressText address={address} />.
                      </>
                    ) : (
                      '.'
                    )}
                  </p>
                )}
              </div>

              {priceStale ? (
                <Note tone="warn" title="Price is stale">
                  The gateway has not published a fresh price point for longer than its maximum age ({price === undefined ? '—' : formatDuration(price.maxAgeS)}). Burning is disabled here until a new point lands; a burn sent anyway would be credited at the last point and flagged.
                </Note>
              ) : null}

              <div className="flex flex-wrap items-center gap-3">
                <Button variant="primary" busy={flow.running} disabled={!plan.canRun} reason={firstBlocker === undefined ? undefined : describeBlocker(firstBlocker, blockerCtx)} onClick={() => void onBurn()}>
                  Burn for credit
                </Button>
                {firstBlocker !== undefined ? <span className="text-xs text-muted">{describeBlocker(firstBlocker, blockerCtx)}</span> : <span className="text-xs text-muted">One wallet confirmation: burn{memo === undefined ? '' : ' + memo'}.</span>}
              </div>

              <StepList flow={flow.state} />
              {flow.state.status === 'failed' || flow.state.status === 'done' ? (
                <Button size="sm" variant="ghost" onClick={flow.reset}>
                  Dismiss
                </Button>
              ) : null}

              {watch.status === 'watching' ? (
                <Note tone="info" title="Waiting for the indexer to credit the burn…">
                  Polling your credit events and balance every {WATCH_POLL_MS / 1000} s (attempt {watch.attempts + 1}). The indexer usually observes a burn within 2–10 s; its lag shows on the landing page.
                </Note>
              ) : watch.status === 'landed' ? (
                <Note tone="ok" title="Credit landed">
                  Balance: <span className="font-mono">{balance.data === undefined ? '—' : fmtUsd(balance.data.balanceMicro)}</span>
                  {watch.signature !== undefined ? (
                    <>
                      {' · '}
                      <TxLink signature={watch.signature} />
                    </>
                  ) : null}
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
                  The burn is final on chain{watch.signature === undefined ? '' : <> (<TxLink signature={watch.signature} />)</>}. The ledger credit appears as soon as the gateway observes the transaction.
                </Note>
              ) : null}
            </div>
          )}
        </Card>

        <div className="space-y-4">
          <Card title="Wallet">
            {!connected || address === undefined ? (
              <p className="text-sm text-muted">Connect a wallet to see its {symbol} balance.</p>
            ) : account.loading ? (
              <Skeleton className="h-10 w-full" />
            ) : account.account !== undefined && !account.account.exists ? (
              <Note tone="info" title={`No ${symbol} token account`}>
                This wallet never received {symbol}: its associated token account does not exist yet. Acquire {symbol} first; the account is created when tokens arrive.
              </Note>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <Stat label={`${symbol} balance`} value={account.balance === undefined ? '—' : fmtTokens(account.balance, decimals)} />
                <Stat label="Delegated to operator" value={account.account === undefined ? '—' : account.account.delegate !== null && sameAddress(account.account.delegate, dep.operator) ? fmtTokens(account.account.delegatedAmount, decimals) : '0'} sub="budget cap, see Budgets" />
              </div>
            )}
            {account.error !== undefined ? <p className="mt-2 text-xs text-err">{account.error}</p> : null}
            <dl className="mt-3 space-y-1 text-xs text-muted">
              <div className="flex justify-between gap-2">
                <dt>Mint</dt>
                <dd>{mint === undefined ? '—' : <AddressText address={mint} />}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Token account</dt>
                <dd>{account.address === undefined ? '—' : <AddressText address={account.address} />}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>Token program</dt>
                <dd className="font-mono">{tokenProgram.startsWith('Tokenz') ? 'Token-2022' : 'Token'}</dd>
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
                    <th>Price point</th>
                    <th>Slot</th>
                    <th>Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((e) => (
                    <tr key={`${e.signature}:${e.ixIndex}`}>
                      <td className="text-muted">{e.blockTime === null ? '—' : formatUnixSeconds(e.blockTime)}</td>
                      <td>
                        <Badge tone={e.kind === 'purchase' ? 'accent' : 'info'} title={e.memo ?? undefined}>
                          {e.kind === 'purchase' ? 'burn' : 'draw'}
                        </Badge>
                      </td>
                      <td className="font-mono">{fmtTokens(e.tokenAmount, decimals, symbol)}</td>
                      <td className="font-mono text-accent">{fmtUsd(e.usdMicro)}</td>
                      <td className="font-mono text-muted">
                        {fmtPrice(e.priceE18)}
                        {e.pricePointId === null ? '' : ` #${e.pricePointId}`}
                        {e.priceStale ? (
                          <>
                            {' '}
                            <Badge tone="warn">stale</Badge>
                          </>
                        ) : null}
                      </td>
                      <td className="font-mono text-muted">{e.slot}</td>
                      <td>
                        <TxLink signature={e.signature} href={e.explorerUrl} />
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
