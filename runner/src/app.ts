/**
 * Composition root: wires DB, chain clients, indexer, economics, memory, metadata, browser,
 * scheduler, API and WS (`docs/SPEC.md` §4.1 `main.ts`): open DB → start indexer → API/WS →
 * scheduler once the indexer is live (and an Anthropic key is set).
 *
 * @module app
 */
import Anthropic from '@anthropic-ai/sdk';
import { privateKeyToAccount } from 'viem/accounts';
import { curvePhaseName, mindStatusName, type WsServerMessage } from '@www-rh/shared';
import { createApi } from './api/routes.js';
import { startServer, type RunningServer } from './api/server.js';
import { tradeDto } from './api/dto.js';
import { WsHub } from './api/ws.js';
import { createEgressFilter, type EgressFilter } from './browser/egress.js';
import { BrowserPool } from './browser/pool.js';
import { createChainClients, type ChainClients } from './chain/clients.js';
import { ViemLaunchpadReader, ViemLaunchpadSender, type LaunchpadReader } from './chain/launchpad.js';
import { TxQueue } from './chain/txQueue.js';
import type { RunnerConfig } from './config.js';
import { Repos } from './db/repos.js';
import { Db } from './db/sqlite.js';
import { microToUsd } from './economics/budget.js';
import { FeedEthUsd, FixedEthUsd } from './economics/ethUsd.js';
import { EconomicsService, type MindEconomics } from './economics/service.js';
import { Settler } from './economics/settle.js';
import { IndexerEvents, type IndexedEvent } from './indexer/events.js';
import { Indexer } from './indexer/indexer.js';
import { ViemLogSource, type LogSource } from './indexer/source.js';
import { createLogger, errorMessage, type Logger } from './log.js';
import { MemoryService } from './memory/memory.js';
import { MetadataResolver } from './metadata/resolve.js';
import { Scheduler } from './mind/scheduler.js';
import { runTick, sdkRunnerFactory, type RunnerFactory, type TickDeps } from './mind/tick.js';
import { StreamBus } from './stream/bus.js';

/** Version reported in logs. */
export const RUNNER_VERSION = '0.1.0';

/** Optional overrides (tests, CLI). */
export interface RunnerOverrides {
  logSource?: LogSource;
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
  reader: LaunchpadReader | null;
  clients: ChainClients;
  server: RunningServer | null;
  scheduler(): Scheduler | null;
  /** Builds tick dependencies (for `cli tick`). */
  tickDeps(): TickDeps;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Wires every service from `config`. Throws when no launchpad is known outside dry run. */
export async function createRunnerApp(config: RunnerConfig, overrides: RunnerOverrides = {}): Promise<RunnerApp> {
  const log = overrides.log ?? createLogger('runner');
  if (config.launchpad === null) {
    if (!config.dryRun) throw new Error('no launchpad address: set LAUNCHPAD_ADDRESS or run `pnpm deployments:sync` (refusing to send transactions)');
    log.error('no launchpad address (LAUNCHPAD_ADDRESS unset and no deployment for CHAIN_ID): running degraded — API up, indexer tracks the head only');
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
  const reader = config.launchpad === null ? null : new ViemLaunchpadReader(config.launchpad, clients.publicClient);
  const sender = !config.dryRun && clients.walletClient !== null && config.launchpad !== null ? new ViemLaunchpadSender(config.launchpad, clients.publicClient, clients.walletClient) : null;
  const queue = new TxQueue(sender, log.child('tx'), config.dryRun ? (config.operatorPrivateKey === null ? 'no OPERATOR_PRIVATE_KEY' : 'DRY_RUN') : null);

  const ethUsd = config.ethUsdFeed === null ? new FixedEthUsd(config.ethUsdPriceMicro) : new FeedEthUsd(clients.publicClient, config.ethUsdFeed, config.ethUsdPriceMicro, log.child('eth-usd'));
  const economics = new EconomicsService(repos, ethUsd, reader, config, log.child('economics'));
  const bus = new StreamBus();
  const memory = new MemoryService(repos, bus, queue, { anchorEvery: config.anchorEveryNMemories }, log.child('memory'));
  const egress = overrides.egress ?? createEgressFilter();
  const metadata = new MetadataResolver(repos, egress, config.ipfsGateway, log.child('metadata'));
  const events = new IndexerEvents();
  const indexer = new Indexer(repos, overrides.logSource ?? new ViemLogSource(clients.publicClient), events, { address: config.launchpad, startBlock: config.startBlock, confirmations: config.confirmations }, log.child('indexer'));

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
  const settler = new Settler(repos, economics, queue, config, log.child('settle'), refreshBudget);

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
      config: { maxIterations: config.tickMaxIterations, maxTickCostUsd: config.maxTickCostUsd, timeoutMs: config.tickTimeoutMs, frameFps: config.frameFps },
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
      default:
        break;
    }
    scheduler?.onEvent(ev);
  });

  let server: RunningServer | null = null;
  let metadataTimer: NodeJS.Timeout | null = null;

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
    clients,
    get server() {
      return server;
    },
    scheduler: () => scheduler,
    tickDeps,
    async start() {
      log.info('starting runner', { version: RUNNER_VERSION, chainId: config.chainId, launchpad: config.launchpad, dryRun: queue.dryRun, db: config.dbPath });
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
          status: {
            chainId: config.chainId,
            launchpad: config.launchpad,
            dryRun: () => queue.dryRun,
            indexer: () => indexer.status,
            activeMinds: () => scheduler?.inFlight ?? 0,
          },
        });
        server = await startServer(api, new WsHub(repos, bus, log.child('ws')), config.port);
        log.info('API listening', { port: server.port });
      }
      void indexer.whenLive().then(async () => {
        await verifyOperator();
        settler.reconcile();
        memory.reconcile();
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
        });
        scheduler.start();
        log.info('scheduler started', { maxConcurrentMinds: config.maxConcurrentMinds });
      });
    },
    async stop() {
      log.info('stopping runner');
      await scheduler?.stop();
      await queue.drain(30_000);
      if (metadataTimer !== null) clearInterval(metadataTimer);
      await pool?.close();
      await indexer.stop();
      await server?.close();
      db.close();
    },
  };
  return app;
}
