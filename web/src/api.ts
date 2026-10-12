/**
 * Typed client of the dashboard API (SPEC §5.9). Wire DTOs are parsed with the zod schemas of
 * `@beagle/shared/api`, so every monetary field, token amount and `priceE18` arrives as `bigint`. Requests send the session
 * cookie (`credentials: 'include'`) and, when the gateway is on another origin, the session token
 * returned by `POST /api/auth/verify` as a bearer header. The token lives in `localStorage` so a
 * cross-origin deployment (where the SameSite=Lax cookie never reaches `fetch`) keeps the 7-day
 * session across tabs and reloads; sign-out and a 401/403 clear it.
 */
import {
  ApiKeyDtoSchema,
  BalanceDtoSchema,
  BudgetDrawDtoSchema,
  BudgetDtoSchema,
  ConfigDtoSchema,
  CreditEventListDtoSchema,
  ErrorDtoSchema,
  LedgerListDtoSchema,
  MeDtoSchema,
  ModelsDtoSchema,
  NonceDtoSchema,
  PriceDtoSchema,
  PriceHistoryDtoSchema,
  ProviderKeyDtoSchema,
  ProviderTestDtoSchema,
  QuoteDtoSchema,
  ReceiptDtoSchema,
  StatusDtoSchema,
  UpgradeDtoSchema,
  UpgradePricesDtoSchema,
  UsageListDtoSchema,
  UsageSummaryDtoSchema,
  VerifyDtoSchema,
} from '@beagle/shared/api';
import type {
  ApiKeyDto,
  BalanceDto,
  BudgetDrawDto,
  BudgetDto,
  ConfigDto,
  CreditEventListDto,
  LedgerListDto,
  MeDto,
  ModelsDto,
  NonceDto,
  PriceDto,
  PriceHistoryDto,
  ProviderKeyDto,
  RegisterBudgetRequest,
  ProviderTestDto,
  QuoteDto,
  ReceiptDto,
  StatusDto,
  UpgradeDto,
  UpgradePricesDto,
  UsageListDto,
  UsageSummaryDto,
  VerifyDto,
} from '@beagle/shared/api';
import type { ByokProvider } from '@beagle/shared/models';
import { config } from './config.js';
import { ApiError } from './lib/apiError.js';
import type { UsageWindow } from './lib/windows.js';

export { ApiError, isApiError } from './lib/apiError.js';

/** Anything with a zod-like `parse`. */
interface Parser<T> {
  parse(input: unknown): T;
}

const TOKEN_KEY = 'beagle.session.token';

