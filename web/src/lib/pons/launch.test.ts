import { applySlippage } from '@www-rh/shared';
import { keccak256, toBytes } from 'viem';
import { describe, expect, it } from 'vitest';
import { ponsInitialReserves, ponsQuoteBuy } from './curve';
import {
  buildLaunchParams,
  clampCreatorTaxBps,
  creatorTaxError,
  defaultLaunchConfig,
  freshLaunchNonce,
  launchSalt,
  planPonsLaunch,
  socialsError,
  tryPlanPonsLaunch,
  type PonsLaunchConfig,
} from './launch';

const ETH = 10n ** 18n;
const CONFIG: PonsLaunchConfig = { id: 0n, supply: 10n ** 27n, curveFeeBps: 100, phantomQuote: (15n * ETH) / 10n, graduationThreshold: 4n * ETH, enabled: true };
const LAUNCH_FEE = 5n * 10n ** 14n; // 0.0005 ETH
const CREATION_FEE = 10n ** 15n;

describe('planPonsLaunch (launchMind value math, SPEC §9.2/§9.5)', () => {
  it('without an initial buy sends launchFee + creationFee and expects no tokens', () => {
    const plan = planPonsLaunch({ config: CONFIG, launchFee: LAUNCH_FEE, creationFee: CREATION_FEE, quoteIn: 0n, creatorTaxBps: 300, slippageBps: 100n });
    expect(plan).toMatchObject({ value: LAUNCH_FEE + CREATION_FEE, quoteIn: 0n, quote: null, minTokensOut: 0n, clamped: false });
  });

  it('value = launchFee + quoteIn + creationFee; the buy is quoted on the fresh curve with the creator tax', () => {
    const quoteIn = ETH / 10n;
    const plan = planPonsLaunch({ config: CONFIG, launchFee: LAUNCH_FEE, creationFee: CREATION_FEE, quoteIn, creatorTaxBps: 200, slippageBps: 100n });
    expect(plan.value).toBe(LAUNCH_FEE + quoteIn + CREATION_FEE);
    const fresh = ponsInitialReserves(CONFIG);
    const expected = ponsQuoteBuy({ quoteIn, ...fresh, feeBps: 100n, taxBps: 200n });
    expect(plan.quote).toEqual(expected);
    expect(plan.quote?.fee).toBe(quoteIn / 100n);
    expect(plan.quote?.tax).toBe((quoteIn * 2n) / 100n);
    expect(plan.minTokensOut).toBe(applySlippage(expected.tokensOut, 100n));
    expect(plan.minTokensOut).toBe((expected.tokensOut * 9_900n) / 10_000n);
    expect(plan.supplyShareBps).toBe((expected.tokensOut * 10_000n) / CONFIG.supply);
    expect(plan.clamped).toBe(false);
  });

  it('a creator tax lowers the tokens received', () => {
    const base = { config: CONFIG, launchFee: 0n, creationFee: 0n, quoteIn: ETH, slippageBps: 100n };
    const noTax = planPonsLaunch({ ...base, creatorTaxBps: 0 });
    const taxed = planPonsLaunch({ ...base, creatorTaxBps: 1_000 });
    expect((taxed.quote?.tokensOut ?? 0n) < (noTax.quote?.tokensOut ?? 0n)).toBe(true);
  });

  it('an initial buy that sells out the curve is clamped; msg.value still carries the full quoteIn (refund forwarded)', () => {
    const quoteIn = 100n * ETH;
    const plan = planPonsLaunch({ config: CONFIG, launchFee: LAUNCH_FEE, creationFee: CREATION_FEE, quoteIn, creatorTaxBps: 0, slippageBps: 100n });
    const sellable = ponsInitialReserves(CONFIG).sellable;
    expect(plan.clamped).toBe(true);
    expect(plan.quote?.tokensOut).toBe(sellable);
    expect((plan.quote?.refund ?? 0n) > 0n).toBe(true);
    expect(plan.value).toBe(LAUNCH_FEE + quoteIn + CREATION_FEE);
  });

  it('tryPlanPonsLaunch returns null when the buy cannot be priced', () => {
    const tiny = { ...CONFIG, phantomQuote: 10n ** 30n };
    expect(tryPlanPonsLaunch({ config: tiny, launchFee: 0n, creationFee: 0n, quoteIn: 1n, creatorTaxBps: 0, slippageBps: 100n })).toBeNull();
  });
});

describe('launch form inputs', () => {
  it('salt = keccak256(utf8(name + " " + symbol + " " + nonce))', () => {
    expect(launchSalt('Night Sky', 'STARS', 7)).toBe(keccak256(toBytes('Night Sky STARS 7')));
    expect(launchSalt('Night Sky', 'STARS', 'a-1')).not.toBe(launchSalt('Night Sky', 'STARS', 'a-2'));
    expect(freshLaunchNonce(1_700_000_000_000, 0.5)).toBe('1700000000000-500000000');
  });

  it('creator tax is bounded by maxCreatorTaxBps and the 20% combined ceiling', () => {
    expect(clampCreatorTaxBps(1_500, 1_000)).toBe(1_000);
    expect(clampCreatorTaxBps(-5, 1_000)).toBe(0);
    expect(clampCreatorTaxBps(Number.NaN, 1_000)).toBe(0);
    expect(creatorTaxError(500, 1_000, CONFIG)).toBeNull();
    expect(creatorTaxError(1_001, 1_000, CONFIG)).toMatch(/at most 10%/);
    expect(creatorTaxError(1_000, 2_000, { ...CONFIG, curveFeeBps: 1_500 })).toMatch(/within 20%/);
    expect(creatorTaxError(12.5, 1_000, CONFIG)).toMatch(/whole number/);
  });

  it('picks the first enabled config by default', () => {
    expect(defaultLaunchConfig([{ ...CONFIG, id: 0n, enabled: false }, { ...CONFIG, id: 1n }])?.id).toBe(1n);
    expect(defaultLaunchConfig([{ ...CONFIG, enabled: false }])).toBeNull();
  });

  it('builds LaunchParams with trimmed strings and validates socials', () => {
    const socials = { twitter: ' https://x.com/a ', telegram: '', discord: '', website: 'https://a.example', farcaster: '' };
    const p = buildLaunchParams({
      name: ' Night ',
      symbol: 'STARS ',
      logo: ' ipfs://x ',
      description: '',
      socials,
      creatorTaxBps: 100,
      expectedEconomics: `0x${'11'.repeat(32)}`,
      salt: `0x${'22'.repeat(32)}`,
      launchConfigId: 2n,
    });
    expect(p).toMatchObject({ name: 'Night', symbol: 'STARS', logo: 'ipfs://x', creatorTaxBps: 100, launchConfigId: 2n });
    expect(p.socials.twitter).toBe('https://x.com/a');
    expect(socialsError(socials)).toBeNull();
    expect(socialsError({ ...socials, discord: 'discord.gg/x' })).toMatch(/discord/);
    expect(socialsError({ ...socials, farcaster: `https://f.example/${'a'.repeat(300)}` })).toMatch(/farcaster/);
  });
});
