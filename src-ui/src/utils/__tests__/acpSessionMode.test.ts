import { describe, expect, test } from 'vitest';
import { advertisedAcpSessionModesFromConnection } from '../acpSessionMode';

describe('advertisedAcpSessionModesFromConnection', () => {
  test('prefers configOptions category mode over the older modes list', () => {
    expect(
      advertisedAcpSessionModesFromConnection({
        modes: ['ask', 'code'],
        configOptions: [
          {
            category: 'mode',
            currentValue: 'plan',
            options: [
              { value: 'build', name: 'Build' },
              {
                value: 'plan',
                name: 'Plan',
                description: 'Read-only planning',
              },
            ],
          },
        ],
      }),
    ).toEqual({
      currentModeId: 'plan',
      modes: [
        { id: 'build', name: 'Build' },
        { id: 'plan', name: 'Plan', description: 'Read-only planning' },
      ],
    });
  });

  test('falls back to the connection modes list when no mode option exists', () => {
    expect(
      advertisedAcpSessionModesFromConnection({
        modes: ['ask', 'code'],
        configOptions: [{ category: 'model', options: ['sonnet'] }],
      }),
    ).toEqual({
      modes: [
        { id: 'ask', name: 'ask' },
        { id: 'code', name: 'code' },
      ],
    });
  });

  test('returns an empty catalog when the connection advertised nothing', () => {
    expect(advertisedAcpSessionModesFromConnection(undefined)).toEqual({
      modes: [],
    });
    expect(advertisedAcpSessionModesFromConnection({ modes: [] })).toEqual({
      modes: [],
    });
  });
});
