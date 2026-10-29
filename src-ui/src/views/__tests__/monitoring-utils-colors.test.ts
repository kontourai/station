import { describe, expect, test } from 'vitest';
import { getAgentColor, getConversationColor } from '../monitoring-utils';

describe('monitoring accents follow the series tokens', () => {
  const keys = Array.from({ length: 60 }, (_, index) => `agent-${index}`);

  test.each([
    ['agent', getAgentColor],
    ['conversation', getConversationColor],
  ])(
    '%s colours are series variables, stable per key, and use all six',
    (_, colorOf) => {
      const colors = keys.map((key) => colorOf(key));
      for (const color of colors)
        expect(color).toMatch(/^var\(--series-[1-6]\)$/);
      expect(new Set(colors)).toEqual(
        new Set([1, 2, 3, 4, 5, 6].map((n) => `var(--series-${n})`)),
      );
      expect(keys.map((key) => colorOf(key))).toEqual(colors);
    },
  );
});
