/**
 * Bonding-curve math mirroring `MindLaunchpad` (SPEC §1) with exact bigint arithmetic.
 *
 * Constant product with virtual reserves: `x = VIRTUAL_ETH + realEthReserve`,
 * `y = VIRTUAL_TOKENS - tokensSold`, `k = x·y`. Rounding always favours the contract.
 * All token amounts are 18-decimals; ETH amounts are wei. Fees are in basis points.
 *
 * @module curve
 */

// ---------------------------------------------------------------------------
// Normative constants (SPEC §1)
// ---------------------------------------------------------------------------

/** 1e18 — token / ETH scale. */
export const WAD = 10n ** 18n;
/** Basis-point denominator. */
export const BPS = 10_000n;

/** `TOTAL_SUPPLY = 1_000_000_000e18` — minted once to the launchpad at creation. */
export const TOTAL_SUPPLY = 1_000_000_000n * WAD;
/** `CURVE_SUPPLY = 800_000_000e18` — sold on the bonding curve. */
export const CURVE_SUPPLY = 800_000_000n * WAD;
/** `LP_SUPPLY = 200_000_000e18` — reserved for the DEX at graduation. */
export const LP_SUPPLY = 200_000_000n * WAD;
/** `VIRTUAL_ETH = 1.365 ether` — virtual ETH reserve (x₀). */
export const VIRTUAL_ETH = 1_365_000_000_000_000_000n;
/** `VIRTUAL_TOKENS = 1_073_000_000e18` — virtual token reserve (y₀). */
export const VIRTUAL_TOKENS = 1_073_000_000n * WAD;

/** Default `tradeFeeBps` (1 %). Owner-settable on-chain, max {@link MAX_TRADE_FEE_BPS}. */
export const DEFAULT_TRADE_FEE_BPS = 100n;
/** Default `mindShareBps` (70 % of every fee → mind vault). Max {@link MAX_MIND_SHARE_BPS}. */
export const DEFAULT_MIND_SHARE_BPS = 7_000n;
/** Default `graduationFeeBps` (2.5 % of the real reserve at graduation). Max {@link MAX_GRADUATION_FEE_BPS}. */
export const DEFAULT_GRADUATION_FEE_BPS = 250n;
/** Default `creationFee` (0 wei). */
export const DEFAULT_CREATION_FEE = 0n;
/** Default `maxDrawPerEpoch` (0.25 ether). */
export const DEFAULT_MAX_DRAW_PER_EPOCH = 250_000_000_000_000_000n;
/** Default `drawEpoch` (1 day, seconds). */
export const DEFAULT_DRAW_EPOCH_SECONDS = 86_400;

/** Upper bound for `tradeFeeBps` (5 %). */
export const MAX_TRADE_FEE_BPS = 500n;
/** Upper bound for `mindShareBps` (100 %). */
export const MAX_MIND_SHARE_BPS = 10_000n;
/** Upper bound for `graduationFeeBps` (10 %). */
export const MAX_GRADUATION_FEE_BPS = 1_000n;

/** Fee parameters as stored on-chain (`FeeParams`). */
export interface FeeParams {
  tradeFeeBps: bigint;
  mindShareBps: bigint;
  graduationFeeBps: bigint;
}

