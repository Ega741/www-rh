/**
 * In-memory {@link BeagleApi} fake for the server tests: deterministic prices, an echoing
 * completion, a mutable ledger, receipts the "indexer" can append on schedule, budget
 * registration and per-method failure injection.
 */
import { MEMO_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@beagle/shared/addresses';
import type { BalanceDto, BudgetDto, ConfigDto, CreditEventDto, ModelDto, PriceDto, StatusDto, UpgradeDto, UsageRowDto, UsageSummaryDto } from '@beagle/shared/api';
import { quoteUsdMicro, tokensForUsdMicro } from '@beagle/shared/credit';
import { ALIASES, DEFAULT_CATALOG } from '@beagle/shared/models';
import type { ChatCompletionRequest } from '@beagle/shared/openai';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { BeagleApiError, type BeagleApi, type BeagleChatCompletion, type CompletionOptions } from '../src/api.js';
import { AGENT, MINT, OPERATOR } from './fake-connection.js';

/** $0.01 per token. */
export const PRICE_E18 = 10n ** 16n;
export const DECIMALS = 6;
/** The agent wallet is the default workspace of the fake. */
export const WORKSPACE = AGENT;
/** The agent's associated token account of the mint. */
export const AGENT_ATA = getAssociatedTokenAddressSync(new PublicKey(MINT), new PublicKey(AGENT), true, new PublicKey(TOKEN_PROGRAM_ID)).toBase58();
export const NOW_MS = 1_760_000_000_000;
export const NOW_S = Math.floor(NOW_MS / 1000);
export const RPC_URL = 'http://127.0.0.1:8899';

export const PRO_PRICE_MICRO = 20_000_000n;
export const WARM_HOUR_PRICE_MICRO = 2_000_000n;

/** A base58 signature with a recognisable byte pattern. */
export function signatureOf(byte: number): string {
  return bs58.encode(new Uint8Array(64).fill(byte));
}
export const DRAW_SIGNATURE = signatureOf(0x22);

export interface FakeApiState {
  balanceMicro: bigint;
  reservedMicro: bigint;
  headroomMicro: bigint;
  plan: 'free' | 'pro';
  planUntil: number | null;
  budgets: BudgetDto[];
  usage: UsageRowDto[];
  upgrades: UpgradeDto[];
  receipts: CreditEventDto[];
  priceHistory: PriceDto[];
  models: ModelDto[];
  config: ConfigDto;
  status: StatusDto;
  /** Current price point staleness (also reflected in balance / quote / price). */
  priceStale: boolean;
  /** Attach `beagle` metadata to completions (the REST client does; an in-process impl may not). */
  completionMeta: boolean;
  /** Per-method injected failure. */
  failures: Partial<Record<keyof BeagleApi, Error>>;
  /** Every call, in order. */
  calls: Array<{ method: keyof BeagleApi; args: unknown[] }>;
}

export interface FakeApi extends BeagleApi {
  state: FakeApiState;
  /** Credits `micro` to the balance once `balance()` has been called `afterCalls` more times. */
  scheduleCredit(micro: bigint, afterCalls: number): void;
  /** Debits `micro` from the balance once `balance()` has been called `afterCalls` more times (a concurrent completion settling). */
  scheduleDebit(micro: bigint, afterCalls: number): void;
  /** Makes `row` appear in `receipts()` (and credits its usdMicro) once `receipts()` has been called `afterCalls` more times. */
  scheduleReceipt(row: CreditEventDto, afterCalls: number): void;
  callsTo(method: keyof BeagleApi): number;
}

export function defaultModels(): ModelDto[] {
  return DEFAULT_CATALOG.map((spec) => ({
    ...spec,
    available: spec.provider !== 'google',
    providerState: spec.provider === 'google' ? 'down' : 'ok',
  }));
}

export function samplePrice(overrides: Partial<PriceDto> = {}): PriceDto {
  return {
    pricePointId: 7,
    priceE18: PRICE_E18,
    observedAt: NOW_S - 30,
    stale: false,
    source: 'manual',
    maxAgeS: 3600,
    usdPerToken: '0.01',
    tokensPerUsd: '100',
    ...overrides,
  };
}

export function defaultConfig(): ConfigDto {
  return {
    cluster: 'localnet',
    rpcUrl: RPC_URL,
    mint: MINT,
    decimals: DECIMALS,
    symbol: 'BEAGLE',
    tokenProgram: TOKEN_PROGRAM_ID,
    memoProgram: MEMO_PROGRAM_ID,
    operator: OPERATOR,
    explorer: 'https://explorer.solana.com',
    aliases: [...ALIASES],
    markupBps: 1000,
    byokFeeBps: 0,
    minCreditMicro: 1_000n,
    pro: { priceMicro: PRO_PRICE_MICRO, days: 30 },
    warmHourPriceMicro: WARM_HOUR_PRICE_MICRO,
  };
}

export function defaultStatus(): StatusDto {
  return {
    cluster: 'localnet',
    mint: MINT,
    token: { mint: MINT, symbol: 'BEAGLE', decimals: DECIMALS, tokenProgram: TOKEN_PROGRAM_ID },
    indexer: { lastSignature: null, lastSlot: 120, headSlot: 121, lagSlots: 1, lastEventAt: NOW_MS - 5_000 },
    price: samplePrice(),
    providers: {
      anthropic: { state: 'ok', configured: true },
      openai: { state: 'ok', configured: true },
      google: { state: 'down', configured: false },
      house: { state: 'ok', configured: true },
    },
    house: { enabled: true, warmUntil: null, largeModel: 'house/gpt-oss-120b' },
    operator: { address: OPERATOR, enabled: true, dryRun: false },
    version: '0.1.0-test',
  };
}

export function sampleBudget(overrides: Partial<BudgetDto> = {}): BudgetDto {
  return {
    tokenAccount: AGENT_ATA,
    owner: WORKSPACE,
    workspace: WORKSPACE,
    delegate: OPERATOR,
    cap: 400n * 10n ** 6n,
    balance: 1_000n * 10n ** 6n,
    headroomTokens: 400n * 10n ** 6n,
    headroomMicro: 4_000_000n,
    closed: false,
    stalledReason: null,
    registeredAt: NOW_MS - 120_000,
    lastSeenSlot: 120,
    draws: [
      {
        id: 1,
        tokenAccount: AGENT_ATA,
        workspace: WORKSPACE,
        tokenAmount: 100n * 10n ** 6n,
        usdMicro: 1_000_000n,
        receiptHash: `0x${'11'.repeat(32)}`,
        usageIds: ['req_a', 'req_b'],
        signature: DRAW_SIGNATURE,
        status: 'confirmed',
        error: null,
        createdAt: NOW_MS - 60_000,
        updatedAt: NOW_MS - 50_000,
      },
    ],
    ...overrides,
  };
}

export function sampleReceipt(overrides: Partial<CreditEventDto> = {}): CreditEventDto {
  return {
    signature: signatureOf(0xab),
    ixIndex: 0,
    slot: 42,
    blockTime: NOW_S - 10,
    kind: 'purchase',
    workspace: WORKSPACE,
    payer: WORKSPACE,
    tokenAccount: AGENT_ATA,
    tokenAmount: 500n * 10n ** 6n,
    usdMicro: 5_000_000n,
    priceE18: PRICE_E18,
    pricePointId: 7,
    priceStale: false,
    memo: null,
    receiptHash: null,
    explorerUrl: null,
    ...overrides,
  };
}

export function sampleUsageRow(overrides: Partial<UsageRowDto> = {}): UsageRowDto {
  return {
    id: 'req_00000000-0000-4000-8000-000000000001',
    workspace: WORKSPACE,
    apiKeyId: 'key_1',
    endpoint: '/v1/chat/completions',
    requestedModel: 'beagle/auto',
    servedModel: 'house/gpt-oss-20b',
    provider: 'house',
    tier: 'house',
    paidBy: 'credit',
    inputTokens: 12,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    upstreamCostMicro: 5n,
    chargedMicro: 6n,
    status: 'ok',
    httpStatus: 200,
    errorCode: null,
    latencyMs: 350,
    routeReasons: ['alias beagle/auto → tier budget'],
    stream: false,
    difficulty: 0.25,
    drawId: null,
    createdAt: NOW_MS - 10_000,
    ...overrides,
  };
}

function lastUserText(req: ChatCompletionRequest): string {
  for (let i = req.messages.length - 1; i >= 0; i--) {
    const m = req.messages[i];
    if (m !== undefined && m.role === 'user') {
      if (typeof m.content === 'string') return m.content;
      return m.content.map((p) => (p.type === 'text' ? p.text : '[image]')).join('');
    }
  }
  return '';
}

export function createFakeApi(overrides: Partial<FakeApiState> = {}): FakeApi {
  const state: FakeApiState = {
    balanceMicro: 12_340_000n,
    reservedMicro: 0n,
    headroomMicro: 0n,
    plan: 'free',
    planUntil: null,
    budgets: [sampleBudget()],
    usage: [sampleUsageRow(), sampleUsageRow({ id: 'req_00000000-0000-4000-8000-000000000002', createdAt: NOW_MS - 20_000 })],
    upgrades: [],
    receipts: [],
    priceHistory: [samplePrice(), samplePrice({ pricePointId: 6, observedAt: NOW_S - 4000, priceE18: 9n * 10n ** 15n, usdPerToken: '0.009' })],
    models: defaultModels(),
    config: defaultConfig(),
    status: defaultStatus(),
    priceStale: false,
    completionMeta: true,
    failures: {},
    calls: [],
    ...overrides,
  };
  const pending: Array<{ micro: bigint; remaining: number }> = [];
  const pendingReceipts: Array<{ row: CreditEventDto; remaining: number }> = [];
  let completions = 0;

  function record(method: keyof BeagleApi, args: unknown[]): void {
    state.calls.push({ method, args });
    const failure = state.failures[method];
    if (failure !== undefined) throw failure;
  }

  const price = (): PriceDto => samplePrice({ stale: state.priceStale, observedAt: state.priceStale ? NOW_S - 7200 : NOW_S - 30 });

  const balance = (): BalanceDto => ({
    balanceMicro: state.balanceMicro,
    reservedMicro: state.reservedMicro,
    budgetHeadroomMicro: state.headroomMicro,
    availableMicro: state.balanceMicro - state.reservedMicro + state.headroomMicro,
    plan: state.plan,
    planUntil: state.planUntil,
    price: price(),
  });

  const api: FakeApi = {
    state,
    scheduleCredit(micro, afterCalls) {
      pending.push({ micro, remaining: afterCalls });
    },
    scheduleDebit(micro, afterCalls) {
      pending.push({ micro: -micro, remaining: afterCalls });
    },
    scheduleReceipt(row, afterCalls) {
      pendingReceipts.push({ row, remaining: afterCalls });
    },
    callsTo(method) {
      return state.calls.filter((c) => c.method === method).length;
    },

    async balance() {
      record('balance', []);
      for (let i = pending.length - 1; i >= 0; i--) {
        const p = pending[i]!;
        p.remaining -= 1;
        if (p.remaining <= 0) {
          state.balanceMicro += p.micro;
          pending.splice(i, 1);
        }
      }
      return balance();
    },

    async models() {
      record('models', []);
      return state.models;
    },

    async quote(q) {
      record('quote', [q]);
      const p = price();
      const base = { priceE18: PRICE_E18, pricePointId: p.pricePointId, stale: p.stale };
      if (q.tokens !== undefined) return { tokens: q.tokens, usdMicro: quoteUsdMicro(q.tokens, PRICE_E18, DECIMALS), ...base };
      if (q.usdMicro !== undefined) return { tokens: tokensForUsdMicro(q.usdMicro, PRICE_E18, DECIMALS), usdMicro: q.usdMicro, ...base };
      throw new BeagleApiError(400, 'invalid_request', 'pass tokens or usdMicro');
    },

    async complete(req: ChatCompletionRequest, options?: CompletionOptions) {
      record('complete', [req, options]);
      completions += 1;
      const cost = 1_500n;
      state.balanceMicro -= cost;
      const text = `echo: ${lastUserText(req)}`;
      const completion: BeagleChatCompletion = {
        id: `req_${completions}`,
        object: 'chat.completion',
        created: NOW_S,
        model: 'house/gpt-oss-20b',
        choices: [{ index: 0, message: { role: 'assistant', content: text, refusal: null }, finish_reason: 'stop', logprobs: null }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
      if (state.completionMeta) {
        completion.beagle = {
          requestId: completion.id,
          model: 'house/gpt-oss-20b',
          provider: 'house',
          paidBy: 'credit',
          costMicro: cost,
          balanceMicro: state.balanceMicro,
          route: ['alias beagle/auto → tier budget', 'fallback house'],
        };
      }
      return completion;
    },

    async usage(q) {
      record('usage', [q]);
      const rows = state.usage.slice(0, q.limit ?? 50);
      const summary: UsageSummaryDto = {
        window: q.window ?? '24h',
        requests: state.usage.length,
        chargedMicro: state.usage.reduce((s, r) => s + r.chargedMicro, 0n),
        upstreamCostMicro: state.usage.reduce((s, r) => s + r.upstreamCostMicro, 0n),
        inputTokens: state.usage.reduce((s, r) => s + r.inputTokens, 0),
        outputTokens: state.usage.reduce((s, r) => s + r.outputTokens, 0),
        byModel: [{ model: 'house/gpt-oss-20b', requests: state.usage.length, chargedMicro: 12n }],
        byDay: [{ day: '2025-10-09', requests: state.usage.length, chargedMicro: 12n }],
      };
      return { rows, summary };
    },

    async budgets() {
      record('budgets', []);
      return state.budgets;
    },

    async registerBudget(req) {
      record('registerBudget', [req]);
      const budget = sampleBudget({ tokenAccount: req.tokenAccount, workspace: req.workspace ?? WORKSPACE, registeredAt: NOW_MS, draws: [] });
      state.budgets = [...state.budgets.filter((b) => b.tokenAccount !== req.tokenAccount), budget];
      return budget;
    },

    async upgrade(kind, quantity) {
      record('upgrade', [kind, quantity]);
      const amount = (kind === 'pro' ? PRO_PRICE_MICRO : WARM_HOUR_PRICE_MICRO) * BigInt(quantity);
      const available = state.balanceMicro - state.reservedMicro + state.headroomMicro;
      if (available < amount) {
        throw new BeagleApiError(402, 'insufficient_credit', 'Insufficient credit: burn BEAGLE on the Credits page or open a budget.');
      }
      state.balanceMicro -= amount;
      const days = kind === 'pro' ? 30 * quantity : 0;
      const upgrade: UpgradeDto = {
        id: `upg_${state.upgrades.length + 1}`,
        workspace: WORKSPACE,
        kind,
        quantity,
        amountMicro: amount,
        startsAt: NOW_MS,
        endsAt: NOW_MS + (kind === 'pro' ? days * 86_400_000 : quantity * 3_600_000),
        createdAt: NOW_MS,
      };
      state.upgrades.push(upgrade);
      if (kind === 'pro') {
        state.plan = 'pro';
        state.planUntil = upgrade.endsAt;
      }
      return upgrade;
    },

    async status() {
      record('status', []);
      return { ...state.status, price: price() };
    },

    async config() {
      record('config', []);
      return state.config;
    },

    async price() {
      record('price', []);
      return price();
    },

    async priceHistory(q) {
      record('priceHistory', [q]);
      return state.priceHistory.slice(0, q?.limit ?? 100);
    },

    async receipts(q) {
      record('receipts', [q]);
      for (let i = pendingReceipts.length - 1; i >= 0; i--) {
        const p = pendingReceipts[i]!;
        p.remaining -= 1;
        if (p.remaining <= 0) {
          state.receipts = [p.row, ...state.receipts];
          state.balanceMicro += p.row.usdMicro;
          pendingReceipts.splice(i, 1);
        }
      }
      return { rows: state.receipts.slice(0, q?.limit ?? 50), nextBefore: null };
    },
  };
  return api;
}
