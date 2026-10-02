/**
 * Bigint mirror of the Pons V2 bonding-curve quote math (`docs/SPEC.md` §9.1, §9.3), transcribed
 * from `PonsV2BondingCurve.buy` / `.sell` and `PonsV2BondingCurveMath` with the contract's exact
 * integer truncation:
 *
 * ```
 * buy:  fee = spent·feeBps/10000, tax = spent·taxBps/10000, snipe = spent·snipeBps/10000
 *       tokensOut = getAmountOut(spent − fee − tax − snipe, quoteReserve, tokenReserve)
 *       if tokensOut > sellable:                       // the capped (completing) buy
 *         tokensOut = sellable
 *         net   = getAmountIn(sellable, quoteReserve, tokenReserve)
 *         spent = min(ceil(net·10000 / (10000 − feeBps − taxBps − snipeBps)), quoteIn)
 *         fee, tax, snipe recomputed from spent;  refund = quoteIn − spent
 * sell: gross = getAmountOut(tokensIn, tokenReserve, quoteReserve)
 *       fee = gross·feeBps/10000, tax = gross·taxBps/10000, quoteOut = gross − fee − tax
 * getAmountOut(a, rIn, rOut) = a·10000·rOut / (rIn·10000 + a·10000)            (floor)
 * getAmountIn(o, rIn, rOut)  = o·rIn·10000 / ((rOut − o)·10000) + 1
 * price (wei per 1e18 tokens) = quoteReserve·1e18 / tokenReserve
 * progress (bps)             = realQuoteReserve·10000 / graduationThreshold     (capped at 10000)
 * ```
 *
 * `quoteReserve` is the curve's tradeable quote reserve (`getReserves()`: phantom reserve included,
 * pending fees and creator tax excluded). Every quote throws `RangeError` where the contract reverts.
 * The snipe tax (a decaying launch-window tax for non-exempt buyers, capped so a buyer keeps at least
 * 1 %) is optional and defaults to 0.
 *
 * @module ponsCurve
 */

const BPS = 10_000n;
const WAD = 10n ** 18n;
/** The snipe tax is capped so a taxed buyer always keeps at least 1 % of the spend. */
const MIN_BUYER_SHARE_BPS = 100n;
/** `MAX_TOTAL_TRADE_FEE_BPS` of the curve (feeBps + creatorTaxBps ≤ 20 %). */
export const PONS_MAX_TOTAL_TRADE_FEE_BPS = 2_000n;
/** Protocol share of the base trade fee in the launch's frozen fee policy (30 % at launch, §9.1). */
export const PONS_PROTOCOL_FEE_SHARE_BPS = 3_000n;

/** `PonsV2BondingCurveMath.getAmountOut(amountIn, reserveIn, reserveOut, 0)`. */
export function ponsGetAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountIn <= 0n) throw new RangeError('InsufficientInputAmount');
  if (reserveIn <= 0n || reserveOut <= 0n) throw new RangeError('InsufficientLiquidity');
  const amountInWithFee = amountIn * BPS;
  const out = (amountInWithFee * reserveOut) / (reserveIn * BPS + amountInWithFee);
  if (out === 0n) throw new RangeError('InsufficientOutputAmount');
  return out;
}

/** `PonsV2BondingCurveMath.getAmountIn(amountOut, reserveIn, reserveOut, 0)` (rounds up). */
export function ponsGetAmountIn(amountOut: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  if (amountOut <= 0n) throw new RangeError('InsufficientOutputAmount');
  if (reserveIn <= 0n || reserveOut <= amountOut) throw new RangeError('InsufficientLiquidity');
  return (amountOut * reserveIn * BPS) / ((reserveOut - amountOut) * BPS) + 1n;
}

/** `Math.mulDiv(x, y, d, Rounding.Ceil)`. */
function mulDivCeil(x: bigint, y: bigint, d: bigint): bigint {
  const p = x * y;
  return p % d === 0n ? p / d : p / d + 1n;
}

