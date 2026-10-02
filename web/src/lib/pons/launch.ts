/**
 * Pons launch form math (SPEC §9.5): launch configs from `/api/launch-config`, the creator tax
 * bounds, the CREATE2 salt, the `LaunchParams` struct and the `launchMind` value
 * (`launchFee + quoteIn + creationFee`, SPEC §9.2) with the initial buy quoted on the config's
 * fresh curve (phantom quote reserve vs the whole supply).
 *
 * @module lib/pons/launch
 */
import { applySlippage } from '@www-rh/shared';
import { keccak256, toBytes, type Hex } from 'viem';
import { ponsInitialReserves, ponsQuoteBuy, type PonsBuyQuote } from './curve';

/** Combined curve fee + creator tax ceiling enforced by the Pons factory (`MAX_TOTAL_TRADE_FEE_BPS`). */
export const MAX_TOTAL_TRADE_FEE_BPS = 2_000;
/** Default `maxCreatorTaxBps` of the Pons factory (10 %), used until the launch config arrives. */
export const DEFAULT_MAX_CREATOR_TAX_BPS = 1_000;
/** Default snipe-tax window of the Pons factory (`snipeTaxSeconds`). */
export const DEFAULT_SNIPE_TAX_SECONDS = 15;

/** One launch configuration (`/api/launch-config` `configs[]`, or `factory.getLaunchConfig(id)`). */
export interface PonsLaunchConfig {
  id: bigint;
  /** Token supply in base units (18 decimals). */
  supply: bigint;
  curveFeeBps: number;
  /** Virtual quote reserve (wei). */
  phantomQuote: bigint;
  /** Real quote reserve (wei) at which the curve graduates. */
  graduationThreshold: bigint;
  enabled: boolean;
}

/** `/api/launch-config` (SPEC §9.4). */
export interface PonsLaunchSettings {
  launchFee: bigint;
  configs: PonsLaunchConfig[];
  maxCreatorTaxBps: number;
  snipeTaxSeconds: number;
}

/** The first enabled config (the form's default selection), or `null`. */
export function defaultLaunchConfig(configs: readonly PonsLaunchConfig[]): PonsLaunchConfig | null {
  return configs.find((c) => c.enabled) ?? null;
}

/** Clamps a slider value to `0..maxCreatorTaxBps` (whole bps). */
export function clampCreatorTaxBps(bps: number, maxBps: number): number {
  if (!Number.isFinite(bps)) return 0;
  return Math.max(0, Math.min(Math.trunc(bps), Math.max(0, Math.trunc(maxBps))));
}

/** Problems with a creator tax / config combination, or `null` when the factory would accept it. */
export function creatorTaxError(bps: number, maxBps: number, config: PonsLaunchConfig | null): string | null {
  if (!Number.isInteger(bps) || bps < 0) return 'The creator tax must be a whole number of basis points.';
  if (bps > maxBps) return `The creator tax can be at most ${maxBps / 100}% (Pons maxCreatorTaxBps).`;
  if (config !== null && config.curveFeeBps + bps > MAX_TOTAL_TRADE_FEE_BPS) {
    return `Curve fee plus creator tax must stay within ${MAX_TOTAL_TRADE_FEE_BPS / 100}%.`;
  }
  return null;
}

/**
 * The CREATE2 salt of the Pons token (SPEC §9.5): `keccak256(utf8(name + ' ' + symbol + ' ' + nonce))`.
 * Use a fresh nonce per attempt: the registry derives the mind account from `(creator, salt)` and
 * reverts with `AccountExists` when it is reused.
 */
export function launchSalt(name: string, symbol: string, nonce: string | number | bigint): Hex {
  return keccak256(toBytes(`${name} ${symbol} ${String(nonce)}`));
}

/** A fresh, practically unique nonce for {@link launchSalt}. */
export function freshLaunchNonce(nowMs: number = Date.now(), random: number = Math.random()): string {
  return `${nowMs}-${Math.floor(random * 1e9)}`;
}

/** `Socials` of the Pons token (empty strings for unset fields). */
export interface PonsSocials {
  twitter: string;
  telegram: string;
  discord: string;
  website: string;
  farcaster: string;
}

/** Trims every social field (Pons stores them verbatim on the token). */
export function buildSocials(draft: PonsSocials): PonsSocials {
  return {
    twitter: draft.twitter.trim(),
    telegram: draft.telegram.trim(),
    discord: draft.discord.trim(),
    website: draft.website.trim(),
    farcaster: draft.farcaster.trim(),
  };
}

