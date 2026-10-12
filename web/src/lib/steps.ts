/**
 * Pure state machines for the wallet flows of the Credits and Budgets pages (one transaction
 * each on Solana: burn + memo, approve, revoke), their preflight checks, and the state labels of
 * budgets. No price floor and no allowance exist here: a burn is final and credited at the
 * published price when observed (SPEC §3.2), a budget is an SPL delegation (SPEC §3.4).
 */
import { tokensForUsdMicro } from '@beagle/shared/credit';
import type { BudgetDto } from '@beagle/shared/api';

/** Status of one transaction step. */
export type StepStatus = 'idle' | 'skipped' | 'signing' | 'pending' | 'confirmed' | 'failed';

/** One step of a flow. */
export interface StepState {
  id: string;
  label: string;
  status: StepStatus;
  /** Transaction signature once sent. */
  signature?: string;
  error?: string;
  /** Program logs of a failed send / simulation, when the RPC returned them. */
  logs?: readonly string[];
}

/** Overall flow status. */
export type FlowStatus = 'idle' | 'running' | 'done' | 'failed';

/** Whole flow. */
export interface FlowState {
  steps: StepState[];
  status: FlowStatus;
}

/** Events the flow reducer accepts. */
export type FlowEvent =
  | { type: 'init'; steps: { id: string; label: string }[] }
  | { type: 'skip'; id: string }
  | { type: 'signing'; id: string }
  | { type: 'sent'; id: string; signature: string }
  | { type: 'confirmed'; id: string }
  | { type: 'failed'; id: string; error: string; signature?: string | undefined; logs?: readonly string[] | undefined }
  | { type: 'reset' };

/** Empty flow. */
export const EMPTY_FLOW: FlowState = { steps: [], status: 'idle' };

/** Builds the initial state for `steps`. */
export function createFlow(steps: { id: string; label: string }[]): FlowState {
  return { steps: steps.map((s) => ({ id: s.id, label: s.label, status: 'idle' })), status: steps.length === 0 ? 'idle' : 'running' };
}

function deriveStatus(steps: StepState[]): FlowStatus {
  if (steps.length === 0) return 'idle';
  if (steps.some((s) => s.status === 'failed')) return 'failed';
  if (steps.every((s) => s.status === 'confirmed' || s.status === 'skipped')) return 'done';
  return 'running';
}

function patch(state: FlowState, id: string, update: (s: StepState) => StepState): FlowState {
  const steps = state.steps.map((s) => (s.id === id ? update(s) : s));
  return { steps, status: deriveStatus(steps) };
}

/** Reducer of the flow state. Unknown ids are ignored. */
export function reduceFlow(state: FlowState, event: FlowEvent): FlowState {
  switch (event.type) {
    case 'init':
      return createFlow(event.steps);
    case 'reset':
      return EMPTY_FLOW;
    case 'skip':
      return patch(state, event.id, (s) => ({ id: s.id, label: s.label, status: 'skipped' }));
    case 'signing':
      return patch(state, event.id, (s) => ({ id: s.id, label: s.label, status: 'signing' }));
    case 'sent':
      return patch(state, event.id, (s) => ({ id: s.id, label: s.label, status: 'pending', signature: event.signature }));
    case 'confirmed':
      return patch(state, event.id, (s) => ({ ...s, status: 'confirmed' }));
    case 'failed':
      return patch(state, event.id, (s) => ({
        ...s,
        status: 'failed',
        error: event.error,
        ...(event.signature === undefined ? {} : { signature: event.signature }),
        ...(event.logs === undefined || event.logs.length === 0 ? {} : { logs: event.logs }),
      }));
  }
}

/** The step currently waiting on the wallet or the chain, if any. */
export function activeStep(state: FlowState): StepState | undefined {
  return state.steps.find((s) => s.status === 'signing' || s.status === 'pending');
}

