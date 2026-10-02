/**
 * Pons-mode indexing (`docs/SPEC.md` §9.4). For every block range:
 *
 * 1. `PonsMindRegistry` logs (MindCore events + `MindLaunched` / `AdoptionPrepared` / `MindAdopted`
 *    / `MindLeft` / `PoolIdSet` / …); new registrations are resolved (curve, launch record, curve
 *    parameters, token supply) with chain reads before anything is applied;
 * 2. for the registered tokens (known ones plus those registered in this range): the curves'
 *    `CurveBuy` / `CurveSell` / `CurveBuyRefunded` / `FeesSwept` / `CurveCompleted` (address-filtered
 *    `eth_getLogs` over the set of curves), the factory's `LaunchSwept` / `PoolGraduated` /
 *    `CreatorFeeRecipientUpdated` filtered by token, the escrow's `Credited` / `Claimed` filtered by
 *    mind account, and the hook's `PoolRegistered` filtered by memecoin;
 * 3. post-trade reserves: for every (curve, block) with trades, `getReserves()` +
 *    `realQuoteReserve()` are read at that block and the block's trades are walked back from that
 *    end-of-block state (from the `CurveCompleted` amounts when the block graduated the curve), so
 *    every trade's price is anchored to on-chain state. When the historical read fails, the reserves
 *    follow forward from the last indexed state;
 * 4. everything is merged in `(blockNumber, logIndex)` order and applied in the indexer's single
 *    range transaction (idempotent on `(tx_hash, log_index)` through `chain_events`).
 *
 * Mapping: trades → the §5 `Trade` (`ethAmountWei` = spent / quoteOut, `feeWei` = fee + tax, post-trade
 * price from the reserves, `realEthReserveWei` = `realQuoteReserve`, `tokensSold` = supply − token
 * reserve); `Swept` (`LaunchSwept` / `CurveCompleted`) → phase `complete` with the price frozen at the
 * final curve price; `PoolGraduated` → `graduated`; escrow `Credited` − `Claimed` → `claimableWei`.
 *
 * @module indexer/pons
 */
import { encodeEventTopics, parseEventLogs, zeroAddress, type Abi, type Address, type Hex, type Log } from 'viem';
import { ponsCurveAbi, ponsFactoryAbi, ponsFeeEscrowAbi, ponsMemeHookAbi, ponsMindRegistryAbi, ponsPrice } from '@www-rh/shared';
import type { OnchainMind } from '../chain/launchpad.js';
import { addressTopic, type OnchainPonsMind, type PonsCurveParams, type PonsCurveState, type PonsLaunchedToken, type PonsReader, type PonsTokenInfo } from '../chain/pons.js';
import type { PonsMindRow, Repos } from '../db/repos.js';
import { errorMessage, type Logger } from '../log.js';
import { applyCoreEvent, CORE_EVENTS, STATE_TOTAL_FEES_TO_MINDS, STATE_TOTAL_VOLUME, type AnomalySink, type ApplyContext, type CoreEvent } from './apply.js';
import type { IndexedEvent } from './events.js';
import type { LogSource, RawLog } from './source.js';
import type { IndexerVenue, RangeBatch } from './venue.js';

const WAD = 10n ** 18n;
/** Addresses / topic values per `eth_getLogs` request. */
export const PONS_LOGS_CHUNK = 100;

/** Chain reads the Pons indexer needs. */
export type PonsIndexReader = Pick<PonsReader, 'contracts' | 'launchedToken' | 'ponsMind' | 'curveState' | 'curveParams' | 'tokenInfo' | 'getMind'>;

type SourceKind = 'registry' | 'curve' | 'factory' | 'escrow' | 'hook';

/** One decoded log of any Pons source. */
export interface PonsDecodedLog {
  log: RawLog;
  source: SourceKind;
  eventName: string;
  args: Record<string, unknown>;
}

/** Everything known about a registration before it is applied. */
export interface PonsRegistration {
  token: string;
  curve: string;
  account: string;
  launchedHere: boolean;
  launchConfigId: bigint | null;
  launch: PonsLaunchedToken | null;
  params: PonsCurveParams | null;
  tokenInfo: PonsTokenInfo | null;
  /** Read for adoptions whose `MindCreated` is not part of the batch. */
  mind: OnchainMind | null;
}

