import { describe, expect, test } from 'vitest';
import {
  getAgentModelBreakdown,
  getTopUsageEntries,
  getTotalUsageConversations,
  getUsageModelDisplayName,
} from '../components/usage-stats/utils';

describe('usage-stats utils', () => {
  test('getTotalUsageConversations handles fallback values', () => {
    expect(getTotalUsageConversations({ totalSessions: 9 })).toBe(9);
  });

  test('getTopUsageEntries sorts by message volume', () => {
    expect(
      getTopUsageEntries({
        a: { messages: 1 },
        b: { messages: 7 },
        c: { messages: 3 },
      }),
    ).toEqual([
      ['b', { messages: 7 }],
      ['c', { messages: 3 }],
      ['a', { messages: 1 }],
    ]);
  });

  test('model and agent helpers resolve display and model breakdowns', () => {
    const models = [{ id: 'model-a', name: 'Model A' }];
    expect(getUsageModelDisplayName(models, 'model-a')).toBe('Model A');
    expect(
      getAgentModelBreakdown({
        agentStats: {
          models: {
            'model-a': { messages: 4, cost: 2 },
          },
        },
        models,
      }),
    ).toEqual([
      {
        modelId: 'model-a',
        displayName: 'Model A',
        messages: 4,
        cost: 2,
      },
    ]);
  });
});
