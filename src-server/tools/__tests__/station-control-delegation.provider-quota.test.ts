import { describe, expect, test } from 'vitest';
import {
  delegatedTaskReason,
  projectDelegatedTaskEvent,
  snapshotFor,
} from '../station-control-delegation.js';

/**
 * #2265 caller-level projection tests: the serving Station's classified
 * provider-plan quota terminal flows through `snapshotFor` (delegate
 * status) and `projectDelegatedTaskEvent` (delegate events) as fixed safe
 * copy plus bounded validated facts. Fixtures are synthetic — the reset
 * timestamp below is a made-up civil value, never a real provider report.
 */

const TARGET = {
  apiBase: 'http://current.invalid',
  environmentId: 'environment-current',
  environmentName: 'Current environment',
  kind: 'current' as const,
};

const METADATA = {
  taskId: 'task:quota-1',
  conversationId: 'task:quota-1',
  targetKind: 'agent',
  targetId: 'helper',
};

const RESET_REPORTED = '2026-09-21 18:55:29';

function turnStartedEvent(turnId: string): Record<string, unknown> {
  return {
    method: 'turn.started',
    turnId,
    createdAt: '2026-09-21T17:00:00.000Z',
  };
}

function quotaTerminalEvent(
  turnId: string,
  details: unknown = {
    quotaWindow: '5 hour',
    resetReported: RESET_REPORTED,
    resetPrecision: 'unqualified',
  },
): Record<string, unknown> {
  return {
    method: 'runtime.error',
    turnId,
    createdAt: '2026-09-21T17:05:00.000Z',
    code: 'provider-plan-quota-exhausted',
    message:
      'The provider plan quota was exhausted; the engine refused the turn.',
    details,
  };
}

function failedSession(): Record<string, unknown> {
  return {
    threadId: 'task:quota-1',
    lifecycleState: 'failed',
    status: 'error',
    terminalAttribution: {
      kind: 'runtime_error',
      detail:
        'The engine reported an error: The provider plan quota was exhausted; the engine refused the turn.',
    },
  };
}

