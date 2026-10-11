/**
 * Router runtime (SPEC §5.6): builds the `RoutingInput`, calls the pure `route()`, then walks the
 * candidates — credentials, estimate + reservation for credit-paid, adapter call with a per-attempt
 * abort signal, health bookkeeping, fallback on retryable errors, settlement on success. For streams
 * the candidate may change only until the first chunk; later failures end the stream with an error
 * chunk and are charged for what was streamed.
 *
 * @module router/execute
 */
import { estimateDifficulty } from '@beagle/shared/difficulty';
import type { ModelSpec, Plan, Provider, Tier } from '@beagle/shared/models';
import { route, type FallbackPolicy, type RoutingDecision } from '@beagle/shared/routing';
import type { Config } from '../config.js';
import type { Repos } from '../db/repos.js';
import type { Logger } from '../log.js';
import { GatewayError } from '../api/errors.js';
import { estimateInputTokens, estimateRequest } from '../metering/estimate.js';
import { InsufficientCreditError, type Reservation, type ReservationService } from '../metering/reserve.js';
import type { PaidBy, Settlement, SettlementService } from '../metering/settle.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { networkError, ProviderError, type Credentials } from '../providers/types.js';
import {
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

function clampDifficulty(d: number | undefined): number | undefined {
  if (d === undefined || !Number.isFinite(d)) return undefined;
  return Math.min(1, Math.max(0, d));
}

function combineSignals(timeoutMs: number, client: AbortSignal | undefined): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return client === undefined ? timeout : AbortSignal.any([timeout, client]);
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
      providers: this.deps.health.snapshot(),
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

  private writeErrorRow(ctx: ExecuteContext, difficulty: number, reasons: string[], err: GatewayError, model: ModelSpec | undefined, paidBy: PaidBy | undefined, startedAt: number): void {
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
        errorCode: err.code,
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

    for (const candidate of decision.candidates) {
      if (ctx.signal?.aborted) break;
      const { model, paidBy } = candidate;
      const creds = await this.deps.registry.resolveCredentials(model.provider, ctx.workspace, paidBy);
      if (creds === undefined) {
        reasons.push(`skip ${model.id}: no credentials`);
        continue;
      }
      if (paidBy === 'byok' && creds.kind !== 'byok') {
        reasons.push(`skip ${model.id}: BYOK key unusable`);
        continue;
      }
      let reservation: Reservation | undefined;
      if (paidBy === 'credit') {
        const est = estimateRequest(ctx.base, model, {
          markupBps: this.deps.config.economics.markupBps,
          minReserveMicro: this.deps.config.economics.minReserveMicro,
          maxReserveMicro: this.deps.config.economics.maxReserveMicro,
        });
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
        maxTokens: Math.min(ctx.base.maxTokens, model.maxOutput),
        upstreamModel: model.upstreamId,
        metadata: { requestId: ctx.requestId, workspace: ctx.workspace },
      };
      const meta: ExecMeta = { model, paidBy, tier: model.tier, routeReasons: reasons, difficulty };
      const adapter = this.deps.registry.adapter(model.provider);
      const signal = combineSignals(this.deps.config.providers.timeoutMs, ctx.signal);

      const onFailure = (err: ProviderError): void => {
        this.deps.health.recordFailure(model.provider, err, creds.kind);
        if (err.authFailure && creds.kind === 'byok') this.deps.repos.providerKeys.setLastError(ctx.workspace, model.provider, `${err.status}: ${err.message}`.slice(0, 200));
        if (reservation !== undefined) this.deps.reservations.release(reservation.id);
      };

      if (!ctx.base.stream) {
        let response: InternalResponse;
        try {
          response = await adapter.complete(req, creds, signal);
        } catch (e) {
          const err = ProviderError.is(e) ? e : networkError(model.provider, e);
          onFailure(err);
          reasons.push(`${model.id} failed: ${err.code} (${err.status})`);
          log.warn('upstream failure', { model: model.id, code: err.code, status: err.status, retryable: err.retryable, message: err.message });
          if (err.retryable && !ctx.signal?.aborted) {
            lastError = err;
            continue;
          }
          const error = Executor.clientError(err);
          this.writeErrorRow(ctx, difficulty, reasons, error, model, paidBy, startedAt);
          return { kind: 'error', error, routeReasons: reasons };
        }
        this.deps.health.recordSuccess(model.provider);
        if (creds.kind === 'byok') this.deps.repos.providerKeys.setLastError(ctx.workspace, model.provider, null);
        const settlement = this.deps.settlement.settle({
          requestId: ctx.requestId,
          workspace: ctx.workspace,
          apiKeyId: ctx.apiKeyId,
          endpoint: ctx.endpoint,
          requestedModel: ctx.requestedModel,
          model,
          paidBy,
          tier: model.tier,
          usage: response.usage,
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
        return { kind: 'response', response, meta, settlement };
      }

      // Streaming: commit to this candidate only after the first chunk arrives.
      let iterator: AsyncIterator<InternalChunk>;
      let first: IteratorResult<InternalChunk>;
      try {
        iterator = adapter.stream(req, creds, signal)[Symbol.asyncIterator]();
        first = await iterator.next();
      } catch (e) {
        const err = ProviderError.is(e) ? e : networkError(model.provider, e);
        onFailure(err);
        reasons.push(`${model.id} failed: ${err.code} (${err.status})`);
        log.warn('upstream stream failure', { model: model.id, code: err.code, status: err.status, retryable: err.retryable });
        if (err.retryable && !ctx.signal?.aborted) {
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
        reasons.push(`${model.id} failed: ${err.code} (${err.status})`);
        if (err.retryable && !ctx.signal?.aborted) {
          lastError = err;
          continue;
        }
        const error = Executor.clientError(err);
        this.writeErrorRow(ctx, difficulty, reasons, error, model, paidBy, startedAt);
        return { kind: 'error', error, routeReasons: reasons };
      }
      return this.streamOutcome(ctx, meta, creds, reservation, iterator, first, startedAt, log);
    }

    // Every candidate failed or was skipped.
    let error: GatewayError;
    if (!triedAny) error = new GatewayError('no_model_available', 'No provider is configured for any capable model.');
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
    const finalize = (streamError: ProviderError | undefined, aborted: boolean): void => {
      if (settled) return;
      settled = true;
      try {
        const finished = assembler.finished;
        const ok = streamError === undefined && !aborted && finished !== undefined;
        const usage: Usage = finished?.usage ?? { inputTokens: estimatedInput, outputTokens: Math.ceil(assembler.streamedChars / 4), cacheReadTokens: 0, cacheWriteTokens: 0 };
        if (ok) {
          this.deps.health.recordSuccess(meta.model.provider);
          if (creds.kind === 'byok') this.deps.repos.providerKeys.setLastError(ctx.workspace, meta.model.provider, null);
        } else if (streamError !== undefined) this.deps.health.recordFailure(meta.model.provider, streamError, creds.kind);
        const settlement = this.deps.settlement.settle({
          requestId: ctx.requestId,
          workspace: ctx.workspace,
          apiKeyId: ctx.apiKeyId,
          endpoint: ctx.endpoint,
          requestedModel: ctx.requestedModel,
          model: meta.model,
          paidBy: meta.paidBy,
          tier: meta.tier,
          usage,
          status: ok ? 'ok' : 'error',
          httpStatus: 200,
          errorCode: ok ? null : streamError?.code ?? (aborted ? 'client_aborted' : 'stream_incomplete'),
          latencyMs: this.now() - startedAt,
          routeReasons: meta.routeReasons,
          stream: true,
          difficulty: meta.difficulty,
          reservationId: reservation?.id,
          createdAt: startedAt,
        });
        log.info('stream settled', { model: meta.model.id, paidBy: meta.paidBy, chargedMicro: settlement.chargedMicro, ok });
        resolveDone({ settlement, error: streamError, response: assembler.response(ctx.requestId, meta.model.upstreamId) });
      } catch (e) {
        log.error('stream settlement failed', { error: e });
        rejectDone(e);
      }
    };
    const chunks = async function* (): AsyncGenerator<InternalChunk> {
      let streamError: ProviderError | undefined;
      let completed = false;
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
          result = await iterator.next();
        }
        if (!completed && result.done) completed = assembler.finished !== undefined;
      } catch (e) {
        streamError = ProviderError.is(e) ? e : networkError(meta.model.provider, e);
        assembler.push({ type: 'error', error: streamError });
        yield { type: 'error', error: streamError };
        completed = true;
      } finally {
        finalize(streamError, !completed);
        void iterator.return?.();
      }
    };
    return { kind: 'stream', meta, chunks: chunks(), done };
  }
}
