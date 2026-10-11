/**
 * Pure state machines for the multi-transaction flows of the Credits and Budgets pages
 * (approve → burnForCreditMin, approve → openBudget), their preflight checks, the credit floor
 * (`minUsdMicro`) passed to the desk and the cumulative `approve` value.
 */
import type { Hex } from 'viem';
import { BPS_DENOMINATOR, ceilDiv } from '@beagle/shared/credit';
import { fmtTokens } from './amounts.js';

/** Status of one transaction step. */
export type StepStatus = 'idle' | 'skipped' | 'signing' | 'pending' | 'confirmed' | 'failed';

/** One step of a flow. */
export interface StepState {
  id: string;
  label: string;
  status: StepStatus;
  hash?: Hex;
  error?: string;
  /** Name of the contract custom error a failed step reverted with (e.g. `SlippageExceeded`), when decodable. */
  revert?: string;
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
  | { type: 'failed'; id: string; error: string; revert?: string | undefined }
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
      return patch(state, event.id, (s) => ({ ...s, status: 'failed', error: event.error, ...(event.revert === undefined ? {} : { revert: event.revert }) }));
  }
}

/** The failed step that reverted with the contract error `name`, if any. */
export function failedWith(state: FlowState, name: string): StepState | undefined {
  return state.steps.find((s) => s.status === 'failed' && s.revert === name);
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
  | 'quote_pending'
  | 'insufficient_balance'
  | 'allowance_unknown'
  | 'bad_hours'
  | 'desk_unknown';

// ---------------------------------------------------------------------------------------------
// Credit floor (SlippageExceeded) and cumulative approvals

/** Default price tolerance of a burn: 100 bps = 1 %. */
export const DEFAULT_TOLERANCE_BPS = 100;

/** Tolerances the Credits page offers (0.5 %, 1 %, 2 %, 5 %). */
export const TOLERANCE_CHOICES_BPS = [50, 100, 200, 500] as const;

/** One-line explanation of the tolerance control. */
export const TOLERANCE_HELP = 'If the on-chain price moves against you by more than this before the transaction lands, it reverts instead of burning for less credit.';

/** Shown when the approve step is skipped: the allowance is not private to this flow. */
export const SHARED_ALLOWANCE_NOTE = 'Your allowance already covers this amount, so no approve is needed. Open budgets of this wallet draw from the same allowance: a burn spends it and a budget relies on it.';

/** `2^256 − 1`, the largest `approve` value. */
export const UINT256_MAX = (1n << 256n) - 1n;

/**
 * Credit floor passed to `burnForCreditMin`: `quoted − ceil(quoted · toleranceBps / 10 000)` in µUSD.
 * `0` disables the floor on chain, which happens for `toleranceBps >= 10 000` and for quotes so small
 * that the tolerance rounds up to the whole quote (e.g. 1 µUSD at 1 %). `toleranceBps` must be a
 * non-negative safe integer; `quotedUsdMicro` must be `>= 0`.
 */
export function creditFloor(quotedUsdMicro: bigint, toleranceBps: number = DEFAULT_TOLERANCE_BPS): bigint {
  if (quotedUsdMicro < 0n) throw new RangeError(`quotedUsdMicro must be ≥ 0 (got ${quotedUsdMicro})`);
  if (!Number.isSafeInteger(toleranceBps) || toleranceBps < 0) throw new RangeError(`toleranceBps must be a non-negative integer (got ${toleranceBps})`);
  const bps = BigInt(toleranceBps);
  if (bps >= BPS_DENOMINATOR) return 0n;
  return quotedUsdMicro - ceilDiv(quotedUsdMicro * bps, BPS_DENOMINATOR);
}

/** `100` → `1 %`, `50` → `0.5 %`, `25` → `0.25 %`. */
export function formatBps(bps: number): string {
  if (!Number.isSafeInteger(bps) || bps < 0) throw new RangeError(`bps must be a non-negative integer (got ${bps})`);
  const whole = Math.floor(bps / 100);
  const frac = (bps % 100).toString().padStart(2, '0').replace(/0+$/, '');
  return `${whole}${frac === '' ? '' : `.${frac}`} %`;
}

/**
 * Value of the `approve` that precedes a burn or a budget: `allowance + amount`, capped at
 * `uint256.max`. The same `allowance(owner, desk)` backs every open budget of the wallet
 * (headroom = min(cap − drawn, allowance, balance)) and a burn spends it, so approving exactly
 * `amount` would silently shrink or stall those budgets. Mirrors the MCP wallet executor.
 */
export function cumulativeApproval(allowance: bigint, amount: bigint): bigint {
  if (allowance < 0n || amount < 0n) throw new RangeError('allowance and amount must be ≥ 0');
  const sum = allowance + amount;
  return sum > UINT256_MAX ? UINT256_MAX : sum;
}

/**
 * Approve decision for `amount` given the wallet's current `allowance`: skip when the allowance
 * already covers it, otherwise approve {@link cumulativeApproval}. `undefined` allowance (still
 * loading or unreadable) yields `needsApprove: true` with no amount: the flow cannot start, since
 * a non-cumulative approve could clobber what open budgets rely on.
 */
export function approvalFor(allowance: bigint | undefined, amount: bigint): { needsApprove: boolean; approveAmount: bigint | undefined } {
  if (allowance === undefined) return { needsApprove: true, approveAmount: undefined };
  if (allowance >= amount) return { needsApprove: false, approveAmount: undefined };
  return { needsApprove: true, approveAmount: cumulativeApproval(allowance, amount) };
}

/**
 * Label of the approve step: the cumulative value, with its breakdown when the wallet already has
 * an allowance (`Approve 1,500 BEAGLE for the credit desk (500 already allowed + 1,000)`).
 */
export function approveLabel(approveAmount: bigint, allowance: bigint | undefined, amount: bigint, decimals: number, symbol: string): string {
  const total = fmtTokens(approveAmount, decimals, symbol);
  if (allowance === undefined || allowance === 0n) return `Approve ${total} for the credit desk`;
  return `Approve ${total} for the credit desk (${fmtTokens(allowance, decimals)} already allowed + ${fmtTokens(amount, decimals)})`;
}

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
  /** Live `desk.quote(amount)` in µUSD, `undefined` while unknown (the floor needs it). */
  usdMicro: bigint | undefined;
  /** Price tolerance in bps for {@link creditFloor} (default {@link DEFAULT_TOLERANCE_BPS}). */
  toleranceBps?: number;
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
  /**
   * Value of that `approve`: `allowance + amount` ({@link cumulativeApproval}). `undefined` when no
   * approve is needed, or when the allowance is unknown (then `allowance_unknown` blocks the flow).
   */
  approveAmount: bigint | undefined;
}

