import { describe, expect, it } from 'vitest';
import {
  CODE_PATTERN,
  DIFFICULTY_BASE,
  REASONING_KEYWORD_PATTERN,
  clampDifficulty,
  estimateDifficulty,
  type DifficultyInput,
} from '../src/difficulty.js';

const base = (over: Partial<DifficultyInput> = {}): DifficultyInput => ({
  messages: [{ role: 'user', text: 'hi' }],
  systemLength: 0,
  toolCount: 0,
  ...over,
});

describe('estimateDifficulty (SPEC §4.5)', () => {
  it('starts at 0.25 for a trivial request', () => {
    expect(DIFFICULTY_BASE).toBe(0.25);
    expect(estimateDifficulty(base())).toBeCloseTo(0.25, 6);
    expect(estimateDifficulty({ messages: [], systemLength: 0, toolCount: 0 })).toBe(0.25);
  });

  it('adds up to 0.30 for input size (text or textLength)', () => {
    expect(estimateDifficulty(base({ messages: [{ role: 'user', textLength: 20_000 }] }))).toBeCloseTo(0.4, 6);
    expect(estimateDifficulty(base({ messages: [{ role: 'user', textLength: 40_000 }] }))).toBeCloseTo(0.55, 6);
    expect(estimateDifficulty(base({ messages: [{ role: 'user', textLength: 400_000 }] }))).toBeCloseTo(0.55, 6);
    expect(estimateDifficulty(base({ messages: [{ role: 'user', text: 'a'.repeat(20_000) }] }))).toBeCloseTo(0.4, 6);
    // text wins over textLength; assistant messages count toward size too
    expect(estimateDifficulty(base({ messages: [{ role: 'user', text: 'a'.repeat(20_000), textLength: 1 }, { role: 'assistant', textLength: 20_000 }] }))).toBeCloseTo(0.55, 6);
    expect(estimateDifficulty(base({ messages: [{ role: 'user', textLength: Number.NaN }] }))).toBe(0.25);
  });

  it('adds 0.15 for code in user content only', () => {
    expect(estimateDifficulty(base({ messages: [{ role: 'user', text: 'here:\n```js\nx\n```' }] }))).toBeCloseTo(0.4, 6);
    expect(estimateDifficulty(base({ messages: [{ role: 'user', text: 'def foo(): pass' }] }))).toBeCloseTo(0.4, 6);
    expect(estimateDifficulty(base({ messages: [{ role: 'user', text: '#include <stdio.h>' }] }))).toBeCloseTo(0.4, 6);
    expect(estimateDifficulty(base({ messages: [{ role: 'user', text: 'SELECT * FROM t' }] }))).toBeCloseTo(0.4, 6);
    expect(estimateDifficulty(base({ messages: [{ role: 'user', text: 'the class of 2026' }] }))).toBeCloseTo(0.4, 6);
    expect(estimateDifficulty(base({ messages: [{ role: 'assistant', text: 'function f() {}' }, { role: 'user', text: 'thanks' }] }))).toBeCloseTo(0.25, 6);
    expect(estimateDifficulty(base({ messages: [{ role: 'user', text: 'classy functional importance' }] }))).toBeCloseTo(0.25, 6);
    expect(CODE_PATTERN.test('import os')).toBe(true);
    expect(CODE_PATTERN.test('important')).toBe(false);
  });

  it('adds 0.15 for tools, 0.10 for a long system prompt, 0.10 for > 8 messages', () => {
    expect(estimateDifficulty(base({ toolCount: 3 }))).toBeCloseTo(0.4, 6);
    expect(estimateDifficulty(base({ systemLength: 2_000 }))).toBeCloseTo(0.25, 6);
    expect(estimateDifficulty(base({ systemLength: 2_001 }))).toBeCloseTo(0.35, 6);
    const eight = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: 'x' }));
    expect(estimateDifficulty(base({ messages: eight }))).toBeCloseTo(0.25, 6);
    expect(estimateDifficulty(base({ messages: [...eight, { role: 'user', text: 'y' }] }))).toBeCloseTo(0.35, 6);
  });

  it('adds 0.10 for reasoning keywords (case-insensitive, user content only)', () => {
    for (const t of ['Please ANALYZE this', 'analyse it', 'go step-by-step', 'step by step', 'prove it', 'refactor', 'debug', 'optimise', 'optimize', 'plan a trip', 'design', 'audit', 'architect']) {
      expect(estimateDifficulty(base({ messages: [{ role: 'user', text: t }] })), t).toBeCloseTo(0.35, 6);
    }
    expect(estimateDifficulty(base({ messages: [{ role: 'user', text: 'planning analysis' }] }))).toBeCloseTo(0.25, 6);
    expect(estimateDifficulty(base({ messages: [{ role: 'system', text: 'audit everything' }, { role: 'user', text: 'ok' }] }))).toBeCloseTo(0.25, 6);
    expect(REASONING_KEYWORD_PATTERN.test('Debug')).toBe(true);
  });

  it('applies reasoning effort', () => {
    expect(estimateDifficulty(base({ reasoningEffort: 'high' }))).toBeCloseTo(0.55, 6);
    expect(estimateDifficulty(base({ reasoningEffort: 'xhigh' }))).toBeCloseTo(0.55, 6);
    expect(estimateDifficulty(base({ reasoningEffort: 'max' }))).toBeCloseTo(0.55, 6);
    expect(estimateDifficulty(base({ reasoningEffort: 'low' }))).toBeCloseTo(0.05, 6);
    expect(estimateDifficulty(base({ reasoningEffort: 'minimal' }))).toBeCloseTo(0.05, 6);
    expect(estimateDifficulty(base({ reasoningEffort: 'medium' }))).toBeCloseTo(0.25, 6);
    expect(estimateDifficulty(base({ reasoningEffort: 'none' }))).toBeCloseTo(0.25, 6);
    expect(estimateDifficulty(base({ reasoningEffort: 'weird' }))).toBeCloseTo(0.25, 6);
  });

  it('clamps to [0, 1] and rounds to 4 decimals', () => {
    const everything: DifficultyInput = {
      messages: [...Array.from({ length: 9 }, () => ({ role: 'user', text: 'analyse ```code```' })), { role: 'user', textLength: 40_000 }],
      systemLength: 5_000,
      toolCount: 1,
      reasoningEffort: 'max',
    };
    expect(estimateDifficulty(everything)).toBe(1);
    expect(estimateDifficulty(base({ messages: [], reasoningEffort: 'low' }))).toBe(0.05);
    expect(estimateDifficulty(base({ toolCount: 1, systemLength: 3_000 }))).toBe(0.5);
    expect(clampDifficulty(-1)).toBe(0);
    expect(clampDifficulty(2)).toBe(1);
    expect(clampDifficulty(Number.NaN)).toBe(0);
    expect(clampDifficulty(0.4)).toBe(0.4);
  });

  it('is deterministic', () => {
    const input = base({ messages: [{ role: 'user', text: 'refactor ```x```' }], toolCount: 2, reasoningEffort: 'high' });
    expect(estimateDifficulty(input)).toBe(estimateDifficulty({ ...input, messages: [...input.messages] }));
  });
});
