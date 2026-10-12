/**
 * `/app/budgets`: open a budget (cap in USD/tokens; `ApproveChecked(ata, operator, cap)` in one
 * wallet confirmation, then `POST /api/budgets/register`), list with cap / balance / headroom /
 * stalled reason, draws with explorer links, close (`Revoke`). A budget is an SPL delegation
 * (SPEC §3.4): one delegate per account, a new approval replaces the previous cap, the operator
 * can only burn from the account, never transfer. A budget funds the workspace of the wallet that
 * delegates: the gateway lets only the token account owner name another workspace to fund
 * (`POST /api/budgets/register` → 403 `not_owner` otherwise), so the page registers the account
 * for its owner and refuses to approve while the connected wallet differs from the signed-in
 * workspace (the approval would otherwise be confirmed on chain before the registration fails).
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useWallet } from '@solana/wallet-adapter-react';
import type { BudgetDto } from '@beagle/shared/api';
import { AmountInput } from '../../components/AmountInput.jsx';
import { AddressText, HashText, TxLink } from '../../components/Hash.jsx';
import { QueryGuard } from '../../components/QueryGuard.jsx';
import { StepList } from '../../components/StepList.jsx';
import { Badge, Button, Card, Note, PageHeader, Skeleton, TableWrap } from '../../components/ui.jsx';
import { useDeployment } from '../../hooks/useDeployment.js';
import { useSession } from '../../hooks/useSession.jsx';
import { useToast } from '../../hooks/useToast.jsx';
import { useInvalidateTokenAccounts, useTokenAccount } from '../../hooks/useTokenAccount.js';
import { useTxFlow } from '../../hooks/useTxFlow.js';
import { convertAmount, fmtTokens, fmtUsd, parseAmount, type AmountMode } from '../../lib/amounts.js';
import { describeError } from '../../lib/errors.js';
import { sameAddress, shortAddress } from '../../lib/explorer.js';
import { defaultTargetWorkspace } from '../../lib/session.js';
import { budgetState, describeBlocker, planBudget, replacesCapNote, type BudgetTone } from '../../lib/steps.js';
import { formatDateTime } from '../../lib/time.js';
import { buildApproveInstructions, buildRevokeInstructions } from '../../lib/tx.js';
import { qk, useBudgets, usePrice, useRegisterBudget } from '../../queries.js';

/** Budgets page. */
export function Budgets() {
  const session = useSession();
  const me = session.me;
  const { publicKey, connected } = useWallet();
  const address = publicKey?.toBase58();
  const toast = useToast();
  const client = useQueryClient();
  const dep = useDeployment();
  const { mint, decimals, symbol, tokenProgram, operator } = dep;
  const apiPrice = usePrice();
  const priceE18 = apiPrice.data === undefined || apiPrice.data.priceE18 <= 0n ? undefined : apiPrice.data.priceE18;
  const account = useTokenAccount(mint, address, tokenProgram);
  const invalidateTokenAccounts = useInvalidateTokenAccounts();
  const budgets = useBudgets();
  const register = useRegisterBudget();

  const [mode, setMode] = useState<AmountMode>('usd');
  const [capInput, setCapInput] = useState('');
  const [expanded, setExpanded] = useState<string | undefined>(undefined);

  const parsedCap = parseAmount(capInput, mode, decimals);
  const converted = parsedCap.ok && priceE18 !== undefined ? convertAmount(mode, parsedCap.value, priceE18, decimals) : undefined;
  const cap = converted?.tokens;
  const workspace = defaultTargetWorkspace(me?.workspace, address);
  const walletMismatch = session.walletMismatch && address !== undefined;

  const accountError = account.account === undefined ? account.error : undefined;
  const plan = planBudget({
    connected,
    deploymentKnown: mint !== undefined,
    gatewayConfig: dep.gatewayConfig,
    configMismatch: dep.mismatch !== undefined,
    workspaceValid: workspace !== undefined,
    walletMismatch,
    priceAvailable: priceE18 !== undefined,
    accountKnown: account.settled,
    hasTokenAccount: account.account?.exists === true,
    accountError,
    balance: account.balance,
    cap,
    operatorKnown: operator !== undefined,
  });
  const firstBlocker = plan.blockers[0];
  const blockerCtx = { symbol, accountError };
  const delegatedToOperator = account.account !== undefined && account.account.delegate !== null && sameAddress(account.account.delegate, operator);
  const existingCap = delegatedToOperator && account.account !== undefined ? account.account.delegatedAmount : 0n;
  const replaceNote = replacesCapNote(existingCap, fmtTokens(existingCap, decimals, symbol));
  // A delegation of another wallet is not this workspace's to register (see the module comment).
  const unregistered = !walletMismatch && delegatedToOperator && existingCap > 0n && account.address !== undefined && budgets.data !== undefined && !budgets.data.some((b) => b.tokenAccount === account.address);

  const flow = useTxFlow();
  const closeFlow = useTxFlow();

  /** Registers the account for its owner's workspace; the gateway reads the owner from the chain. */
  const registerAccount = async (tokenAccount: string): Promise<boolean> => {
    try {
      await register.mutateAsync({ tokenAccount });
      return true;
    } catch (e) {
      toast.push({ kind: 'warning', title: 'Registration failed', message: `${describeError(e)} The gateway's scanner also discovers delegations on its own; "Register" below retries.` });
      return false;
    }
  };

  const onOpen = async () => {
    const tokenAccount = account.address;
    if (!plan.canRun || cap === undefined || mint === undefined || operator === undefined || address === undefined || tokenAccount === undefined) return;
    const signature = await flow.run([
      {
        id: 'approve',
        label: `Delegate ${fmtTokens(cap, decimals, symbol)} of ${shortAddress(tokenAccount)} to the operator ${shortAddress(operator)}`,
        instructions: () => buildApproveInstructions({ tokenAccount, mint, delegate: operator, owner: address, cap, decimals, tokenProgram }),
        onConfirmed: () => invalidateTokenAccounts(),
      },
    ]);
    if (signature !== undefined) {
      const ok = await registerAccount(tokenAccount);
      if (ok) toast.push({ kind: 'success', title: 'Budget opened', message: 'Registered with the gateway; headroom follows on the next refresh.' });
      setCapInput('');
    }
  };

  const onClose = async (b: BudgetDto) => {
    if (address === undefined) return;
    const signature = await closeFlow.run([
      {
        id: `revoke-${b.tokenAccount}`,
        label: `Revoke the delegation of ${shortAddress(b.tokenAccount)}`,
        instructions: () => buildRevokeInstructions({ tokenAccount: b.tokenAccount, owner: address, tokenProgram }),
        onConfirmed: () => Promise.all([invalidateTokenAccounts(), client.invalidateQueries({ queryKey: qk.budgets })]),
      },
    ]);
    if (signature !== undefined) toast.push({ kind: 'success', title: 'Budget closed', message: 'The delegation is revoked; the gateway marks the budget closed on its next scan.' });
  };

  const canClose = (b: BudgetDto): boolean => !b.closed && connected && sameAddress(b.owner, address);

  return (
    <div className="space-y-6">
      <PageHeader title="Budgets" lead={`A budget is an SPL delegation: you approve the operator to burn up to a cap of ${symbol} from your token account as usage accrues. It lives until revoked or exhausted. The operator can only burn, never transfer, and each draw carries a receipt hash of the usage it settles.`} />

      {dep.error !== undefined ? <Note tone="err" title="Deployment unavailable">{dep.error}</Note> : null}
      {dep.error === undefined && !dep.loading && operator === undefined ? (
        <Note tone="warn" title="Budgets are unavailable">
          The gateway has no operator wallet (draws are disabled), so there is nobody to delegate to.
        </Note>
      ) : null}

      <Card title="Open a budget">
        {dep.loading ? (
          <Skeleton className="h-10 w-full" />
        ) : (
          <div className="space-y-4">
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
              converted={converted === undefined ? (priceE18 === undefined ? (apiPrice.isPending ? 'Waiting for the published price…' : 'Token price is unavailable') : undefined) : mode === 'usd' ? `≈ ${fmtTokens(converted.tokens, decimals, symbol)} cap at today's price` : `≈ ${fmtUsd(converted.usdMicro)} at today's price`}
              disabled={flow.running}
            />
            <p className="text-xs text-muted">
              Budget for {workspace === undefined ? 'your workspace' : <AddressText address={workspace} />}
              {walletMismatch && address !== undefined ? (
                <>
                  {' '}
                  (your signed-in workspace). The connected wallet <AddressText address={address} /> is another account: a budget funds the workspace of the wallet that delegates, so sign in with that wallet to open one here
                </>
              ) : null}
              . Wallet: {account.balance === undefined ? '—' : fmtTokens(account.balance, decimals, symbol)}
              {account.account !== undefined && !account.account.exists ? ` (no ${symbol} token account)` : ''} · delegated to the operator: {fmtTokens(existingCap, decimals, symbol)}. Draws are quoted at the published price of the moment they happen; the cap is in tokens and headroom is min(cap, balance).
            </p>
            {replaceNote !== undefined ? <Note tone="info" title="A new approval replaces the current cap">{replaceNote}</Note> : null}
            {plan.capAboveBalance ? (
              <Note tone="info" title="Cap above the wallet balance">
                Allowed: the operator can only ever burn what the account holds, so the headroom is the balance until you top up.
              </Note>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <Button variant="primary" busy={flow.running} disabled={!plan.canRun} reason={firstBlocker === undefined ? undefined : describeBlocker(firstBlocker, blockerCtx)} onClick={() => void onOpen()}>
                {existingCap > 0n ? 'Replace cap' : 'Open budget'}
              </Button>
              {firstBlocker !== undefined ? <span className="text-xs text-muted">{describeBlocker(firstBlocker, blockerCtx)}</span> : <span className="text-xs text-muted">One wallet confirmation: approve. The page then registers the token account with the gateway.</span>}
              {unregistered ? (
                <Button size="sm" busy={register.isPending} onClick={() => void registerAccount(account.address as string).then((ok) => ok && toast.push({ kind: 'success', title: 'Budget registered' }))}>
                  Register existing delegation
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
        <QueryGuard query={budgets} isEmpty={(d) => d.length === 0} empty={<p className="py-6 text-center text-sm text-muted">No budgets yet. Agents can also open them through the MCP server (approve + register).</p>}>
          {(list) => (
            <TableWrap>
              <table className="table">
                <thead>
                  <tr>
                    <th>Token account</th>
                    <th>State</th>
                    <th>Cap</th>
                    <th>Balance</th>
                    <th>Headroom</th>
                    <th>Owner</th>
                    <th>Since</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {[...list]
                    .sort((a, b) => (b.registeredAt ?? 0) - (a.registeredAt ?? 0))
                    .map((b) => {
                      const st = budgetState(b, operator);
                      const isOpen = expanded === b.tokenAccount;
                      return (
                        <BudgetRows key={b.tokenAccount} b={b} st={st} isOpen={isOpen} toggle={() => setExpanded(isOpen ? undefined : b.tokenAccount)} decimals={decimals} symbol={symbol} canClose={canClose(b)} closing={closeFlow.running} onClose={() => void onClose(b)} />
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

function BudgetRows({ b, st, isOpen, toggle, decimals, symbol, canClose, closing, onClose }: { b: BudgetDto; st: { label: string; tone: BudgetTone }; isOpen: boolean; toggle(): void; decimals: number; symbol: string; canClose: boolean; closing: boolean; onClose(): void }) {
  return (
    <>
      <tr>
        <td>
          <AddressText address={b.tokenAccount} />
          {b.workspace !== b.owner ? (
            <span className="block text-xs text-faint">
              funds <AddressText address={b.workspace} />
            </span>
          ) : null}
        </td>
        <td>
          <Badge tone={st.tone}>{st.label}</Badge>
        </td>
        <td className="font-mono">{fmtTokens(b.cap, decimals, symbol)}</td>
        <td className="font-mono">{fmtTokens(b.balance, decimals)}</td>
        <td className="font-mono">
          {fmtTokens(b.headroomTokens, decimals)} <span className="text-accent">({fmtUsd(b.headroomMicro)})</span>
        </td>
        <td>
          <AddressText address={b.owner} />
        </td>
        <td className="text-muted">{b.registeredAt === null ? 'scanner' : formatDateTime(b.registeredAt)}</td>
        <td className="text-right">
          <span className="inline-flex gap-1">
            <Button size="sm" variant="ghost" onClick={toggle} aria-expanded={isOpen}>
              {b.draws.length} draw{b.draws.length === 1 ? '' : 's'} {isOpen ? '▴' : '▾'}
            </Button>
            {canClose ? (
              <Button size="sm" variant="danger" busy={closing} onClick={onClose}>
                Revoke
              </Button>
            ) : null}
          </span>
        </td>
      </tr>
      {isOpen ? (
        <tr>
          <td colSpan={8} className="bg-elevated/40">
            {b.draws.length === 0 ? (
              <p className="py-2 text-xs text-muted">No draws yet. The operator draws when your deficit reaches the threshold; each draw is a delegate burn with a memo naming the receipt hash.</p>
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
                      <td>{d.signature === null ? <span className="text-faint">—</span> : <TxLink signature={d.signature} />}</td>
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
