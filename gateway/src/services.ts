/**
 * Service container: wires config, database, auth, providers, router, metering, upgrades, the
 * price service and the chain workers together. Every external dependency (clock, fetch,
 * Anthropic client factory, DNS, chain access) is injectable so tests run fully offline against
 * an in-memory database. Nothing here starts timers or listens; `main.ts` does that.
 *
 * @module services
 */
import { readFileSync } from 'node:fs';
import { clusterCaip } from '@beagle/shared/clusters';
import { DEFAULT_CATALOG, mergeCatalog, type ModelSpec, type Provider } from '@beagle/shared/models';
import { ApiKeyService } from './auth/apiKeys.js';
import { Keyring } from './auth/crypto.js';
import { SessionService } from './auth/session.js';
import { SiwsService } from './auth/siws.js';
import { BudgetScanner } from './chain/budgets.js';
import { BudgetDrawer } from './chain/drawer.js';
import { Indexer } from './chain/indexer.js';
import { PriceService } from './chain/price.js';
import { createChainContext, resolveChainInfo, type ChainContext, type ChainInfo } from './chain/rpc.js';
import type { Config } from './config.js';
import { Repos } from './db/repos.js';
import { migrate } from './db/schema.js';
import { Db } from './db/sqlite.js';
import { createLogger, type Logger } from './log.js';
import { LedgerService } from './metering/ledger.js';
import { ReservationService } from './metering/reserve.js';
import { SettlementService } from './metering/settle.js';
import type { AnthropicClientFactory } from './providers/anthropic.js';
import type { FetchLike } from './providers/openaiCompat.js';
import { ProviderRegistry, type DnsLookup } from './providers/registry.js';
import type { ProviderAdapter } from './providers/types.js';
import { Executor } from './router/execute.js';
import { HealthStore } from './router/health.js';
import { UpgradeService } from './upgrades/plans.js';
import { createWarmDriver, WarmService, type WarmDriver } from './upgrades/warm.js';

/** Gateway version reported by `/api/status`. */
export const GATEWAY_VERSION = '0.1.0';

/** Injectable dependencies of {@link createServices}. */
export interface ServiceDeps {
  logger?: Logger;
  now?: () => number;
  /** Fetch used by the OpenAI-compatible adapter, the price feeds and the warm driver. */
  fetch?: FetchLike;
  anthropicClientFactory?: AnthropicClientFactory;
  lookup?: DnsLookup;
  /** `null` disables chain access (workers off); `undefined` builds it from the config. */
  chain?: ChainContext | null;
  adapters?: Partial<Record<Provider, ProviderAdapter>>;
  catalog?: readonly ModelSpec[];
  warmDriver?: WarmDriver;
  /** An already opened database (tests); otherwise `DB_PATH` is opened. */
  db?: Db;
}

/** Mutable runtime facts refreshed by the loops. */
export interface RuntimeState {
  /** Lamports of the operator wallet, refreshed by housekeeping; `undefined` until read. */
  operatorSolBalance: bigint | undefined;
}

/** Everything the HTTP layer, the CLI and the workers use. */
export interface Services {
  config: Config;
  logger: Logger;
  now: () => number;
  db: Db;
  repos: Repos;
  catalog: readonly ModelSpec[];
  apiKeys: ApiKeyService;
  sessions: SessionService;
  siws: SiwsService;
  keyring: Keyring | undefined;
  registry: ProviderRegistry;
  health: HealthStore;
  ledger: LedgerService;
  reservations: ReservationService;
  settlement: SettlementService;
  executor: Executor;
  upgrades: UpgradeService;
  warm: WarmService;
  price: PriceService;
  /** Static chain facts (always present, from the deployment record and the env). */
  chainInfo: ChainInfo;
  /** RPC access and the operator key; `undefined` when the mint is unknown or chain access was disabled. */
  chain: ChainContext | undefined;
  indexer: Indexer | undefined;
  budgets: BudgetScanner | undefined;
  drawer: BudgetDrawer | undefined;
  runtime: RuntimeState;
  version: string;
  /** Closes the database and stops driver timers. */
  close(): void;
}

/** Loads the catalog: defaults, `HOUSE_MODEL_*` upstream ids, then `MODEL_CATALOG_FILE` overrides. */
export function loadCatalog(config: Config): ModelSpec[] {
  const houseOverrides: unknown[] = [];
  if (config.providers.houseModelSmall !== 'openai/gpt-oss-20b') houseOverrides.push({ id: 'house/gpt-oss-20b', upstreamId: config.providers.houseModelSmall });
  if (config.providers.houseModelLarge !== 'openai/gpt-oss-120b') houseOverrides.push({ id: 'house/gpt-oss-120b', upstreamId: config.providers.houseModelLarge });
  let catalog = mergeCatalog(DEFAULT_CATALOG, houseOverrides);
  if (config.providers.catalogFile !== undefined) {
    const raw = JSON.parse(readFileSync(config.providers.catalogFile, 'utf8')) as unknown;
    if (!Array.isArray(raw)) throw new Error(`MODEL_CATALOG_FILE must contain a JSON array (${config.providers.catalogFile})`);
    catalog = mergeCatalog(catalog, raw);
  }
  return catalog;
}