/** Reserve state after a trade. */
export type ReserveState = PonsCurveState;

/** A curve trade reduced to its reserve effect. */
export interface CurveTradeDelta {
  key: string;
  isBuy: boolean;
  /** `quoteIn` (spent) of a buy, `quoteOut` of a sell. */
  quote: bigint;
  /** `tokensOut` of a buy, `tokensIn` of a sell. */
  tokens: bigint;
  fee: bigint;
  tax: bigint;
}

/** Applies a trade to a reserve state (forward). */
export function applyTradeDelta(s: ReserveState, t: CurveTradeDelta): ReserveState {
  const dq = t.isBuy ? t.quote - t.fee - t.tax : -(t.quote + t.fee + t.tax);
  const dt = t.isBuy ? -t.tokens : t.tokens;
  return { quoteReserve: s.quoteReserve + dq, tokenReserve: s.tokenReserve + dt, realQuoteReserve: s.realQuoteReserve + dq };
}

/**
 * Post-trade reserve states of the trades of one curve in one block (chain order), walking back
 * from `after` — the state right after the last trade: the end-of-block `getReserves()` read, or the
 * pre-graduation state `(phantom + quoteOut, tokenOut)` when `CurveCompleted` drained the curve in
 * that block. (A snipe tax inside the window is not visible in the events; earlier trades of such a
 * block are approximated.)
 */
export function walkBackStates(trades: readonly CurveTradeDelta[], after: ReserveState): Map<string, ReserveState> {
  const out = new Map<string, ReserveState>();
  let cur = after;
  for (let i = trades.length - 1; i >= 0; i--) {
    const t = trades[i] as CurveTradeDelta;
    out.set(t.key, cur);
    const dq = t.isBuy ? t.quote - t.fee - t.tax : -(t.quote + t.fee + t.tax);
    const dt = t.isBuy ? -t.tokens : t.tokens;
    cur = { quoteReserve: cur.quoteReserve - dq, tokenReserve: cur.tokenReserve - dt, realQuoteReserve: cur.realQuoteReserve - dq };
  }
  return out;
}

/** Market fields of a mind row from a reserve state. */
export function ponsMarket(s: ReserveState, supply: bigint | null): { realEthReserve: string; tokensSold: string; priceWei: string; mcapSort: number } {
  const price = ponsPrice(s.quoteReserve, s.tokenReserve);
  const mcap = supply === null ? 0n : (price * supply) / WAD;
  const sold = supply !== null && supply > s.tokenReserve ? supply - s.tokenReserve : 0n;
  return {
    realEthReserve: (s.realQuoteReserve < 0n ? 0n : s.realQuoteReserve).toString(10),
    tokensSold: sold.toString(10),
    priceWei: price.toString(10),
    mcapSort: Number(mcap) / 1e18,
  };
}

const keyOf = (log: RawLog): string => `${log.transactionHash.toLowerCase()}:${log.logIndex}`;
const lower = (v: unknown): string => String(v).toLowerCase();
const big = (v: string | null | undefined): bigint | null => (v === null || v === undefined ? null : BigInt(v));

function decodeWith(abi: Abi, source: SourceKind, logs: readonly RawLog[]): PonsDecodedLog[] {
  const out: PonsDecodedLog[] = [];
  for (const log of logs) {
    try {
      const [parsed] = parseEventLogs({ abi, logs: [log as unknown as Log], strict: true });
      if (parsed !== undefined) out.push({ log, source, eventName: parsed.eventName, args: parsed.args as Record<string, unknown> });
    } catch {
      // an event outside the minimal ABI (e.g. the curve's snipe-tax events): not needed
    }
  }
  return out;
}

