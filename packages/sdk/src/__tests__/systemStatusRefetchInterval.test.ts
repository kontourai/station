import { describe, expect, test } from 'vitest';
import { StationHttpError } from '../client/http';
import {
  resolveSystemStatusRefetchInterval,
  type SystemStatus,
  shouldRetrySystemStatus,
} from '../query-domains/systemRuntime';

function systemStatus(
  prerequisitesState: SystemStatus['prerequisitesState'],
): SystemStatus {
  return {
    prerequisitesState,
    acp: { connected: false, connections: [] },
    clis: {},
    ready: prerequisitesState === 'ready',
  };
}

/**
 * station#chat-dock-maximize-readiness: while system prerequisite discovery
 * is `pending`, the status snapshot is an all-false placeholder. Without a
 * poll cadence, a query that resolves with that placeholder never refetches
 * until something else invalidates the cache — so a genuinely ready
 * Claude/Codex/ACP/Ollama path stays hidden behind a false "setup needed"
 * overlay. The refetch interval must keep polling until discovery settles.
 */
describe('resolveSystemStatusRefetchInterval', () => {
  test('polls while discovery is pending', () => {
    const interval = resolveSystemStatusRefetchInterval({
      state: {
        status: 'success',
        data: systemStatus('pending'),
      },
    });
    expect(typeof interval).toBe('number');
    expect(interval).toBeGreaterThan(0);
  });

  test('stops polling once discovery settles to ready', () => {
    const interval = resolveSystemStatusRefetchInterval({
      state: {
        status: 'success',
        data: systemStatus('ready'),
      },
    });
    expect(interval).toBe(false);
  });

  test('stops polling once discovery settles to stale', () => {
    const interval = resolveSystemStatusRefetchInterval({
      state: {
        status: 'success',
        data: systemStatus('stale'),
      },
    });
    expect(interval).toBe(false);
  });

  test('does not poll when prerequisitesState is absent (legacy payload)', () => {
    const interval = resolveSystemStatusRefetchInterval({
      state: { status: 'success', data: undefined },
    });
    expect(interval).toBe(false);
  });

  test('honors an explicit pollInterval once settled', () => {
    const interval = resolveSystemStatusRefetchInterval(
      {
        state: {
          status: 'success',
          data: systemStatus('ready'),
        },
      },
      5_000,
    );
    expect(interval).toBe(5_000);
  });

  test('pending polling takes precedence over a caller-supplied pollInterval', () => {
    // While pending we want the faster cadence regardless of caller intent.
    const interval = resolveSystemStatusRefetchInterval(
      {
        state: {
          status: 'success',
          data: systemStatus('pending'),
        },
      },
      5_000,
    );
    expect(interval).toBeLessThan(5_000);
  });

  test('keeps polling on error', () => {
    const interval = resolveSystemStatusRefetchInterval({
      state: { status: 'error' },
    });
    expect(interval).toBe(5_000);
  });

  // station#3444: same terminal/transient split as
  // `resolveMonitoringStatsRefetchInterval` (`monitoringStatsRefetchInterval.test.ts`)
  // — a credential failure (401/403) cannot clear by polling again.
  test('keeps polling on a transient error (no status, network failure)', () => {
    const interval = resolveSystemStatusRefetchInterval({
      state: { status: 'error', error: new Error('network down') },
    });
    expect(interval).toBe(5_000);
  });

  test('keeps polling on a non-terminal HTTP status (e.g. 503)', () => {
    const interval = resolveSystemStatusRefetchInterval({
      state: { status: 'error', error: new StationHttpError(503, 'busy') },
    });
    expect(interval).toBe(5_000);
  });

  test('stops polling on a 401 (terminal, matches the SSE transport)', () => {
    const interval = resolveSystemStatusRefetchInterval({
      state: {
        status: 'error',
        error: new StationHttpError(401, 'Unauthorized'),
      },
    });
    expect(interval).toBe(false);
  });

  test('stops polling on a 403 (terminal, matches the SSE transport)', () => {
    const interval = resolveSystemStatusRefetchInterval({
      state: {
        status: 'error',
        error: new StationHttpError(403, 'Forbidden'),
      },
    });
    expect(interval).toBe(false);
  });
});

/**
 * station#3444: the per-attempt sibling of the interval split above. Without
 * it, `retry: 2` burned two extra attempts on a 401/403 before the interval
 * resolver ever got a say — three requests against a status that rejects
 * every one of them identically.
 */
describe('shouldRetrySystemStatus', () => {
  test('retries a transient failure up to the budget', () => {
    const error = new Error('network down');
    expect(shouldRetrySystemStatus(0, error)).toBe(true);
    expect(shouldRetrySystemStatus(1, error)).toBe(true);
    expect(shouldRetrySystemStatus(2, error)).toBe(false);
  });

  test('retries a non-terminal HTTP status up to the budget', () => {
    const error = new StationHttpError(503, 'busy');
    expect(shouldRetrySystemStatus(0, error)).toBe(true);
    expect(shouldRetrySystemStatus(2, error)).toBe(false);
  });

  test('never retries a 401, even on the first failure', () => {
    const error = new StationHttpError(401, 'Unauthorized');
    expect(shouldRetrySystemStatus(0, error)).toBe(false);
  });

  test('never retries a 403, even on the first failure', () => {
    const error = new StationHttpError(403, 'Forbidden');
    expect(shouldRetrySystemStatus(0, error)).toBe(false);
  });
});
