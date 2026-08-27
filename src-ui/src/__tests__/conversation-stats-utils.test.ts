import { describe, expect, test } from 'vitest';
import {
  formatAverageTokens,
  getContextBreakdownEntries,
  getContextWindowColor,
  getModelStatsEntries,
} from '../components/conversation-stats/utils';

describe('conversation stats utils', () => {
  test('returns the expected context window color thresholds', () => {
    expect(getContextWindowColor(10)).toBe('#10b981');
    expect(getContextWindowColor(51)).toBe('#f59e0b');
    expect(getContextWindowColor(81)).toBe('#ef4444');
  });

  test('filters undefined breakdown entries and zero context files', () => {
    expect(
      getContextBreakdownEntries({
        systemPromptTokens: 10,
        mcpServerTokens: undefined,
        userMessageTokens: 20,
        assistantMessageTokens: 30,
        contextFilesTokens: 0,
      }),
    ).toEqual([
      { label: 'System Prompt', value: 10 },
      { label: 'User Messages', value: 20 },
      { label: 'Assistant Messages', value: 30 },
    ]);
  });

  test('returns model stats entries in object order', () => {
    expect(
      getModelStatsEntries({
        modelA: {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          contextTokens: 4,
          turns: 5,
          toolCalls: 6,
          estimatedCost: 7,
        },
      }),
    ).toEqual([
      [
        'modelA',
        {
          inputTokens: 1,
          outputTokens: 2,
          totalTokens: 3,
          contextTokens: 4,
          turns: 5,
          toolCalls: 6,
          estimatedCost: 7,
        },
      ],
    ]);
  });

  test('formats average token counts', () => {
    expect(formatAverageTokens(10, 4)).toBe('3');
    expect(formatAverageTokens(10, 0)).toBeNull();
  });
});
