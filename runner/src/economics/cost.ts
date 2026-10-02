/**
 * Usage accounting (R3): every API iteration is billed at the model that served it
 * (`message.model`), in exact integer micro-USD, and accumulated per `(tick, served model)`.
 *
 * @module economics/cost
 */
import { costOfUsageMicroUsd, modelSpec, pricingForServedModel, pricingOf, type ModelPricing, type TokenUsage } from '@www-rh/shared';

/** Cost of one usage record. */
export interface UsageCost {
  /** Model the price was taken from (the served model, or the requested one if unknown). */
  model: string;
  costUsdMicro: number;
  /** Whether the served model was unknown and the requested model's price was applied. */
  fallbackPricing: boolean;
}

/**
 * Prices `usage` at `servedModel`. Unknown served models (not in the catalog or the fallback
 * table) are billed at `requestedModel`'s catalog price, and reported under the served id.
 */
export function costOfUsage(servedModel: string, usage: TokenUsage, requestedModel: string): UsageCost {
  const served = pricingForServedModel(servedModel);
  if (served !== undefined) return { model: servedModel, costUsdMicro: costOfUsageMicroUsd(served, usage), fallbackPricing: false };
  const requested = modelSpec(requestedModel) ?? pricingForServedModel(requestedModel);
  if (requested === undefined) throw new RangeError(`no pricing for model ${servedModel} or ${requestedModel}`);
  const pricing: ModelPricing = pricingOf(requested);
  return { model: servedModel, costUsdMicro: costOfUsageMicroUsd(pricing, usage), fallbackPricing: true };
}

/** Token totals of one ledger line. */
export interface UsageLine {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsdMicro: number;
}

/** Accumulates the usage of one tick, one line per served model. */
export class TickUsage {
  readonly #lines = new Map<string, UsageLine>();

  constructor(readonly requestedModel: string) {}

  /** Adds one API response's usage; returns its cost. */
  add(servedModel: string, usage: TokenUsage): UsageCost {
    const cost = costOfUsage(servedModel, usage, this.requestedModel);
    const line = this.#lines.get(servedModel) ?? { model: servedModel, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdMicro: 0 };
    line.inputTokens += usage.input_tokens;
    line.outputTokens += usage.output_tokens;
    line.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    line.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
    // Re-price the whole line so per-line rounding matches what a verifier computes from the totals.
    line.costUsdMicro = costOfUsage(servedModel, {
      input_tokens: line.inputTokens,
      output_tokens: line.outputTokens,
      cache_read_input_tokens: line.cacheReadTokens,
      cache_creation_input_tokens: line.cacheWriteTokens,
    }, this.requestedModel).costUsdMicro;
    this.#lines.set(servedModel, line);
    return cost;
  }

  /** Lines in model order. */
  lines(): UsageLine[] {
    return [...this.#lines.values()].sort((a, b) => (a.model < b.model ? -1 : a.model > b.model ? 1 : 0));
  }

  /** Total cost of the tick so far (sum of line costs). */
  get totalMicro(): number {
    let sum = 0;
    for (const l of this.#lines.values()) sum += l.costUsdMicro;
    return sum;
  }

  /** The served model with the most output tokens (for the tick summary). */
  get primaryModel(): string | null {
    let best: UsageLine | null = null;
    for (const l of this.#lines.values()) if (best === null || l.outputTokens > best.outputTokens) best = l;
    return best?.model ?? null;
  }
}

/** Micro-USD → USD with 6 decimals. */
export function microToUsd(micro: number | bigint): number {
  return Number(micro) / 1_000_000;
}

/** USD → integer micro-USD (rounded). */
export function usdToMicro(usd: number): number {
  return Math.round(usd * 1_000_000);
}
