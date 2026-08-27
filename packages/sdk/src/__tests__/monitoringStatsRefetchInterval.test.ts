import { describe, expect, test } from 'vitest';
import { StationHttpError } from '../client/http';
import { resolveMonitoringStatsRefetchInterval } from '../query-domains/systemRuntime';

/**
 * station#3436: `useMonitoring`'s SSE stream stops after a 401 (the shared
 * `fetchSSE` transport's terminal-status handling), but the REST stats poll
 * beside it used a flat `refetchInterval: 5_000` unaffected by that stop —
 * ~24 requests over 120s. This mirrors `resolveSystemStatusRefetchInterval`'s
 * (`systemStatusRefetchInterval.test.ts`) shape, using the same
 * `isTerminalConnectionStatus` vocabulary the SSE transport's
 * `classifySseFailure` uses (401/403 stop, everything else keeps polling).
 */
describe('resolveMonitoringStatsRefetchInterval', () => {
  test('polls at the default cadence while healthy', () => {
    const interval = resolveMonitoringStatsRefetchInterval({
      state: { status: 'success' },
    });
    expect(interval).toBe(5_000);
  });

  test('keeps polling on a transient error (no status, network failure)', () => {
    const interval = resolveMonitoringStatsRefetchInterval({
      state: { status: 'error', error: new Error('network down') },
    });
    expect(interval).toBe(5_000);
  });

  test('keeps polling on a non-terminal HTTP status (e.g. 503)', () => {
    const interval = resolveMonitoringStatsRefetchInterval({
      state: { status: 'error', error: new StationHttpError(503, 'busy') },
    });
    expect(interval).toBe(5_000);
  });

  test('stops polling on a 401 (terminal, matches the SSE transport)', () => {
    const interval = resolveMonitoringStatsRefetchInterval({
      state: {
        status: 'error',
        error: new StationHttpError(401, 'Unauthorized'),
      },
    });
    expect(interval).toBe(false);
  });

  test('stops polling on a 403 (terminal, matches the SSE transport)', () => {
    const interval = resolveMonitoringStatsRefetchInterval({
      state: {
        status: 'error',
        error: new StationHttpError(403, 'Forbidden'),
      },
    });
    expect(interval).toBe(false);
  });
});