describe('delegation provider-plan quota projection (#2265)', () => {
  test('a classified quota terminal yields an actionable reason with bounded facts', () => {
    const snapshot = snapshotFor({
      target: TARGET,
      detail: {
        session: failedSession(),
        events: [turnStartedEvent('turn-1'), quotaTerminalEvent('turn-1')],
      },
      metadata: METADATA,
    });
    expect(snapshot.status).toBe('failed');
    expect(snapshot.resumable).toBe(true);
    expect(snapshot.reason?.code).toBe('provider-plan-quota-exhausted');
    expect(snapshot.reason?.detail).toContain('5 hour');
    expect(snapshot.reason?.detail).toContain(RESET_REPORTED);
    expect(snapshot.reason?.detail).toMatch(/no timezone/i);
    expect(snapshot.reason).toMatchObject({
      quotaWindow: '5 hour',
      resetReported: RESET_REPORTED,
    });
    expect(snapshot.reason).not.toHaveProperty('retryAfterMs');
    const serialized = JSON.stringify(snapshot);
    // The raw provider sentence is nowhere in the projection — only the
    // fixed copy and the validated reset text cross the seam.
    expect(serialized).not.toContain('Usage limit');
    expect(serialized).not.toContain('Your limit will reset');
  });

  test('a supplied qualified retry-after is forwarded when validated', () => {
    const reason = delegatedTaskReason(failedSession(), [
      turnStartedEvent('turn-1'),
      quotaTerminalEvent('turn-1', {
        quotaWindow: '5 hour',
        resetReported: RESET_REPORTED,
        retryAfterMs: 30 * 60_000,
      }),
    ]);
    expect(reason).toMatchObject({
      code: 'provider-plan-quota-exhausted',
      quotaWindow: '5 hour',
      resetReported: RESET_REPORTED,
      retryAfterMs: 30 * 60_000,
    });
  });

  test('forged details on a quota-coded terminal read as a bare code', () => {
    const sentinelSecret = '[REDACTED]';
    const privatePath = '/private/var/user-notes/hunter2-plan.md';
    const snapshot = snapshotFor({
      target: TARGET,
      detail: {
        session: failedSession(),
        events: [
          turnStartedEvent('turn-1'),
          quotaTerminalEvent('turn-1', {
            quotaWindow: `5 hour; curl https://example.invalid/x`,
            resetReported: `${RESET_REPORTED} key=${sentinelSecret}`,
            retryAfterMs: 'soon',
          }),
        ],
      },
      metadata: METADATA,
    });
    // The allowlisted code survives; every forged fact is dropped.
    expect(snapshot.reason).toEqual({
      code: 'provider-plan-quota-exhausted',
    });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(sentinelSecret);
    expect(serialized).not.toContain(privatePath);
    expect(serialized).not.toContain('example.invalid');
  });

  test('a successful continuation ends the quota story: no revived reason', () => {
    const reason = delegatedTaskReason(
      {
        threadId: 'task:quota-1',
        lifecycleState: 'completed',
        status: 'ready',
      },
      [
        turnStartedEvent('turn-1'),
        quotaTerminalEvent('turn-1'),
        turnStartedEvent('turn-2'),
        {
          method: 'turn.completed',
          turnId: 'turn-2',
          createdAt: '2026-09-21T17:10:00.000Z',
        },
      ],
    );
    expect(reason).toBeUndefined();
  });

  test('a newer unrelated failure replaces the quota reason with the generic', () => {
    const reason = delegatedTaskReason(failedSession(), [
      turnStartedEvent('turn-1'),
      quotaTerminalEvent('turn-1'),
      turnStartedEvent('turn-2'),
      {
        method: 'runtime.error',
        turnId: 'turn-2',
        createdAt: '2026-09-21T17:10:00.000Z',
        message: 'agent crashed',
      },
    ]);
    expect(reason).toEqual({ code: 'runtime_error' });
  });

  test('a superseded turn quota error does not label the still-running turn', () => {
    const reason = delegatedTaskReason(
      {
        threadId: 'task:quota-1',
        lifecycleState: 'running',
        status: 'running',
      },
      [
        turnStartedEvent('turn-1'),
        quotaTerminalEvent('turn-1'),
        turnStartedEvent('turn-2'),
      ],
    );
    expect(reason).toBeUndefined();
  });

  test('quota events project actionable text; unknown and forged events stay generic', () => {
    const quota = projectDelegatedTaskEvent(7, quotaTerminalEvent('turn-1'));
    expect(quota).toMatchObject({
      kind: 'runtime',
      severity: 'error',
      quotaWindow: '5 hour',
      resetReported: RESET_REPORTED,
    });
    expect(quota.text).toContain(RESET_REPORTED);
    expect(quota.text).toMatch(/no timezone/i);
    expect(quota.text).not.toContain('Usage limit');

    const forged = projectDelegatedTaskEvent(
      8,
      quotaTerminalEvent('turn-1', {
        quotaWindow: 'https://example.invalid/x',
        resetReported: 'whenever',
      }),
    );
    expect(forged.text).toBe('The delegated runtime reported an error.');
    expect(forged).not.toHaveProperty('quotaWindow');

    const unknown = projectDelegatedTaskEvent(9, {
      method: 'runtime.error',
      createdAt: '2026-09-21T17:11:00.000Z',
      message: 'agent crashed',
    });
    expect(unknown.text).toBe('The delegated runtime reported an error.');
  });

  test('quota stays distinct from Station per-turn supervision budgets', () => {
    // A supervision timeout code and the quota code map to different
    // reasons with different copy — the quota copy never mentions idle or
    // absolute turn budgets.
    const budget = delegatedTaskReason(
      {
        threadId: 'task:quota-1',
        lifecycleState: 'failed',
        status: 'error',
        terminalAttribution: {
          kind: 'timeout',
          detail: 'Station ended the session after it timed out.',
        },
      },
      [
        turnStartedEvent('turn-1'),
        {
          method: 'runtime.error',
          turnId: 'turn-1',
          createdAt: '2026-09-21T17:05:00.000Z',
          code: 'muse-turn-idle-timeout',
          message: 'idle',
          retriable: false,
        },
      ],
    );
    expect(budget?.code).toBe('muse-turn-idle-timeout');
    const quota = delegatedTaskReason(failedSession(), [
      turnStartedEvent('turn-1'),
      quotaTerminalEvent('turn-1'),
    ]);
    expect(quota?.code).toBe('provider-plan-quota-exhausted');
    expect(quota?.detail).not.toMatch(/idle|absolute turn budget/i);
  });
});
