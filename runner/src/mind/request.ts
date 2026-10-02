/**
 * Request-shape builder for one tick (`docs/SPEC.md` §4.1 `mind/tick.ts`):
 *
 * - opus-5-5 / sonnet-5-5 / fable-5-1: `thinking: { type: 'adaptive', display: 'summarized' }`,
 *   `output_config: { effort: 'medium' }`, `betas: ['server-side-fallback-2026-07-01']`,
 *   `fallbacks: 'default'`;
 * - haiku-4-5: `thinking: { type: 'enabled', budget_tokens: 2048 }`, `max_tokens: 8192`, and no
 *   `output_config`, `betas` or `fallbacks`.
 *
 * `tool_choice` is never set (forced tool use 400s on the 5.x models); `tools` precedes `system`.
 *
 * @module mind/request
 */
import type Anthropic from '@anthropic-ai/sdk';
import type { BetaToolRunnerParams } from '@anthropic-ai/sdk/lib/tools/BetaToolRunner';
import type { ModelSpec } from '@www-rh/shared';
import { TICK_PROMPT } from './persona.js';
import type { MindTool } from './tools.js';

/** Server-side fallback beta header for the `'default'` scalar form. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Tool-runner params of one tick (streaming). */
export type TickParams = BetaToolRunnerParams & { stream: true };

/** Builds the tool-runner params for `spec`. */
export function buildTickParams(
  spec: ModelSpec,
  tools: readonly MindTool[],
  system: Anthropic.Beta.BetaTextBlockParam[],
  maxIterations: number,
  messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: TICK_PROMPT }],
): TickParams {
  const base = {
    model: spec.id,
    max_tokens: spec.maxTokens,
    tools: [...tools],
    system,
    cache_control: { type: 'ephemeral' as const },
    messages,
    stream: true as const,
    max_iterations: maxIterations,
    thinking: spec.thinking,
  };
  return {
    ...base,
    ...(spec.supportsEffort ? { output_config: { effort: 'medium' as const } } : {}),
    ...(spec.supportsFallbacks ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
  };
}
