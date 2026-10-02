import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BPS,
  CURVE_SUPPLY,
  DEFAULT_FEE_PARAMS,
  DEFAULT_TRADE_FEE_BPS,
  INITIAL_RESERVES,
  LP_SUPPLY,
  TOTAL_SUPPLY,
  VIRTUAL_ETH,
  VIRTUAL_TOKENS,
  WAD,
  applySlippage,
  ceilDiv,
  completionReserves,
  ethForTokens,
  graduationSplit,
  isComplete,
  marketCap,
  priceOf,
  progressBps,
  quoteBuy,
  quoteSell,
  splitFee,
  type CurveReserves,
} from '../src/curve.js';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(here, '../fixtures/curve.json');

// ---------------------------------------------------------------------------
// Deterministic PRNG for property tests (no external deps)
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random bigint in [0, max]. */
function randBig(rng: () => number, max: bigint): bigint {
  if (max <= 0n) return 0n;
  const digits = max.toString().length;
  let out = 0n;
  for (let i = 0; i < digits + 2; i++) out = out * 10n + BigInt(Math.floor(rng() * 10));
  return out % (max + 1n);
}

/** Produces a reachable curve state by performing random buys from the initial state. */
function randomState(rng: () => number, feeBps = DEFAULT_TRADE_FEE_BPS): CurveReserves {
  let state: CurveReserves = { ...INITIAL_RESERVES };
  const steps = Math.floor(rng() * 6);
  for (let i = 0; i < steps; i++) {
    if (isComplete(state)) break;
    const ethIn = 1n + randBig(rng, WAD); // up to 1 ETH
    state = quoteBuy(state, ethIn, feeBps).next;
  }
  return state;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('curve constants (SPEC §1)', () => {
  it('match the normative values', () => {
    expect(TOTAL_SUPPLY).toBe(1_000_000_000n * 10n ** 18n);
    expect(CURVE_SUPPLY).toBe(800_000_000n * 10n ** 18n);
    expect(LP_SUPPLY).toBe(200_000_000n * 10n ** 18n);
    expect(CURVE_SUPPLY + LP_SUPPLY).toBe(TOTAL_SUPPLY);
    expect(VIRTUAL_ETH).toBe(1_365_000_000_000_000_000n);
    expect(VIRTUAL_TOKENS).toBe(1_073_000_000n * 10n ** 18n);
    expect(DEFAULT_FEE_PARAMS).toEqual({ tradeFeeBps: 100n, mindShareBps: 7000n, graduationFeeBps: 250n });
  });

  it('completes at ≈ 4.0 ETH collected (1.365·800/273)', () => {
    const done = completionReserves();
    expect(done.tokensSold).toBe(CURVE_SUPPLY);
    // 1.365 * 800 / 273 = 4.0 exactly
    expect(done.realEthReserve).toBe(4n * WAD);
  });

  it('final curve price ≈ 1.965e-8 ETH and LP price ≈ 1.95e-8 ETH', () => {
    const done = completionReserves();
    const price = Number(priceOf(done)) / 1e18;
    expect(price).toBeCloseTo(1.965e-8, 10);
    const split = graduationSplit(done);
    expect(Number(split.lpPriceWei) / 1e18).toBeCloseTo(1.95e-8, 10);
    expect(split.lpPriceWei < split.targetPriceWei).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('ceilDiv', () => {
  it('rounds up', () => {
    expect(ceilDiv(0n, 7n)).toBe(0n);
    expect(ceilDiv(1n, 7n)).toBe(1n);
    expect(ceilDiv(7n, 7n)).toBe(1n);
    expect(ceilDiv(8n, 7n)).toBe(2n);
    expect(ceilDiv(14n, 7n)).toBe(2n);
    expect(() => ceilDiv(1n, 0n)).toThrow(RangeError);
  });
});

describe('priceOf / marketCap / progressBps', () => {
  it('initial price = VIRTUAL_ETH·1e18/VIRTUAL_TOKENS', () => {
    expect(priceOf(INITIAL_RESERVES)).toBe((VIRTUAL_ETH * WAD) / VIRTUAL_TOKENS);
    expect(marketCap(INITIAL_RESERVES)).toBe((priceOf(INITIAL_RESERVES) * TOTAL_SUPPLY) / WAD);
  });
  it('progress is 0..10000', () => {
    expect(progressBps(0n)).toBe(0n);
    expect(progressBps(CURVE_SUPPLY / 2n)).toBe(5000n);
    expect(progressBps(CURVE_SUPPLY)).toBe(10000n);
    expect(() => progressBps(CURVE_SUPPLY + 1n)).toThrow(RangeError);
  });
  it('splitFee follows mindShareBps and never loses wei', () => {
    const { mindAmount, protocolAmount } = splitFee(1_000_001n, 7000n);
    expect(mindAmount).toBe(700_000n);
    expect(protocolAmount).toBe(300_001n);
    expect(mindAmount + protocolAmount).toBe(1_000_001n);
  });
  it('applySlippage', () => {
    expect(applySlippage(10_000n, 100n)).toBe(9_900n);
    expect(applySlippage(10_000n, 0n)).toBe(10_000n);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe('input validation', () => {
  it('rejects zero amounts and wrong phase', () => {
    expect(() => quoteBuy(INITIAL_RESERVES, 0n)).toThrow(/ZeroAmount/);
    expect(() => quoteSell(INITIAL_RESERVES, 0n)).toThrow(/ZeroAmount/);
    expect(() => quoteSell(INITIAL_RESERVES, 1n)).toThrow(/exceeds tokensSold/);
    expect(() => quoteBuy(completionReserves(), WAD)).toThrow(/WrongPhase/);
    expect(() => quoteBuy(INITIAL_RESERVES, WAD, 501n)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Property tests (self-contained)
// ---------------------------------------------------------------------------

describe('curve properties', () => {
  const rng = mulberry32(0xc0ffee);

  it('buy then sell never profits (rounding favours the contract), any fee incl. 0', () => {
    for (let i = 0; i < 400; i++) {
      const feeBps = i % 4 === 0 ? 0n : i % 4 === 1 ? 100n : i % 4 === 2 ? 500n : 37n;
      const state = randomState(rng, feeBps);
      if (isComplete(state)) continue;
      const ethIn = 1n + randBig(rng, 2n * WAD);
      const buy = quoteBuy(state, ethIn, feeBps);
      if (buy.tokensOut === 0n) continue;
      const sell = quoteSell(buy.next, buy.tokensOut, feeBps);
      expect(sell.ethOut <= buy.ethUsed).toBe(true);
      // the reserve never goes negative and returns to <= where it started
      expect(sell.next.realEthReserve >= 0n).toBe(true);
      expect(sell.next.realEthReserve >= state.realEthReserve).toBe(true);
      expect(sell.next.tokensSold).toBe(state.tokensSold);
    }
  });

  it('price is monotone: non-decreasing in buys, non-increasing in sells', () => {
    for (let i = 0; i < 300; i++) {
      const state = randomState(rng);
      if (isComplete(state)) continue;
      const p0 = priceOf(state);
      const buy = quoteBuy(state, 1n + randBig(rng, WAD));
      const p1 = priceOf(buy.next);
      expect(p1 >= p0).toBe(true);
      if (buy.tokensOut > 0n) {
        const sell = quoteSell(buy.next, 1n + randBig(rng, buy.tokensOut - 1n));
        expect(priceOf(sell.next) <= p1).toBe(true);
      }
    }
  });

  it('tokensOut is monotone non-decreasing in ethIn', () => {
    for (let i = 0; i < 200; i++) {
      const state = randomState(rng);
      if (isComplete(state)) continue;
      const a = 1n + randBig(rng, WAD);
      const b = a + 1n + randBig(rng, WAD);
      expect(quoteBuy(state, b).tokensOut >= quoteBuy(state, a).tokensOut).toBe(true);
    }
  });

  it('fee is exactly floor(ethIn·bps/10000) on non-completing buys and floor(ethGross·bps/10000) on sells', () => {
    for (let i = 0; i < 200; i++) {
      const state = randomState(rng);
      if (isComplete(state)) continue;
      const ethIn = 1n + randBig(rng, WAD / 10n);
      const buy = quoteBuy(state, ethIn);
      if (!buy.completes) {
        expect(buy.fee).toBe((ethIn * DEFAULT_TRADE_FEE_BPS) / BPS);
        expect(buy.ethUsed).toBe(ethIn);
        expect(buy.refund).toBe(0n);
        expect(buy.net).toBe(ethIn - buy.fee);
      }
      if (buy.tokensOut > 0n) {
        const sell = quoteSell(buy.next, buy.tokensOut);
        expect(sell.fee).toBe((sell.ethGross * DEFAULT_TRADE_FEE_BPS) / BPS);
        expect(sell.ethOut + sell.fee).toBe(sell.ethGross);
      }
    }
  });

  it('k never decreases across trades (rounding favours the contract)', () => {
    for (let i = 0; i < 200; i++) {
      const state = randomState(rng);
      if (isComplete(state)) continue;
      const k0 = (VIRTUAL_ETH + state.realEthReserve) * (VIRTUAL_TOKENS - state.tokensSold);
      const buy = quoteBuy(state, 1n + randBig(rng, WAD));
      const k1 = (VIRTUAL_ETH + buy.next.realEthReserve) * (VIRTUAL_TOKENS - buy.next.tokensSold);
      expect(k1 >= k0).toBe(true);
      if (buy.tokensOut > 0n) {
        const sell = quoteSell(buy.next, buy.tokensOut);
        const k2 = (VIRTUAL_ETH + sell.next.realEthReserve) * (VIRTUAL_TOKENS - sell.next.tokensSold);
        expect(k2 >= k1).toBe(true);
      }
    }
  });

  it('ethForTokens is a sufficient (and near-tight) inverse of quoteBuy', () => {
    for (let i = 0; i < 200; i++) {
      const state = randomState(rng);
      if (isComplete(state)) continue;
      const want = 1n + randBig(rng, CURVE_SUPPLY - state.tokensSold - 1n);
      const cost = ethForTokens(state, want);
      const got = quoteBuy(state, cost);
      expect(got.tokensOut >= want).toBe(true);
      expect(got.ethUsed <= cost).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Completion & refund
// ---------------------------------------------------------------------------

describe('completion and refund', () => {
  it('a huge buy completes the curve, is capped at the remaining supply and refunds the rest', () => {
    const ethIn = 100n * WAD;
    const buy = quoteBuy(INITIAL_RESERVES, ethIn);
    expect(buy.completes).toBe(true);
    expect(buy.tokensOut).toBe(CURVE_SUPPLY);
    expect(buy.next.tokensSold).toBe(CURVE_SUPPLY);
    expect(isComplete(buy.next)).toBe(true);
    // net' = ceilDiv(k, y - tokensOut) - x = 4 ETH exactly from the initial state
    expect(buy.net).toBe(4n * WAD);
    expect(buy.next.realEthReserve).toBe(4n * WAD);
    // fee' = ceilDiv(net'·100, 9900)
    expect(buy.fee).toBe(ceilDiv(buy.net * 100n, 9900n));
    expect(buy.ethUsed).toBe(buy.net + buy.fee);
    expect(buy.refund).toBe(ethIn - buy.ethUsed);
    expect(buy.refund > 0n).toBe(true);
    expect(buy.ethUsed < ethIn).toBe(true);
    // the completing ETH is ≈ 4.04 ETH (4 ETH net + 1 % fee on the gross)
    expect(Number(buy.ethUsed) / 1e18).toBeCloseTo(4.0404, 3);
  });

  it('the exact completing amount completes without refund; a few wei less does not complete', () => {
    const exact = ethForTokens(INITIAL_RESERVES, CURVE_SUPPLY);
    const buy = quoteBuy(INITIAL_RESERVES, exact);
    expect(buy.completes).toBe(true);
    expect(buy.tokensOut).toBe(CURVE_SUPPLY);
    expect(buy.refund).toBe(0n);
    expect(buy.ethUsed).toBe(exact);
    // ethForTokens rounds the fee up (ceilDiv) while a plain buy rounds it down, so the
    // threshold is tight only up to 2 wei: 3 wei less can never complete the curve.
    const less = quoteBuy(INITIAL_RESERVES, exact - 3n);
    expect(less.completes).toBe(false);
    expect(less.tokensOut < CURVE_SUPPLY).toBe(true);
    expect(less.refund).toBe(0n);
    expect(less.ethUsed).toBe(exact - 3n);
  });

  it('completion from an arbitrary partial state is consistent (refund + ethUsed == ethIn, reserve by net)', () => {
    const rng = mulberry32(42);
    for (let i = 0; i < 100; i++) {
      const state = randomState(rng);
      if (isComplete(state)) continue;
      const buy = quoteBuy(state, 10n * WAD);
      expect(buy.completes).toBe(true);
      expect(buy.tokensOut).toBe(CURVE_SUPPLY - state.tokensSold);
      expect(buy.ethUsed + buy.refund).toBe(10n * WAD);
      expect(buy.next.realEthReserve).toBe(state.realEthReserve + buy.net);
      expect(buy.ethUsed).toBe(ethForTokens(state, buy.tokensOut));
      // a sell of everything after completion returns at most what was put in
      const sell = quoteSell(buy.next, buy.tokensOut);
      expect(sell.ethOut <= buy.ethUsed).toBe(true);
    }
  });

  it('never charges more than ethIn at the exact completion threshold (ceil-fee rounding guard)', () => {
    // Scan partial states; at `ethForTokens(...) - d` for small d the literal SPEC formula
    // would yield ethUsed = ethIn + 1 wei in roughly a third of the states.
    let completing = 0;
    for (let i = 1; i <= 300; i++) {
      const state = quoteBuy(INITIAL_RESERVES, (BigInt(i) * WAD) / 100n).next;
      const exact = ethForTokens(state, CURVE_SUPPLY - state.tokensSold);
      for (const d of [0n, 1n, 2n]) {
        const ethIn = exact - d;
        const q = quoteBuy(state, ethIn);
        expect(q.ethUsed <= ethIn, `state ${i} d=${d}`).toBe(true);
        expect(q.refund >= 0n, `state ${i} d=${d}`).toBe(true);
        expect(q.ethUsed).toBe(q.net + q.fee);
        // the fee never drops below the floor rule the buyer would pay on a plain buy
        expect(q.fee >= (q.ethUsed * DEFAULT_TRADE_FEE_BPS) / BPS, `state ${i} d=${d} fee floor`).toBe(true);
        if (q.completes) {
          completing++;
          expect(q.next.tokensSold).toBe(CURVE_SUPPLY);
          expect(q.next.realEthReserve).toBe(state.realEthReserve + q.net);
        }
      }
    }
    expect(completing).toBeGreaterThan(300);
  });

  it('graduation split', () => {
    const done = completionReserves();
    const split = graduationSplit(done);
    expect(split.graduationFee).toBe((done.realEthReserve * 250n) / BPS);
    expect(split.mindFee + split.protocolFee).toBe(split.graduationFee);
    expect(split.mindFee).toBe((split.graduationFee * 7000n) / BPS);
    expect(split.ethLiquidity + split.graduationFee).toBe(done.realEthReserve);
    expect(split.tokenLiquidity).toBe(LP_SUPPLY);
    expect(split.targetPriceWei).toBe(priceOf(done));
  });
});

// ---------------------------------------------------------------------------
// Foundry fixture equivalence
// ---------------------------------------------------------------------------

interface FixtureCase {
  realEthReserve: string | number;
  tokensSold: string | number;
  op: string;
  amountIn: string | number;
  tokensOut?: string | number;
  ethOut?: string | number;
  ethUsed?: string | number;
  fee?: string | number;
  tradeFeeBps?: string | number;
}

function big(v: string | number | undefined): bigint | undefined {
  if (v === undefined || v === null) return undefined;
  return BigInt(typeof v === 'number' ? Math.trunc(v) : v);
}

function loadFixture(): { cases: FixtureCase[]; tradeFeeBps: bigint } | undefined {
  if (!existsSync(FIXTURE_PATH)) return undefined;
  const raw: unknown = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
  if (Array.isArray(raw)) return { cases: raw as FixtureCase[], tradeFeeBps: DEFAULT_TRADE_FEE_BPS };
  if (raw !== null && typeof raw === 'object') {
    const obj = raw as { cases?: unknown; tradeFeeBps?: string | number };
    if (Array.isArray(obj.cases)) {
      return { cases: obj.cases as FixtureCase[], tradeFeeBps: big(obj.tradeFeeBps) ?? DEFAULT_TRADE_FEE_BPS };
    }
  }
  throw new Error(`unrecognised fixture shape in ${FIXTURE_PATH}`);
}

const fixture = loadFixture();

describe.skipIf(fixture === undefined)('Foundry fixture equivalence (fixtures/curve.json)', () => {
  it('has at least 40 cases', () => {
    expect(fixture?.cases.length ?? 0).toBeGreaterThanOrEqual(40);
  });

  it('every case matches the TS mirror exactly', () => {
    const { cases, tradeFeeBps: defaultFee } = fixture as NonNullable<typeof fixture>;
    for (const [i, c] of cases.entries()) {
      const state: CurveReserves = { realEthReserve: big(c.realEthReserve) ?? 0n, tokensSold: big(c.tokensSold) ?? 0n };
      const feeBps = big(c.tradeFeeBps) ?? defaultFee;
      const amountIn = big(c.amountIn) ?? 0n;
      const label = `case #${i} (${c.op}, amountIn=${amountIn})`;
      if (c.op === 'sell') {
        const q = quoteSell(state, amountIn, feeBps);
        expect(q.ethOut, `${label} ethOut`).toBe(big(c.ethOut));
        expect(q.fee, `${label} fee`).toBe(big(c.fee));
      } else if (c.op === 'buy' || c.op === 'complete') {
        const q = quoteBuy(state, amountIn, feeBps);
        expect(q.tokensOut, `${label} tokensOut`).toBe(big(c.tokensOut));
        expect(q.ethUsed, `${label} ethUsed`).toBe(big(c.ethUsed));
        expect(q.fee, `${label} fee`).toBe(big(c.fee));
        if (c.op === 'complete') expect(q.completes, `${label} completes`).toBe(true);
      } else {
        throw new Error(`${label}: unknown op`);
      }
    }
  });
});

if (fixture === undefined) {
  // eslint-disable-next-line no-console
  console.info(
    `[curve.test] fixtures/curve.json not found at ${FIXTURE_PATH} — Foundry equivalence skipped. ` +
      'Generate it with `cd contracts && forge script script/GenerateFixtures.s.sol` (see fixtures/README.md).',
  );
}