/** Builds the services (opens and migrates the database, bootstraps the price). */
export function createServices(config: Config, deps: ServiceDeps = {}): Services {
  const logger = deps.logger ?? createLogger({ level: config.server.logLevel });
  const now = deps.now ?? (() => Date.now());
  const db = deps.db ?? new Db(config.server.dbPath);
  migrate(db);
  const repos = new Repos(db);
  const catalog = deps.catalog ?? loadCatalog(config);
  const keyring = config.secrets.keyringMasterKey === undefined ? undefined : new Keyring(config.secrets.keyringMasterKey);
  if (config.secrets.sessionSecretIsDefault) logger.warn('SESSION_SECRET is unset: using the development default');

  let chain: ChainContext | undefined;
  if (deps.chain === null) chain = undefined;
  else if (deps.chain !== undefined) chain = deps.chain;
  else chain = createChainContext(config, logger);
  const chainInfo: ChainInfo = chain ?? resolveChainInfo(config, logger);

  const apiKeys = new ApiKeyService(repos.apiKeys, repos.workspaces, now);
  const sessions = new SessionService(repos.sessions, config.secrets.sessionSecret, now);
  const siws = new SiwsService(repos.nonces, { domain: config.server.publicHost, uri: config.server.publicUrl, chainId: clusterCaip(config.cluster.name), now });
  const registry = new ProviderRegistry({
    config,
    providerKeys: repos.providerKeys,
    keyring,
    logger,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.anthropicClientFactory === undefined ? {} : { anthropicClientFactory: deps.anthropicClientFactory }),
    ...(deps.lookup === undefined ? {} : { lookup: deps.lookup }),
    ...(deps.adapters === undefined ? {} : { adapters: deps.adapters }),
  });
  const health = new HealthStore(repos.health, now);
  const ledger = new LedgerService(repos, now);
  const reservations = new ReservationService(repos, { minReserveMicro: config.economics.minReserveMicro, ttlMs: config.economics.reservationTtlMs }, now);
  const settlement = new SettlementService(repos, { markupBps: config.economics.markupBps, byokFeeBps: config.economics.byokFeeBps }, now);
  const executor = new Executor({ config, repos, catalog, registry, health, reservations, settlement, logger, now });
  const fetchForDrivers = deps.fetch === undefined ? undefined : (i: string, init?: RequestInit) => deps.fetch!(i, init ?? {});
  const warmDriver = deps.warmDriver ?? createWarmDriver(config, logger, fetchForDrivers);
  const warm = new WarmService(repos, warmDriver, now);
  const upgrades = new UpgradeService(repos, config, warm, now);
  const price = new PriceService(
    repos,
    {
      source: config.price.source,
      ...(config.price.initialPriceE18 === undefined ? {} : { initialPriceE18: config.price.initialPriceE18 }),
      ...(config.price.feedUrl === undefined ? {} : { feedUrl: config.price.feedUrl }),
      jupiterUrl: config.price.jupiterUrl,
      ...(chainInfo.mint === undefined ? {} : { mint: chainInfo.mint }),
      minChangeBps: config.price.minChangeBps,
      maxStepBps: config.price.maxStepBps,
      maxAgeS: config.price.maxAgeS,
      decimals: chainInfo.decimals,
      ...(fetchForDrivers === undefined ? {} : { fetch: fetchForDrivers }),
      now,
    },
    logger,
  );
  price.init();

  let indexer: Indexer | undefined;
  let budgets: BudgetScanner | undefined;
  let drawer: BudgetDrawer | undefined;
  if (chain !== undefined) {
    indexer = new Indexer(
      repos,
      chain.reader,
      price,
      {
        mint: chain.mint,
        operator: chain.operator,
        decimals: chain.decimals,
        pageLimit: config.cluster.indexPageLimit,
        fetchConcurrency: config.cluster.txFetchConcurrency,
        indexFromSignature: config.cluster.indexFromSignature,
        creditWhenStale: config.price.creditWhenStale,
        minCreditMicro: config.price.minCreditMicro,
        now,
      },
      logger,
    );
    budgets = new BudgetScanner(repos, chain.reader, price, { mint: chain.mint, operator: chain.operator, tokenProgram: chain.tokenProgram, decimals: chain.decimals, now }, logger);
    drawer = new BudgetDrawer(
      repos,
      chain.reader,
      chain.writer,
      price,
      {
        cluster: chain.cluster,
        mint: chain.mint,
        tokenProgram: chain.tokenProgram,
        memoProgram: chain.memoProgram,
        operator: chain.operator,
        decimals: chain.decimals,
        thresholdMicro: config.budgets.drawThresholdMicro,
        priorityFeeMicrolamports: config.operator.priorityFeeMicrolamports,
        confirmTimeoutMs: config.budgets.drawConfirmTimeoutMs,
        dryRun: config.operator.dryRun,
        now,
      },
      logger,
    );
  }

  return {
    config,
    logger,
    now,
    db,
    repos,
    catalog,
    apiKeys,
    sessions,
    siws,
    keyring,
    registry,
    health,
    ledger,
    reservations,
    settlement,
    executor,
    upgrades,
    warm,
    price,
    chainInfo,
    chain,
    indexer,
    budgets,
    drawer,
    runtime: { operatorSolBalance: undefined },
    version: GATEWAY_VERSION,
    close() {
      warm.stop();
      db.close();
    },
  };
}
