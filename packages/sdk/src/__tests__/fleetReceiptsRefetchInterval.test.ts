import { describe, expect, test } from 'vitest';
import { StationHttpError } from '../client/http';
import { resolveFleetReceiptsRefetchInterval } from '../query-domains/systemRuntime';

/**
 * station#3444: `useFleetRoutingReceiptsQuery`/`useFleetServeReceiptsQuery`
 * had a flat `refetchInterval: 30_000` that kept polling through a terminal
 * (401/403) failure the SSE transport correctly stops for — the same class
 * #3436 fixed for `useMonitoringStatsQuery`
 * (`resolveMonitoringStatsRefetchInterval`, `monitoringStatsRefetchInterval.test.ts`).
 * This resolver is shared by both fleet receipt queries and replicates that
 * tested pattern rather than inventing a new one.
 */
describe('resolveFleetReceiptsRefetchInterval', () => {
  test('polls at the default cadence while healthy', () => {
    const interval = resolveFleetReceiptsRefetchInterval({
      state: { status: 'success' },
    });
    expect(interval).toBe(30_000);
  });

  test('keeps polling on a transient error (no status, network failure)', () => {
    const interval = resolveFleetReceiptsRefetchInterval({
      state: { status: 'error', error: new Error('network down') },
    });
    expect(interval).toBe(30_000);
  });

  test('keeps polling on a non-terminal HTTP status (e.g. 503)', () => {
    const interval = resolveFleetReceiptsRefetchInterval({
      state: { status: 'error', error: new StationHttpError(503, 'busy') },
    });
    expect(interval).toBe(30_000);
  });

  test('stops polling on a 401 (terminal, matches the SSE transport)', () => {
    const interval = resolveFleetReceiptsRefetchInterval({
      state: {
        status: 'error',
        error: new StationHttpError(401, 'Unauthorized'),
      },
    });
    expect(interval).toBe(false);
  });

  test('stops polling on a 403 (terminal, matches the SSE transport)', () => {
    const interval = resolveFleetReceiptsRefetchInterval({
      state: {
        status: 'error',
        error: new StationHttpError(403, 'Forbidden'),
      },
    });
    expect(interval).toBe(false);
  });
});
