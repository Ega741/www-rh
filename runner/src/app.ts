/**
 * Composition root: wires DB, chain clients, indexer, economics, memory, metadata, browser,
 * scheduler, API and WS (`docs/SPEC.md` §4.1 `main.ts`): open DB → start indexer → API/WS →
 * once live: verify the operator, reconcile live receipts and anchors (and, in live mode, re-settle
 * the spend of dry-run receipts), start the receipt reconciler (every 60 s) and the scheduler
 * (with an Anthropic key).
 *
 * Venue (`docs/SPEC.md` §9.4): `VENUE=curve` indexes `MindLaunchpad`; `VENUE=pons` indexes
 * `PonsMindRegistry` plus the Pons logs of the registered tokens, reads `claimable(token)` and runs
 * the Pons harvest / pool transactions. The MindCore surface (draws, anchors, status) is shared.
 *
 * Shutdown runs in bounded stages — scheduler (ticks aborted), receipt reconciler, tx queue
 * (≤ 30 s), anchoring, metadata resolution, browser, indexer, WS hub + HTTP server — and always
 * closes the DB last, after every background DB writer has stopped.
 *
 * @module app
 */
import Anthropic from '@anthropic-ai/sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { curvePhaseName, mindStatusName, type WsServerMessage } from '@www-rh/shared';
import { createApi } from './api/routes.js';
import { startServer, withTimeout, type RunningServer } from './api/server.js';
import { tradeDto } from './api/dto.js';
import { WsHub } from './api/ws.js';
import { createEgressFilter, type EgressFilter } from './browser/egress.js';
import { BrowserPool } from './browser/pool.js';
import { createChainClients, type ChainClients } from './chain/clients.js';
import { ViemDrawChainView, ViemLaunchpadReader, ViemLaunchpadSender, type LaunchpadReader } from './chain/launchpad.js';
import { LaunchConfigCache, ViemPonsReader, type PonsReader } from './chain/pons.js';
import { TxQueue } from './chain/txQueue.js';
import { mindContract, type RunnerConfig } from './config.js';
import { Repos } from './db/repos.js';
import { Db } from './db/sqlite.js';
import { microToUsd } from './economics/budget.js';
import { FeedEthUsd, FixedEthUsd } from './economics/ethUsd.js';
import { EconomicsService, type MindEconomics } from './economics/service.js';
import { Settler } from './economics/settle.js';
import { IndexerEvents, type IndexedEvent } from './indexer/events.js';
import { Indexer } from './indexer/indexer.js';
import { PonsIndexerVenue } from './indexer/pons.js';
import { ViemLogSource, type LogSource } from './indexer/source.js';
import { CurveIndexerVenue } from './indexer/venue.js';
import { createLogger, errorMessage, type Logger } from './log.js';
import { MemoryService } from './memory/memory.js';
import { MetadataResolver } from './metadata/resolve.js';
import { PonsOps } from './mind/ponsOps.js';
import { Scheduler } from './mind/scheduler.js';
import { runTick, sdkRunnerFactory, type RunnerFactory, type TickDeps } from './mind/tick.js';
import { StreamBus } from './stream/bus.js';

/** Version reported in logs. */
export const RUNNER_VERSION = '0.1.0';

/** Upper bounds of the shutdown stages (ms); their sum stays below `main.ts`'s forced exit. */
export const SHUTDOWN_STAGE_MS = { scheduler: 10_000, settler: 3_000, queue: 30_000, memory: 3_000, metadata: 3_000, browser: 5_000, indexer: 3_000, api: 3_000 } as const;

/** Optional overrides (tests, CLI). */
export interface RunnerOverrides {
  logSource?: LogSource;
  /** Pons chain reads (tests). */
  ponsReader?: PonsReader;
  egress?: EgressFilter;
  createRunner?: RunnerFactory;
  /** Skip the HTTP server (CLI commands). */
  api?: boolean;
  log?: Logger;
}

