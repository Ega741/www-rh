/**
 * In-memory {@link BeagleApi} fake for the server tests: deterministic prices, an echoing
 * completion, a mutable ledger and per-method failure injection.
 */
import type { BalanceDto, BudgetDto, ConfigDto, ModelDto, StatusDto, UpgradeDto, UsageRowDto, UsageSummaryDto } from '@beagle/shared/api';
import { quoteUsdMicro, tokensForUsdMicro } from '@beagle/shared/credit';
import { ALIASES, DEFAULT_CATALOG } from '@beagle/shared/models';
import type { ChatCompletionRequest } from '@beagle/shared/openai';
import { BeagleApiError, type BeagleApi, type BeagleChatCompletion, type CompletionOptions } from '../src/api.js';

/** $0.01 per token. */
export const PRICE_E18 = 10n ** 16n;
export const WORKSPACE = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
export const DESK = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0';
export const TOKEN = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
export const PRICE_SOURCE = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512';
export const NOW_MS = 1_760_000_000_000;

export const PRO_PRICE_MICRO = 20_000_000n;
export const WARM_HOUR_PRICE_MICRO = 2_000_000n;

export interface FakeApiState {
  balanceMicro: bigint;
  reservedMicro: bigint;
  headroomMicro: bigint;
  plan: 'free' | 'pro';
  planUntil: number | null;
  budgets: BudgetDto[];
  usage: UsageRowDto[];
  upgrades: UpgradeDto[];
  models: ModelDto[];
  config: ConfigDto;
  status: StatusDto;
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
  callsTo(method: keyof BeagleApi): number;
}

export function defaultModels(): ModelDto[] {
  return DEFAULT_CATALOG.map((spec) => ({
    ...spec,
    available: spec.provider !== 'google',
    providerState: spec.provider === 'google' ? 'down' : 'ok',
  }));
}

export function defaultConfig(): ConfigDto {
  return {
    chainId: 31337,
    creditDesk: DESK,
    token: { address: TOKEN, symbol: 'BEAGLE', decimals: 18, nativeBurn: true },
    priceSource: PRICE_SOURCE,
    explorer: null,
    aliases: [...ALIASES],
    markupBps: 1000,
    byokFeeBps: 0,
    pro: { priceMicro: PRO_PRICE_MICRO, days: 30 },
    warmHourPriceMicro: WARM_HOUR_PRICE_MICRO,
  };
}

export function defaultStatus(): StatusDto {
  return {
    chainId: 31337,
    creditDesk: DESK,
    token: { address: TOKEN, symbol: 'BEAGLE', decimals: 18, nativeBurn: true },
    indexer: { lastBlock: 120, head: 121, lagBlocks: 1, lastEventAt: NOW_MS - 5_000 },
    providers: {
      anthropic: { state: 'ok', configured: true },
      openai: { state: 'ok', configured: true },
      google: { state: 'down', configured: false },
      house: { state: 'ok', configured: true },
    },
    house: { enabled: true, warmUntil: null, largeModel: 'house/gpt-oss-120b' },
    operator: { enabled: true, dryRun: false },
    version: '0.1.0-test',
  };
}

export function sampleBudget(overrides: Partial<BudgetDto> = {}): BudgetDto {
  return {
    budgetId: 3,
    owner: WORKSPACE,
    workspace: WORKSPACE,
    cap: 500n * 10n ** 18n,
    drawn: 100n * 10n ** 18n,
    remainingCap: 400n * 10n ** 18n,
    headroomTokens: 400n * 10n ** 18n,
    headroomMicro: 4_000_000n,
    deadline: Math.floor(NOW_MS / 1000) + 3600,
    closed: false,
    stalledReason: null,
    draws: [
      {
        id: 1,
        budgetId: 3,
        workspace: WORKSPACE,
        tokenAmount: 100n * 10n ** 18n,
        usdMicro: 1_000_000n,
        receiptHash: `0x${'11'.repeat(32)}`,
        usageIds: ['req_a', 'req_b'],
        txHash: `0x${'22'.repeat(32)}`,
        status: 'confirmed',
        error: null,
        createdAt: NOW_MS - 60_000,
        updatedAt: NOW_MS - 50_000,
      },
    ],
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
    models: defaultModels(),
    config: defaultConfig(),
    status: defaultStatus(),
    completionMeta: true,
    failures: {},
    calls: [],
    ...overrides,
  };
  const pending: Array<{ micro: bigint; remaining: number }> = [];
  let completions = 0;

  function record(method: keyof BeagleApi, args: unknown[]): void {
    state.calls.push({ method, args });
    const failure = state.failures[method];
    if (failure !== undefined) throw failure;
  }

  const balance = (): BalanceDto => ({
    balanceMicro: state.balanceMicro,
    reservedMicro: state.reservedMicro,
    budgetHeadroomMicro: state.headroomMicro,
    availableMicro: state.balanceMicro - state.reservedMicro + state.headroomMicro,
    plan: state.plan,
    planUntil: state.planUntil,
    price: {
      priceE18: PRICE_E18,
      updatedAt: Math.floor(NOW_MS / 1000) - 30,
      stale: false,
      usdPerToken: '0.01',
      tokensPerUsd: '100',
      source: 'manual',
      maxPriceAge: 3600,
    },
  });

  const api: FakeApi = {
    state,
    scheduleCredit(micro, afterCalls) {
      pending.push({ micro, remaining: afterCalls });
    },
    scheduleDebit(micro, afterCalls) {
      pending.push({ micro: -micro, remaining: afterCalls });
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
      const updatedAt = Math.floor(NOW_MS / 1000) - 30;
      if (q.tokens !== undefined) {
        return { tokens: q.tokens, usdMicro: quoteUsdMicro(q.tokens, PRICE_E18), priceE18: PRICE_E18, updatedAt };
      }
      if (q.usdMicro !== undefined) {
        return { tokens: tokensForUsdMicro(q.usdMicro, PRICE_E18), usdMicro: q.usdMicro, priceE18: PRICE_E18, updatedAt };
      }
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
        created: Math.floor(NOW_MS / 1000),
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
      return state.status;
    },

    async config() {
      record('config', []);
      return state.config;
    },
  };
  return api;
}
