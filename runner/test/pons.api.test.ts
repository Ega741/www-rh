import { describe, expect, it } from 'vitest';
import {
  computeResponseSchema,
  healthResponseSchema,
  launchConfigResponseSchema,
  mindDetailSchema,
  mindsResponseSchema,
  modelIdToHash,
  ponsAdoptionsResponseSchema,
  ponsCurveAbi,
  ponsFeeEscrowAbi,
  ponsMindRegistryAbi,
  tradeSchema,
} from '@www-rh/shared';
import { createApi, type ApiStatus } from '../src/api/routes.js';
import { LaunchConfigCache } from '../src/chain/pons.js';
import { createRunnerApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { FixedEthUsd } from '../src/economics/ethUsd.js';
import { EconomicsService } from '../src/economics/service.js';
import { applyLogs, decodeLaunchpadLogs } from '../src/indexer/apply.js';
import { IndexerEvents } from '../src/indexer/events.js';
import { Indexer } from '../src/indexer/indexer.js';
import { PonsIndexerVenue } from '../src/indexer/pons.js';
import { StreamBus } from '../src/stream/bus.js';
import { CREATOR, FakeClock, FakeLogSource, memoryRepos, mindCreatedLog, silentLogger, TOKEN } from './helpers.js';
import { AACCOUNT, AACCOUNT2, ACURVE, ATOKEN, E, encodePonsLog, ESCROW, FakePonsReader, launchedToken, mindCreatedArgs, PACCOUNT, PCURVE, PHANTOM, PREPARER2, PTOKEN, REGISTRY, SUPPLY } from './ponsHelpers.js';

const policy = { tickIntervalMs: 20_000, targetRunwayDays: 14, minDailySpendUsd: 0.5, maxTickCostUsd: 0.25, minTickBudgetUsd: 0.05 };
const NOW = 1_800_000_000_000;

function ponsWorld(opts: { registry?: string | null; launchConfig?: boolean } = {}) {
  const repos = memoryRepos();
  const clock = new FakeClock(NOW);
  const reader = new FakePonsReader();
  const cache = new LaunchConfigCache(() => reader.launchConfig(), clock.now);
  const status: ApiStatus = {
    chainId: 4663,
    venue: 'pons',
    launchpad: null,
    registry: opts.registry === undefined ? REGISTRY : opts.registry,
    dryRun: () => true,
    indexer: () => ({ live: true, lastError: null, headBlock: 10n, lastIndexedBlock: 10n }),
    activeMinds: () => 0,
  };
  const economics = new EconomicsService(repos, new FixedEthUsd(3_000_000_000), null, policy, silentLogger, clock.now, (t) => reader.claimable(t));
  const app = createApi({ repos, economics, bus: new StreamBus(), status, origins: [], log: silentLogger, now: clock.now, launchConfig: opts.launchConfig === false ? null : () => cache.get() });
  return { repos, clock, reader, app, economics };
}

const json = async (app: ReturnType<typeof createApi>, path: string): Promise<{ status: number; body: unknown }> => {
  const res = await app.request(path);
  return { status: res.status, body: await res.json() };
};

describe('GET /api/launch-config (SPEC §9.4)', () => {
  it('returns the factory launch config, read-through cached for 60 s', async () => {
    const w = ponsWorld();
    const first = await json(w.app, '/api/launch-config');
    expect(first.status).toBe(200);
    expect(launchConfigResponseSchema.parse(first.body)).toEqual({
      launchFee: '500000000000000',
      configs: [{ id: 0, supply: SUPPLY.toString(), curveFeeBps: 100, phantomQuote: PHANTOM.toString(), graduationThreshold: '4200000000000000000', enabled: true }],
      maxCreatorTaxBps: 1000,
      snipeTaxSeconds: 15,
    });
    await Promise.all([json(w.app, '/api/launch-config'), json(w.app, '/api/launch-config')]);
    w.clock.advance(59_999);
    await json(w.app, '/api/launch-config');
    expect(w.reader.launchConfigReads).toBe(1);
    w.clock.advance(1);
    await json(w.app, '/api/launch-config');
    expect(w.reader.launchConfigReads).toBe(2);
  });

  it('a failed factory read is a 500 { error } and is not cached; curve mode answers 404', async () => {
    const w = ponsWorld();
    w.reader.failLaunchConfig = true;
    const failed = await json(w.app, '/api/launch-config');
    expect(failed).toEqual({ status: 500, body: { error: expect.stringMatching(/launch config unavailable/) } });
    w.reader.failLaunchConfig = false;
    expect((await json(w.app, '/api/launch-config')).status).toBe(200);
    expect(w.reader.launchConfigReads).toBe(2);
    const curve = ponsWorld({ launchConfig: false });
    expect(await json(curve.app, '/api/launch-config')).toEqual({ status: 404, body: { error: expect.stringMatching(/Pons mode/) } });
  });
});

describe('Pons-mode API DTOs (SPEC §9.3, §9.4)', () => {
  it('GET /api/health reports venue and registry; ok needs the registry', async () => {
    const health = healthResponseSchema.parse((await json(ponsWorld().app, '/api/health')).body);
    expect(health).toMatchObject({ ok: true, chainId: 4663, venue: 'pons', registry: REGISTRY, launchpad: '0x0000000000000000000000000000000000000000' });
    const degraded = healthResponseSchema.parse((await json(ponsWorld({ registry: null }).app, '/api/health')).body);
    expect(degraded).toMatchObject({ ok: false, venue: 'pons', registry: null });
  });

  it('minds list / detail / trades / compute of an indexed Pons mind parse with the shared schemas', async () => {
    const w = ponsWorld();
    const source = new FakeLogSource();
    source.byAddress = true;
    w.reader.launched.set(PTOKEN, launchedToken(PCURVE));
    const after = { quoteReserve: PHANTOM + 99n * 10n ** 16n, tokenReserve: SUPPLY - 370_786_516_853_932_584_269_662_921n };
    w.reader.states.set(`${PCURVE}@5`, { ...after, realQuoteReserve: after.quoteReserve - PHANTOM });
    w.reader.claimables.set(PTOKEN, 123n);
    const ts = BigInt(NOW / 1000) - 60n;
    source.logs = [
      encodePonsLog(ponsMindRegistryAbi, 'MindCreated', mindCreatedArgs(PTOKEN), { address: REGISTRY, block: 5n, logIndex: 0, timestamp: ts }),
      encodePonsLog(ponsMindRegistryAbi, 'MindLaunched', { token: PTOKEN, curve: PCURVE, account: PACCOUNT, creator: CREATOR, launchConfigId: 0n }, { address: REGISTRY, block: 5n, logIndex: 1, timestamp: ts }),
      encodePonsLog(ponsCurveAbi, 'CurveBuy', { buyer: REGISTRY, recipient: CREATOR, quoteIn: E, tokensOut: SUPPLY - after.tokenReserve, fee: E / 100n, tax: 0n }, { address: PCURVE, block: 5n, logIndex: 2, timestamp: ts }),
      encodePonsLog(ponsFeeEscrowAbi, 'Credited', { recipient: PACCOUNT, depositor: PCURVE, amount: 120n }, { address: ESCROW, block: 5n, logIndex: 3, timestamp: ts }),
    ];
    source.head = 5n;
    const indexer = new Indexer(w.repos, source, new IndexerEvents(), { address: REGISTRY, venue: new PonsIndexerVenue(REGISTRY, w.reader, silentLogger), startBlock: 0n, confirmations: 0 }, silentLogger);
    await indexer.syncOnce();
    // a curve-venue mind in the same DB keeps venue curve and pons null
    w.repos.tx(() => applyLogs(w.repos, decodeLaunchpadLogs([mindCreatedLog(TOKEN, 1n)]), () => ts));

    const list = mindsResponseSchema.parse((await json(w.app, '/api/minds')).body);
    // same createdAt: ties broken by token ascending
    expect(list.items.map((m) => [m.token, m.venue])).toEqual([[TOKEN, 'curve'], [PTOKEN, 'pons']]);
    const pons = list.items[1]!;
    expect(pons).toMatchObject({ trades24h: 1, volume24hWei: E.toString(), progressBps: Number((99n * 10n ** 16n * 10_000n) / 4_200_000_000_000_000_000n) });
    const detail = mindDetailSchema.parse((await json(w.app, `/api/minds/${PTOKEN}`)).body);
    expect(detail.pons).toEqual({ curve: PCURVE, account: PACCOUNT, deployer: REGISTRY, launchConfigId: 0, feeBps: 100, creatorTaxBps: 0, claimableWei: '120', launchedHere: true, adopted: false, left: false, poolId: null });
    expect(mindDetailSchema.parse((await json(w.app, `/api/minds/${TOKEN}`)).body).pons).toBeNull();
    const [trade] = tradeSchema.array().parse((await json(w.app, `/api/minds/${PTOKEN}/trades`)).body);
    expect(trade).toMatchObject({ isBuy: true, trader: CREATOR.toLowerCase(), ethAmountWei: E.toString(), feeWei: (E / 100n).toString(), realEthReserveWei: (99n * 10n ** 16n).toString() });
    computeResponseSchema.parse((await json(w.app, `/api/minds/${PTOKEN}/compute`)).body);
    // the budget counts the vault only; claimable(token) is reported next to it (on-chain read wins)
    const econ = await w.economics.snapshot(PTOKEN);
    expect([econ.budget.balanceWei, econ.claimableWei]).toEqual([0n, 123n]);
    expect((await w.economics.snapshot(TOKEN)).claimableWei).toBeNull();
  });
});

describe('GET /api/minds/:token/adoptions (SPEC §9.7)', () => {
  it('serves the pending preparations of a Pons token that is not a mind yet (indexed from AdoptionPrepared), most recent first', async () => {
    const w = ponsWorld();
    const source = new FakeLogSource();
    source.byAddress = true;
    const opus = modelIdToHash('claude-opus-5-5');
    const haiku = modelIdToHash('claude-haiku-4-5');
    w.reader.pending.set(`${ATOKEN}:${CREATOR.toLowerCase()}`, { account: AACCOUNT, modelId: opus, personaHash: `0x${'aa'.repeat(32)}`, metadataURI: 'runner://metadata/' + 'ab'.repeat(32) });
    w.reader.pending.set(`${ATOKEN}:${PREPARER2.toLowerCase()}`, { account: AACCOUNT2, modelId: haiku, personaHash: `0x${'bb'.repeat(32)}`, metadataURI: 'ipfs://second' });
    source.logs = [
      encodePonsLog(ponsMindRegistryAbi, 'AdoptionPrepared', { token: ATOKEN, account: AACCOUNT, preparer: CREATOR }, { address: REGISTRY, block: 5n, logIndex: 0 }),
      encodePonsLog(ponsMindRegistryAbi, 'AdoptionPrepared', { token: ATOKEN, account: AACCOUNT2, preparer: PREPARER2 }, { address: REGISTRY, block: 6n, logIndex: 0 }),
    ];
    source.head = 6n;
    const indexer = new Indexer(w.repos, source, new IndexerEvents(), { address: REGISTRY, venue: new PonsIndexerVenue(REGISTRY, w.reader, silentLogger), startBlock: 0n, confirmations: 0 }, silentLogger);
    await indexer.syncOnce();
    expect(w.repos.minds.get(ATOKEN)).toBeUndefined();
    // mixed-case address accepted
    const res = await json(w.app, `/api/minds/${ATOKEN.toUpperCase().replace('0X', '0x')}/adoptions`);
    expect(res.status).toBe(200);
    expect(ponsAdoptionsResponseSchema.parse(res.body)).toEqual([
      { preparer: PREPARER2.toLowerCase(), account: AACCOUNT2, modelId: haiku, personaHash: `0x${'bb'.repeat(32)}`, metadataURI: 'ipfs://second' },
      { preparer: CREATOR.toLowerCase(), account: AACCOUNT, modelId: opus, personaHash: `0x${'aa'.repeat(32)}`, metadataURI: 'runner://metadata/' + 'ab'.repeat(32) },
    ]);
    // the mind routes still 404 for a token that is not a mind
    expect((await json(w.app, `/api/minds/${ATOKEN}`)).status).toBe(404);

    // activation by CREATOR removes its preparation; PREPARER2's stays pending (served for the registered mind too)
    w.reader.launched.set(ATOKEN, launchedToken(ACURVE, { creatorFeeRecipient: AACCOUNT }));
    w.reader.states.set(`${ACURVE}@7`, { quoteReserve: PHANTOM, tokenReserve: SUPPLY, realQuoteReserve: 0n });
    source.logs.push(
      encodePonsLog(ponsMindRegistryAbi, 'MindCreated', { ...mindCreatedArgs(ATOKEN), creator: CREATOR }, { address: REGISTRY, block: 7n, logIndex: 0 }),
      encodePonsLog(ponsMindRegistryAbi, 'MindAdopted', { token: ATOKEN, account: AACCOUNT, creator: CREATOR }, { address: REGISTRY, block: 7n, logIndex: 1 }),
    );
    source.head = 7n;
    await indexer.syncOnce();
    expect(ponsAdoptionsResponseSchema.parse((await json(w.app, `/api/minds/${ATOKEN}/adoptions`)).body).map((a) => a.preparer)).toEqual([PREPARER2.toLowerCase()]);
    expect(mindDetailSchema.parse((await json(w.app, `/api/minds/${ATOKEN}`)).body).pons).toMatchObject({ account: AACCOUNT, adopted: true, left: false, launchedHere: false });
  });

  it('[] for an address without preparations; 400 for a malformed address; preparations no longer pending are not served', async () => {
    const w = ponsWorld();
    expect(await json(w.app, `/api/minds/${PTOKEN}/adoptions`)).toEqual({ status: 200, body: [] });
    expect(await json(w.app, '/api/minds/0x1234/adoptions')).toEqual({ status: 400, body: { error: 'invalid token address' } });
    w.repos.ponsAdoptions.upsert({ token: PTOKEN, preparer: CREATOR, account: PACCOUNT, modelId: null, personaHash: null, metadataUri: null, updatedAt: 1 });
    expect(await json(w.app, `/api/minds/${PTOKEN}/adoptions`)).toEqual({ status: 200, body: [] });
  });
});

describe('startup in Pons mode without a reachable RPC (definition of done)', () => {
  it('VENUE=pons, DRY_RUN=true, unreachable RPC, no API key: starts degraded and stops cleanly (with and without a registry)', async () => {
    for (const extra of [{}, { REGISTRY_ADDRESS: REGISTRY }]) {
      const config = loadConfig({ CHAIN_ID: '4663', RPC_URL: 'http://127.0.0.1:1', DB_PATH: ':memory:', PORT: '0', DRY_RUN: 'true', ...extra });
      expect(config.venue).toBe('pons');
      const app = await createRunnerApp(config, { log: silentLogger });
      await app.start();
      await new Promise((r) => setTimeout(r, 300));
      const res = await fetch(`http://127.0.0.1:${app.server!.port}/api/health`);
      const health = healthResponseSchema.parse(await res.json());
      expect(health).toMatchObject({ ok: false, venue: 'pons', chainId: 4663, dryRun: true, registry: 'REGISTRY_ADDRESS' in extra ? REGISTRY : null });
      const lc = await fetch(`http://127.0.0.1:${app.server!.port}/api/launch-config`);
      expect(lc.status).toBe('REGISTRY_ADDRESS' in extra ? 500 : 404);
      await app.stop();
    }
  });
});
