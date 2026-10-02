/**
 * Pons curve helpers on top of the shared quote mirror (`@www-rh/shared` `ponsCurve.ts`, SPEC
 * §9.3: `ponsQuoteBuy`, `ponsQuoteSell`, `ponsPrice`, `ponsProgressBps`).
 *
 * LOCAL (web-only, candidates for shared): the fresh-curve reserves of a launch config
 * ({@link ponsReservedTokens} / {@link ponsInitialReserves}, from `PonsV2BondingCurve.initialize`)
 * used by the launch-form preview, and non-throwing quote wrappers for the UI.
 *
 * @module lib/pons/curve
 */
import { ponsQuoteBuy, ponsQuoteSell, type PonsBuyInput, type PonsBuyQuote, type PonsSellInput, type PonsSellQuote } from '@www-rh/shared';

export { ponsGetAmountIn, ponsGetAmountOut, ponsPrice, ponsProgressBps, ponsQuoteBuy, ponsQuoteSell } from '@www-rh/shared';
export type { PonsBuyInput, PonsBuyQuote, PonsSellInput, PonsSellQuote } from '@www-rh/shared';

/** Tokens the curve never sells (`PonsV2BondingCurve.initialize`): `mulDiv(supply, phantom, phantom + threshold)`. */
export function ponsReservedTokens(supply: bigint, phantomQuote: bigint, graduationThreshold: bigint): bigint {
  const d = phantomQuote + graduationThreshold;
  return d > 0n ? (supply * phantomQuote) / d : 0n;
}

/** Reserves of a fresh curve for a launch config (no trades yet): the phantom quote against the whole supply. */
export function ponsInitialReserves(config: { supply: bigint; phantomQuote: bigint; graduationThreshold: bigint }): {
  quoteReserve: bigint;
  tokenReserve: bigint;
  sellable: bigint;
} {
  const reserved = ponsReservedTokens(config.supply, config.phantomQuote, config.graduationThreshold);
  return { quoteReserve: config.phantomQuote, tokenReserve: config.supply, sellable: config.supply > reserved ? config.supply - reserved : 0n };
}

/** `ponsQuoteBuy` that returns `null` where the curve would revert. */
export function tryPonsQuoteBuy(input: PonsBuyInput): PonsBuyQuote | null {
  try {
    return ponsQuoteBuy(input);
  } catch {
    return null;
  }
}

/** `ponsQuoteSell` that returns `null` where the curve would revert. */
export function tryPonsQuoteSell(input: PonsSellInput): PonsSellQuote | null {
  try {
    return ponsQuoteSell(input);
  } catch {
    return null;
  }
}
