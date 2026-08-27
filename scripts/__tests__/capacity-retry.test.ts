import { describe, expect, test } from 'vitest';
import {
  type CapacityRetryObservation,
  waitForAnswerThroughCapacityRetry,
} from '../../tests/helpers/capacity-retry.js';

function observation(overrides: Partial<CapacityRetryObservation> = {}) {
  let now = 0;
  return {
    answerVisible: async () => false,
    capacityRetryVisible: async () => false,
    retryCapacity: async () => undefined,
    capacityDetail: async () => 'Host is at capacity at 99% load.',
    wait: async (milliseconds: number) => {
      now += milliseconds;
    },
    now: () => now,
    ...overrides,
  } satisfies CapacityRetryObservation;
}

describe('visible capacity retry journey', () => {
  test('waits for the answer through the visible Retry control', async () => {
    let retries = 0;
    const result = await waitForAnswerThroughCapacityRetry(
      observation({
        answerVisible: async () => retries === 1,
        capacityRetryVisible: async () => retries === 0,
        retryCapacity: async () => {
          retries += 1;
        },
      }),
      1_000,
    );

    expect(result).toEqual({ capacityRetries: 1 });
  });

  test('keeps the original deadline and reports capacity diagnostics when recovery never arrives', async () => {
    let retries = 0;
    await expect(
      waitForAnswerThroughCapacityRetry(
        observation({
          capacityRetryVisible: async () => true,
          retryCapacity: async () => {
            retries += 1;
          },
        }),
        2_100,
      ),
    ).rejects.toThrow(
      'Activated the visible host-capacity Retry control 2 time(s); last capacity notice: Host is at capacity at 99% load.',
    );
    expect(retries).toBe(2);
  });
});