/** In-browser storage of the bearer session token (fallback when the cookie cannot be sent); shared by every tab of the origin. */
export const sessionToken = {
  get(): string | undefined {
    try {
      return window.localStorage.getItem(TOKEN_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(token: string): void {
    try {
      window.localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* storage unavailable: cookie-only session */
    }
  },
  clear(): void {
    try {
      window.localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
  },
};

const voidParser: Parser<void> = { parse: () => undefined };

/** Accepts a bare array or an envelope `{ <key>: [...] }` (list routes without a fixed envelope in §5.9). */
function listOf<T>(item: Parser<T>, ...keys: string[]): Parser<T[]> {
  return {
    parse(input: unknown): T[] {
      let arr: unknown = input;
      if (!Array.isArray(arr) && typeof input === 'object' && input !== null) {
        const rec = input as Record<string, unknown>;
        const key = [...keys, 'rows', 'items', 'data'].find((k) => Array.isArray(rec[k]));
        arr = key === undefined ? undefined : rec[key];
      }
      if (!Array.isArray(arr)) throw new TypeError('expected a list response');
      return arr.map((x) => item.parse(x));
    },
  };
}

/** Builds `?a=1&b=2` from the string/number/bigint/boolean members of `params`, skipping undefined. */
export function queryString(params: object): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'bigint' || typeof v === 'boolean') q.set(k, String(v));
  }
  const s = q.toString();
  return s === '' ? '' : `?${s}`;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  json?: unknown;
  signal?: AbortSignal;
}

async function request<T>(path: string, parser: Parser<T>, options: RequestOptions = {}): Promise<T> {
  const headers = new Headers({ accept: 'application/json' });
  if (options.json !== undefined) headers.set('content-type', 'application/json');
  const token = sessionToken.get();
  if (token !== undefined) headers.set('authorization', `Bearer ${token}`);

  let res: Response;
  try {
    res = await fetch(`${config.apiBase}${path}`, {
      method: options.method ?? 'GET',
      headers,
      credentials: 'include',
      ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError(0, 'network_error', 'Cannot reach the gateway');
  }

  const text = await res.text();
  let body: unknown;
  if (text !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }
  if (!res.ok) {
    const parsed = ErrorDtoSchema.safeParse(body);
    if (parsed.success) throw new ApiError(res.status, parsed.data.error.code, parsed.data.error.message);
    throw new ApiError(res.status, `http_${res.status}`, res.statusText === '' ? `HTTP ${res.status}` : res.statusText);
  }
  try {
    return parser.parse(body);
  } catch (e) {
    throw new ApiError(res.status, 'bad_response', `Unexpected response from ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Cursor query of the list routes. */
export interface CursorParams {
  limit?: number;
  before?: number;
}

/** Filters of `GET /api/usage`. */
export interface UsageListParams extends CursorParams {
  model?: string;
  status?: 'ok' | 'error';
}

/** The dashboard API. */
export const api = {
  // public
  status: (signal?: AbortSignal): Promise<StatusDto> => request('/api/status', StatusDtoSchema, { ...(signal ? { signal } : {}) }),
  config: (): Promise<ConfigDto> => request('/api/config', ConfigDtoSchema),
  price: (): Promise<PriceDto> => request('/api/price', PriceDtoSchema),
  priceHistory: (limit = 100): Promise<PriceHistoryDto> => request(`/api/price/history${queryString({ limit })}`, PriceHistoryDtoSchema),
  models: (): Promise<ModelsDto> => request('/api/models', ModelsDtoSchema),
  quote: (q: { tokens?: bigint; usdMicro?: bigint }): Promise<QuoteDto> => request(`/api/quote${queryString(q)}`, QuoteDtoSchema),

  // auth
  nonce: (): Promise<NonceDto> => request('/api/auth/nonce', NonceDtoSchema),
  /** SIWS: the exact signed text, its detached signature (base58) and the signer (base58). */
  verify: (message: string, signature: string, publicKey: string): Promise<VerifyDto> =>
    request('/api/auth/verify', VerifyDtoSchema, { method: 'POST', json: { message, signature, publicKey } }),
  logout: (): Promise<void> => request('/api/auth/logout', voidParser, { method: 'POST' }),
  me: (): Promise<MeDto> => request('/api/me', MeDtoSchema),

  // workspace
  balance: (): Promise<BalanceDto> => request('/api/balance', BalanceDtoSchema),
  keys: {
    list: (): Promise<ApiKeyDto[]> => request('/api/keys', listOf(ApiKeyDtoSchema, 'keys')),
    create: (name: string): Promise<ApiKeyDto> => request('/api/keys', ApiKeyDtoSchema, { method: 'POST', json: { name } }),
    revoke: (id: string): Promise<void> => request(`/api/keys/${encodeURIComponent(id)}`, voidParser, { method: 'DELETE' }),
  },
  usage: {
    list: (q: UsageListParams = {}): Promise<UsageListDto> => request(`/api/usage${queryString(q)}`, UsageListDtoSchema),
    summary: (window: UsageWindow): Promise<UsageSummaryDto> => request(`/api/usage/summary${queryString({ window })}`, UsageSummaryDtoSchema),
  },
  ledger: (q: CursorParams = {}): Promise<LedgerListDto> => request(`/api/ledger${queryString(q)}`, LedgerListDtoSchema),
  receipts: {
    list: (q: CursorParams = {}): Promise<CreditEventListDto> => request(`/api/receipts${queryString(q)}`, CreditEventListDtoSchema),
    get: (requestId: string): Promise<ReceiptDto> => request(`/api/receipts/${encodeURIComponent(requestId)}`, ReceiptDtoSchema),
  },
  providers: {
    list: (): Promise<ProviderKeyDto[]> => request('/api/providers', listOf(ProviderKeyDtoSchema, 'providers')),
    put: (provider: ByokProvider, body: { apiKey: string; baseUrl?: string }): Promise<ProviderKeyDto> =>
      request(`/api/providers/${provider}`, ProviderKeyDtoSchema, { method: 'PUT', json: body }),
    remove: (provider: ByokProvider): Promise<void> => request(`/api/providers/${provider}`, voidParser, { method: 'DELETE' }),
    test: (provider: ByokProvider): Promise<ProviderTestDto> => request(`/api/providers/${provider}/test`, ProviderTestDtoSchema, { method: 'POST' }),
  },
  budgets: {
    list: (): Promise<BudgetDto[]> => request('/api/budgets', listOf(BudgetDtoSchema, 'budgets')),
    /** Budget id = the delegated token account (base58). */
    get: (tokenAccount: string): Promise<BudgetDto> => request(`/api/budgets/${encodeURIComponent(tokenAccount)}`, BudgetDtoSchema),
    draws: (tokenAccount: string): Promise<BudgetDrawDto[]> => request(`/api/budgets/${encodeURIComponent(tokenAccount)}/draws`, listOf(BudgetDrawDtoSchema, 'draws')),
    /** `POST /api/budgets/register` right after `ApproveChecked` (201 with the dto, or 400 `not_delegated`). */
    register: (body: RegisterBudgetRequest): Promise<BudgetDto> =>
      request('/api/budgets/register', BudgetDtoSchema, { method: 'POST', json: { tokenAccount: body.tokenAccount, ...(body.workspace === undefined ? {} : { workspace: body.workspace }) } }),
  },
  upgrades: {
    list: (): Promise<UpgradeDto[]> => request('/api/upgrades', listOf(UpgradeDtoSchema, 'upgrades')),
    prices: (): Promise<UpgradePricesDto> => request('/api/upgrades/prices', UpgradePricesDtoSchema),
    buy: (kind: 'pro' | 'warm', quantity: number): Promise<UpgradeDto> =>
      request('/api/upgrades', UpgradeDtoSchema, { method: 'POST', json: { kind, quantity } }),
  },
};

/** Type of {@link api}. */
export type Api = typeof api;