/** Default on-chain fee parameters (SPEC §1). */
export const DEFAULT_FEE_PARAMS: Readonly<FeeParams> = Object.freeze({
  tradeFeeBps: DEFAULT_TRADE_FEE_BPS,
  mindShareBps: DEFAULT_MIND_SHARE_BPS,
  graduationFeeBps: DEFAULT_GRADUATION_FEE_BPS,
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The two curve variables that determine every quote. */
export interface CurveReserves {
  /** Real ETH collected by the curve (wei), net of fees. */
  realEthReserve: bigint;
  /** Tokens sold so far on the curve (18 decimals), `<= CURVE_SUPPLY`. */
  tokensSold: bigint;
}

/** Result of {@link quoteBuy}. */
export interface BuyQuote {
  /** Tokens the buyer receives. */
  tokensOut: bigint;
  /** ETH actually consumed (`ethIn` unless the buy completes the curve), fee included. */
  ethUsed: bigint;
  /** Total fee taken (split between mind vault and protocol by `mindShareBps`). */
  fee: bigint;
  /** `ethUsed - fee` — what is added to `realEthReserve`. */
  net: bigint;
  /** `ethIn - ethUsed` — refunded to the buyer (only non-zero on the completing buy). */
  refund: bigint;
  /** Whether this buy sells out the curve (`tokensSold` becomes `CURVE_SUPPLY`). */
  completes: boolean;
  /** Reserves after the buy. */
  next: CurveReserves;
}

/** Result of {@link quoteSell}. */
export interface SellQuote {
  /** ETH the seller receives, net of fee. */
  ethOut: bigint;
  /** Fee taken from `ethGross`. */
  fee: bigint;
  /** `ethOut + fee` — what is removed from `realEthReserve`. */
  ethGross: bigint;
  /** Reserves after the sell. */
  next: CurveReserves;
}

/** Fee / liquidity split applied by `graduate()` (SPEC §1). */
export interface GraduationSplit {
  /** `realEthReserve · graduationFeeBps / 10000`. */
  graduationFee: bigint;
  /** Portion of `graduationFee` credited to the mind vault. */
  mindFee: bigint;
  /** Portion of `graduationFee` credited to the protocol. */
  protocolFee: bigint;
  /** ETH sent to the DEX. */
  ethLiquidity: bigint;
  /** Tokens sent to the DEX (= `LP_SUPPLY`). */
  tokenLiquidity: bigint;
  /** Curve's final price `x·1e18/y`, wei per 1e18 tokens (informational). */
  targetPriceWei: bigint;
  /**
   * Implied DEX price `ethLiquidity · 1e18 / tokenLiquidity`, wei per 1e18 tokens. The graduator
   * initializes the pool from exactly these amounts (D3), see {@link sqrtPriceX96FromAmounts}.
   */
  lpPriceWei: bigint;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Ceiling division for non-negative bigints (`b > 0`). */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError('ceilDiv: divisor must be positive');
  if (a < 0n) throw new RangeError('ceilDiv: dividend must be non-negative');
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}

/** Virtual ETH reserve `x = VIRTUAL_ETH + realEthReserve`. */
export function reserveX(state: CurveReserves): bigint {
  return VIRTUAL_ETH + state.realEthReserve;
}

/** Virtual token reserve `y = VIRTUAL_TOKENS - tokensSold`. */
export function reserveY(state: CurveReserves): bigint {
  return VIRTUAL_TOKENS - state.tokensSold;
}

/** Tokens still available on the curve: `CURVE_SUPPLY - tokensSold`. */
export function remainingSupply(state: CurveReserves): bigint {
  return CURVE_SUPPLY - state.tokensSold;
}

/** The zero state of a freshly created curve. */
export const INITIAL_RESERVES: Readonly<CurveReserves> = Object.freeze({ realEthReserve: 0n, tokensSold: 0n });

function assertState(state: CurveReserves): void {
  if (state.realEthReserve < 0n) throw new RangeError('realEthReserve must be non-negative');
  if (state.tokensSold < 0n || state.tokensSold > CURVE_SUPPLY) {
    throw new RangeError('tokensSold must be within [0, CURVE_SUPPLY]');
  }
}

function assertFeeBps(feeBps: bigint): void {
  if (feeBps < 0n || feeBps > MAX_TRADE_FEE_BPS) {
    throw new RangeError(`tradeFeeBps must be within [0, ${MAX_TRADE_FEE_BPS}]`);
  }
}

/** Split a fee into `(mindAmount, protocolAmount)` using `mindShareBps` (SPEC §2.3 rules). */
export function splitFee(fee: bigint, mindShareBps: bigint = DEFAULT_MIND_SHARE_BPS): { mindAmount: bigint; protocolAmount: bigint } {
  if (mindShareBps < 0n || mindShareBps > MAX_MIND_SHARE_BPS) {
    throw new RangeError(`mindShareBps must be within [0, ${MAX_MIND_SHARE_BPS}]`);
  }
  const mindAmount = (fee * mindShareBps) / BPS;
  return { mindAmount, protocolAmount: fee - mindAmount };
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

/**
 * Rounding note for the completing buy (SPEC §1, directive D6): with
 * `net' = ceilDiv(k, y - remaining) - x` and `fee' = ceilDiv(net'·f, 10000 - f)`, a buyer whose
 * `ethIn - floor(ethIn·f/10000)` already equals `net'` would be charged `net' + fee' = ethIn + 1`
 * wei. D6 therefore clamps `ethUsed` to `msg.value` (and sets `fee' = ethUsed - net'`) so the refund
 * is never negative; the mirror applies the same guard.
 */
export const COMPLETION_ROUNDING_NOTE =
  'quoteBuy clamps ethUsed to ethIn on the completing buy (fee = ethIn - net when the ceil-rounded fee would exceed it)';

/**
 * Mirror of `MindLaunchpad.quoteBuy` (SPEC §1).
 *
 * ```
 * fee = ethIn·tradeFeeBps/10000, net = ethIn - fee, tokensOut = y - ceilDiv(k, x + net)
 * ```
 * If the curve would overflow, `tokensOut` is capped at the remaining supply and the ETH
 * actually needed is recomputed (`net' = ceilDiv(k, y - tokensOut) - x`,
 * `fee' = ceilDiv(net'·tradeFeeBps, 10000 - tradeFeeBps)`, `ethUsed = min(net' + fee', ethIn)`,
 * see {@link COMPLETION_ROUNDING_NOTE}); the state update uses `net'` / `fee'` (D6) and the
 * remainder is refunded.
 *
 * @throws RangeError when `ethIn == 0`, the curve is not in `Bonding` (sold out) or inputs are out of range.
 */
export function quoteBuy(state: CurveReserves, ethIn: bigint, tradeFeeBps: bigint = DEFAULT_TRADE_FEE_BPS): BuyQuote {
  assertState(state);
  assertFeeBps(tradeFeeBps);
  if (ethIn <= 0n) throw new RangeError('ZeroAmount: ethIn must be positive');
  const remaining = remainingSupply(state);
  if (remaining === 0n) throw new RangeError('WrongPhase: curve is complete');

  const x = reserveX(state);
  const y = reserveY(state);
  const k = x * y;

  let fee = (ethIn * tradeFeeBps) / BPS;
  let net = ethIn - fee;
  let tokensOut = y - ceilDiv(k, x + net);
  let ethUsed = ethIn;
  let completes = false;

  if (tokensOut >= remaining) {
    completes = true;
    if (tokensOut > remaining) {
      tokensOut = remaining;
      net = ceilDiv(k, y - tokensOut) - x;
      fee = ceilDiv(net * tradeFeeBps, BPS - tradeFeeBps);
      ethUsed = net + fee;
      // Rounding guard (see COMPLETION_ROUNDING_NOTE): when `net` is already the minimal
      // completing amount, the ceil-rounded fee can exceed the floor-rounded fee the buyer
      // actually paid by 1 wei. Never charge more than was sent.
      if (ethUsed > ethIn) {
        ethUsed = ethIn;
        fee = ethIn - net;
      }
    }
  }

  return {
    tokensOut,
    ethUsed,
    fee,
    net,
    refund: ethIn - ethUsed,
    completes,
    next: { realEthReserve: state.realEthReserve + net, tokensSold: state.tokensSold + tokensOut },
  };
}

/**
 * Mirror of `MindLaunchpad.quoteSell` (SPEC §1).
 *
 * ```
 * ethGross = x - ceilDiv(k, y + tokensIn), fee = ethGross·tradeFeeBps/10000, ethOut = ethGross - fee
 * ```
 *
 * @throws RangeError when `tokensIn == 0` or `tokensIn > tokensSold`.
 */
export function quoteSell(state: CurveReserves, tokensIn: bigint, tradeFeeBps: bigint = DEFAULT_TRADE_FEE_BPS): SellQuote {
  assertState(state);
  assertFeeBps(tradeFeeBps);
  if (tokensIn <= 0n) throw new RangeError('ZeroAmount: tokensIn must be positive');
  if (tokensIn > state.tokensSold) throw new RangeError('tokensIn exceeds tokensSold');

  const x = reserveX(state);
  const y = reserveY(state);
  const k = x * y;

  const ethGross = x - ceilDiv(k, y + tokensIn);
  const fee = (ethGross * tradeFeeBps) / BPS;
  const ethOut = ethGross - fee;

  return {
    ethOut,
    fee,
    ethGross,
    next: { realEthReserve: state.realEthReserve - ethGross, tokensSold: state.tokensSold - tokensIn },
  };
}

/**
 * ETH needed (fee included) to buy exactly `tokensOut` tokens — the inverse of {@link quoteBuy}.
 * Useful for "buy N tokens" UI; `quoteBuy(state, result).tokensOut >= tokensOut` always holds.
 */
export function ethForTokens(state: CurveReserves, tokensOut: bigint, tradeFeeBps: bigint = DEFAULT_TRADE_FEE_BPS): bigint {
  assertState(state);
  assertFeeBps(tradeFeeBps);
  if (tokensOut <= 0n) throw new RangeError('ZeroAmount: tokensOut must be positive');
  if (tokensOut > remainingSupply(state)) throw new RangeError('tokensOut exceeds remaining supply');
  const x = reserveX(state);
  const y = reserveY(state);
  const k = x * y;
  const net = ceilDiv(k, y - tokensOut) - x;
  const fee = ceilDiv(net * tradeFeeBps, BPS - tradeFeeBps);
  return net + fee;
}

/** Mirror of `MindLaunchpad.currentPrice`: wei per 1e18 tokens `= x·1e18 / y`. */
export function priceOf(state: CurveReserves): bigint {
  assertState(state);
  return (reserveX(state) * WAD) / reserveY(state);
}

/** Display market cap in wei `= price · TOTAL_SUPPLY / 1e18`. */
export function marketCap(state: CurveReserves): bigint {
  return (priceOf(state) * TOTAL_SUPPLY) / WAD;
}

/** Market cap for a given price (wei per 1e18 tokens), e.g. from a `Trade` event. */
export function marketCapAtPrice(priceWei: bigint): bigint {
  return (priceWei * TOTAL_SUPPLY) / WAD;
}

/** Progress to graduation in basis points `= tokensSold·10000/CURVE_SUPPLY` (0..10000). */
export function progressBps(tokensSold: bigint): bigint {
  if (tokensSold < 0n || tokensSold > CURVE_SUPPLY) throw new RangeError('tokensSold must be within [0, CURVE_SUPPLY]');
  return (tokensSold * BPS) / CURVE_SUPPLY;
}

/** Whether the curve has sold out (`tokensSold == CURVE_SUPPLY`). */
export function isComplete(state: CurveReserves): boolean {
  return state.tokensSold === CURVE_SUPPLY;
}

/**
 * The reserves of a sold-out curve: `tokensSold = CURVE_SUPPLY` and the minimal real ETH
 * reserve that reaches it from the initial state in one fee-less step
 * (`ceilDiv(k₀, VIRTUAL_TOKENS - CURVE_SUPPLY) - VIRTUAL_ETH` ≈ 4.0 ETH).
 */
export function completionReserves(): CurveReserves {
  const k = VIRTUAL_ETH * VIRTUAL_TOKENS;
  return { realEthReserve: ceilDiv(k, VIRTUAL_TOKENS - CURVE_SUPPLY) - VIRTUAL_ETH, tokensSold: CURVE_SUPPLY };
}

/**
 * Mirror of the graduation split (SPEC §1 / §2.3 `graduate`):
 * `gradFee = realEthReserve·graduationFeeBps/10000`, split by `mindShareBps`,
 * `ethLiquidity = realEthReserve - gradFee`, `tokenLiquidity = LP_SUPPLY`.
 */
export function graduationSplit(state: CurveReserves, fees: Readonly<FeeParams> = DEFAULT_FEE_PARAMS): GraduationSplit {
  assertState(state);
  if (fees.graduationFeeBps < 0n || fees.graduationFeeBps > MAX_GRADUATION_FEE_BPS) {
    throw new RangeError(`graduationFeeBps must be within [0, ${MAX_GRADUATION_FEE_BPS}]`);
  }
  const graduationFee = (state.realEthReserve * fees.graduationFeeBps) / BPS;
  const { mindAmount, protocolAmount } = splitFee(graduationFee, fees.mindShareBps);
  const ethLiquidity = state.realEthReserve - graduationFee;
  return {
    graduationFee,
    mindFee: mindAmount,
    protocolFee: protocolAmount,
    ethLiquidity,
    tokenLiquidity: LP_SUPPLY,
    targetPriceWei: priceOf(state),
    lpPriceWei: (ethLiquidity * WAD) / LP_SUPPLY,
  };
}

/**
 * Applies slippage tolerance to a quoted amount: `amount · (10000 - slippageBps) / 10000`
 * (what the UI passes as `minTokensOut` / `minEthOut`).
 */
export function applySlippage(amount: bigint, slippageBps: bigint): bigint {
  if (slippageBps < 0n || slippageBps > BPS) throw new RangeError('slippageBps must be within [0, 10000]');
  return (amount * (BPS - slippageBps)) / BPS;
}

/** `2^96` */
export const Q96 = 2n ** 96n;

/** Integer square root (floor) of a non-negative bigint (Newton's method). */
export function sqrtBigint(value: bigint): bigint {
  if (value < 0n) throw new RangeError('sqrtBigint: negative input');
  if (value < 2n) return value;
  let x0 = value;
  let x1 = (value + 1n) >> 1n;
  while (x1 < x0) {
    x0 = x1;
    x1 = (x1 + value / x1) >> 1n;
  }
  return x0;
}

/**
 * Uniswap v3 `sqrtPriceX96` the graduator derives from the amounts it receives (D3), after ordering
 * `token0 < token1`: `sqrt(amount1 · 2^192 / amount0)` (floor, as `Math.sqrt(Math.mulDiv(...))`).
 */
export function sqrtPriceX96FromAmounts(amount0: bigint, amount1: bigint): bigint {
  if (amount0 <= 0n || amount1 < 0n) throw new RangeError('sqrtPriceX96FromAmounts: amount0 must be positive');
  return sqrtBigint((amount1 * Q96 * Q96) / amount0);
}

/**
 * The `sqrtPriceX96` a graduation of `state` targets: WETH = `ethLiquidity`, token = `LP_SUPPLY`,
 * ordered by address (`token0 < token1`, compared as integers).
 */
export function graduationSqrtPriceX96(
  state: CurveReserves,
  token: string,
  weth: string,
  fees: Readonly<FeeParams> = DEFAULT_FEE_PARAMS,
): bigint {
  const { ethLiquidity, tokenLiquidity } = graduationSplit(state, fees);
  const tokenIsToken0 = BigInt(token) < BigInt(weth);
  return tokenIsToken0 ? sqrtPriceX96FromAmounts(tokenLiquidity, ethLiquidity) : sqrtPriceX96FromAmounts(ethLiquidity, tokenLiquidity);
}
