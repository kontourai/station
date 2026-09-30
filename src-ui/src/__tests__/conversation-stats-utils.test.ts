import { describe, expect, test } from 'vitest';
import {
  formatAverageTokens,
  getContextBreakdownEntries,
  getContextWindowColor,
} from '../components/conversation-stats/utils';

describe('conversation stats utils', () => {
  test('returns the expected context window color thresholds', () => {
    // Token names, not pigments: the pigment is the theme's decision (#2140).
    expect(getContextWindowColor(10)).toBe('var(--meter-low)');
    expect(getContextWindowColor(51)).toBe('var(--meter-mid)');
    expect(getContextWindowColor(81)).toBe('var(--meter-high)');
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

  test('formats average token counts', () => {
    expect(formatAverageTokens(10, 4)).toBe('3');
    expect(formatAverageTokens(10, 0)).toBeNull();
  });
});
