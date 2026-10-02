import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import {
  mindDetailSchema,
  mindLaunchpadAbi,
  mindSummarySchema,
  ponsCurveAbi,
  ponsFactoryAbi,
  ponsFeeEscrowAbi,
  ponsMemeHookAbi,
  ponsMindRegistryAbi,
  ponsPrice,
  ponsQuoteBuy,
  ponsQuoteSell,
  ponsReservesAfterBuy,
  ponsReservesAfterSell,
} from '@www-rh/shared';
import { mindDetailDto, mindSummaryDto } from '../src/api/dto.js';
import { addressTopic, type PonsCurveState } from '../src/chain/pons.js';
import { STATE_TOTAL_FEES_TO_MINDS, STATE_TOTAL_VOLUME } from '../src/indexer/apply.js';
import { IndexerEvents, type IndexedEvent } from '../src/indexer/events.js';
import { Indexer } from '../src/indexer/indexer.js';
import { PonsIndexerVenue, walkBackStates } from '../src/indexer/pons.js';
import { CurveIndexerVenue } from '../src/indexer/venue.js';
import { CREATOR, FakeLogSource, LAUNCHPAD, memoryRepos, mindCreatedLog, silentLogger, TOKEN } from './helpers.js';
import {
  AACCOUNT,
  ACURVE,
  ATOKEN,
  BUYER,
  E,
  encodePonsLog,
  ESCROW,
  FACTORY,
  FakePonsReader,
  HOOK,
  launchedToken,
  mindCreatedArgs,
  PACCOUNT,
  PCURVE,
  PHANTOM,
  PTOKEN,
  REGISTRY,
  RESERVED,
  SUPPLY,
  THRESHOLD,
} from './ponsHelpers.js';

const reg = (eventName: string, args: Record<string, unknown>, block: bigint, logIndex: number, tx?: `0x${string}`) =>
  encodePonsLog(ponsMindRegistryAbi, eventName, args, { address: REGISTRY, block, logIndex, ...(tx ? { tx } : {}) });
const curve = (eventName: string, args: Record<string, unknown>, block: bigint, logIndex: number, address: Address = PCURVE, tx?: `0x${string}`) =>
  encodePonsLog(ponsCurveAbi, eventName, args, { address, block, logIndex, ...(tx ? { tx } : {}) });
const factory = (eventName: string, args: Record<string, unknown>, block: bigint, logIndex: number) => encodePonsLog(ponsFactoryAbi, eventName, args, { address: FACTORY, block, logIndex });
const escrow = (eventName: string, args: Record<string, unknown>, block: bigint, logIndex: number) => encodePonsLog(ponsFeeEscrowAbi, eventName, args, { address: ESCROW, block, logIndex });
const hook = (eventName: string, args: Record<string, unknown>, block: bigint, logIndex: number) => encodePonsLog(ponsMemeHookAbi, eventName, args, { address: HOOK, block, logIndex });

function setup() {
  const repos = memoryRepos();
  const source = new FakeLogSource();
  source.byAddress = true;
  const reader = new FakePonsReader();
  const events = new IndexerEvents();
  const seen: IndexedEvent[] = [];
  events.on((e) => seen.push(e));
  const indexer = new Indexer(repos, source, events, { address: REGISTRY, venue: new PonsIndexerVenue(REGISTRY, reader, silentLogger), startBlock: 0n, confirmations: 0 }, silentLogger);
  return { repos, source, reader, seen, indexer };
}

const state = (r: { quoteReserve: bigint; tokenReserve: bigint }): PonsCurveState => ({ ...r, realQuoteReserve: r.quoteReserve - PHANTOM });
const params = { feeBps: 100n, taxBps: 0n };

