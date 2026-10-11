/**
 * Router runtime (SPEC §5.6): builds the `RoutingInput`, calls the pure `route()`, then walks the
 * candidates — credentials, estimate + reservation for credit-paid, adapter call with a per-attempt
 * abort signal, health bookkeeping, fallback on retryable errors, settlement on success. For streams
 * the candidate may change only until the first chunk; later failures end the stream with an error
 * chunk and are charged for what was streamed.
 *
 * Health bookkeeping only ever sees **provider** failures: a client disconnect (the request signal
 * aborted) releases the reservation and settles the row as `client_aborted` without touching the
 * breaker, and failures of a workspace's own BYOK key never count against the shared provider state.
 *
 * @module router/execute
 */
import { applyMarkupBps, costMicroUsd, formatUsdMicro } from '@beagle/shared/credit';
import { estimateDifficulty } from '@beagle/shared/difficulty';
import type { ModelSpec, Plan, Provider, Tier } from '@beagle/shared/models';
import { route, type FallbackPolicy, type ProviderState, type RoutingDecision } from '@beagle/shared/routing';
import type { Config } from '../config.js';
import type { Repos } from '../db/repos.js';
import type { Logger } from '../log.js';
import { GatewayError } from '../api/errors.js';
import { CHARS_PER_TOKEN, estimateInputTokens, estimateRequest } from '../metering/estimate.js';
import { InsufficientCreditError, type Reservation, type ReservationService } from '../metering/reserve.js';
import type { PaidBy, Settlement, SettlementService } from '../metering/settle.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { networkError, ProviderError, type Credentials } from '../providers/types.js';
import {
  charsOf,
  ChunkAssembler,
  hasImages,
  textOf,
  totalChars,
  ZERO_USAGE,
  type InternalChunk,
  type InternalRequest,
  type InternalRequestBase,
  type InternalResponse,
  type Usage,
} from '../translate/internal.js';
import type { HealthStore } from './health.js';

/** What the HTTP layer passes in. */
export interface ExecuteContext {
  requestId: string;
  workspace: string;
  apiKeyId: string | null;
  endpoint: string;
  requestedModel: string;
  base: InternalRequestBase;
  /** `x-beagle-difficulty`. */
  difficultyOverride?: number;
  /** `x-beagle-fallback`. */
  fallbackOverride?: FallbackPolicy;
  /** Client disconnect. */
  signal?: AbortSignal;
}

/** Routing metadata of a served (or attempted) request. */
export interface ExecMeta {
  model: ModelSpec;
  paidBy: PaidBy;
  tier: Tier;
  routeReasons: string[];
  difficulty: number;
}

/** Final state of a stream. */
export interface StreamResult {
  settlement: Settlement;
  /** Set when the stream ended with an upstream error after the first chunk. */
  error: ProviderError | undefined;
  response: InternalResponse;
}

/** Outcome of {@link Executor.execute}. */
export type ExecuteOutcome =
  | { kind: 'response'; response: InternalResponse; meta: ExecMeta; settlement: Settlement }
  | { kind: 'stream'; meta: ExecMeta; chunks: AsyncIterable<InternalChunk>; done: Promise<StreamResult> }
  | { kind: 'error'; error: GatewayError; routeReasons: string[] };

/** Dependencies of {@link Executor}. */
export interface ExecutorDeps {
  config: Config;
  repos: Repos;
  catalog: readonly ModelSpec[];
  registry: ProviderRegistry;
  health: HealthStore;
  reservations: ReservationService;
  settlement: SettlementService;
  logger: Logger;
  now?: () => number;
}

/** Workspace facts the router needs. */
export interface WorkspaceContext {
  plan: Plan;
  availableMicro: bigint;
  balanceMicro: bigint;
  byok: Provider[];
}

