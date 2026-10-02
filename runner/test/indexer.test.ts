import { describe, expect, it } from 'vitest';
import { CURVE_SUPPLY, priceOf } from '@www-rh/shared';
import { IndexerEvents, type IndexedEvent } from '../src/indexer/events.js';
import { Indexer } from '../src/indexer/indexer.js';
import { STATE_TOTAL_FEES_TO_MINDS, STATE_TOTAL_VOLUME } from '../src/indexer/apply.js';
import { encodeLog, FakeLogSource, LAUNCHPAD, memoryRepos, mindCreatedLog, silentLogger, TOKEN, TOKEN2 } from './helpers.js';

const ETH = 10n ** 18n;

function setup(opts: { startBlock?: bigint; confirmations?: number } = {}) {
  const repos = memoryRepos();
  const source = new FakeLogSource();
  const events = new IndexerEvents();
  const seen: IndexedEvent[] = [];
  events.on((e) => seen.push(e));
  const indexer = new Indexer(repos, source, events, { address: LAUNCHPAD, startBlock: opts.startBlock ?? 0n, confirmations: opts.confirmations ?? 0, pollMs: 5, maxBackoffMs: 20 }, silentLogger);
  return { repos, source, events, seen, indexer };
}

function trade(block: bigint, logIndex: number, isBuy: boolean, ethAmount: bigint, tokenAmount: bigint, fee: bigint, realEthReserve: bigint, tokensSold: bigint) {
  return encodeLog('Trade', { token: TOKEN, trader: TOKEN2, isBuy, ethAmount, tokenAmount, fee, realEthReserve, tokensSold }, { block, logIndex });
}