describe('Pons indexer (SPEC §9.4)', () => {
  it('indexes a mind launched here: registration, trades (§5 DTO), per-block reserve anchoring, escrow, sweep, graduation, pool id; idempotent', async () => {
    const { repos, source, reader, seen, indexer } = setup();
    // ---- block 10: launchMind = MindCreated + MindLaunched + the creator's initial buy (registry is the buyer)
    const s0 = { quoteReserve: PHANTOM, tokenReserve: SUPPLY };
    const b1 = ponsQuoteBuy({ quoteIn: E, ...s0, sellable: SUPPLY - RESERVED, ...params });
    const s1 = ponsReservesAfterBuy(s0, b1);
    const launchTx = `0x${'1a'.repeat(32)}` as const;
    reader.launched.set(PTOKEN, launchedToken(PCURVE));
    reader.states.set(`${PCURVE}@10`, state(s1));
    source.logs.push(
      reg('MindCreated', mindCreatedArgs(PTOKEN), 10n, 0, launchTx),
      reg('MindLaunched', { token: PTOKEN, curve: PCURVE, account: PACCOUNT, creator: CREATOR, launchConfigId: 0n }, 10n, 1, launchTx),
      curve('CurveBuy', { buyer: REGISTRY, recipient: CREATOR, quoteIn: b1.spent, tokensOut: b1.tokensOut, fee: b1.fee, tax: b1.tax }, 10n, 2, PCURVE, launchTx),
      // a curve we do not know is never requested
      curve('CurveBuy', { buyer: BUYER, recipient: BUYER, quoteIn: E, tokensOut: 1n, fee: 1n, tax: 0n }, 10n, 3, '0x' + 'ab'.repeat(20) as Address),
    );
    source.head = 10n;
    await indexer.syncOnce();
    const mind = repos.minds.get(PTOKEN)!;
    expect([mind.venue, mind.status, mind.phase]).toEqual(['pons', 0, 0]);
    const p = repos.pons.get(PTOKEN)!;
    expect(p).toMatchObject({ curve: PCURVE, account: PACCOUNT, launched_here: 1, adopted: 0, launch_config_id: 0, fee_bps: 100, creator_tax_bps: 0, supply: SUPPLY.toString(), graduation_threshold: THRESHOLD.toString(), phantom_quote: PHANTOM.toString(), deployer: REGISTRY });
    const [t1] = repos.trades.listByToken(PTOKEN, 10);
    expect(t1).toMatchObject({
      trader: CREATOR.toLowerCase(), is_buy: 1, eth_amount: E.toString(), token_amount: b1.tokensOut.toString(), fee: (b1.fee + b1.tax).toString(),
      price_wei: ponsPrice(s1.quoteReserve, s1.tokenReserve).toString(), real_eth_reserve: (s1.quoteReserve - PHANTOM).toString(), tokens_sold: b1.tokensOut.toString(),
    });
    expect(repos.trades.listByToken('0x' + 'ab'.repeat(20), 10)).toHaveLength(0);
    expect(source.filtered.some((f) => Array.isArray(f.address) && f.address.includes(PCURVE))).toBe(true);
    expect(source.filtered.find((f) => f.address === FACTORY)?.topics?.[1]).toEqual([addressTopic(PTOKEN)]);
    expect(source.filtered.find((f) => f.address === ESCROW)?.topics?.[1]).toEqual([addressTopic(PACCOUNT)]);
    expect(seen.map((e) => e.type)).toEqual(['mind:created', 'trade']);

    // ---- block 12: two trades in one block (walked back from the end-of-block read) + escrow credits
    const b2 = ponsQuoteBuy({ quoteIn: E / 2n, ...s1, sellable: s1.tokenReserve - RESERVED, ...params });
    const s2 = ponsReservesAfterBuy(s1, b2);
    const sell = ponsQuoteSell({ tokensIn: b2.tokensOut / 2n, ...s2, ...params });
    const s3 = ponsReservesAfterSell(s2, b2.tokensOut / 2n, sell);
    reader.states.set(`${PCURVE}@12`, state(s3));
    source.logs.push(
      curve('CurveBuy', { buyer: BUYER, recipient: BUYER, quoteIn: b2.spent, tokensOut: b2.tokensOut, fee: b2.fee, tax: b2.tax }, 12n, 0),
      curve('CurveSell', { seller: BUYER, recipient: BUYER, tokensIn: b2.tokensOut / 2n, quoteOut: sell.quoteOut, fee: sell.fee, tax: sell.tax }, 12n, 1),
      escrow('Credited', { recipient: PACCOUNT, depositor: PCURVE, amount: 7n * 10n ** 15n }, 12n, 2),
      escrow('Credited', { recipient: BUYER, depositor: PCURVE, amount: E }, 12n, 3), // someone else's balance
    );
    source.head = 12n;
    await indexer.syncOnce();
    const trades = repos.trades.listByToken(PTOKEN, 10);
    expect(trades.map((t) => t.price_wei)).toEqual([s3, s2, s1].map((s) => ponsPrice(s.quoteReserve, s.tokenReserve).toString()));
    expect(trades[0]).toMatchObject({ is_buy: 0, eth_amount: sell.quoteOut.toString(), fee: (sell.fee + sell.tax).toString(), trader: BUYER });
    expect(repos.pons.get(PTOKEN)?.claimable).toBe((7n * 10n ** 15n).toString());
    expect(repos.pons.get(PTOKEN)?.pending_fee).toBe((b1.fee + b2.fee + sell.fee).toString());
    expect(repos.state.bigint(STATE_TOTAL_VOLUME)).toBe(E + E / 2n + sell.grossQuoteOut);

    // ---- block 13: historical read unavailable → reserves follow forward from the last indexed state; then a sweep
    const b3 = ponsQuoteBuy({ quoteIn: E / 10n, ...s3, sellable: s3.tokenReserve - RESERVED, ...params });
    const s4 = ponsReservesAfterBuy(s3, b3);
    source.logs.push(
      curve('CurveBuy', { buyer: BUYER, recipient: BUYER, quoteIn: b3.spent, tokensOut: b3.tokensOut, fee: b3.fee, tax: b3.tax }, 13n, 0),
      curve('FeesSwept', { protocolAmount: 1n, buybackAmount: 0n, creatorAmount: 2n }, 13n, 1),
    );
    source.head = 13n;
    await indexer.syncOnce();
    expect(repos.minds.get(PTOKEN)?.price_wei).toBe(ponsPrice(s4.quoteReserve, s4.tokenReserve).toString());
    expect(repos.pons.get(PTOKEN)).toMatchObject({ pending_fee: '0', pending_tax: '0', quote_reserve: s4.quoteReserve.toString() });

    // ---- block 14: harvest (registry: Harvested + MindFunded; escrow: Claimed)
    const out = 7n * 10n ** 15n;
    source.logs.push(
      escrow('Claimed', { recipient: PACCOUNT, amount: out }, 14n, 0),
      reg('MindFunded', { token: PTOKEN, from: PACCOUNT, amount: out }, 14n, 1),
      reg('Harvested', { token: PTOKEN, ethOut: out, tokensBurned: 0n }, 14n, 2),
    );
    source.head = 14n;
    await indexer.syncOnce();
    expect(repos.pons.get(PTOKEN)?.claimable).toBe('0');
    expect(repos.minds.get(PTOKEN)?.mind_balance).toBe(out.toString());
    expect(repos.state.bigint(STATE_TOTAL_FEES_TO_MINDS)).toBe(out);
    expect(repos.pons.get(PTOKEN)?.last_harvest_at).toBe((1_790_000_000 + 14) * 1000);

    // ---- block 20: the crossing buy graduates the curve automatically (Swept): price frozen at the final curve state
    const b4 = ponsQuoteBuy({ quoteIn: 10n * E, ...s4, sellable: s4.tokenReserve - RESERVED, ...params });
    expect(b4.capped).toBe(true);
    const s5 = ponsReservesAfterBuy(s4, b4);
    const quoteOut = s5.quoteReserve - PHANTOM;
    reader.states.set(`${PCURVE}@20`, { quoteReserve: PHANTOM, tokenReserve: 0n, realQuoteReserve: 0n }); // drained
    source.logs.push(
      curve('CurveBuyRefunded', { buyer: BUYER, refund: b4.refund }, 20n, 0),
      curve('CurveBuy', { buyer: BUYER, recipient: BUYER, quoteIn: b4.spent, tokensOut: b4.tokensOut, fee: b4.fee, tax: b4.tax }, 20n, 1),
      curve('FeesSwept', { protocolAmount: 1n, buybackAmount: 0n, creatorAmount: 2n }, 20n, 2),
      curve('CurveCompleted', { recipient: FACTORY, quoteOut, tokenOut: RESERVED }, 20n, 3),
      factory('LaunchSwept', { token: PTOKEN, quoteOut, tokenOut: RESERVED }, 20n, 4),
    );
    source.head = 20n;
    await indexer.syncOnce();
    const swept = repos.minds.get(PTOKEN)!;
    const finalPrice = ponsPrice(PHANTOM + quoteOut, RESERVED).toString();
    expect([swept.phase, swept.price_wei, swept.tokens_sold]).toEqual([1, finalPrice, (SUPPLY - RESERVED).toString()]);
    expect(repos.trades.listByToken(PTOKEN, 1)[0]?.price_wei).toBe(finalPrice);
    expect(repos.pons.get(PTOKEN)?.swept_at).toBe((1_790_000_000 + 20) * 1000);
    expect(seen.filter((e) => e.blockNumber === 20).map((e) => e.type)).toEqual(['trade', 'curve:complete']);

    // ---- block 30: pool created (PoolCreated → graduated); only our memecoin's PoolRegistered counts
    const poolId = `0x${'90'.repeat(32)}` as const;
    source.logs.push(
      hook('PoolRegistered', { poolId: `0x${'91'.repeat(32)}`, memecoin: BUYER, quoteToken: '0x0000000000000000000000000000000000000000', creator: BUYER }, 30n, 0),
      hook('PoolRegistered', { poolId, memecoin: PTOKEN, quoteToken: '0x0000000000000000000000000000000000000000', creator: PACCOUNT }, 30n, 1),
      factory('PoolGraduated', { token: PTOKEN, positionId: 7n, tokenAmount: RESERVED, pairTokenAmount: quoteOut }, 30n, 2),
      reg('PoolIdSet', { token: PTOKEN, poolId }, 31n, 0),
    );
    source.head = 31n;
    await indexer.syncOnce();
    const grad = repos.minds.get(PTOKEN)!;
    expect([grad.phase, grad.position_id, grad.real_eth_reserve, grad.price_wei]).toEqual([2, '7', '0', finalPrice]);
    expect(repos.pons.get(PTOKEN)).toMatchObject({ pool_id: poolId, registry_pool_id: poolId, launch_phase: 2 });
    expect(seen.filter((e) => e.blockNumber === 30).map((e) => e.type)).toEqual(['pons:pool-registered', 'graduated']);

    // ---- DTOs parse with the shared schemas
    const detail = mindDetailSchema.parse(mindDetailDto(grad, undefined, repos.pons.get(PTOKEN)));
    expect(detail).toMatchObject({ venue: 'pons', phase: 'graduated', progressBps: 10_000, pons: { curve: PCURVE, account: PACCOUNT, launchedHere: true, adopted: false, poolId, claimableWei: '0', feeBps: 100 } });
    expect(BigInt(detail.marketCapWei)).toBe((BigInt(finalPrice) * SUPPLY) / E);

    // ---- replaying everything changes nothing
    const snapshot = JSON.stringify([repos.minds.get(PTOKEN), repos.pons.get(PTOKEN), repos.trades.listByToken(PTOKEN, 50), repos.state.bigint(STATE_TOTAL_VOLUME).toString(), repos.chain.eventCount()]);
    repos.state.setLastBlock(-1n);
    repos.chain.deleteBlockHashesAbove(-1);
    await indexer.syncOnce();
    expect(JSON.stringify([repos.minds.get(PTOKEN), repos.pons.get(PTOKEN), repos.trades.listByToken(PTOKEN, 50), repos.state.bigint(STATE_TOTAL_VOLUME).toString(), repos.chain.eventCount()])).toBe(snapshot);
  });

  it('adoption: AdoptionPrepared (Dormant, mind built from chain reads), recipient hand-off, MindAdopted (Alive), MindLeft (Dormant)', async () => {
    const { repos, source, reader, seen, indexer } = setup();
    const mid = { quoteReserve: PHANTOM + 2n * E, tokenReserve: SUPPLY / 2n };
    reader.launched.set(ATOKEN, launchedToken(ACURVE, { deployer: BUYER, creatorFeeRecipient: CREATOR, creatorTaxBps: 200 }));
    reader.minds.set(ATOKEN, { curve: ACURVE, account: AACCOUNT, launchConfigId: 0n, launchedHere: false, adopted: false });
    reader.mindInfo.set(ATOKEN, { creator: CREATOR, modelId: mindCreatedArgs(ATOKEN)['modelId'] as `0x${string}`, personaHash: mindCreatedArgs(ATOKEN)['personaHash'] as `0x${string}`, metadataURI: 'ipfs://bafy-adopt', createdAt: 1n, status: 1 });
    reader.states.set(`${ACURVE}@40`, state(mid));
    source.logs.push(reg('AdoptionPrepared', { token: ATOKEN, account: AACCOUNT, creator: CREATOR }, 40n, 0));
    source.head = 40n;
    await indexer.syncOnce();
    let m = repos.minds.get(ATOKEN)!;
    expect([m.venue, m.name, m.symbol, m.status, m.metadata_uri, m.creator, m.price_wei]).toEqual(['pons', 'Adopted Coin', 'ADPT', 1, 'ipfs://bafy-adopt', CREATOR.toLowerCase(), ponsPrice(mid.quoteReserve, mid.tokenReserve).toString()]);
    // the registry records launchConfigId 0 for adoptions as a placeholder: reported as unknown
    expect(repos.pons.get(ATOKEN)).toMatchObject({ curve: ACURVE, account: AACCOUNT, launched_here: 0, adopted: 0, deployer: BUYER, fee_recipient: CREATOR.toLowerCase(), launch_config_id: null });
    expect(seen.map((e) => e.type)).toEqual(['mind:created', 'mind:status']);
    source.logs.push(
      factory('CreatorFeeRecipientUpdated', { token: ATOKEN, previousRecipient: CREATOR, newRecipient: AACCOUNT }, 41n, 0),
      reg('MindAdopted', { token: ATOKEN, account: AACCOUNT }, 41n, 1),
    );
    source.head = 41n;
    await indexer.syncOnce();
    m = repos.minds.get(ATOKEN)!;
    expect(m.status).toBe(0);
    expect(repos.pons.get(ATOKEN)).toMatchObject({ adopted: 1, fee_recipient: AACCOUNT });
    expect(seen.slice(2).map((e) => e.type)).toEqual(['pons:adopted', 'mind:status']);
    source.logs.push(reg('MindLeft', { token: ATOKEN, newRecipient: CREATOR }, 42n, 0));
    source.head = 42n;
    await indexer.syncOnce();
    expect(repos.minds.get(ATOKEN)?.status).toBe(1);
    expect(seen.slice(4).map((e) => e.type)).toEqual(['pons:left', 'mind:status']);
    const summary = mindSummarySchema.parse(mindSummaryDto(repos.minds.get(ATOKEN)!, undefined, repos.pons.get(ATOKEN)));
    expect(summary).toMatchObject({ venue: 'pons', status: 'dormant', progressBps: Number(((mid.quoteReserve - PHANTOM) * 10_000n) / THRESHOLD) });
  });

  it('adopting a launch that already graduated: phase graduated, price frozen from the swept amounts', async () => {
    const { repos, source, reader, indexer } = setup();
    reader.launched.set(ATOKEN, launchedToken(ACURVE, { phase: 2, sweptQuote: THRESHOLD, sweptTokens: RESERVED, sweptAt: 1_700_000_000n }));
    reader.minds.set(ATOKEN, { curve: ACURVE, account: AACCOUNT, launchConfigId: 0n, launchedHere: false, adopted: false });
    reader.states.set(`${ACURVE}@50`, { quoteReserve: PHANTOM, tokenReserve: 0n, realQuoteReserve: 0n });
    source.logs.push(reg('MindCreated', mindCreatedArgs(ATOKEN), 50n, 0), reg('AdoptionPrepared', { token: ATOKEN, account: AACCOUNT, creator: CREATOR }, 50n, 1));
    source.head = 50n;
    await indexer.syncOnce();
    const m = repos.minds.get(ATOKEN)!;
    expect([m.phase, m.status, m.price_wei]).toEqual([2, 1, ponsPrice(PHANTOM + THRESHOLD, RESERVED).toString()]);
    expect(repos.pons.get(ATOKEN)).toMatchObject({ launch_phase: 2, swept_at: 1_700_000_000_000 });
  });

  it('an unresolvable registration (no curve) fails the range so it is retried; nothing is committed', async () => {
    const { repos, source, indexer } = setup();
    source.logs.push(reg('AdoptionPrepared', { token: ATOKEN, account: AACCOUNT, creator: CREATOR }, 5n, 0));
    source.head = 5n;
    await expect(indexer.syncOnce()).rejects.toThrow(/cannot resolve the Pons curve/);
    expect(repos.state.lastBlock()).toBeUndefined();
    expect(repos.minds.get(ATOKEN)).toBeUndefined();
  });

  it('walkBackStates: trades of one block are anchored at the state after the last one', () => {
    const after: PonsCurveState = { quoteReserve: 1000n, tokenReserve: 500n, realQuoteReserve: 100n };
    const states = walkBackStates(
      [
        { key: 'a', isBuy: true, quote: 110n, tokens: 50n, fee: 1n, tax: 9n },
        { key: 'b', isBuy: false, quote: 40n, tokens: 20n, fee: 2n, tax: 3n },
      ],
      after,
    );
    expect(states.get('b')).toEqual(after);
    // before 'b' (a sell of gross 45): quote +45, tokens −20
    expect(states.get('a')).toEqual({ quoteReserve: 1045n, tokenReserve: 480n, realQuoteReserve: 145n });
  });
});