/** Usage row error code of a request whose client went away. */
export const CLIENT_ABORTED = 'client_aborted';
/** HTTP status recorded for a client-aborted request (nginx's "client closed request"; never sent). */
export const CLIENT_ABORTED_STATUS = 499;

function clampDifficulty(d: number | undefined): number | undefined {
  if (d === undefined || !Number.isFinite(d)) return undefined;
  return Math.min(1, Math.max(0, d));
}

/**
 * The per-attempt abort signal: `PROVIDER_TIMEOUT_MS` to the first byte, combined with the client's
 * signal. For streams the timer is an **idle** timeout — `touch()` on every chunk restarts it — so a
 * long generation is never cut while tokens keep arriving (SPEC §5.6 step 3).
 */
export class AttemptSignal {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  readonly signal: AbortSignal;

  constructor(
    private readonly timeoutMs: number,
    client: AbortSignal | undefined,
  ) {
    this.signal = client === undefined ? this.controller.signal : AbortSignal.any([this.controller.signal, client]);
    this.touch();
  }

  /** Restarts the timeout (a chunk arrived). */
  touch(): void {
    this.clear();
    this.timer = setTimeout(() => this.controller.abort(new DOMException('request timed out', 'TimeoutError')), this.timeoutMs);
    this.timer.unref?.();
  }

  /** Stops the timer (the attempt is over). */
  clear(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** `true` when every token count is zero (an upstream that reported no usage at all). */
export function isZeroUsage(u: Usage): boolean {
  return u.inputTokens === 0 && u.outputTokens === 0 && u.cacheReadTokens === 0 && u.cacheWriteTokens === 0;
}

/**
 * Billable usage of a completed request: the upstream's numbers, or — when it reported none at all
 * (a compat server that ignores `stream_options.include_usage`) — the estimate, so delivered content
 * is never settled at zero (SPEC §5.7). The prompt is never empty, so all-zero usage is impossible
 * for a genuine answer.
 */
export function billableUsage(reported: Usage | undefined, estimatedInput: number, outputChars: number): { usage: Usage; estimated: boolean } {
  if (reported !== undefined && !isZeroUsage(reported)) return { usage: reported, estimated: false };
  return { usage: { inputTokens: estimatedInput, outputTokens: Math.ceil(outputChars / CHARS_PER_TOKEN), cacheReadTokens: 0, cacheWriteTokens: 0 }, estimated: true };
}

/**
 * The largest `maxTokens` whose marked-up worst-case estimate fits `boundMicro` (SPEC §5.7): a
 * credit-paid request may not run up a charge beyond what the workspace can cover, except for the
 * accepted post-paid gap of `MAX_RESERVE_USD`. Returns `undefined` when even the prompt alone exceeds
 * the bound (→ 402).
 */
export function maxTokensWithinBound(base: InternalRequestBase, model: ModelSpec, boundMicro: bigint, markupBps: number): number | undefined {
  const inputTokens = estimateInputTokens(base);
  const inputCost = applyMarkupBps(costMicroUsd({ inputTokens, outputTokens: 0 }, model.price), markupBps);
  if (inputCost > boundMicro) return undefined;
  const requested = Math.min(base.maxTokens, model.maxOutput);
  if (model.price.outputPerM <= 0) return requested;
  const remaining = boundMicro - inputCost;
  const perMillion = BigInt(model.price.outputPerM) * (10_000n + BigInt(markupBps));
  let maxOut = Number((remaining * 1_000_000n * 10_000n) / perMillion);
  if (maxOut > requested) return requested;
  while (maxOut > 0 && applyMarkupBps(costMicroUsd({ inputTokens, outputTokens: maxOut }, model.price), markupBps) > boundMicro) maxOut--;
  return maxOut;
}

/** Routes and runs requests. */
export class Executor {
  private readonly now: () => number;

  constructor(private readonly deps: ExecutorDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Plan, credit and BYOK facts for `workspace` (creating the workspace row if needed). */
  workspaceContext(workspace: string): WorkspaceContext {
    const now = this.now();
    const row = this.deps.repos.workspaces.ensure(workspace, now);
    const { plan } = this.deps.repos.workspaces.effectivePlan(row, now);
    const snap = this.deps.repos.ledger.snapshot(workspace, now);
    return { plan, availableMicro: snap.available, balanceMicro: snap.balance, byok: this.deps.registry.byokProviders(workspace) };
  }

  /** Computes the difficulty of a request (override or heuristic). */
  difficultyOf(base: InternalRequestBase, override: number | undefined, reasoningEffort: string | undefined): number {
    const o = clampDifficulty(override);
    if (o !== undefined) return o;
    const systemLength = base.messages.filter((m) => m.role === 'system').reduce((n, m) => n + textOf(m).length, 0);
    return estimateDifficulty({
      messages: base.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role, text: textOf(m) })),
      systemLength,
      toolCount: base.tools?.length ?? 0,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    });
  }