describe('indexer', () => {
  it('applies a range idempotently on (txHash, logIndex) and derives the vault balance', async () => {
    const { repos, source, indexer } = setup();
    source.logs = [
      mindCreatedLog(TOKEN, 10n),
      trade(11n, 0, true, ETH, 1000n, ETH / 100n, ETH - ETH / 100n, 1000n),
      encodeLog('FeeAccrued', { token: TOKEN, mindAmount: 7n * 10n ** 15n, protocolAmount: 3n * 10n ** 15n }, { block: 11n, logIndex: 1 }),
      encodeLog('MindFunded', { token: TOKEN, from: TOKEN2, amount: ETH / 10n }, { block: 12n, logIndex: 0 }),
      encodeLog('ComputeDrawn', { token: TOKEN, amount: 10n ** 15n, receiptHash: `0x${'ee'.repeat(32)}` }, { block: 13n, logIndex: 0 }),
    ];
    source.head = 20n;
    await indexer.syncOnce();
    const balance = 7n * 10n ** 15n + ETH / 10n - 10n ** 15n;
    expect(repos.minds.get(TOKEN)?.mind_balance).toBe(balance.toString());
    expect(repos.trades.listByToken(TOKEN, 10)).toHaveLength(1);
    expect(repos.state.bigint(STATE_TOTAL_VOLUME)).toBe(ETH);
    expect(repos.state.bigint(STATE_TOTAL_FEES_TO_MINDS)).toBe(7n * 10n ** 15n);
    // replay the same range (e.g. crash before the next poll): nothing changes
    repos.state.setLastBlock(0n);
    await indexer.syncOnce();
    expect(repos.minds.get(TOKEN)?.mind_balance).toBe(balance.toString());
    expect(repos.trades.listByToken(TOKEN, 10)).toHaveLength(1);
    expect(repos.chain.eventCount()).toBe(5);
    expect(repos.state.bigint(STATE_TOTAL_VOLUME)).toBe(ETH);
  });

  it('applies logs in (blockNumber, logIndex) order regardless of RPC order', async () => {
    const { repos, source, indexer } = setup();
    source.logs = [trade(12n, 0, true, ETH, 5000n, 0n, ETH, 5000n), trade(11n, 3, true, ETH, 1000n, 0n, ETH, 1000n), mindCreatedLog(TOKEN, 11n, 0)];
    source.head = 12n;
    await indexer.syncOnce();
    const mind = repos.minds.get(TOKEN);
    expect(mind?.tokens_sold).toBe('5000');
    expect(repos.trades.listByToken(TOKEN, 10).map((t) => t.block_number)).toEqual([12, 11]);
  });

  it('splits ranges at 2000 blocks, honours CONFIRMATIONS and resumes from indexer_state', async () => {
    const { repos, source, indexer, events } = setup({ startBlock: 100n, confirmations: 5 });
    source.head = 4605n;
    await indexer.syncOnce();
    expect(source.calls).toEqual([
      { from: 100n, to: 2099n },
      { from: 2100n, to: 4099n },
      { from: 4100n, to: 4600n },
    ]);
    expect(repos.state.lastBlock()).toBe(4600n);
    const again = new Indexer(repos, source, events, { address: LAUNCHPAD, startBlock: 100n, confirmations: 5 }, silentLogger);
    source.calls = [];
    source.head = 4700n;
    await again.syncOnce();
    expect(source.calls).toEqual([{ from: 4601n, to: 4695n }]);
  });

  it('emits events only for live logs (block >= head observed at startup)', async () => {
    const { source, seen, indexer } = setup();
    source.logs = [mindCreatedLog(TOKEN, 5n), trade(6n, 0, true, ETH, 10n, 0n, ETH, 10n), trade(50n, 0, true, ETH, 20n, 0n, 2n * ETH, 30n)];
    source.head = 50n;
    await indexer.syncOnce();
    // blocks 5 and 6 are replayed history; block 50 is the startup head, hence live
    expect(seen.map((e) => `${e.type}@${e.blockNumber}`)).toEqual(['trade@50']);
    source.logs.push(encodeLog('CurveCompleted', { token: TOKEN, realEthReserve: 4n * ETH }, { block: 51n, logIndex: 0 }));
    source.head = 51n;
    await indexer.syncOnce();
    expect(seen.map((e) => `${e.type}@${e.blockNumber}`)).toEqual(['trade@50', 'curve:complete@51']);
  });

  it('derives phase, frozen price, graduation, status, config and anchors', async () => {
    const { repos, source, indexer } = setup();
    source.logs = [
      mindCreatedLog(TOKEN, 1n),
      encodeLog('CurveCompleted', { token: TOKEN, realEthReserve: 4n * ETH }, { block: 2n, logIndex: 0 }),
    ];
    source.head = 2n;
    await indexer.syncOnce();
    let m = repos.minds.get(TOKEN)!;
    expect(m.phase).toBe(1);
    expect(m.price_wei).toBe(priceOf({ realEthReserve: 4n * ETH, tokensSold: CURVE_SUPPLY }).toString());
    source.logs.push(
      encodeLog('Graduated', { token: TOKEN, pool: TOKEN2, positionId: 0n, ethLiquidity: 39n * ETH / 10n, tokenLiquidity: 200_000_000n * ETH, graduationFee: ETH / 10n }, { block: 3n, logIndex: 0 }),
      encodeLog('MindStatusChanged', { token: TOKEN, status: 2 }, { block: 3n, logIndex: 1 }),
      encodeLog('MindConfigUpdated', { token: TOKEN, modelId: `0x${'12'.repeat(32)}`, personaHash: `0x${'34'.repeat(32)}`, metadataURI: 'ipfs://bafy' }, { block: 3n, logIndex: 2 }),
    );
    source.head = 3n;
    await indexer.syncOnce();
    m = repos.minds.get(TOKEN)!;
    expect([m.phase, m.pool, m.position_id, m.real_eth_reserve, m.status, m.metadata_uri, m.meta_status]).toEqual([2, TOKEN2, '0', '0', 2, 'ipfs://bafy', 'pending']);
    expect(m.price_wei).toBe(priceOf({ realEthReserve: 4n * ETH, tokensSold: CURVE_SUPPLY }).toString()); // frozen after graduation
  });

  it('CurveReopened puts a Complete curve back to Bonding; the following sell sets reserve and price', async () => {
    const { repos, source, seen, indexer } = setup();
    source.logs = [
      mindCreatedLog(TOKEN, 1n),
      encodeLog('CurveCompleted', { token: TOKEN, realEthReserve: 4n * ETH }, { block: 2n, logIndex: 0 }),
    ];
    source.head = 2n;
    await indexer.syncOnce();
    expect(repos.minds.get(TOKEN)?.phase).toBe(1);
    const sold = CURVE_SUPPLY - 1_000_000n * ETH;
    source.logs.push(
      encodeLog('CurveReopened', { token: TOKEN }, { block: 3n, logIndex: 0 }),
      encodeLog('FeeAccrued', { token: TOKEN, mindAmount: 10n ** 15n, protocolAmount: 10n ** 15n }, { block: 3n, logIndex: 1 }),
      trade(3n, 2, false, ETH / 10n, 1_000_000n * ETH, 2n * 10n ** 15n, 4n * ETH - ETH / 10n - 2n * 10n ** 15n, sold),
    );
    source.head = 3n;
    await indexer.syncOnce();
    const m = repos.minds.get(TOKEN)!;
    expect(m.phase).toBe(0);
    expect(m.tokens_sold).toBe(sold.toString());
    expect(m.price_wei).toBe(priceOf({ realEthReserve: 4n * ETH - ETH / 10n - 2n * 10n ** 15n, tokensSold: sold }).toString());
    expect(seen.filter((e) => e.blockNumber === 3).map((e) => e.type)).toEqual(['curve:reopened', 'fee:accrued', 'trade']);
    // a stray CurveReopened never demotes a graduated coin
    source.logs.push(
      encodeLog('CurveCompleted', { token: TOKEN, realEthReserve: 4n * ETH }, { block: 4n, logIndex: 0 }),
      encodeLog('Graduated', { token: TOKEN, pool: TOKEN2, positionId: 1n, ethLiquidity: ETH, tokenLiquidity: ETH, graduationFee: 0n }, { block: 5n, logIndex: 0 }),
      encodeLog('CurveReopened', { token: TOKEN }, { block: 6n, logIndex: 0 }),
    );
    source.head = 6n;
    await indexer.syncOnce();
    expect(repos.minds.get(TOKEN)?.phase).toBe(2);
  });

  it('retries RPC failures with backoff and reports live once caught up', async () => {
    const { source, indexer } = setup();
    source.head = 3n;
    source.failNext = 2;
    indexer.start();
    await indexer.whenLive();
    expect(indexer.status.live).toBe(true);
    expect(indexer.status.lastError).toBeNull();
    expect(indexer.status.headBlock).toBe(3n);
    await indexer.stop();
  });
});