/** A wired runner. */
export interface RunnerApp {
  config: RunnerConfig;
  repos: Repos;
  bus: StreamBus;
  indexer: Indexer;
  queue: TxQueue;
  economics: EconomicsService;
  memory: MemoryService;
  settler: Settler;
  /** MindCore reads on the launchpad (curve) or the registry (pons). */
  reader: LaunchpadReader | null;
  /** Pons reads (Pons mode with a registry). */
  ponsReader: PonsReader | null;
  clients: ChainClients;
  server: RunningServer | null;
  scheduler(): Scheduler | null;
  /** Builds tick dependencies (for `cli tick`). */
  tickDeps(): TickDeps;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Wires every service from `config`. Throws when no launchpad (curve) / registry (pons) is known outside dry run. */
export async function createRunnerApp(config: RunnerConfig, overrides: RunnerOverrides = {}): Promise<RunnerApp> {
  const log = overrides.log ?? createLogger('runner');
  const contract = mindContract(config);
  if (contract === null) {
    const [what, env] = config.venue === 'pons' ? ['registry', 'REGISTRY_ADDRESS'] : ['launchpad', 'LAUNCHPAD_ADDRESS'];
    if (!config.dryRun) throw new Error(`no ${what} address (VENUE=${config.venue}): set ${env} or run \`pnpm deployments:sync\` (refusing to send transactions)`);
    log.error(`no ${what} address (VENUE=${config.venue}, ${env} unset and no deployment for CHAIN_ID): running degraded — API up, indexer tracks the head only`);
  }

  const db = Db.open(config.dbPath);
  const repos = new Repos(db);
  const closed = repos.ticks.closeDangling(Date.now());
  if (closed > 0) log.warn('closed ticks left running by a previous process', { count: closed });

  const clients = createChainClients({
    chainId: config.chainId,
    rpcUrl: config.rpcUrl,
    operatorPrivateKey: config.dryRun ? null : config.operatorPrivateKey,
    pollingIntervalMs: 1_000,
  });
  const operatorAccount = config.operatorPrivateKey === null ? null : privateKeyToAccount(config.operatorPrivateKey);
  // MindCore reads / writes have the same selectors on the launchpad and on the registry
  const reader = contract === null ? null : new ViemLaunchpadReader(contract, clients.publicClient);
  const ponsReader = config.venue === 'pons' && config.registry !== null ? (overrides.ponsReader ?? new ViemPonsReader(config.registry, clients.publicClient, config.pons)) : null;
  const sender = !config.dryRun && clients.walletClient !== null && contract !== null ? new ViemLaunchpadSender(contract, clients.publicClient, clients.walletClient, config.venue) : null;
  const queue = new TxQueue(sender, log.child('tx'), config.dryRun ? (config.operatorPrivateKey === null ? 'no OPERATOR_PRIVATE_KEY' : 'DRY_RUN') : null);

  const ethUsd =
    config.ethUsdFeed === null
      ? new FixedEthUsd(config.ethUsdPriceMicro, config.ethUsdBoundsMicro, log.child('eth-usd'))
      : new FeedEthUsd(clients.publicClient, config.ethUsdFeed, config.ethUsdPriceMicro, log.child('eth-usd'), Date.now, config.ethUsdBoundsMicro);
  const economics = new EconomicsService(repos, ethUsd, reader, config, log.child('economics'), Date.now, ponsReader === null ? null : (token) => ponsReader.claimable(token));
  const bus = new StreamBus();
  const memory = new MemoryService(repos, bus, queue, { anchorEvery: config.anchorEveryNMemories }, log.child('memory'));
  const egress = overrides.egress ?? createEgressFilter();
  const metadata = new MetadataResolver(repos, egress, config.ipfsGateway, log.child('metadata'));
  const events = new IndexerEvents();
  const indexer = new Indexer(
    repos,
    overrides.logSource ?? new ViemLogSource(clients.publicClient),
    events,
    {
      address: contract,
      venue: config.venue === 'pons' ? new PonsIndexerVenue(config.registry, ponsReader, log.child('indexer')) : new CurveIndexerVenue(config.launchpad),
      startBlock: config.startBlock,
      confirmations: config.confirmations,
      balanceReader: reader,
    },
    log.child('indexer'),
  );
  const launchConfig = ponsReader === null ? null : new LaunchConfigCache(() => ponsReader.launchConfig());

  const publish = (token: string, m: WsServerMessage): void => bus.publish(token, m);
  const publishBudget = (token: string, econ: MindEconomics): void =>
    publish(token, {
      type: 'budget',
      balanceWei: econ.budget.balanceWei.toString(10),
      balanceUsd: microToUsd(econ.budget.balanceUsdMicro),
      burnUsdPerHour: Math.round(econ.burnUsdPerHour * 1e6) / 1e6,
      runwayHours: econ.runwayHours,
      at: new Date().toISOString(),
    });
  const refreshBudget = (token: string): void => {
    void economics.snapshot(token).then((e) => publishBudget(token, e), () => undefined);
  };
  const publishStatus = (token: string): void => {
    const row = repos.minds.get(token);
    if (row !== undefined) publish(token, { type: 'status', status: mindStatusName(row.status), phase: curvePhaseName(row.phase), at: new Date().toISOString() });
  };
  // read-only chain view for the receipt reconciler (also in dry run, when the operator key is known)
  const chainView = operatorAccount !== null ? new ViemDrawChainView(clients.publicClient, operatorAccount.address) : null;
  const settler = new Settler(repos, economics, queue, config, log.child('settle'), refreshBudget, Date.now, { chain: chainView });

  let scheduler: Scheduler | null = null;
  let pool: BrowserPool | null = null;
  const createRunnerFn = overrides.createRunner ?? (config.anthropicApiKey === null ? null : sdkRunnerFactory(new Anthropic({ apiKey: config.anthropicApiKey, maxRetries: 0 })));

  const tickDeps = (): TickDeps => {
    if (createRunnerFn === null) throw new Error('ANTHROPIC_API_KEY is not set');
    pool ??= new BrowserPool({ headless: config.browserHeadless, maxContexts: 2 * config.maxConcurrentMinds }, egress, log.child('browser'));
    const browserPool = pool;
    return {
      createRunner: createRunnerFn,
      repos,
      bus,
      memory,
      egress,
      browser: (token) => browserPool.session(token),
      resetBrowser: (token) => browserPool.reset(token),
      config: { maxIterations: config.tickMaxIterations, maxTickCostUsd: config.maxTickCostUsd, timeoutMs: config.tickTimeoutMs, frameFps: config.frameFps, toolTimeoutMs: config.toolTimeoutMs },
      log: log.child('mind'),
    };
  };

  events.on((ev: IndexedEvent) => {
    switch (ev.type) {
      case 'trade':
        publish(ev.token, { type: 'trade', trade: tradeDto(ev.trade) });
        break;
      case 'mind:created':
      case 'mind:config':
        metadata.enqueue(ev.token);
        break;
      case 'mind:status':
      case 'curve:complete':
      case 'curve:reopened':
      case 'graduated':
        publishStatus(ev.token);
        break;
      case 'fee:accrued':
      case 'mind:funded':
      case 'compute:drawn':
        if (ev.type === 'compute:drawn') economics.invalidateEpoch(ev.token);
        refreshBudget(ev.token);
        break;
      case 'pons:credited':
      case 'pons:claimed':
      case 'harvested':
        economics.invalidateClaimable(ev.token);
        break;
      default:
        break;
    }
    scheduler?.onEvent(ev);
  });

  let server: RunningServer | null = null;
  let metadataTimer: NodeJS.Timeout | null = null;
  let stopping: Promise<void> | null = null;

  const verifyOperator = async (): Promise<void> => {
    if (reader === null || operatorAccount === null) return;
    try {
      const onchain = (await reader.operator()).toLowerCase();
      if (onchain === operatorAccount.address.toLowerCase()) return;
      if (config.dryRun) log.warn('OPERATOR_PRIVATE_KEY does not match operator() on-chain (dry run, nothing is sent)', { onchain, key: operatorAccount.address });
      else {
        log.error('OPERATOR_PRIVATE_KEY does not match operator() on-chain: forcing dry run', { onchain, key: operatorAccount.address });
        queue.forceDryRun('operator mismatch');
      }
    } catch (err) {
      log.warn('could not verify operator()', { error: errorMessage(err) });
    }
  };

  const app: RunnerApp = {
    config,
    repos,
    bus,
    indexer,
    queue,
    economics,
    memory,
    settler,
    reader,
    ponsReader,
    clients,
    get server() {
      return server;
    },
    scheduler: () => scheduler,
    tickDeps,
    async start() {
      log.info('starting runner', { version: RUNNER_VERSION, chainId: config.chainId, venue: config.venue, launchpad: config.launchpad, registry: config.registry, dryRun: queue.dryRun, db: config.dbPath });
      indexer.start();
      metadata.sweepPending();
      metadataTimer = setInterval(() => metadata.sweepPending(), 30_000);
      metadataTimer.unref();
      if (overrides.api !== false) {
        const api = createApi({
          repos,
          economics,
          bus,
          origins: config.publicWebOrigins,
          log: log.child('api'),
          launchConfig: launchConfig === null ? null : () => launchConfig.get(),
          status: {
            chainId: config.chainId,
            venue: config.venue,
            launchpad: config.launchpad,
            registry: config.registry,
            dryRun: () => queue.dryRun,
            indexer: () => indexer.status,
            activeMinds: () => scheduler?.inFlight ?? 0,
          },
        });
        server = await startServer(api, new WsHub(repos, bus, log.child('ws')), config.port);
        log.info('API listening', { port: server.port });
      }
      void indexer.whenLive().then(async () => {
        if (stopping !== null) return;
        await verifyOperator();
        if (stopping !== null) return;
        // live receipts first: nothing is re-settled before they are resolved
        await settler.reconcile();
        if (stopping !== null) return;
        memory.reconcile();
        if (!queue.dryRun) {
          // spend recorded during a dry-run period is settled on-chain now (never stranded)
          settler.releaseDryRunForLive();
          memory.releaseDryRunForLive();
        }
        settler.startReconciler();
        if (createRunnerFn === null) {
          log.warn('ANTHROPIC_API_KEY is not set: minds will not think (indexer and API keep running)');
          return;
        }
        const deps = tickDeps();
        scheduler = new Scheduler({
          repos,
          economics,
          settler,
          queue,
          reader,
          runTick: (input) => runTick(deps, input),
          publishBudget,
          log: log.child('scheduler'),
          config: { maxConcurrentMinds: config.maxConcurrentMinds, harvestIntervalMs: config.harvestIntervalMs },
          pons:
            config.venue === 'pons'
              ? new PonsOps({ repos, queue, reader: ponsReader, economics, log: log.child('pons'), config: { harvestMinWei: config.harvestMinWei, harvestIntervalMs: config.harvestIntervalMs } })
              : null,
        });
        scheduler.start();
        log.info('scheduler started', { maxConcurrentMinds: config.maxConcurrentMinds });
      });
    },
    stop() {
      stopping ??= (async () => {
        log.info('stopping runner');
        const stage = async (name: keyof typeof SHUTDOWN_STAGE_MS, fn: () => Promise<unknown> | undefined): Promise<void> => {
          const ms = SHUTDOWN_STAGE_MS[name];
          const r = await withTimeout(Promise.resolve().then(fn), ms);
          if (r === 'timeout') log.warn('shutdown stage timed out; continuing', { stage: name, ms });
        };
        try {
          if (metadataTimer !== null) clearInterval(metadataTimer);
          await stage('scheduler', () => scheduler?.stop());
          await stage('settler', () => settler.stop());
          queue.close();
          await stage('queue', () => queue.drain(SHUTDOWN_STAGE_MS.queue));
          await stage('memory', () => memory.stop());
          await stage('metadata', () => metadata.stop());
          await stage('browser', () => pool?.close());
          await stage('indexer', () => indexer.stop());
          await stage('api', () => server?.close(SHUTDOWN_STAGE_MS.api / 2));
        } finally {
          try {
            db.close();
          } catch (err) {
            log.error('closing the database failed', { error: errorMessage(err) });
          }
          log.info('runner stopped');
        }
      })();
      return stopping;
    },
  };
  return app;
}