  /**
   * Provider states for `route()`: breaker health, with providers lacking a platform key forced
   * `down` (SPEC §5.1: absent platform keys → down for credit-paid routing). A provider the workspace
   * brought its own key for keeps its breaker state, since its candidates are BYOK-paid anyway.
   */
  providerStates(ws: WorkspaceContext): Record<Provider, ProviderState> {
    const states = this.deps.health.snapshot();
    for (const p of Object.keys(states) as Provider[]) {
      if (!this.deps.registry.platformConfigured(p) && !ws.byok.includes(p)) states[p] = { ...states[p], state: 'down' };
    }
    return states;
  }

  /** Runs the pure routing policy for `ctx`. */
  decide(ctx: ExecuteContext, ws: WorkspaceContext, difficulty: number): RoutingDecision {
    const base = ctx.base;
    return route({
      requested: ctx.requestedModel,
      difficulty,
      needs: {
        tools: (base.tools?.length ?? 0) > 0,
        vision: hasImages(base),
        json: base.responseFormat !== undefined,
        contextTokens: Math.ceil(totalChars(base) / 4),
        maxOutputTokens: base.maxTokens,
      },
      workspace: { availableMicroUsd: ws.availableMicro, plan: ws.plan, byok: ws.byok },
      providers: this.providerStates(ws),
      fallback: ctx.fallbackOverride ?? 'cheaper',
      catalog: this.deps.catalog,
      limits: { lowCreditMicroUsd: this.deps.config.economics.lowCreditMicro, veryLowCreditMicroUsd: this.deps.config.economics.veryLowCreditMicro },
    });
  }

  private creditsUrl(): string {
    return `${this.deps.config.server.webOrigins[0] ?? 'http://localhost:5173'}/app/credits`;
  }

  private routingError(decision: Extract<RoutingDecision, { kind: 'error' }>, ws: WorkspaceContext): GatewayError {
    switch (decision.code) {
      case 'unknown_model':
        return new GatewayError('model_not_found', decision.message, { param: 'model' });
      case 'plan_required':
        return new GatewayError('plan_required', decision.message);
      case 'no_capable_model':
        return new GatewayError('no_model_available', decision.message);
      case 'insufficient_credit':
        return GatewayError.insufficientCredit(ws.balanceMicro, this.creditsUrl());
    }
  }

  private writeErrorRow(
    ctx: ExecuteContext,
    difficulty: number,
    reasons: string[],
    err: GatewayError,
    model: ModelSpec | undefined,
    paidBy: PaidBy | undefined,
    startedAt: number,
    errorCode: string = err.code,
  ): void {
    try {
      this.deps.settlement.settle({
        requestId: ctx.requestId,
        workspace: ctx.workspace,
        apiKeyId: ctx.apiKeyId,
        endpoint: ctx.endpoint,
        requestedModel: ctx.requestedModel,
        model,
        paidBy,
        tier: model?.tier,
        usage: { ...ZERO_USAGE },
        status: 'error',
        httpStatus: err.status,
        errorCode,
        latencyMs: this.now() - startedAt,
        routeReasons: reasons,
        stream: ctx.base.stream,
        difficulty,
        reservationId: undefined,
        createdAt: startedAt,
      });
    } catch (e) {
      this.deps.logger.error('failed to write usage row', { requestId: ctx.requestId, error: e });
    }
  }