/** Input of {@link ponsQuoteBuy}. */
export interface PonsBuyInput {
  /** Quote offered (`msg.value` for a native launch). */
  quoteIn: bigint;
  /** Tradeable quote reserve (`getReserves().quoteReserve_`). */
  quoteReserve: bigint;
  /** Token reserve (`getReserves().tokenReserve_`). */
  tokenReserve: bigint;
  /** `sellableTokens()` — tokens left before the curve graduates. */
  sellable: bigint;
  /** `feeBps()` (base trade fee, 100 = 1 %). */
  feeBps: bigint;
  /** `creatorTaxBps()`. */
  taxBps: bigint;
  /** Snipe tax of the buyer at execution time (0 when exempt or after the window). */
  snipeTaxBps?: bigint;
}

/** Result of {@link ponsQuoteBuy}. */
export interface PonsBuyQuote {
  tokensOut: bigint;
  /** Quote consumed (`CurveBuy.quoteIn`): fee, tax and snipe tax included, refund excluded. */
  spent: bigint;
  fee: bigint;
  tax: bigint;
  /** Unspent quote returned to the buyer (non-zero only on a capped buy). */
  refund: bigint;
  /** Snipe tax charged (0 unless `snipeTaxBps > 0`). */
  snipeTax: bigint;
  /** True when the buy hit `sellable` and was partly filled. */
  capped: boolean;
}

/** Caps a snipe tax the way the curve does (the buyer keeps ≥ 1 %). */
export function ponsBoundedSnipeTaxBps(feeBps: bigint, taxBps: bigint, snipeTaxBps: bigint): bigint {
  if (snipeTaxBps <= 0n) return 0n;
  const max = BPS - feeBps - taxBps - MIN_BUYER_SHARE_BPS;
  return snipeTaxBps > max ? max : snipeTaxBps;
}

/**
 * Snipe tax (bps) of a non-exempt buyer `elapsedSeconds` after launch: `startBps` halved 14 times
 * evenly across the window, 0 from `windowSeconds` on (as `PonsV2BondingCurve.currentSnipeTaxBps`;
 * read `snipeTaxSeconds()` from the factory — 15 s at deployment, owner-mutable).
 */
export function ponsSnipeTaxBpsAt(startBps: bigint, windowSeconds: bigint, elapsedSeconds: bigint): bigint {
  if (startBps <= 0n || windowSeconds <= 0n || elapsedSeconds >= windowSeconds) return 0n;
  if (elapsedSeconds < 0n) return startBps;
  return startBps >> ((elapsedSeconds * 14n) / windowSeconds);
}

/** Quotes a curve buy exactly as `PonsV2BondingCurve.buy` executes it. */
export function ponsQuoteBuy(i: PonsBuyInput): PonsBuyQuote {
  if (i.quoteIn <= 0n) throw new RangeError('ZeroAmount');
  if (i.sellable <= 0n) throw new RangeError('CurveGraduated');
  if (i.feeBps < 0n || i.taxBps < 0n || i.feeBps + i.taxBps > PONS_MAX_TOTAL_TRADE_FEE_BPS) throw new RangeError('InvalidFeePolicy');
  const snipeBps = ponsBoundedSnipeTaxBps(i.feeBps, i.taxBps, i.snipeTaxBps ?? 0n);
  const legs = (amount: bigint) => ({ fee: (amount * i.feeBps) / BPS, tax: (amount * i.taxBps) / BPS, snipe: (amount * snipeBps) / BPS });
  let spent = i.quoteIn;
  let { fee, tax, snipe } = legs(spent);
  let tokensOut = ponsGetAmountOut(spent - fee - tax - snipe, i.quoteReserve, i.tokenReserve);
  let capped = false;
  if (tokensOut > i.sellable) {
    capped = true;
    tokensOut = i.sellable;
    const net = ponsGetAmountIn(i.sellable, i.quoteReserve, i.tokenReserve);
    const grossed = mulDivCeil(net, BPS, BPS - i.feeBps - i.taxBps - snipeBps);
    spent = grossed < i.quoteIn ? grossed : i.quoteIn;
    ({ fee, tax, snipe } = legs(spent));
  }
  return { tokensOut, spent, fee, tax, refund: i.quoteIn - spent, snipeTax: snipe, capped };
}

