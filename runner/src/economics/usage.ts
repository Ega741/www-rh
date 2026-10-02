/**
 * Per-tick usage accounting (`docs/SPEC.md` §4.1 economics): each iteration's final message is
 * charged `costOfUsageMicroUsd(message.model, message.usage)` — the **served** model, never the
 * requested one (unknown served models are charged at `claude-fable-5-1` prices). A tick's cost is
 * the sum over its iterations, including iterations whose stream broke (charged from the last
 * `message_start` / `message_delta` usage seen).
 *
 * @module economics/usage
 */
import { costOfUsageMicroUsd, pricesForServedModel, type TokenUsage } from '@www-rh/shared';

/** Totals of one tick. */
export interface TickTotals {
  iterations: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsdMicro: number;
  /** Served model of the last charged iteration. */
  servedModel: string | null;
}

/** Accumulates the usage of one tick. */
export class TickUsage {
  readonly totals: TickTotals = { iterations: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdMicro: 0, servedModel: null };
  /** Served model ids that were not in `MODEL_PRICES`. */
  readonly unknownModels = new Set<string>();

  /** Charges one iteration; returns its cost in µUSD. */
  charge(servedModel: string, usage: TokenUsage): number {
    const cost = costOfUsageMicroUsd(servedModel, usage);
    if (!pricesForServedModel(servedModel).known) this.unknownModels.add(servedModel);
    const t = this.totals;
    t.iterations += 1;
    t.inputTokens += usage.input_tokens;
    t.outputTokens += usage.output_tokens;
    t.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
    t.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
    t.costUsdMicro += cost;
    t.servedModel = servedModel;
    return cost;
  }
}