  /** Maps a non-retryable provider failure onto the client error. */
  static clientError(err: ProviderError): GatewayError {
    if (err.authFailure) return new GatewayError('upstream_error', `The ${err.provider} key stored for this workspace was rejected (${err.status}). Update it on the Providers page.`, { cause: err });
    if (err.code === 'bad_request') return new GatewayError('invalid_request_error', err.message, { cause: err });
    if (err.status === 429) return new GatewayError('upstream_rate_limited', err.message, { ...(err.retryAfterSec === undefined ? {} : { retryAfterSec: err.retryAfterSec }), cause: err });
    return new GatewayError('upstream_error', err.message, { cause: err });
  }

  /** The (never delivered) error of a request whose client disconnected. */
  static clientAborted(): GatewayError {
    return new GatewayError('upstream_error', 'Client disconnected.', { status: CLIENT_ABORTED_STATUS });
  }

  /** Executes `ctx` (see module docs). Never throws for upstream or routing failures. */
  async execute(ctx: ExecuteContext): Promise<ExecuteOutcome> {
    const startedAt = this.now();
    const log = this.deps.logger.child({ requestId: ctx.requestId, workspace: ctx.workspace });
    const ws = this.workspaceContext(ctx.workspace);
    const difficulty = this.difficultyOf(ctx.base, ctx.difficultyOverride, ctx.base.reasoningEffort);
    const decision = this.decide(ctx, ws, difficulty);
    const reasons = [...decision.reasons];
    if (decision.kind === 'error') {
      const error = this.routingError(decision, ws);
      this.writeErrorRow(ctx, difficulty, reasons, error, undefined, undefined, startedAt);
      log.info('routing failed', { code: decision.code, reasons });
      return { kind: 'error', error, routeReasons: reasons };
    }

    let lastError: ProviderError | undefined;
    let lastModel: ModelSpec | undefined;
    let lastPaidBy: PaidBy | undefined;
    let triedAny = false;
    const skipped: string[] = [];
    const clientGone = (): boolean => ctx.signal?.aborted === true;
    const { markupBps, minReserveMicro, maxReserveMicro } = this.deps.config.economics;

    for (const candidate of decision.candidates) {
      if (clientGone()) break;
      const { model, paidBy } = candidate;
      const creds = await this.deps.registry.resolveCredentials(model.provider, ctx.workspace, paidBy);
      if (creds === undefined) {
        reasons.push(`skip ${model.id}: no credentials`);
        skipped.push(`${model.id} (no credentials)`);
        continue;
      }
      if (paidBy === 'byok' && creds.kind !== 'byok') {
        reasons.push(`skip ${model.id}: BYOK key unusable`);
        skipped.push(`${model.id} (BYOK key unusable)`);
        continue;
      }
      let maxTokens = Math.min(ctx.base.maxTokens, model.maxOutput);
      let reservation: Reservation | undefined;
      if (paidBy === 'credit') {
        // Credit bound: the worst case (prompt + max_tokens, marked up) may not exceed what the
        // workspace can cover, beyond the accepted post-paid gap of MAX_RESERVE (SPEC §5.7).
        const bound = ws.availableMicro > maxReserveMicro ? ws.availableMicro : maxReserveMicro;
        const capped = maxTokensWithinBound(ctx.base, model, bound, markupBps);
        if (capped === undefined || capped < 1) {
          const error = GatewayError.insufficientCredit(ws.balanceMicro, this.creditsUrl());
          reasons.push(`credit bound ${model.id}: the prompt alone exceeds ${formatUsdMicro(bound)}`);
          this.writeErrorRow(ctx, difficulty, reasons, error, model, paidBy, startedAt);
          return { kind: 'error', error, routeReasons: reasons };
        }
        if (capped < maxTokens) {
          reasons.push(`credit bound ${model.id}: max_tokens ${maxTokens} → ${capped} (${formatUsdMicro(bound)})`);
          maxTokens = capped;
        }
        const est = estimateRequest({ ...ctx.base, maxTokens }, model, { markupBps, minReserveMicro, maxReserveMicro });
        try {
          reservation = this.deps.reservations.reserve(ctx.workspace, est.reserveMicro);
          reasons.push(`reserve ${model.id}: ${reservation.amountMicro.toString()} µUSD (estimate ${est.estimateMicro.toString()})`);
        } catch (e) {
          if (e instanceof InsufficientCreditError) {
            const error = GatewayError.insufficientCredit(e.balanceMicro, this.creditsUrl());
            reasons.push('reserve: insufficient credit');
            this.writeErrorRow(ctx, difficulty, reasons, error, model, paidBy, startedAt);
            return { kind: 'error', error, routeReasons: reasons };
          }
          throw e;
        }
      }
      triedAny = true;
      lastModel = model;
      lastPaidBy = paidBy;
      const req: InternalRequest = {
        ...ctx.base,
        maxTokens,
        upstreamModel: model.upstreamId,
        metadata: { requestId: ctx.requestId, workspace: ctx.workspace },
      };
      const meta: ExecMeta = { model, paidBy, tier: model.tier, routeReasons: reasons, difficulty };
      const adapter = this.deps.registry.adapter(model.provider);
      const attempt = new AttemptSignal(this.deps.config.providers.timeoutMs, ctx.signal);

      /** Releases the reservation; records the failure against health unless the client went away. */
      const onFailure = (err: ProviderError): void => {
        attempt.clear();
        if (reservation !== undefined) this.deps.reservations.release(reservation.id);
        if (clientGone()) return;
        this.deps.health.recordFailure(model.provider, err, creds.kind);
        if (err.authFailure && creds.kind === 'byok') this.deps.repos.providerKeys.setLastError(ctx.workspace, model.provider, `${err.status}: ${err.message}`.slice(0, 200));
      };
      /** Settles a request whose client disconnected mid-attempt (nothing is charged). */
      const abortedOutcome = (): ExecuteOutcome => {
        const error = Executor.clientAborted();
        reasons.push(`${model.id}: client disconnected`);
        this.writeErrorRow(ctx, difficulty, reasons, error, model, paidBy, startedAt, CLIENT_ABORTED);
        log.info('client disconnected before the upstream answered', { model: model.id });
        return { kind: 'error', error, routeReasons: reasons };
      };

      if (!ctx.base.stream) {
        let response: InternalResponse;
        try {
          response = await adapter.complete(req, creds, attempt.signal);
        } catch (e) {
          const err = ProviderError.is(e) ? e : networkError(model.provider, e);
          onFailure(err);
          if (clientGone()) return abortedOutcome();
          reasons.push(`${model.id} failed: ${err.code} (${err.status})`);
          log.warn('upstream failure', { model: model.id, code: err.code, status: err.status, retryable: err.retryable, message: err.message });
          if (err.retryable) {
            lastError = err;
            continue;
          }
          const error = Executor.clientError(err);
          this.writeErrorRow(ctx, difficulty, reasons, error, model, paidBy, startedAt);
          return { kind: 'error', error, routeReasons: reasons };
        }
        attempt.clear();
        this.deps.health.recordSuccess(model.provider);
        if (creds.kind === 'byok') this.deps.repos.providerKeys.setLastError(ctx.workspace, model.provider, null);
        const billed = billableUsage(response.usage, estimateInputTokens(ctx.base), charsOf(response.message));
        if (billed.estimated) log.warn('upstream reported no usage; charging the estimate', { model: model.id, provider: model.provider });
        const settlement = this.deps.settlement.settle({
          requestId: ctx.requestId,
          workspace: ctx.workspace,
          apiKeyId: ctx.apiKeyId,
          endpoint: ctx.endpoint,
          requestedModel: ctx.requestedModel,
          model,
          paidBy,
          tier: model.tier,
          usage: billed.usage,
          status: 'ok',
          httpStatus: 200,
          errorCode: null,
          latencyMs: this.now() - startedAt,
          routeReasons: reasons,
          stream: false,
          difficulty,
          reservationId: reservation?.id,
          createdAt: startedAt,
        });
        log.info('completion served', { model: model.id, paidBy, chargedMicro: settlement.chargedMicro, latencyMs: this.now() - startedAt });
        return { kind: 'response', response: { ...response, usage: billed.usage }, meta, settlement };
      }

      // Streaming: commit to this candidate only after the first chunk arrives.
      let iterator: AsyncIterator<InternalChunk>;
      let first: IteratorResult<InternalChunk>;
      try {
        iterator = adapter.stream(req, creds, attempt.signal)[Symbol.asyncIterator]();
        first = await iterator.next();
      } catch (e) {
        const err = ProviderError.is(e) ? e : networkError(model.provider, e);
        onFailure(err);
        if (clientGone()) return abortedOutcome();
        reasons.push(`${model.id} failed: ${err.code} (${err.status})`);
        log.warn('upstream stream failure', { model: model.id, code: err.code, status: err.status, retryable: err.retryable });
        if (err.retryable) {
          lastError = err;
          continue;
        }
        const error = Executor.clientError(err);
        this.writeErrorRow(ctx, difficulty, reasons, error, model, paidBy, startedAt);
        return { kind: 'error', error, routeReasons: reasons };
      }
      if (!first.done && first.value.type === 'error') {
        const err = first.value.error;
        onFailure(err);
        if (clientGone()) return abortedOutcome();
        reasons.push(`${model.id} failed: ${err.code} (${err.status})`);
        if (err.retryable) {
          lastError = err;
          continue;
        }
        const error = Executor.clientError(err);
        this.writeErrorRow(ctx, difficulty, reasons, error, model, paidBy, startedAt);
        return { kind: 'error', error, routeReasons: reasons };
      }
      attempt.touch();
      return this.streamOutcome(ctx, meta, creds, reservation, iterator, first, attempt, startedAt, log);
    }

    // Every candidate failed or was skipped.
    let error: GatewayError;
    if (!triedAny) error = new GatewayError('no_model_available', `No provider could serve this request${skipped.length === 0 ? '' : `: skipped ${skipped.join(', ')}`}.`);
    else if (lastError !== undefined && lastError.status === 429) {
      error = new GatewayError('upstream_rate_limited', lastError.message, lastError.retryAfterSec === undefined ? {} : { retryAfterSec: lastError.retryAfterSec });
    } else error = new GatewayError('upstream_error', lastError?.message ?? 'All upstream providers failed.');
    this.writeErrorRow(ctx, difficulty, reasons, error, lastModel, lastPaidBy, startedAt);
    log.warn('all candidates failed', { code: error.code, reasons });
    return { kind: 'error', error, routeReasons: reasons };
  }

