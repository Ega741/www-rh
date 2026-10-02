/**
 * Quote helpers on top of the `@www-rh/shared` curve mirror: the create-flow initial buy on a
 * fresh curve (directive W2), slippage and deadline handling, and local estimates used while
 * the on-chain `quoteBuy` / `quoteSell` reads are loading or unavailable.
 *
 * @module lib/quote
 */
import {
  BPS,
  CURVE_SUPPLY,
  DEFAULT_TRADE_FEE_BPS,
  INITIAL_RESERVES,
  applySlippage,
  quoteBuy,
  quoteSell,
  type CurveReserves,
} from '@www-rh/shared';

/** Default slippage tolerance: 1 % (SPEC §7). */
export const DEFAULT_SLIPPAGE_BPS = 100n;
/** Upper bound accepted by the UI: 50 %. */
export const MAX_SLIPPAGE_BPS = 5_000n;
/** Default trade deadline in minutes. */
export const DEFAULT_DEADLINE_MINUTES = 10;

/**
 * Parses a slippage percentage typed by the user (`"1"`, `"0.5"`) into basis points.
 * Returns `null` when invalid, negative, more than 2 decimals or above {@link MAX_SLIPPAGE_BPS}.
 */
export function slippagePercentToBps(input: string): bigint | null {
  const text = input.trim().replace(',', '.');
  if (!/^[0-9]+(\.[0-9]{0,2})?$|^\.[0-9]{1,2}$/.test(text)) return null;
  const [int = '0', frac = ''] = text.split('.');
  const bps = BigInt(int === '' ? '0' : int) * 100n + BigInt((frac + '00').slice(0, 2));
  return bps > MAX_SLIPPAGE_BPS ? null : bps;
}

/** `amount · (1 − slippage)` — the min-out passed to the contract. */
export function minOutWithSlippage(amount: bigint, slippageBps: bigint): bigint {
  return applySlippage(amount, slippageBps);
}

/** Unix-seconds deadline `minutes` from `nowMs`. */
export function deadlineFromNow(minutes: number, nowMs: number = Date.now()): bigint {
  return BigInt(Math.floor(nowMs / 1000) + Math.max(1, Math.round(minutes * 60)));
}

/** The create-flow plan: what `createMind` is called with and what the creator receives. */
export interface InitialBuyPlan {
  /** ETH spent on the initial buy (0 = no initial buy). */
  initialBuyWei: bigint;
  /** `msg.value = creationFee + initialBuyWei` (W2). */
  value: bigint;
  /** Quoted tokens out on a fresh curve. */
  tokensOut: bigint;
  /** `tokensOut · (1 − slippage)`; 0 when there is no initial buy. */
  minTokensOut: bigint;
  /** Trade fee taken from the initial buy. */
  fee: bigint;
  /** Refund when the initial buy alone completes the curve. */
  refund: bigint;
  /** Whether the initial buy sells out the curve. */
  completes: boolean;
  /** Share of the curve supply bought, in bps. */
  curveShareBps: bigint;
}

/**
 * Plans the initial buy of `createMind` on a fresh curve (`realEthReserve = 0`, `tokensSold = 0`)
 * with the shared bigint curve math (directive W2).
 */
export function planInitialBuy(params: {
  initialBuyWei: bigint;
  creationFee: bigint;
  tradeFeeBps?: bigint;
  slippageBps?: bigint;
}): InitialBuyPlan {
  const { initialBuyWei, creationFee } = params;
  const tradeFeeBps = params.tradeFeeBps ?? DEFAULT_TRADE_FEE_BPS;
  const slippageBps = params.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  if (initialBuyWei <= 0n) {
    return { initialBuyWei: 0n, value: creationFee, tokensOut: 0n, minTokensOut: 0n, fee: 0n, refund: 0n, completes: false, curveShareBps: 0n };
  }
  const q = quoteBuy(INITIAL_RESERVES, initialBuyWei, tradeFeeBps);
  return {
    initialBuyWei,
    value: creationFee + initialBuyWei,
    tokensOut: q.tokensOut,
    minTokensOut: applySlippage(q.tokensOut, slippageBps),
    fee: q.fee,
    refund: q.refund,
    completes: q.completes,
    curveShareBps: (q.tokensOut * BPS) / CURVE_SUPPLY,
  };
}

/** Local buy estimate `{ tokensOut, fee, ethUsed }`, or `null` when the curve cannot fill it. */
export function estimateBuy(state: CurveReserves, ethIn: bigint, tradeFeeBps: bigint): { tokensOut: bigint; ethUsed: bigint; fee: bigint } | null {
  try {
    const q = quoteBuy(state, ethIn, tradeFeeBps);
    return { tokensOut: q.tokensOut, ethUsed: q.ethUsed, fee: q.fee };
  } catch {
    return null;
  }
}

/** Local sell estimate `{ ethOut, fee }`, or `null` when invalid. */
export function estimateSell(state: CurveReserves, tokensIn: bigint, tradeFeeBps: bigint): { ethOut: bigint; fee: bigint } | null {
  try {
    const q = quoteSell(state, tokensIn, tradeFeeBps);
    return { ethOut: q.ethOut, fee: q.fee };
  } catch {
    return null;
  }
}

/** Price impact of a trade in bps: how far the execution price is from the spot price. */
export function priceImpactBps(spotPriceWei: bigint, ethAmount: bigint, tokenAmount: bigint): bigint | null {
  if (spotPriceWei <= 0n || tokenAmount <= 0n) return null;
  const execPrice = (ethAmount * 10n ** 18n) / tokenAmount;
  const diff = execPrice > spotPriceWei ? execPrice - spotPriceWei : spotPriceWei - execPrice;
  return (diff * BPS) / spotPriceWei;
}