/** {@link Plan} of a burn, with the floor for `burnForCreditMin`. */
export interface BurnPlan extends Plan {
  /** `minUsdMicro` for `burnForCreditMin`: {@link creditFloor} of the quote, `undefined` without a quote. */
  minUsdMicro: bigint | undefined;
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

/**
 * Preflight of approve → burnForCreditMin. The live quote is required: without it there is no
 * floor to pass (`quote_pending`), and the price blockers come first so a stale/unavailable price
 * is not reported as a pending quote.
 */
export function planBurn(input: BurnPlanInput): BurnPlan {
  const blockers = envBlockers(input);
  if (!input.priceAvailable) blockers.push('price_unavailable');
  else if (input.priceStale) blockers.push('price_stale');
  const { amount, usdMicro } = input;
  const minUsdMicro = usdMicro === undefined ? undefined : creditFloor(usdMicro, input.toleranceBps ?? DEFAULT_TOLERANCE_BPS);
  if (amount === undefined || amount <= 0n) {
    blockers.push('no_amount');
    return { canRun: false, blockers, needsApprove: false, approveAmount: undefined, minUsdMicro };
  }
  if (input.minBurn !== undefined && amount < input.minBurn) blockers.push('below_min_burn');
  if (usdMicro === undefined) {
    if (input.priceAvailable && !input.priceStale) blockers.push('quote_pending');
  } else if (usdMicro === 0n) blockers.push('quote_zero');
  if (input.balance !== undefined && input.balance < amount) blockers.push('insufficient_balance');
  const approval = approvalFor(input.allowance, amount);
  if (approval.needsApprove && approval.approveAmount === undefined) blockers.push('allowance_unknown');
  return { canRun: blockers.length === 0, blockers, ...approval, minUsdMicro };
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

/**
 * Preflight of approve(allowance + cap) → openBudget. The balance is advisory: budgets may exceed
 * it (draws fail later).
 */
export function planBudget(input: BudgetPlanInput): Plan {
  const blockers = envBlockers(input);
  const { cap } = input;
  const noCap = cap === undefined || cap <= 0n;
  if (noCap) blockers.push('no_amount');
  if (input.hours === undefined || !Number.isInteger(input.hours) || input.hours < 1 || input.hours > MAX_BUDGET_HOURS) blockers.push('bad_hours');
  const approval = cap === undefined || cap <= 0n ? { needsApprove: false, approveAmount: undefined } : approvalFor(input.allowance, cap);
  if (approval.needsApprove && approval.approveAmount === undefined) blockers.push('allowance_unknown');
  return { canRun: blockers.length === 0, blockers, ...approval };
}

/**
 * Seconds kept below the desk's `MAX_BUDGET_DURATION` (30 days). The desk checks
 * `deadline <= block.timestamp + 30 days` against the inclusion block, so a deadline computed as
 * exactly now + 30 days on the browser clock reverts `BadBudgetParams` whenever that block's
 * timestamp is behind the browser clock.
 */
export const DEADLINE_SAFETY_SECONDS = 300;

/**
 * Unix-seconds deadline for a budget of `hours` opened at `nowMs` (as `bigint` for `uint64`).
 * The maximum duration is shortened by {@link DEADLINE_SAFETY_SECONDS}.
 */
export function budgetDeadline(nowMs: number, hours: number): bigint {
  const seconds = Math.min(hours * 3600, MAX_BUDGET_HOURS * 3600 - DEADLINE_SAFETY_SECONDS);
  return BigInt(Math.floor(nowMs / 1000) + seconds);
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
    case 'quote_pending':
      return 'Waiting for the on-chain quote';
    case 'insufficient_balance':
      return 'Insufficient token balance';
    case 'allowance_unknown':
      return 'Reading the wallet allowance for the credit desk';
    case 'bad_hours':
      return `Hours must be a whole number between 1 and ${ctx.maxHours ?? MAX_BUDGET_HOURS}`;
  }
}