/** Input of {@link ponsQuoteSell}. */
export interface PonsSellInput {
  tokensIn: bigint;
  quoteReserve: bigint;
  tokenReserve: bigint;
  feeBps: bigint;
  taxBps: bigint;
}

/** Result of {@link ponsQuoteSell}. */
export interface PonsSellQuote {
  /** Paid to the seller (`CurveSell.quoteOut`). */
  quoteOut: bigint;
  /** Output before the fee legs (`quoteOut + fee + tax`). */
  grossQuoteOut: bigint;
  fee: bigint;
  tax: bigint;
}

/** Quotes a curve sell exactly as `PonsV2BondingCurve.sell` executes it (fees come off the output). */
export function ponsQuoteSell(i: PonsSellInput): PonsSellQuote {
  if (i.tokensIn <= 0n) throw new RangeError('ZeroAmount');
  const grossQuoteOut = ponsGetAmountOut(i.tokensIn, i.tokenReserve, i.quoteReserve);
  const fee = (grossQuoteOut * i.feeBps) / BPS;
  const tax = (grossQuoteOut * i.taxBps) / BPS;
  return { quoteOut: grossQuoteOut - fee - tax, grossQuoteOut, fee, tax };
}

/** Spot price in wei per 1e18 tokens: `quoteReserve·1e18 / tokenReserve` (0 for an empty token side). */
export function ponsPrice(quoteReserve: bigint, tokenReserve: bigint): bigint {
  return tokenReserve <= 0n ? 0n : (quoteReserve * WAD) / tokenReserve;
}

/** Graduation progress in bps: `realQuoteReserve·10000 / graduationThreshold`, capped at 10000. */
export function ponsProgressBps(realQuoteReserve: bigint, graduationThreshold: bigint): bigint {
  if (graduationThreshold <= 0n) return 0n;
  const p = (realQuoteReserve * BPS) / graduationThreshold;
  return p > BPS ? BPS : p;
}

/** Tradeable reserves after a trade (`getReserves()` right after it, with no sweep in between). */
export interface PonsReserves {
  quoteReserve: bigint;
  tokenReserve: bigint;
}

/** Reserves after a buy: the quote side grows by the spend net of fee, tax and snipe tax. */
export function ponsReservesAfterBuy(r: PonsReserves, q: Pick<PonsBuyQuote, 'spent' | 'fee' | 'tax' | 'snipeTax' | 'tokensOut'>): PonsReserves {
  return { quoteReserve: r.quoteReserve + q.spent - q.fee - q.tax - q.snipeTax, tokenReserve: r.tokenReserve - q.tokensOut };
}

/** Reserves after a sell: the quote side shrinks by the gross output. */
export function ponsReservesAfterSell(r: PonsReserves, tokensIn: bigint, q: Pick<PonsSellQuote, 'grossQuoteOut'>): PonsReserves {
  return { quoteReserve: r.quoteReserve - q.grossQuoteOut, tokenReserve: r.tokenReserve + tokensIn };
}

/**
 * Creator amount a curve fee sweep credits to the creator fee recipient for pending `fee` / `tax`
 * with buyback disabled: `fee − fee·protocolShareBps/10000 + tax`.
 */
export function ponsCreatorShare(fee: bigint, tax: bigint, protocolShareBps: bigint = PONS_PROTOCOL_FEE_SHARE_BPS): bigint {
  return fee - (fee * protocolShareBps) / BPS + tax;
}