describe('curve venue indexer (SPEC §4.1)', () => {
  it('indexes MindLaunchpad logs only; registry-only events on the launchpad address are ignored', async () => {
    const repos = memoryRepos();
    const source = new FakeLogSource();
    const indexer = new Indexer(repos, source, new IndexerEvents(), { address: LAUNCHPAD, venue: new CurveIndexerVenue(LAUNCHPAD), startBlock: 0n, confirmations: 0 }, silentLogger);
    source.logs = [
      mindCreatedLog(TOKEN, 1n),
      { ...encodePonsLog(ponsMindRegistryAbi, 'MindLaunched', { token: PTOKEN, curve: PCURVE, account: PACCOUNT, creator: CREATOR, launchConfigId: 0n }, { address: LAUNCHPAD, block: 2n, logIndex: 0 }) },
    ];
    source.head = 2n;
    const r = await indexer.syncOnce();
    expect(r.logs).toBe(1);
    expect(repos.minds.get(TOKEN)?.venue).toBe('curve');
    expect(repos.minds.get(PTOKEN)).toBeUndefined();
    expect(repos.pons.all()).toEqual([]);
    expect(mindLaunchpadAbi.some((i) => i.type === 'event' && (i.name as string) === 'MindLaunched')).toBe(false);
  });
});
