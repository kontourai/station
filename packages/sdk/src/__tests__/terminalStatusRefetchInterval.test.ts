import { describe, expect, test } from 'vitest';
import { StationHttpError } from '../client/http';
import {
  resolveFleetReceiptsRefetchInterval,
  resolveMonitoringStatsRefetchInterval,
  resolveSystemStatusRefetchInterval,
} from '../query-domains/systemRuntime';

/**
 * archive#3436 / archive#3444: a REST poll beside an SSE stream must stop on
 * the same terminal statuses the shared `fetchSSE` transport stops on
 * (401/403, `isTerminalConnectionStatus`) and keep its own cadence through
 * everything else. Each resolver keeps its cadence as a literal here.
 */
const resolvers = [
  [
    'resolveMonitoringStatsRefetchInterval',
    resolveMonitoringStatsRefetchInterval,
    5_000,
  ],
  [
    'resolveFleetReceiptsRefetchInterval',
    resolveFleetReceiptsRefetchInterval,
    30_000,
  ],
  [
    'resolveSystemStatusRefetchInterval',
    (query: { state: { status: string; error?: unknown } }) =>
      resolveSystemStatusRefetchInterval(query),
    5_000,
  ],
] as const;

describe.each(resolvers)('%s', (_name, resolve, cadence) => {
  test.each([
    ['a transient network failure', new Error('network down')],
    ['a non-terminal HTTP status (503)', new StationHttpError(503, 'busy')],
  ])('keeps polling on %s', (_label, error) => {
    expect(resolve({ state: { status: 'error', error } })).toBe(cadence);
  });

  test.each([
    [401, 'Unauthorized'],
    [403, 'Forbidden'],
  ])('stops polling on a terminal %i', (status, message) => {
    expect(
      resolve({
        state: {
          status: 'error',
          error: new StationHttpError(status, message),
        },
      }),
    ).toBe(false);
  });
});

test.each([
  [
    'resolveMonitoringStatsRefetchInterval',
    resolveMonitoringStatsRefetchInterval,
    5_000,
  ],
  [
    'resolveFleetReceiptsRefetchInterval',
    resolveFleetReceiptsRefetchInterval,
    30_000,
  ],
] as const)(
  '%s polls at its cadence while healthy',
  (_name, resolve, cadence) => {
    expect(resolve({ state: { status: 'success' } })).toBe(cadence);
  },
);