/** Longest social link accepted (same bound as the metadata links). */
export const MAX_SOCIAL_CHARS = 256;

/** Problems with the socials (each optional; when set, a full http(s) URL of ≤ 256 chars), or `null`. */
export function socialsError(socials: PonsSocials): string | null {
  for (const [key, value] of Object.entries(socials)) {
    const text = value.trim();
    if (text === '') continue;
    let ok = false;
    try {
      const u = new URL(text);
      ok = u.protocol === 'https:' || u.protocol === 'http:';
    } catch {
      ok = false;
    }
    if (!ok || text.length > MAX_SOCIAL_CHARS) return `The ${key} link must be a full http(s) URL of at most ${MAX_SOCIAL_CHARS} characters.`;
  }
  return null;
}

/** `PonsMindRegistry.LaunchParams` as viem encodes it. */
export interface PonsLaunchParams {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  socials: PonsSocials;
  creatorTaxBps: number;
  expectedEconomics: Hex;
  salt: Hex;
  launchConfigId: bigint;
}

/** Builds the `LaunchParams` struct (strings trimmed; empty logo/description allowed). */
export function buildLaunchParams(input: {
  name: string;
  symbol: string;
  logo: string;
  description: string;
  socials: PonsSocials;
  creatorTaxBps: number;
  expectedEconomics: Hex;
  salt: Hex;
  launchConfigId: bigint;
}): PonsLaunchParams {
  return {
    name: input.name.trim(),
    symbol: input.symbol.trim(),
    logo: input.logo.trim(),
    description: input.description.trim(),
    socials: buildSocials(input.socials),
    creatorTaxBps: input.creatorTaxBps,
    expectedEconomics: input.expectedEconomics,
    salt: input.salt,
    launchConfigId: input.launchConfigId,
  };
}

/** What `launchMind` is called with and what the creator gets. */
export interface PonsLaunchPlan {
  /** Initial buy offered to the curve (0 = none). */
  quoteIn: bigint;
  launchFee: bigint;
  creationFee: bigint;
  /** `msg.value = launchFee + quoteIn + creationFee` (SPEC §9.2). */
  value: bigint;
  /** Quote of the initial buy on the fresh curve, or `null` without an initial buy. */
  quote: PonsBuyQuote | null;
  /** `tokensOut·(1 − slippage)`; 0 without an initial buy. */
  minTokensOut: bigint;
  /** The initial buy alone exhausts the sellable allocation (partial fill + refund). */
  clamped: boolean;
  /** Share of the total supply bought, in bps. */
  supplyShareBps: bigint;
}

/**
 * Plans `launchMind` (SPEC §9.2 / §9.5). The initial buy is quoted with {@link ponsQuoteBuy} on
 * the config's fresh curve with the chosen creator tax (the creator is snipe-tax exempt).
 * Throws when the curve cannot price the buy (e.g. it rounds to zero tokens).
 */
export function planPonsLaunch(params: {
  config: Pick<PonsLaunchConfig, 'supply' | 'curveFeeBps' | 'phantomQuote' | 'graduationThreshold'>;
  launchFee: bigint;
  creationFee: bigint;
  quoteIn: bigint;
  creatorTaxBps: number;
  slippageBps: bigint;
}): PonsLaunchPlan {
  const { config, launchFee, creationFee, quoteIn, creatorTaxBps, slippageBps } = params;
  const value = launchFee + (quoteIn > 0n ? quoteIn : 0n) + creationFee;
  if (quoteIn <= 0n) {
    return { quoteIn: 0n, launchFee, creationFee, value, quote: null, minTokensOut: 0n, clamped: false, supplyShareBps: 0n };
  }
  const fresh = ponsInitialReserves(config);
  const quote = ponsQuoteBuy({ quoteIn, ...fresh, feeBps: BigInt(config.curveFeeBps), taxBps: BigInt(creatorTaxBps) });
  return {
    quoteIn,
    launchFee,
    creationFee,
    value,
    quote,
    minTokensOut: applySlippage(quote.tokensOut, slippageBps),
    clamped: quote.refund > 0n,
    supplyShareBps: config.supply > 0n ? (quote.tokensOut * 10_000n) / config.supply : 0n,
  };
}

/** {@link planPonsLaunch} that returns `null` when the initial buy cannot be priced. */
export function tryPlanPonsLaunch(params: Parameters<typeof planPonsLaunch>[0]): PonsLaunchPlan | null {
  try {
    return planPonsLaunch(params);
  } catch {
    return null;
  }
}