/** The signature of the last confirmed step, if any (the burn / approve / revoke transaction). */
export function lastSignature(state: FlowState): string | undefined {
  for (let i = state.steps.length - 1; i >= 0; i--) {
    const s = state.steps[i];
    if (s !== undefined && s.signature !== undefined) return s.signature;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Preflight plans

/** Reasons a flow cannot start. */
export type BlockerCode =
  | 'not_connected'
  | 'no_session'
  | 'deployment_unknown'
  | 'config_mismatch'
  | 'operator_unknown'
  | 'price_unavailable'
  | 'price_stale'
  | 'bad_workspace'
  | 'no_amount'
  | 'below_min_credit'
  | 'quote_zero'
  | 'no_token_account'
  | 'insufficient_balance'
  | 'account_pending';

/** Common environment of both plans. */
export interface FlowEnv {
  connected: boolean;
  /** The mint (and token program) are known. */
  deploymentKnown: boolean;
  /** The build and the gateway disagree on the mint or the cluster. */
  configMismatch: boolean;
  workspaceValid: boolean;
  /** `false` while the wallet's token account is still being read. */
  accountKnown: boolean;
  /** The wallet has a token account of the mint (`false` = never received BEAGLE). */
  hasTokenAccount: boolean;
  /** Raw token balance of that account. */
  balance: bigint | undefined;
}

/** Inputs of {@link planBurn}. */
export interface BurnPlanInput extends FlowEnv {
  /** Raw token amount to burn, `undefined` when the input is empty/invalid. */
  amount: bigint | undefined;
  /** µUSD the burn quotes at the published price (`undefined` without a price). */
  usdMicro: bigint | undefined;
  priceAvailable: boolean;
  priceStale: boolean;
  /** `MIN_CREDIT_USD` in µUSD (burns quoting below it earn no credit). */
  minCreditMicro: bigint | undefined;
}

/** What a flow preflight decided. */
export interface Plan {
  canRun: boolean;
  blockers: BlockerCode[];
}

function envBlockers(env: FlowEnv): BlockerCode[] {
  const out: BlockerCode[] = [];
  if (!env.connected) out.push('not_connected');
  if (env.configMismatch) out.push('config_mismatch');
  else if (!env.deploymentKnown) out.push('deployment_unknown');
  if (!env.workspaceValid) out.push('bad_workspace');
  return out;
}

function accountBlockers(env: FlowEnv, amount: bigint): BlockerCode[] {
  if (!env.connected || !env.deploymentKnown || env.configMismatch) return [];
  if (!env.accountKnown) return ['account_pending'];
  if (!env.hasTokenAccount) return ['no_token_account'];
  if (env.balance !== undefined && env.balance < amount) return ['insufficient_balance'];
  return [];
}

/**
 * Preflight of the burn. The price blockers come first so a stale/unavailable price is not
 * reported as a missing quote; the minimum is enforced in µUSD at the published price
 * (SPEC §3.2: burns quoting below `MIN_CREDIT_USD` are recorded with no credit).
 */
export function planBurn(input: BurnPlanInput): Plan {
  const blockers = envBlockers(input);
  if (!input.priceAvailable) blockers.push('price_unavailable');
  else if (input.priceStale) blockers.push('price_stale');
  const { amount, usdMicro } = input;
  if (amount === undefined || amount <= 0n) {
    blockers.push('no_amount');
    return { canRun: false, blockers };
  }
  if (usdMicro !== undefined) {
    if (usdMicro === 0n) blockers.push('quote_zero');
    else if (input.minCreditMicro !== undefined && usdMicro < input.minCreditMicro) blockers.push('below_min_credit');
  }
  blockers.push(...accountBlockers(input, amount));
  return { canRun: blockers.length === 0, blockers };
}

/** Inputs of {@link planBudget}. */
export interface BudgetPlanInput extends FlowEnv {
  /** Raw token cap, `undefined` when the input is empty/invalid. */
  cap: bigint | undefined;
  /** The operator (delegate) is known; `false` while the gateway has no operator key. */
  operatorKnown: boolean;
}

/** {@link Plan} of an approval, with the advisory flag for a cap above the balance. */
export interface BudgetPlan extends Plan {
  /** The cap exceeds the wallet balance: allowed (headroom = min(cap, balance)) but worth a note. */
  capAboveBalance: boolean;
}

/**
 * Preflight of `ApproveChecked(ata, operator, cap)`. The balance is advisory: the delegation may
 * exceed it (headroom is `min(cap, balance)`), but the token account must exist for the
 * instruction to succeed.
 */
export function planBudget(input: BudgetPlanInput): BudgetPlan {
  const blockers = envBlockers(input);
  if (input.deploymentKnown && !input.configMismatch && !input.operatorKnown) blockers.push('operator_unknown');
  const { cap } = input;
  if (cap === undefined || cap <= 0n) {
    blockers.push('no_amount');
    return { canRun: false, blockers, capAboveBalance: false };
  }
  blockers.push(...accountBlockers(input, 0n));
  return { canRun: blockers.length === 0, blockers, capAboveBalance: input.balance !== undefined && cap > input.balance };
}

/** Context for {@link describeBlocker}. */
export interface BlockerContext {
  symbol: string;
  minCreditText?: string | undefined;
}

/** English text for a blocker. */
export function describeBlocker(code: BlockerCode, ctx: BlockerContext): string {
  switch (code) {
    case 'not_connected':
      return 'Connect a wallet';
    case 'no_session':
      return 'Sign in first';
    case 'deployment_unknown':
      return 'The mint is not configured';
    case 'config_mismatch':
      return 'This build and the gateway disagree on the deployment';
    case 'operator_unknown':
      return 'Budgets are unavailable: the gateway has no operator wallet';
    case 'price_unavailable':
      return 'Token price is unavailable';
    case 'price_stale':
      return 'Token price is stale; burns are disabled until the gateway publishes a fresh price point';
    case 'bad_workspace':
      return 'Enter a valid workspace public key';
    case 'no_amount':
      return 'Enter an amount';
    case 'below_min_credit':
      return ctx.minCreditText === undefined ? 'Amount is below the minimum credit' : `Minimum credit is ${ctx.minCreditText}`;
    case 'quote_zero':
      return 'Amount is too small to credit anything';
    case 'no_token_account':
      return `This wallet has no ${ctx.symbol} token account`;
    case 'insufficient_balance':
      return `Insufficient ${ctx.symbol} balance`;
    case 'account_pending':
      return 'Reading the wallet token account';
  }
}

/**
 * Smallest raw token amount that quotes at least `minCreditMicro` (`ceil`), for the "minimum
 * amount" hint; `undefined` without a price.
 */
export function minCreditTokens(minCreditMicro: bigint, priceE18: bigint | undefined, decimals: number): bigint | undefined {
  if (priceE18 === undefined || priceE18 <= 0n) return undefined;
  return tokensForUsdMicro(minCreditMicro, priceE18, decimals);
}

// ---------------------------------------------------------------------------------------------
// Budget display

/** Text for `BudgetDto.stalledReason`. */
export const STALLED_TEXT: Readonly<Record<NonNullable<BudgetDto['stalledReason']>, string>> = {
  price: 'price stale or unavailable',
  revoked: 'delegation revoked',
  exhausted: 'cap or balance exhausted',
  draw_failed: 'last draw failed',
};

/** Badge tones the budget state uses. */
export type BudgetTone = 'ok' | 'warn' | 'err' | 'neutral';

/** Label and tone of a budget row. */
export function budgetState(b: Pick<BudgetDto, 'closed' | 'stalledReason' | 'headroomTokens' | 'delegate'>, operator: string | undefined): { label: string; tone: BudgetTone } {
  if (b.closed) return { label: 'closed', tone: 'neutral' };
  if (b.stalledReason !== null) return { label: `stalled: ${STALLED_TEXT[b.stalledReason]}`, tone: 'warn' };
  if (operator !== undefined && b.delegate !== operator) return { label: b.delegate === null ? 'revoked' : 'delegated elsewhere', tone: 'neutral' };
  if (b.headroomTokens === 0n) return { label: 'exhausted', tone: 'neutral' };
  return { label: 'open', tone: 'ok' };
}

/** Note shown when the wallet already delegates to the operator: SPL keeps one delegate per account. */
export function replacesCapNote(existingCap: bigint, capText: string): string | undefined {
  if (existingCap <= 0n) return undefined;
  return `This wallet's token account already delegates ${capText} to the operator. SPL keeps one delegate per account: the new approval replaces that cap (it does not add to it).`;
}
