/**
 * Pre-flight cost estimate and reservation sizing (SPEC §5.7).
 *
 * @module metering/estimate
 */
import { applyMarkupBps, costMicroUsd } from '@beagle/shared/credit';
import type { ModelSpec } from '@beagle/shared/models';
import { totalChars, type InternalRequestBase } from '../translate/internal.js';

/** Characters per token used by every estimate. */
export const CHARS_PER_TOKEN = 4;
/** Tokens added per tool definition. */
export const TOKENS_PER_TOOL = 50;

/** `ceil(totalChars / 4) + 50·toolCount`. */
export function estimateInputTokens(req: InternalRequestBase): number {
  return Math.ceil(totalChars(req) / CHARS_PER_TOKEN) + TOKENS_PER_TOOL * (req.tools?.length ?? 0);
}

/** Result of {@link estimateRequest}. */
export interface Estimate {
  inputTokens: number;
  outputTokens: number;
  /** Marked-up estimate in µUSD. */
  estimateMicro: bigint;
  /** `clamp(estimate, MIN_RESERVE, MAX_RESERVE)`. */
  reserveMicro: bigint;
}

/** Estimates the cost of `req` on `model` and the reservation to take. */
export function estimateRequest(req: InternalRequestBase, model: ModelSpec, limits: { markupBps: number; minReserveMicro: bigint; maxReserveMicro: bigint }): Estimate {
  const inputTokens = estimateInputTokens(req);
  const outputTokens = Math.min(req.maxTokens, model.maxOutput);
  const estimateMicro = applyMarkupBps(costMicroUsd({ inputTokens, outputTokens }, model.price), limits.markupBps);
  const reserveMicro = estimateMicro < limits.minReserveMicro ? limits.minReserveMicro : estimateMicro > limits.maxReserveMicro ? limits.maxReserveMicro : estimateMicro;
  return { inputTokens, outputTokens, estimateMicro, reserveMicro };
}
