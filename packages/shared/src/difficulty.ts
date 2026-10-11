/**
 * Request difficulty heuristic (SPEC §4.5): a deterministic score in `[0, 1]` that `beagle/auto`
 * maps to a tier. No tokenizer, no clock, no randomness.
 *
 * @module difficulty
 */

/** Reasoning effort values understood by the heuristic (OpenAI `reasoning_effort` vocabulary). */
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** One message of the request: either the text itself or just its length. */
export interface DifficultyMessage {
  role: string;
  /** Full text; enables the code / keyword checks for user messages. */
  text?: string;
  /** Length in characters when the text is not available (ignored when `text` is given). */
  textLength?: number;
}

/** Input of {@link estimateDifficulty}. */
export interface DifficultyInput {
  messages: readonly DifficultyMessage[];
  /** Length of the system prompt in characters. */
  systemLength: number;
  /** Number of tool definitions in the request. */
  toolCount: number;
  reasoningEffort?: ReasoningEffort | string;
}

/** Base score of every request. */
export const DIFFICULTY_BASE = 0.25;
/** Input size at which the size term saturates (characters). */
export const DIFFICULTY_SIZE_SATURATION_CHARS = 40_000;

/** Code smell: a fence or a common keyword in user content. */
export const CODE_PATTERN = /```|\b(?:function|class|def |import |SELECT )\b|#include\b/;
/** Reasoning-heavy verbs in user content. */
export const REASONING_KEYWORD_PATTERN =
  /\b(?:prove|analy[sz]e|architect|refactor|debug|optimi[sz]e|step[- ]by[- ]step|plan|design|audit)\b/i;

/** Efforts that add 0.30. */
export const HIGH_EFFORTS: readonly string[] = ['high', 'xhigh', 'max'];
/** Efforts that subtract 0.20. */
export const LOW_EFFORTS: readonly string[] = ['low', 'minimal'];

function charsOf(m: DifficultyMessage): number {
  if (typeof m.text === 'string') return m.text.length;
  const n = m.textLength ?? 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Clamps `x` to `[0, 1]` (NaN → 0). */
export function clampDifficulty(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.min(1, Math.max(0, x));
}

/**
 * Estimates how hard a request is, per SPEC §4.5:
 *
 * ```
 * base 0.25
 * + min(0.30, totalInputChars / 40_000 · 0.30)           (all messages; the system prompt is separate)
 * + 0.15 if user content has a code fence or a code keyword
 * + 0.15 if tools are present
 * + 0.10 if the system prompt is longer than 2_000 chars
 * + 0.10 if there are more than 8 messages
 * + 0.10 if user content has a reasoning keyword (prove, analyse, refactor, …)
 * + 0.30 for reasoningEffort high | xhigh | max;  − 0.20 for low | minimal
 * clamp to [0, 1]
 * ```
 * The result is rounded to four decimals so equal inputs compare exactly.
 */
export function estimateDifficulty(req: DifficultyInput): number {
  const messages = req.messages ?? [];
  let score = DIFFICULTY_BASE;

  const totalInputChars = messages.reduce((sum, m) => sum + charsOf(m), 0);
  score += Math.min(0.3, (totalInputChars / DIFFICULTY_SIZE_SATURATION_CHARS) * 0.3);

  const userText = messages
    .filter((m) => m.role === 'user' && typeof m.text === 'string')
    .map((m) => m.text as string)
    .join('\n');
  if (userText !== '' && CODE_PATTERN.test(userText)) score += 0.15;
  if (req.toolCount > 0) score += 0.15;
  if (req.systemLength > 2_000) score += 0.1;
  if (messages.length > 8) score += 0.1;
  if (userText !== '' && REASONING_KEYWORD_PATTERN.test(userText)) score += 0.1;

  const effort = req.reasoningEffort;
  if (effort !== undefined) {
    if (HIGH_EFFORTS.includes(effort)) score += 0.3;
    else if (LOW_EFFORTS.includes(effort)) score -= 0.2;
  }

  return Math.round(clampDifficulty(score) * 1e4) / 1e4;
}
