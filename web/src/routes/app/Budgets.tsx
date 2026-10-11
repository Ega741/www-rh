/**
 * `/app/budgets`: open a budget (cap in USD/tokens + hours; Approve cap → openBudget), list with
 * cap / drawn / headroom / deadline / stalled reason, draws with tx links, close.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useConnection, useWriteContract } from 'wagmi';
import { getAddress } from 'viem';
import type { BudgetDto } from '@beagle/shared/api';
import { CREDIT_DESK_ABI, ERC20_ABI } from '@beagle/shared/abi';
import { AmountInput } from '../../components/AmountInput.jsx';
import { AddressText, HashText, TxLink } from '../../components/Hash.jsx';
import { QueryGuard } from '../../components/QueryGuard.jsx';
import { StepList } from '../../components/StepList.jsx';
import { Badge, Button, Card, Field, Input, Note, PageHeader, Skeleton, TableWrap } from '../../components/ui.jsx';
import { config } from '../../config.js';
import { useChainGuard } from '../../hooks/useChainGuard.js';
import { useDesk } from '../../hooks/useDesk.js';
import { useDeskParams } from '../../hooks/useQuote.js';
import { useSession } from '../../hooks/useSession.jsx';
import { useToast } from '../../hooks/useToast.jsx';
import { useTokenAccount } from '../../hooks/useTokenAccount.js';
import { useTxFlow } from '../../hooks/useTxFlow.js';
import { convertAmount, fmtTokens, fmtUsd, parseAmount, type AmountMode } from '../../lib/amounts.js';
import { sameAddress } from '../../lib/explorer.js';
import { MAX_BUDGET_HOURS, budgetDeadline, describeBlocker, planBudget } from '../../lib/steps.js';
import { formatDateTime, formatDuration, formatUnixSeconds, secondsUntil } from '../../lib/time.js';
import { parseHours } from '../../lib/validate.js';
import { qk, useBudgets, usePrice } from '../../queries.js';

const STALLED_TEXT: Record<'price' | 'allowance' | 'draw_failed', string> = {
  price: 'price stale or unavailable',
  allowance: 'allowance or balance exhausted',
  draw_failed: 'last draw failed',
};

function budgetState(b: BudgetDto, nowMs: number): { label: string; tone: 'ok' | 'warn' | 'err' | 'neutral' } {
  if (b.closed) return { label: 'closed', tone: 'neutral' };
  if (secondsUntil(b.deadline, nowMs) <= 0) return { label: 'expired', tone: 'neutral' };
  if (b.stalledReason !== null) return { label: `stalled: ${STALLED_TEXT[b.stalledReason]}`, tone: 'warn' };
  if (b.remainingCap === 0n) return { label: 'cap reached', tone: 'neutral' };
  return { label: 'open', tone: 'ok' };
}

/** Budgets page. */
export function Budgets() {
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
  const account = useTokenAccount(token?.address, address, desk);
  const budgets = useBudgets();
  const nowMs = Date.now();

  const [mode, setMode] = useState<AmountMode>('usd');
  const [capInput, setCapInput] = useState('');
  const [hoursInput, setHoursInput] = useState('24');
  const [expanded, setExpanded] = useState<number | undefined>(undefined);

  const parsedCap = parseAmount(capInput, mode, decimals);
  const priceE18 = params.priceE18 ?? apiPrice.data?.priceE18;
  const converted = parsedCap.ok && priceE18 !== undefined ? convertAmount(mode, parsedCap.value, priceE18, decimals) : undefined;
  const cap = converted?.tokens;
  const hours = parseHours(hoursInput, MAX_BUDGET_HOURS);
  const workspace = address ?? (me === undefined ? undefined : getAddress(me.workspace));

  const plan = planBudget({
    connected: isConnected,
    rightChain: !guard.wrongChain,
    deskKnown: desk !== undefined && token !== undefined,
    paused: params.paused,
    workspaceValid: workspace !== undefined,
    cap,
    hours: hours.ok ? hours.hours : undefined,
    balance: account.balance,
    allowance: account.allowance,
  });
  const firstBlocker = plan.blockers[0];
  const blockerCtx = { chainName: config.chain.name, maxHours: MAX_BUDGET_HOURS };

  const flow = useTxFlow();
  const closeFlow = useTxFlow();
  const write = useWriteContract();

  const onOpen = async () => {
    if (!plan.canRun || cap === undefined || !hours.ok || workspace === undefined || desk === undefined || token === undefined) return;
    const deadline = budgetDeadline(Date.now(), hours.hours);
    const ok = await flow.run([
      {
        id: 'approve',
        label: `Approve ${fmtTokens(cap, decimals, symbol)} for the credit desk`,
        skip: !plan.needsApprove,
        write: () => write.mutateAsync({ abi: ERC20_ABI, address: token.address, functionName: 'approve', args: [desk, cap], chainId: config.chainId }),
        onConfirmed: () => account.refetch(),
      },
      {
        id: 'open',
        label: `Open a ${fmtTokens(cap, decimals, symbol)} budget for ${formatDuration(hours.hours * 3600)}`,
        write: () => write.mutateAsync({ abi: CREDIT_DESK_ABI, address: desk, functionName: 'openBudget', args: [workspace, cap, deadline], chainId: config.chainId }),
        onConfirmed: () => client.invalidateQueries({ queryKey: qk.budgets }),
      },
    ]);
    if (ok) {
      toast.push({ kind: 'success', title: 'Budget opened', message: 'It appears below once the indexer sees BudgetOpened; headroom follows on the next refresh.' });
      setCapInput('');
    }
  };

  const onClose = async (b: BudgetDto) => {
    if (desk === undefined) return;
    const ok = await closeFlow.run([
      {
        id: `close-${b.budgetId}`,
        label: `Close budget #${b.budgetId}`,
        write: () => write.mutateAsync({ abi: CREDIT_DESK_ABI, address: desk, functionName: 'closeBudget', args: [BigInt(b.budgetId)], chainId: config.chainId }),
        onConfirmed: () => client.invalidateQueries({ queryKey: qk.budgets }),
      },
    ]);
    if (ok) toast.push({ kind: 'success', title: `Budget #${b.budgetId} closed` });
  };

  const canClose = (b: BudgetDto): boolean => !b.closed && isConnected && !guard.wrongChain && (sameAddress(b.owner, address) || secondsUntil(b.deadline, nowMs) <= 0);

  return (
    <div className="space-y-6">
      <PageHeader title="Budgets" lead={`A budget authorises the operator to burn up to a cap of ${symbol} from your wallet as usage accrues, until a deadline (≤ 30 days). You approve the cap; the desk draws only what your requests cost, never above the cap, and each draw carries a receipt hash of the usage it settles.`} />

      {deskError !== undefined ? <Note tone="err" title="Contracts not configured">{deskError}</Note> : null}

      <Card title="Open a budget">
        {deskLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <div className="space-y-4">
            <div className="grid gap-4 md:grid-cols-[1.4fr_1fr]">
              <AmountInput
                id="budget-cap"
                label="Cap"
                value={capInput}
                mode={mode}
                symbol={symbol}
                onChange={setCapInput}
                onModeChange={(m) => {
                  setMode(m);
                  setCapInput('');
                }}
                error={capInput.trim() !== '' && !parsedCap.ok ? parsedCap.error : undefined}
                converted={converted === undefined ? (priceE18 === undefined ? 'Waiting for the on-chain price…' : undefined) : mode === 'usd' ? `≈ ${fmtTokens(converted.tokens, decimals, symbol)} cap at today's price` : `≈ ${fmtUsd(converted.usdMicro)} at today's price`}
                disabled={flow.running}
              />
              <Field label="Duration (hours)" error={hoursInput.trim() !== '' && !hours.ok ? hours.error : undefined} hint={`1–${MAX_BUDGET_HOURS} h · deadline ${hours.ok ? formatDateTime(nowMs + hours.hours * 3600_000) : '—'}`} htmlFor="budget-hours">
                <Input id="budget-hours" mono inputMode="numeric" value={hoursInput} onChange={(e) => setHoursInput(e.target.value)} disabled={flow.running} />
              </Field>
            </div>
            <p className="text-xs text-muted">
              Wallet: {account.balance === undefined ? '—' : fmtTokens(account.balance, decimals, symbol)} · allowance → desk {account.allowance === undefined ? '—' : fmtTokens(account.allowance, decimals, symbol)}. Draws are quoted at the price of the moment they happen; the cap is in tokens.
            </p>
            {params.paused === true ? (
              <Note tone="err" title="Credit desk paused">
                Opening budgets is disabled while paused (closing still works).
              </Note>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" busy={flow.running} disabled={!plan.canRun} reason={firstBlocker === undefined ? undefined : describeBlocker(firstBlocker, blockerCtx)} onClick={() => void onOpen()}>
                {plan.needsApprove ? 'Approve cap → Open budget' : 'Open budget'}
              </Button>
              {firstBlocker !== undefined ? <span className="text-xs text-muted">{describeBlocker(firstBlocker, blockerCtx)}</span> : null}
              {guard.wrongChain ? (
                <Button size="sm" busy={guard.switching} onClick={() => void guard.switchToAppChain().catch(() => undefined)}>
                  Switch chain
                </Button>
              ) : null}
            </div>
            <StepList flow={flow.state} />
            {flow.state.status === 'failed' || flow.state.status === 'done' ? (
              <Button size="sm" variant="ghost" onClick={flow.reset}>
                Dismiss
              </Button>
            ) : null}
          </div>
        )}
      </Card>

      <Card title="Your budgets">
        <StepList flow={closeFlow.state} />
        <QueryGuard query={budgets} isEmpty={(d) => d.length === 0} empty={<p className="py-6 text-center text-sm text-muted">No budgets yet. Agents can also open them through the MCP server.</p>}>
          {(list) => (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>State</th>
                    <th>Cap</th>
                    <th>Drawn</th>
                    <th>Headroom</th>
                    <th>Deadline</th>
                    <th>Owner</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {[...list]
                    .sort((a, b) => b.budgetId - a.budgetId)
                    .map((b) => {
                      const st = budgetState(b, nowMs);
                      const left = secondsUntil(b.deadline, nowMs);
                      const isOpen = expanded === b.budgetId;
                      return (
                        <BudgetRows key={b.budgetId} b={b} st={st} left={left} isOpen={isOpen} toggle={() => setExpanded(isOpen ? undefined : b.budgetId)} decimals={decimals} symbol={symbol} canClose={canClose(b)} closing={closeFlow.running} onClose={() => void onClose(b)} />
                      );
                    })}
                </tbody>
              </table>
            </TableWrap>
          )}
        </QueryGuard>
      </Card>
    </div>
  );
}

function BudgetRows({ b, st, left, isOpen, toggle, decimals, symbol, canClose, closing, onClose }: { b: BudgetDto; st: { label: string; tone: 'ok' | 'warn' | 'err' | 'neutral' }; left: number; isOpen: boolean; toggle(): void; decimals: number; symbol: string; canClose: boolean; closing: boolean; onClose(): void }) {
  return (
    <>
      <tr>
        <td className="font-mono">{b.budgetId}</td>
        <td>
          <Badge tone={st.tone}>{st.label}</Badge>
        </td>
        <td className="font-mono">{fmtTokens(b.cap, decimals, symbol)}</td>
        <td className="font-mono">
          {fmtTokens(b.drawn, decimals)}
          <span className="text-faint"> · {fmtTokens(b.remainingCap, decimals)} left</span>
        </td>
        <td className="font-mono">
          {fmtTokens(b.headroomTokens, decimals)} <span className="text-accent">({fmtUsd(b.headroomMicro)})</span>
        </td>
        <td className="text-muted" title={formatUnixSeconds(b.deadline)}>
          {left > 0 ? `in ${formatDuration(left)}` : formatUnixSeconds(b.deadline)}
        </td>
        <td>
          <AddressText address={b.owner} />
        </td>
        <td className="text-right">
          <span className="inline-flex gap-1">
            <Button size="sm" variant="ghost" onClick={toggle} aria-expanded={isOpen}>
              {b.draws.length} draw{b.draws.length === 1 ? '' : 's'} {isOpen ? '▴' : '▾'}
            </Button>
            {canClose ? (
              <Button size="sm" variant="danger" busy={closing} onClick={onClose}>
                Close
              </Button>
            ) : null}
          </span>
        </td>
      </tr>
      {isOpen ? (
        <tr>
          <td colSpan={8} className="bg-elevated/40">
            {b.draws.length === 0 ? (
              <p className="py-2 text-xs text-muted">No draws yet. The operator draws when your deficit reaches the threshold or the budget nears its deadline.</p>
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Status</th>
                    <th>Tokens</th>
                    <th>Settled</th>
                    <th>Usage rows</th>
                    <th>Receipt hash</th>
                    <th>Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {b.draws.map((d) => (
                    <tr key={d.id}>
                      <td className="text-muted">{formatDateTime(d.createdAt)}</td>
                      <td>
                        <Badge tone={d.status === 'confirmed' ? 'ok' : d.status === 'failed' ? 'err' : 'warn'} title={d.error ?? undefined}>
                          {d.status}
                        </Badge>
                      </td>
                      <td className="font-mono">{fmtTokens(d.tokenAmount, decimals, symbol)}</td>
                      <td className="font-mono">{fmtUsd(d.usdMicro)}</td>
                      <td className="font-mono text-muted">{d.usageIds.length}</td>
                      <td>
                        <HashText hash={d.receiptHash} />
                      </td>
                      <td>{d.txHash === null ? <span className="text-faint">—</span> : <TxLink hash={d.txHash} />}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}
