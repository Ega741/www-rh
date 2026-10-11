/**
 * Service container: wires config, database, auth, providers, router, metering, upgrades and chain
 * workers together. Every external dependency (clock, fetch, Anthropic client factory, DNS, chain
 * access, SIWE verifier) is injectable so tests run fully offline against an in-memory database.
 * Nothing here starts timers or listens; `main.ts` does that.
 *
 * @module services
 */
import { readFileSync } from 'node:fs';
import { DEFAULT_CATALOG, mergeCatalog, type ModelSpec, type Provider } from '@beagle/shared/models';
import { ApiKeyService } from './auth/apiKeys.js';
import { Keyring } from './auth/crypto.js';
import { SessionService } from './auth/session.js';
import { SiweService, type SiweVerifier } from './auth/siwe.js';
import { HeadroomRefresher } from './chain/budgets.js';
import { createChainContext, type ChainContext } from './chain/clients.js';
import { BudgetDrawer } from './chain/drawer.js';
import { Indexer } from './chain/indexer.js';
import { PricePoster } from './chain/poster.js';
import { PriceService } from './chain/price.js';
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
  /** Fetch used by the OpenAI-compatible adapter, the poster and the warm driver. */
  fetch?: FetchLike;
  anthropicClientFactory?: AnthropicClientFactory;
  lookup?: DnsLookup;
  /** `null` disables the chain entirely; `undefined` builds it from the config. */
  chain?: ChainContext | null;
  siweVerifier?: SiweVerifier;
  adapters?: Partial<Record<Provider, ProviderAdapter>>;
  catalog?: readonly ModelSpec[];
  warmDriver?: WarmDriver;
  /** An already opened database (tests); otherwise `DB_PATH` is opened. */
  db?: Db;
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
  siwe: SiweService;
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
  chain: ChainContext | undefined;
  indexer: Indexer | undefined;
  headroom: HeadroomRefresher | undefined;
  drawer: BudgetDrawer | undefined;
  poster: PricePoster | undefined;
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

/** Builds the services (opens and migrates the database). */
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

  const apiKeys = new ApiKeyService(repos.apiKeys, repos.workspaces, now);
  const sessions = new SessionService(repos.sessions, config.secrets.sessionSecret, now);
  const siwe = new SiweService(repos.nonces, {
    domain: config.server.publicHost,
    now,
    ...(deps.siweVerifier === undefined ? {} : { verifier: deps.siweVerifier }),
    publicClientFor: (chainId) => (chain !== undefined && chain.chainId === chainId ? chain.publicClient : undefined),
  });
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
  const warmDriver = deps.warmDriver ?? createWarmDriver(config, logger, deps.fetch === undefined ? undefined : (i, init) => deps.fetch!(i, init ?? {}));
  const warm = new WarmService(repos, warmDriver, now);
  const upgrades = new UpgradeService(repos, config, warm, now);
  const decimals = chain?.token?.decimals ?? 18;
  const price = new PriceService({ reader: chain?.reader, source: chain?.deployment.priceSourceKind ?? 'unknown', decimals, now });

  let indexer: Indexer | undefined;
  let headroom: HeadroomRefresher | undefined;
  let drawer: BudgetDrawer | undefined;
  let poster: PricePoster | undefined;
  if (chain !== undefined) {
    indexer = new Indexer(repos, chain.reader, { creditDesk: chain.creditDesk, startBlock: chain.startBlock, confirmations: config.chain.confirmations, chunkBlocks: config.chain.logChunkBlocks, now }, logger);
    headroom = new HeadroomRefresher(repos, chain.reader, { decimals, now }, logger);
    drawer = new BudgetDrawer(
      repos,
      chain.reader,
      chain.writer,
      { chainId: chain.chainId, creditDesk: chain.creditDesk, decimals, thresholdMicro: config.budgets.drawThresholdMicro, dryRun: config.operator.dryRun, now },
      logger,
    );
    if (config.poster.enabled && config.poster.feedUrl !== undefined) {
      poster = new PricePoster(
        repos,
        chain.reader,
        chain.writer,
        { feedUrl: config.poster.feedUrl, dryRun: config.operator.dryRun, postIntervalMs: config.poster.intervalMs, now, ...(deps.fetch === undefined ? {} : { fetch: (i: string, init?: RequestInit) => deps.fetch!(i, init ?? {}) }) },
        logger,
      );
    }
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
    siwe,
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
    chain,
    indexer,
    headroom,
    drawer,
    poster,
    version: GATEWAY_VERSION,
    close() {
      warm.stop();
      db.close();
    },
  };
}
