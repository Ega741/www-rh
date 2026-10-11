/**
 * Pure state machines for the multi-transaction flows of the Credits and Budgets pages
 * (approve → burnForCredit, approve → openBudget) and their preflight checks.
 */
import type { Hex } from 'viem';

/** Status of one transaction step. */
export type StepStatus = 'idle' | 'skipped' | 'signing' | 'pending' | 'confirmed' | 'failed';

/** One step of a flow. */
export interface StepState {
  id: string;
  label: string;
  status: StepStatus;
  hash?: Hex;
  error?: string;
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
  | { type: 'sent'; id: string; hash: Hex }
  | { type: 'confirmed'; id: string }
  | { type: 'failed'; id: string; error: string }
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
      return patch(state, event.id, (s) => ({ id: s.id, label: s.label, status: 'pending', hash: event.hash }));
    case 'confirmed':
      return patch(state, event.id, (s) => ({ ...s, status: 'confirmed' }));
    case 'failed':
      return patch(state, event.id, (s) => ({ ...s, status: 'failed', error: event.error }));
  }
}

/** The step currently waiting on the wallet or the chain, if any. */
export function activeStep(state: FlowState): StepState | undefined {
  return state.steps.find((s) => s.status === 'signing' || s.status === 'pending');
}

// ---------------------------------------------------------------------------------------------
// Preflight plans

/** Reasons a flow cannot start. */
export type BlockerCode =
  | 'not_connected'
  | 'wrong_chain'
  | 'no_session'
  | 'paused'
  | 'price_unavailable'
  | 'price_stale'
  | 'bad_workspace'
  | 'no_amount'
  | 'below_min_burn'
  | 'quote_zero'
  | 'insufficient_balance'
  | 'bad_hours'
  | 'desk_unknown';

/** Common environment of both plans. */
export interface FlowEnv {
  connected: boolean;
  rightChain: boolean;
  deskKnown: boolean;
  paused: boolean | undefined;
  workspaceValid: boolean;
}

/** Inputs of {@link planBurn}. */
export interface BurnPlanInput extends FlowEnv {
  /** Raw token amount to burn, `undefined` when the input is empty/invalid. */
  amount: bigint | undefined;
  /** Quoted µUSD for `amount`, `undefined` while unknown. */
  usdMicro: bigint | undefined;
  priceAvailable: boolean;
  priceStale: boolean;
  minBurn: bigint | undefined;
  balance: bigint | undefined;
  allowance: bigint | undefined;
}

/** What a flow preflight decided. */
export interface Plan {
  canRun: boolean;
  blockers: BlockerCode[];
  /** An `approve` step is required before the main call. */
  needsApprove: boolean;
}

function envBlockers(env: FlowEnv): BlockerCode[] {
  const out: BlockerCode[] = [];
  if (!env.connected) out.push('not_connected');
  else if (!env.rightChain) out.push('wrong_chain');
  if (!env.deskKnown) out.push('desk_unknown');
  if (env.paused === true) out.push('paused');
  if (!env.workspaceValid) out.push('bad_workspace');
  return out;
}

/** Preflight of approve → burnForCredit. */
export function planBurn(input: BurnPlanInput): Plan {
  const blockers = envBlockers(input);
  if (!input.priceAvailable) blockers.push('price_unavailable');
  else if (input.priceStale) blockers.push('price_stale');
  if (input.amount === undefined || input.amount <= 0n) blockers.push('no_amount');
  else {
    if (input.minBurn !== undefined && input.amount < input.minBurn) blockers.push('below_min_burn');
    if (input.usdMicro !== undefined && input.usdMicro === 0n) blockers.push('quote_zero');
    if (input.balance !== undefined && input.balance < input.amount) blockers.push('insufficient_balance');
  }
  const needsApprove = input.amount !== undefined && input.amount > 0n && (input.allowance === undefined || input.allowance < input.amount);
  return { canRun: blockers.length === 0, blockers, needsApprove };
}

/** Longest budget allowed by the desk (`MAX_BUDGET_DURATION = 30 days`). */
export const MAX_BUDGET_HOURS = 720;

/** Inputs of {@link planBudget}. */
export interface BudgetPlanInput extends FlowEnv {
  /** Raw token cap, `undefined` when the input is empty/invalid. */
  cap: bigint | undefined;
  hours: number | undefined;
  balance: bigint | undefined;
  allowance: bigint | undefined;
}

/** Preflight of approve(cap) → openBudget. The balance is advisory: budgets may exceed it (draws fail later). */
export function planBudget(input: BudgetPlanInput): Plan {
  const blockers = envBlockers(input);
  if (input.cap === undefined || input.cap <= 0n) blockers.push('no_amount');
  if (input.hours === undefined || !Number.isInteger(input.hours) || input.hours < 1 || input.hours > MAX_BUDGET_HOURS) blockers.push('bad_hours');
  const needsApprove = input.cap !== undefined && input.cap > 0n && (input.allowance === undefined || input.allowance < input.cap);
  return { canRun: blockers.length === 0, blockers, needsApprove };
}

/** Unix-seconds deadline for a budget of `hours` opened at `nowMs` (as `bigint` for `uint64`). */
export function budgetDeadline(nowMs: number, hours: number): bigint {
  return BigInt(Math.floor(nowMs / 1000) + hours * 3600);
}

/** Context for {@link describeBlocker}. */
export interface BlockerContext {
  chainName: string;
  minBurnText?: string;
  maxHours?: number;
}

/** English text for a blocker. */
export function describeBlocker(code: BlockerCode, ctx: BlockerContext): string {
  switch (code) {
    case 'not_connected':
      return 'Connect a wallet';
    case 'wrong_chain':
      return `Switch your wallet to ${ctx.chainName}`;
    case 'no_session':
      return 'Sign in first';
    case 'desk_unknown':
      return 'Credit desk address is not configured';
    case 'paused':
      return 'The credit desk is paused';
    case 'price_unavailable':
      return 'Token price is unavailable on chain';
    case 'price_stale':
      return 'Token price is stale; burns are disabled until a fresh price is posted';
    case 'bad_workspace':
      return 'Enter a valid workspace address';
    case 'no_amount':
      return 'Enter an amount';
    case 'below_min_burn':
      return ctx.minBurnText === undefined ? 'Amount is below the minimum burn' : `Minimum burn is ${ctx.minBurnText}`;
    case 'quote_zero':
      return 'Amount is too small to credit anything';
    case 'insufficient_balance':
      return 'Insufficient token balance';
    case 'bad_hours':
      return `Hours must be a whole number between 1 and ${ctx.maxHours ?? MAX_BUDGET_HOURS}`;
  }
}