const chunks = <T>(items: readonly T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const topic0 = (abi: Abi, eventName: string): Hex => (encodeEventTopics({ abi, eventName } as Parameters<typeof encodeEventTopics>[0])[0] as Hex);

/** Blocks needing a timestamp: logs that store a time. */
const TIMESTAMPED = new Set(['MindCreated', 'MindFunded', 'ComputeDrawn', 'Harvested', 'AdoptionPrepared', 'MindLaunched', 'CurveBuy', 'CurveSell', 'CurveCompleted', 'LaunchSwept']);

/** Pons mode: registry logs plus the address-filtered Pons logs of the registered tokens. */
export class PonsIndexerVenue implements IndexerVenue {
  readonly venue = 'pons' as const;

  constructor(
    readonly address: Address | null,
    private readonly reader: PonsIndexReader | null,
    private readonly log: Logger,
    private readonly chunkSize = PONS_LOGS_CHUNK,
  ) {}

  async #registration(repos: Repos, r: { token: string; curve: string | null; account: string; launchedHere: boolean; launchConfigId: bigint | null }, needMind: boolean): Promise<PonsRegistration> {
    const reader = this.reader;
    const token = r.token as Address;
    const soft = async <T>(what: string, fn: (() => Promise<T>) | undefined): Promise<T | null> => {
      if (fn === undefined) return null;
      try {
        return await fn();
      } catch (err) {
        this.log.warn(`Pons registration: ${what} unavailable`, { token: r.token, error: errorMessage(err) });
        return null;
      }
    };
    const launch = await soft('getLaunchedToken', reader ? () => reader.launchedToken(token) : undefined);
    let curve = r.curve ?? (launch !== null && launch.curve !== zeroAddress ? launch.curve.toLowerCase() : null);
    let pons: OnchainPonsMind | null = null;
    if (curve === null || r.launchConfigId === null) {
      pons = await soft('ponsMind', reader ? () => reader.ponsMind(token) : undefined);
      if (curve === null && pons !== null && pons.curve !== zeroAddress) curve = pons.curve.toLowerCase();
    }
    // without the curve no trade of this mind can be indexed: retry the range
    if (curve === null) throw new Error(`cannot resolve the Pons curve of ${r.token} (registry ponsMind / factory getLaunchedToken)`);
    const known = repos.pons.get(r.token);
    const [params, tokenInfo, mind] = await Promise.all([
      known?.fee_bps != null ? Promise.resolve(null) : soft('curve parameters', reader ? () => reader.curveParams(curve as Address) : undefined),
      known?.supply != null ? Promise.resolve(null) : soft('token info', reader ? () => reader.tokenInfo(token) : undefined),
      needMind ? soft('getMind', reader ? () => reader.getMind(token) : undefined) : Promise.resolve(null),
    ]);
    return { token: r.token, curve, account: r.account, launchedHere: r.launchedHere, launchConfigId: r.launchConfigId ?? pons?.launchConfigId ?? null, launch, params, tokenInfo, mind };
  }

  async fetchRange(source: LogSource, fromBlock: bigint, toBlock: bigint, repos: Repos): Promise<RangeBatch> {
    if (this.address === null) return { rawCount: 0, logCount: 0, blocksNeedingTimestamps: [], apply: () => [] };
    const registryRaw = await source.getLogs(this.address, fromBlock, toBlock);
    const registryLogs = decodeWith(ponsMindRegistryAbi, 'registry', registryRaw);

    // ------------------------------------------------------------ registrations in this range
    const created = new Set(registryLogs.filter((d) => d.eventName === 'MindCreated').map((d) => lower(d.args['token'])));
    const pending = new Map<string, { token: string; curve: string | null; account: string; launchedHere: boolean; launchConfigId: bigint | null; block: bigint }>();
    for (const d of registryLogs) {
      const token = lower(d.args['token']);
      if (pending.has(token) || repos.pons.get(token) !== undefined) continue;
      if (d.eventName === 'MindLaunched') {
        pending.set(token, { token, curve: lower(d.args['curve']), account: lower(d.args['account']), launchedHere: true, launchConfigId: d.args['launchConfigId'] as bigint, block: d.log.blockNumber });
      } else if (d.eventName === 'AdoptionPrepared') {
        pending.set(token, { token, curve: null, account: lower(d.args['account']), launchedHere: false, launchConfigId: null, block: d.log.blockNumber });
      }
    }
    const registrations = new Map<string, PonsRegistration>();
    for (const r of pending.values()) {
      registrations.set(r.token, await this.#registration(repos, r, !created.has(r.token) && repos.minds.get(r.token) === undefined));
    }

    // ------------------------------------------------------------ address sets
    const rows = repos.pons.all();
    const tokens = [...new Set([...rows.map((r) => r.token), ...registrations.keys()])];
    const curves = [...new Set([...rows.map((r) => r.curve), ...[...registrations.values()].map((r) => r.curve)])];
    const accounts = [...new Set([...rows.map((r) => r.account), ...[...registrations.values()].map((r) => r.account)])];
    const tokenSet = new Set(tokens);

    let rawCount = registryRaw.length;
    const decoded: PonsDecodedLog[] = [...registryLogs];
    if (tokens.length > 0) {
      if (this.reader === null) throw new Error('Pons reads unavailable: cannot index curve / factory / escrow / hook logs');
      const c = await this.reader.contracts();
      const fetchAll = async (filters: Parameters<LogSource['getLogsFiltered']>[0][]): Promise<RawLog[]> => {
        const out: RawLog[] = [];
        for (const f of filters) out.push(...(await source.getLogsFiltered(f)));
        rawCount += out.length;
        return out;
      };
      const range = { fromBlock, toBlock };
      const curveRaw = await fetchAll(chunks(curves as Address[], this.chunkSize).map((address) => ({ address, ...range })));
      const factoryTopics = ['LaunchSwept', 'PoolGraduated', 'CreatorFeeRecipientUpdated'].map((e) => topic0(ponsFactoryAbi, e));
      const factoryRaw = await fetchAll(chunks(tokens, this.chunkSize).map((ts) => ({ address: c.factory, topics: [factoryTopics, ts.map(addressTopic)], ...range })));
      const escrowTopics = ['Credited', 'Claimed'].map((e) => topic0(ponsFeeEscrowAbi, e));
      const escrowRaw = await fetchAll(chunks(accounts, this.chunkSize).map((as) => ({ address: c.feeEscrow, topics: [escrowTopics, as.map(addressTopic)], ...range })));
      // PoolRegistered's memecoin is not indexed: fetch the event, filter here
      const hookRaw = await fetchAll([{ address: c.memeHook, topics: [[topic0(ponsMemeHookAbi, 'PoolRegistered')]], ...range }]);
      const curveSet = new Set(curves);
      decoded.push(...decodeWith(ponsCurveAbi, 'curve', curveRaw.filter((l) => curveSet.has(l.address.toLowerCase()))));
      decoded.push(...decodeWith(ponsFactoryAbi, 'factory', factoryRaw.filter((l) => l.address.toLowerCase() === c.factory.toLowerCase())).filter((d) => tokenSet.has(lower(d.args['token']))));
      decoded.push(...decodeWith(ponsFeeEscrowAbi, 'escrow', escrowRaw.filter((l) => l.address.toLowerCase() === c.feeEscrow.toLowerCase())));
      decoded.push(...decodeWith(ponsMemeHookAbi, 'hook', hookRaw.filter((l) => l.address.toLowerCase() === c.memeHook.toLowerCase())).filter((d) => d.eventName === 'PoolRegistered' && tokenSet.has(lower(d.args['memecoin']))));
    }
    decoded.sort((a, b) => (a.log.blockNumber === b.log.blockNumber ? a.log.logIndex - b.log.logIndex : a.log.blockNumber < b.log.blockNumber ? -1 : 1));

    // ------------------------------------------------------------ reserve anchors per (curve, block)
    const perBlock = new Map<string, { curve: string; block: bigint; trades: CurveTradeDelta[]; completed: { quoteOut: bigint; tokenOut: bigint } | null }>();
    const blockKey = (curve: string, block: bigint): string => `${curve}@${block}`;
    const entry = (curve: string, block: bigint) => {
      const k = blockKey(curve, block);
      let e = perBlock.get(k);
      if (e === undefined) perBlock.set(k, (e = { curve, block, trades: [], completed: null }));
      return e;
    };
    for (const r of pending.values()) entry((registrations.get(r.token) as PonsRegistration).curve, r.block);
    for (const d of decoded) {
      if (d.source !== 'curve') continue;
      const curve = d.log.address.toLowerCase();
      if (d.eventName === 'CurveBuy' || d.eventName === 'CurveSell') {
        const a = d.args as Record<string, bigint>;
        const isBuy = d.eventName === 'CurveBuy';
        entry(curve, d.log.blockNumber).trades.push({ key: keyOf(d.log), isBuy, quote: isBuy ? (a['quoteIn'] as bigint) : (a['quoteOut'] as bigint), tokens: isBuy ? (a['tokensOut'] as bigint) : (a['tokensIn'] as bigint), fee: a['fee'] as bigint, tax: a['tax'] as bigint });
      } else if (d.eventName === 'CurveCompleted') {
        entry(curve, d.log.blockNumber).completed = { quoteOut: d.args['quoteOut'] as bigint, tokenOut: d.args['tokenOut'] as bigint };
      }
    }
    const anchors = new Map<string, ReserveState>(); // end-of-block state per (curve, block)
    const phantoms = new Map<string, bigint>();
    const postStates = new Map<string, ReserveState>();
    for (const [k, e] of perBlock) {
      let end: ReserveState | null = null;
      if (this.reader !== null) {
        try {
          end = await this.reader.curveState(e.curve as Address, e.block);
        } catch (err) {
          this.log.debug('historical getReserves() unavailable; following reserves forward', { curve: e.curve, block: e.block, error: errorMessage(err) });
        }
      }
      if (end !== null) {
        anchors.set(k, end);
        phantoms.set(e.curve, end.quoteReserve - end.realQuoteReserve);
      }
      const phantom = phantoms.get(e.curve) ?? big(repos.pons.byCurve(e.curve)?.phantom_quote ?? null);
      const after: ReserveState | null =
        e.completed !== null
          ? phantom === null
            ? null
            : { quoteReserve: phantom + e.completed.quoteOut, tokenReserve: e.completed.tokenOut, realQuoteReserve: e.completed.quoteOut }
          : end;
      if (after !== null && e.trades.length > 0) for (const [key, s] of walkBackStates(e.trades, after)) postStates.set(key, s);
    }

    const blocks = new Set<bigint>();
    for (const d of decoded) if (d.log.blockTimestamp === undefined && TIMESTAMPED.has(d.eventName)) blocks.add(d.log.blockNumber);

    return {
      rawCount,
      logCount: decoded.length,
      blocksNeedingTimestamps: [...blocks],
      apply: (r, timestampOf, onAnomaly) => applyPonsLogs(r, decoded, { registrations, anchors, phantoms, postStates }, timestampOf, onAnomaly),
    };
  }
}

/** Pre-read state {@link applyPonsLogs} uses. */
export interface PonsPrefetch {
  registrations: ReadonlyMap<string, PonsRegistration>;
  /** End-of-block reserves, keyed `${curve}@${block}`. */
  anchors: ReadonlyMap<string, ReserveState>;
  /** Phantom quote reserve per curve (`quoteReserve − realQuoteReserve`). */
  phantoms: ReadonlyMap<string, bigint>;
  /** Post-trade states, keyed `${txHash}:${logIndex}`. */
  postStates: ReadonlyMap<string, ReserveState>;
}

/** Applies decoded Pons logs (chain order) inside the caller's transaction; returns the domain events of newly applied logs. */
export function applyPonsLogs(
  repos: Repos,
  decoded: readonly PonsDecodedLog[],
  pre: PonsPrefetch,
  timestampOf: (block: bigint) => bigint,
  onAnomaly: AnomalySink = () => undefined,
): IndexedEvent[] {
  const out: IndexedEvent[] = [];
  const supplyOf = (row: PonsMindRow | undefined): bigint | null => big(row?.supply ?? null);
  const phantomOf = (row: PonsMindRow): bigint | null => pre.phantoms.get(row.curve) ?? big(row.phantom_quote);

  /** Freezes the market at the final curve state (Swept) and advances the phase; returns whether it advanced. */
  const sweep = (token: string, quoteOut: bigint, tokenOut: bigint, ms: number): boolean => {
    const row = repos.pons.get(token);
    const mind = repos.minds.get(token);
    if (row === undefined || mind === undefined) return false;
    const phantom = phantomOf(row);
    if (phantom !== null && tokenOut > 0n) {
      repos.minds.setMarket(token, ponsMarket({ quoteReserve: phantom + quoteOut, tokenReserve: tokenOut, realQuoteReserve: quoteOut }, supplyOf(row)));
    }
    repos.pons.patch(token, { launch_phase: Math.max(row.launch_phase, 1), swept_at: row.swept_at ?? ms });
    if (mind.phase >= 1) return false;
    repos.minds.advancePhase(token, 1);
    return true;
  };

  const register = (reg: PonsRegistration, ctx: ApplyContext, creator: string | null): IndexedEvent[] => {
    const evs: IndexedEvent[] = [];
    const base = { blockNumber: ctx.blockNumber, txHash: ctx.txHash };
    const t = reg.token;
    if (repos.minds.get(t) === undefined) {
      // an adoption without MindCreated in this batch: build the mind row from chain reads
      const m = reg.mind;
      repos.minds.insertCreated({
        token: t, creator: (creator ?? m?.creator ?? zeroAddress).toLowerCase(), name: reg.tokenInfo?.name ?? '', symbol: reg.tokenInfo?.symbol ?? '',
        metadataUri: m?.metadataURI ?? '', modelId: (m?.modelId ?? `0x${'00'.repeat(32)}`).toLowerCase(), personaHash: (m?.personaHash ?? `0x${'00'.repeat(32)}`).toLowerCase(),
        blockNumber: ctx.blockNumber, logIndex: ctx.log.logIndex, createdAt: ctx.ms(), priceWei: '0', mcapSort: 0, venue: 'pons',
      });
      evs.push({ type: 'mind:created', token: t, ...base });
    }
    repos.db.run("UPDATE minds SET venue = 'pons' WHERE token = ?", t);
    repos.pons.insert({ token: t, curve: reg.curve, account: reg.account, launchedHere: reg.launchedHere });
    const l = reg.launch;
    repos.pons.patch(t, {
      deployer: l?.deployer.toLowerCase() ?? null,
      fee_recipient: l?.creatorFeeRecipient.toLowerCase() ?? null,
      launch_config_id: reg.launchConfigId === null ? null : Number(reg.launchConfigId),
      fee_bps: reg.params === null ? undefined : Number(reg.params.feeBps),
      creator_tax_bps: reg.params !== null ? Number(reg.params.creatorTaxBps) : l !== null ? l.creatorTaxBps : undefined,
      graduation_threshold: (reg.params?.graduationThreshold ?? l?.graduationThreshold)?.toString(10),
      supply: reg.tokenInfo?.totalSupply.toString(10),
      phantom_quote: pre.phantoms.get(reg.curve)?.toString(10),
      launch_phase: l?.phase ?? 0,
    });
    const row = repos.pons.get(t) as PonsMindRow;
    const anchor = pre.anchors.get(`${reg.curve}@${ctx.log.blockNumber}`);
    if (anchor !== undefined && anchor.tokenReserve > 0n) {
      repos.minds.setMarket(t, ponsMarket(anchor, supplyOf(row)));
      repos.pons.patch(t, { quote_reserve: anchor.quoteReserve.toString(10), token_reserve: anchor.tokenReserve.toString(10) });
    }
    // an adopted launch may already have graduated
    if (l !== null && l.phase >= 1) {
      sweep(t, l.sweptQuote, l.sweptTokens, l.sweptAt > 0n ? Number(l.sweptAt) * 1000 : ctx.ms());
      if (l.phase >= 2) repos.minds.setGraduated(t, null, null);
    }
    return evs;
  };

  const setStatus = (token: string, status: number, base: { blockNumber: number; txHash: string }): IndexedEvent | null => {
    const mind = repos.minds.get(token);
    if (mind === undefined || mind.status === status) return null;
    repos.minds.setStatus(token, status);
    return { type: 'mind:status', token, status, ...base };
  };

  for (const d of decoded) {
    const { log } = d;
    const txHash = log.transactionHash.toLowerCase();
    const blockNumber = Number(log.blockNumber);
    const ctx: ApplyContext = { log, txHash, blockNumber, ms: () => Number(log.blockTimestamp ?? timestampOf(log.blockNumber)) * 1000, onAnomaly };
    const base = { blockNumber, txHash };
    const a = d.args;

    // the mind this log belongs to
    let row: PonsMindRow | undefined;
    let token: string | null = null;
    switch (d.source) {
      case 'registry':
        token = typeof a['token'] === 'string' ? lower(a['token']) : null;
        break;
      case 'curve':
        row = repos.pons.byCurve(log.address);
        token = row?.token ?? null;
        break;
      case 'factory':
        token = lower(a['token']);
        break;
      case 'escrow':
        row = repos.pons.byAccount(lower(a['recipient']));
        token = row?.token ?? null;
        break;
      case 'hook':
        token = lower(a['memecoin']);
        break;
    }
    if (d.source !== 'registry' && token === null) continue; // not ours (e.g. a curve registered later in the range)
    if (!repos.chain.insertEvent(txHash, log.logIndex, blockNumber, d.eventName, token)) continue;

    if (d.source === 'registry') {
      if (CORE_EVENTS.has(d.eventName)) {
        const ev = applyCoreEvent(repos, { eventName: d.eventName, args: a } as unknown as CoreEvent, ctx, { venue: 'pons', priceWei: '0', mcapSort: 0 });
        if (ev !== null) out.push(ev);
        if (d.eventName === 'Harvested' && token !== null) {
          // harvests are the vault income of Pons minds (fee shares arrive through the escrow, not FeeAccrued)
          repos.state.addBigint(STATE_TOTAL_FEES_TO_MINDS, a['ethOut'] as bigint);
          repos.pons.patch(token, { last_harvest_at: ctx.ms() });
        }
        continue;
      }
      if (token === null) continue;
      switch (d.eventName) {
        case 'MindLaunched':
        case 'AdoptionPrepared': {
          const reg = pre.registrations.get(token);
          if (reg === undefined) {
            if (repos.pons.get(token) === undefined) onAnomaly('Pons registration without pre-read state (skipped)', { token, event: d.eventName, txHash });
            break;
          }
          out.push(...register(reg, ctx, d.eventName === 'AdoptionPrepared' ? lower(a['creator']) : null));
          if (d.eventName === 'AdoptionPrepared') {
            // registered Dormant until the fee recipient is handed over (activateAdoption)
            const ev = setStatus(token, 1, base);
            if (ev !== null) out.push(ev);
          }
          break;
        }
        case 'MindAdopted': {
          repos.pons.patch(token, { adopted: 1, fee_recipient: lower(a['account']) });
          out.push({ type: 'pons:adopted', token, ...base });
          const mind = repos.minds.get(token);
          if (mind !== undefined && mind.status !== 2) {
            const ev = setStatus(token, 0, base);
            if (ev !== null) out.push(ev);
          }
          break;
        }
        case 'MindLeft': {
          repos.pons.patch(token, { fee_recipient: lower(a['newRecipient']) });
          out.push({ type: 'pons:left', token, ...base });
          const mind = repos.minds.get(token);
          if (mind !== undefined && mind.status !== 2) {
            const ev = setStatus(token, 1, base);
            if (ev !== null) out.push(ev);
          }
          break;
        }
        case 'PoolIdSet':
          repos.pons.patch(token, { registry_pool_id: lower(a['poolId']) });
          break;
        default:
          // SweepAttempted, MindFeeUpdated, admin and OpenZeppelin events: recorded in chain_events only
          break;
      }
      continue;
    }

    const t = token as string;
    switch (d.eventName) {
      case 'CurveBuy':
      case 'CurveSell': {
        const r = row as PonsMindRow;
        const isBuy = d.eventName === 'CurveBuy';
        const quote = (isBuy ? a['quoteIn'] : a['quoteOut']) as bigint;
        const tokens = (isBuy ? a['tokensOut'] : a['tokensIn']) as bigint;
        const fee = a['fee'] as bigint;
        const tax = a['tax'] as bigint;
        let state = pre.postStates.get(`${txHash}:${log.logIndex}`) ?? null;
        if (state === null && r.quote_reserve !== null && r.token_reserve !== null) {
          // no historical read for this block: follow forward from the last indexed state
          const q = BigInt(r.quote_reserve);
          const phantom = phantomOf(r);
          state = applyTradeDelta({ quoteReserve: q, tokenReserve: BigInt(r.token_reserve), realQuoteReserve: phantom === null ? 0n : q - phantom }, { key: '', isBuy, quote, tokens, fee, tax });
        }
        const market = state === null ? null : ponsMarket(state, supplyOf(r));
        const trade = {
          tx_hash: txHash, log_index: log.logIndex, block_number: blockNumber, timestamp: ctx.ms(), token: t,
          // buys: the recipient gets the tokens (the buyer may be a router or the registry); sells: the seller
          trader: lower(isBuy ? a['recipient'] : a['seller']),
          is_buy: isBuy ? 1 : 0, eth_amount: quote.toString(10), token_amount: tokens.toString(10), fee: (fee + tax).toString(10),
          real_eth_reserve: market?.realEthReserve ?? '0', tokens_sold: market?.tokensSold ?? '0', price_wei: market?.priceWei ?? '0',
        };
        repos.trades.insert(trade);
        if (state !== null && market !== null) {
          repos.minds.setMarket(t, market);
          repos.pons.patch(t, { quote_reserve: state.quoteReserve.toString(10), token_reserve: state.tokenReserve.toString(10) });
        }
        repos.pons.addPending(t, fee, tax);
        // gross ETH: spent for buys, quoteOut + fee + tax for sells (SPEC §5)
        repos.state.addBigint(STATE_TOTAL_VOLUME, isBuy ? quote : quote + fee + tax);
        out.push({ type: 'trade', token: t, trade, ...base });
        break;
      }
      case 'FeesSwept':
        repos.pons.patch(t, { pending_fee: '0', pending_tax: '0' });
        break;
      case 'CurveCompleted':
      case 'LaunchSwept':
        if (sweep(t, a['quoteOut'] as bigint, a['tokenOut'] as bigint, ctx.ms())) out.push({ type: 'curve:complete', token: t, ...base });
        break;
      case 'PoolGraduated': {
        const mind = repos.minds.get(t);
        repos.pons.patch(t, { launch_phase: 2 });
        repos.minds.setGraduated(t, null, (a['positionId'] as bigint).toString(10));
        if (mind !== undefined && mind.phase < 2) out.push({ type: 'graduated', token: t, ...base });
        break;
      }
      case 'CreatorFeeRecipientUpdated':
        repos.pons.patch(t, { fee_recipient: lower(a['newRecipient']) });
        break;
      case 'Credited': {
        const amount = a['amount'] as bigint;
        repos.pons.addClaimable(t, amount);
        out.push({ type: 'pons:credited', token: t, amount, ...base });
        break;
      }
      case 'Claimed': {
        const amount = a['amount'] as bigint;
        const r = repos.pons.addClaimable(t, -amount);
        if (r?.clampedFrom != null) onAnomaly('indexed claimable would go negative; stored as 0 (missed escrow credit?)', { token: t, txHash, wouldBe: r.clampedFrom });
        out.push({ type: 'pons:claimed', token: t, amount, ...base });
        break;
      }
      case 'PoolRegistered': {
        const poolId = lower(a['poolId']);
        repos.pons.patch(t, { pool_id: poolId });
        out.push({ type: 'pons:pool-registered', token: t, poolId, ...base });
        break;
      }
      default:
        // CurveBuyRefunded: recorded in chain_events only
        break;
    }
  }
  return out;
}
