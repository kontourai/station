import { describe, expect, test } from 'vitest';
import {
  CONVERSATION_STATS_ENGINES_MAX,
  parseConversationStatsResponse,
  reportsEngineTokens,
} from '../runtime.js';

describe('parseConversationStatsResponse engines (#5389)', () => {
  const base = { modelId: 'm', turns: 3, toolCalls: 0 };
  const claude = {
    provider: 'claude',
    turns: 2,
    toolCalls: 0,
    inputTokens: 14,
    cacheWriteTokens: 20,
    estimatedCost: 0.25,
    reportedCosts: [{ unit: 'credit', amount: 1 }],
    modelId: 'a-model',
  };
  const codex = { provider: 'codex', turns: 1, toolCalls: 0, totalTokens: 790 };

  test("carries each engine's figures, absent fields staying absent", () => {
    const parsed = parseConversationStatsResponse({
      ...base,
      engines: [claude, codex],
    });
    expect(parsed?.engines).toEqual([claude, codex]);
    expect(parsed?.engines?.[1]).not.toHaveProperty('inputTokens');
    expect(parseConversationStatsResponse(base)).not.toHaveProperty('engines');
  });

  test.each([
    ['not a list', { provider: 'codex' }],
    ['no provider', [{ turns: 1, toolCalls: 0 }]],
    ['an empty provider', [{ ...codex, provider: '' }]],
    ['a negative figure', [{ ...codex, totalTokens: -1 }]],
    ['a non-finite figure', [{ ...codex, inputTokens: Number.NaN }]],
    ['a missing count', [{ provider: 'codex', toolCalls: 0 }]],
    ['a malformed cost unit', [{ ...claude, reportedCosts: [{ unit: '' }] }]],
    ['a non-string model', [{ ...claude, modelId: 7 }]],
  ])('refuses a response whose engines are %s', (_label, engines) => {
    expect(
      parseConversationStatsResponse({ ...base, engines }),
    ).toBeUndefined();
  });

  test('refuses an engine listed twice', () => {
    expect(
      parseConversationStatsResponse({ ...base, engines: [codex, codex] }),
    ).toBeUndefined();
  });

  test('accepts up to the bound and refuses one more, never cutting the list', () => {
    // Pinned beside the constant it bounds: a change to either is deliberate.
    expect(CONVERSATION_STATS_ENGINES_MAX).toBe(32);
    const engines = (count: number) =>
      Array.from({ length: count }, (_, index) => ({
        ...codex,
        provider: `engine-${index}`,
      }));
    expect(
      parseConversationStatsResponse({
        ...base,
        engines: engines(CONVERSATION_STATS_ENGINES_MAX),
      })?.engines,
    ).toHaveLength(CONVERSATION_STATS_ENGINES_MAX);
    expect(
      parseConversationStatsResponse({
        ...base,
        engines: engines(CONVERSATION_STATS_ENGINES_MAX + 1),
      }),
    ).toBeUndefined();
  });

  test('a cache figure alone counts as reported tokens', () => {
    expect(reportsEngineTokens({ cacheWriteTokens: 0 })).toBe(true);
    expect(reportsEngineTokens({})).toBe(false);
  });
});