  private streamOutcome(
    ctx: ExecuteContext,
    meta: ExecMeta,
    creds: Credentials,
    reservation: Reservation | undefined,
    iterator: AsyncIterator<InternalChunk>,
    first: IteratorResult<InternalChunk>,
    attempt: AttemptSignal,
    startedAt: number,
    log: Logger,
  ): ExecuteOutcome {
    const assembler = new ChunkAssembler();
    let resolveDone: (r: StreamResult) => void = () => undefined;
    let rejectDone: (e: unknown) => void = () => undefined;
    const done = new Promise<StreamResult>((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    let settled = false;
    const estimatedInput = estimateInputTokens(ctx.base);
    /**
     * Settles the stream. `clientGone`: the consumer stopped reading (disconnect) — nothing is
     * recorded against provider health and the row says `client_aborted`. `upstreamEnded`: the
     * adapter's iterator finished (with or without a `finish` chunk).
     */
    const finalize = (streamError: ProviderError | undefined, clientGone: boolean, upstreamEnded: boolean): void => {
      if (settled) return;
      settled = true;
      attempt.clear();
      try {
        const finished = assembler.finished;
        const ok = streamError === undefined && !clientGone && finished !== undefined;
        const billed = billableUsage(finished?.usage, estimatedInput, assembler.streamedChars);
        if (ok && billed.estimated) log.warn('upstream stream reported no usage; charging the estimate', { model: meta.model.id, provider: meta.model.provider });
        if (ok) {
          this.deps.health.recordSuccess(meta.model.provider);
          if (creds.kind === 'byok') this.deps.repos.providerKeys.setLastError(ctx.workspace, meta.model.provider, null);
        } else if (streamError !== undefined && !clientGone) this.deps.health.recordFailure(meta.model.provider, streamError, creds.kind);
        const errorCode = ok ? null : clientGone ? CLIENT_ABORTED : (streamError?.code ?? (upstreamEnded ? 'stream_incomplete' : CLIENT_ABORTED));
        const settlement = this.deps.settlement.settle({
          requestId: ctx.requestId,
          workspace: ctx.workspace,
          apiKeyId: ctx.apiKeyId,
          endpoint: ctx.endpoint,
          requestedModel: ctx.requestedModel,
          model: meta.model,
          paidBy: meta.paidBy,
          tier: meta.tier,
          usage: billed.usage,
          status: ok ? 'ok' : 'error',
          httpStatus: 200,
          errorCode,
          latencyMs: this.now() - startedAt,
          routeReasons: meta.routeReasons,
          stream: true,
          difficulty: meta.difficulty,
          reservationId: reservation?.id,
          createdAt: startedAt,
        });
        log.info('stream settled', { model: meta.model.id, paidBy: meta.paidBy, chargedMicro: settlement.chargedMicro, ok, errorCode });
        const response = assembler.response(ctx.requestId, meta.model.upstreamId);
        resolveDone({ settlement, error: streamError, response: { ...response, usage: billed.usage } });
      } catch (e) {
        log.error('stream settlement failed', { error: e });
        rejectDone(e);
      }
    };
    const clientSignal = ctx.signal;
    const chunks = async function* (): AsyncGenerator<InternalChunk> {
      let streamError: ProviderError | undefined;
      let completed = false;
      let upstreamEnded = false;
      try {
        let result = first;
        while (!result.done) {
          const chunk = result.value;
          assembler.push(chunk);
          if (chunk.type === 'error') {
            streamError = chunk.error;
            yield chunk;
            completed = true;
            break;
          }
          yield chunk;
          if (chunk.type === 'finish') {
            completed = true;
            break;
          }
          attempt.touch();
          result = await iterator.next();
        }
        if (!completed && result.done) {
          upstreamEnded = true;
          completed = assembler.finished !== undefined;
        }
      } catch (e) {
        streamError = ProviderError.is(e) ? e : networkError(meta.model.provider, e);
        assembler.push({ type: 'error', error: streamError });
        yield { type: 'error', error: streamError };
        completed = true;
      } finally {
        // A consumer that stopped reading before the upstream ended is a client disconnect.
        const clientGone = clientSignal?.aborted === true || (!completed && !upstreamEnded);
        finalize(streamError, clientGone, upstreamEnded);
        void iterator.return?.();
      }
    };
    return { kind: 'stream', meta, chunks: chunks(), done };
  }
}
