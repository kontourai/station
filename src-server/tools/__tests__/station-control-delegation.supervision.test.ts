import { describe, expect, test } from 'vitest';
import {
  delegatedTaskReason,
  delegatedTurnSupervision,
  snapshotFor,
} from '../station-control-delegation.js';

/**
 * #2269 caller-level projection tests: `snapshotFor` is the exact function
 * the delegation routes/tools consume, so these assert the snapshot shape —
 * not just the derivation helpers — for valid facts, time expiry, unknown
 * providers, redaction, and forged metadata.
 */

const TARGET = {
  apiBase: 'http://current.invalid',
  environmentId: 'environment-current',
  environmentName: 'Current environment',
  kind: 'current' as const,
};

const METADATA = {
  taskId: 'task:supervision-1',
  conversationId: 'task:supervision-1',
  targetKind: 'agent',
  targetId: 'helper',
};

function turnStartedEvent(
  turnId: string,
  supervision: Record<string, unknown> | undefined,
  createdAt = '2026-09-20T22:00:00.000Z',
): Record<string, unknown> {
  return {
    method: 'turn.started',
    turnId,
    createdAt,
    ...(supervision ? { metadata: { supervision } } : {}),
  };
}

function museDeclaration(turnId: string): Record<string, unknown> {
  return {
    provider: 'muse',
    turnId,
    startedAt: '2026-09-20T22:00:00.000Z',
    deadlineAt: '2026-09-21T00:00:00.000Z',
    idleLimitMs: 30 * 60_000,
    totalLimitMs: 2 * 60 * 60_000,
  };
}

function observingSession(turnId: string): Record<string, unknown> {
  return {
    threadId: 'task:supervision-1',
    lifecycleState: 'running',
    status: 'running',
    turnProgress: {
      turnId,
      lastProgressEventAt: '2026-09-20T22:10:00.000Z',
    },
  };
}

describe('delegation supervision projection (#2269)', () => {
  test('forwards valid supervision, reason, and transition reason', () => {
    const snapshot = snapshotFor({
      target: TARGET,
      detail: {
        session: {
          ...observingSession('turn-1'),
          provider: 'muse',
          terminalAttribution: {
            kind: 'timeout',
            detail: 'Station ended the session after it timed out.',
          },
          transitionReason: 'runtime_error',
        },
        events: [
          turnStartedEvent('turn-1', museDeclaration('turn-1')),
          {
            method: 'runtime.error',
            turnId: 'turn-1',
            createdAt: '2026-09-20T22:30:01.000Z',
            code: 'muse-turn-idle-timeout',
            message:
              'Muse turn was idle for 1800000ms with no verified protocol activity (last activity at 2026-09-20T22:00:00.000Z; no progress observed — the turn may have been working quietly) and was terminated.',
            retriable: false,
          },
        ],
      },
      metadata: METADATA,
    });
    expect(snapshot.supervision).toMatchObject({
      provider: 'muse',
      turnId: 'turn-1',
      deadlineAt: '2026-09-21T00:00:00.000Z',
      idleLimitMs: 30 * 60_000,
      totalLimitMs: 2 * 60 * 60_000,
      lastProgressEventAt: '2026-09-20T22:10:00.000Z',
    });
    // Idle vs absolute stays distinct even though the lifecycle fold
    // classifies both as `timeout`: the terminal event code names the
    // budget, and the detail is host-synthesized — never the raw message.
    expect(snapshot.reason).toEqual({
      code: 'muse-turn-idle-timeout',
      detail:
        'The turn ended after a full window with no verified protocol activity.',
    });
    expect(JSON.stringify(snapshot)).not.toContain('1800000ms with no verified');
    expect(snapshot.transitionReason).toBe('runtime_error');
  });

  test('an absolute-budget expiry maps to the distinct total reason', () => {
    const snapshot = snapshotFor({
      target: TARGET,
      detail: {
        session: {
          ...observingSession('turn-1'),
          provider: 'muse',
          terminalAttribution: { kind: 'timeout' },
        },
        events: [
          turnStartedEvent('turn-1', museDeclaration('turn-1')),
          {
            method: 'runtime.error',
            turnId: 'turn-1',
            createdAt: '2026-09-21T00:00:01.000Z',
            code: 'muse-turn-timeout',
            message:
              'Muse did not finish the turn within 7200000ms (absolute turn budget) and was terminated.',
            retriable: false,
          },
        ],
      },
      metadata: METADATA,
    });
    expect(snapshot.reason).toEqual({
      code: 'muse-turn-timeout',
      detail: 'The turn ended at its absolute turn budget.',
    });
  });

  test('time-expiry clamps remaining to zero instead of going negative', () => {
    const supervision = delegatedTurnSupervision(
      observingSession('turn-1'),
      [turnStartedEvent('turn-1', museDeclaration('turn-1'))],
      // Long after the 2 h deadline.
      Date.parse('2026-09-21T05:00:00.000Z'),
    );
    expect(supervision?.remainingMs).toBe(0);
    expect(supervision?.elapsedMs).toBeGreaterThan(0);
  });

  test('a stale prior turn declaration is omitted once the watchdog moved on', () => {
    const snapshot = snapshotFor({
      target: TARGET,
      detail: {
        session: observingSession('turn-2'),
        events: [turnStartedEvent('turn-1', museDeclaration('turn-1'))],
      },
      metadata: METADATA,
    });
    expect(snapshot.supervision).toBeUndefined();
  });

  test('unknown providers omit supervision honestly — no deadline is invented', () => {
    const snapshot = snapshotFor({
      target: TARGET,
      detail: {
        session: {
          threadId: 'task:supervision-1',
          lifecycleState: 'running',
          status: 'running',
          provider: 'codex',
          turnProgress: {
            turnId: 'turn-9',
            lastProgressEventAt: '2026-09-20T22:10:00.000Z',
          },
        },
        events: [
          {
            method: 'turn.started',
            turnId: 'turn-9',
            createdAt: '2026-09-20T22:00:00.000Z',
          },
        ],
      },
      metadata: METADATA,
    });
    expect(snapshot.supervision).toBeUndefined();
    expect(snapshot.status).toBe('running');
  });

  test('a malformed declaration is dropped rather than repaired', () => {
    for (const bad of [
      { ...museDeclaration('turn-1'), idleLimitMs: Infinity },
      { ...museDeclaration('turn-1'), totalLimitMs: 0 },
      { ...museDeclaration('turn-1'), deadlineAt: 'not-a-timestamp' },
      { ...museDeclaration('turn-1'), turnId: 'turn-other' },
      { ...museDeclaration('turn-1'), provider: '' },
    ]) {
      const snapshot = snapshotFor({
        target: TARGET,
        detail: {
          session: observingSession('turn-1'),
          events: [turnStartedEvent('turn-1', bad)],
        },
        metadata: METADATA,
      });
      expect(snapshot.supervision).toBeUndefined();
    }
  });

  test('request/caller metadata can neither choose nor extend the budget', () => {
    // A caller smuggling budget-shaped keys (or a whole supervision object)
    // through request metadata must have no effect: the only source is the
    // adapter's own turn.started declaration joined to the live observation.
    const snapshot = snapshotFor({
      target: TARGET,
      detail: {
        session: observingSession('turn-1'),
        events: [
          {
            method: 'turn.started',
            turnId: 'turn-1',
            createdAt: '2026-09-20T22:00:00.000Z',
          },
        ],
      },
      metadata: {
        ...METADATA,
        turnTimeoutMs: 1,
        turnIdleTimeoutMs: 1,
        supervision: museDeclaration('turn-1'),
      },
    });
    expect(snapshot.supervision).toBeUndefined();
  });

  test('reason carries only the typed attribution — raw error text is never forwarded', () => {
    const session = {
      ...observingSession('turn-1'),
      terminalAttribution: { kind: 'runtime_error' },
    };
    const events = [
      turnStartedEvent('turn-1', museDeclaration('turn-1')),
      {
        method: 'runtime.error',
        turnId: 'turn-1',
        createdAt: '2026-09-20T22:11:00.000Z',
        code: 'muse-spawn-failed',
        message:
          'Muse failed to start: connect EACCES sk-live-super-secret-key material in raw log',
        retriable: false,
      },
    ];
    const snapshot = snapshotFor({
      target: TARGET,
      detail: { session, events },
      metadata: METADATA,
    });
    expect(snapshot.reason).toEqual({ code: 'runtime_error' });
    expect(JSON.stringify(snapshot)).not.toContain('sk-live-super-secret');
  });

  test('no attribution means no reason — never a guessed one', () => {
    expect(
      delegatedTaskReason({ threadId: 'x', lifecycleState: 'failed' }),
    ).toBeUndefined();
    const snapshot = snapshotFor({
      target: TARGET,
      detail: {
        session: { threadId: 'x', lifecycleState: 'failed', status: 'error' },
        events: [],
      },
      metadata: METADATA,
    });
    expect(snapshot.reason).toBeUndefined();
    expect(snapshot.supervision).toBeUndefined();
  });

  test('a sentinel secret and private path in the raw error stay out of the snapshot', () => {
    const sentinelSecret = 'sk-sentinel-secret-9f8e7d6c5b4a';
    const privatePath = '/private/var/user-notes/hunter2-plan.md';
    const session = {
      ...observingSession('turn-1'),
      terminalAttribution: {
        kind: 'runtime_error',
        detail: `engine blew up on ${privatePath} with key ${sentinelSecret}`,
      },
    };
    const events = [
      turnStartedEvent('turn-1', museDeclaration('turn-1')),
      {
        method: 'runtime.error',
        turnId: 'turn-1',
        createdAt: '2026-09-20T22:11:00.000Z',
        code: 'muse-exit-without-terminal',
        message: `Muse exited before reporting a terminal result (key ${sentinelSecret} at ${privatePath}).`,
        retriable: false,
      },
    ];
    const snapshot = snapshotFor({
      target: TARGET,
      detail: { session, events },
      metadata: METADATA,
    });
    // Bare generic code — neither the attribution detail nor the event
    // message is forwarded, so neither the secret nor the path crosses.
    expect(snapshot.reason).toEqual({ code: 'runtime_error' });
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain(sentinelSecret);
    expect(serialized).not.toContain(privatePath);
  });

  test('a forged transition reason outside the vocabulary is dropped', () => {
    const snapshot = snapshotFor({
      target: TARGET,
      detail: {
        session: {
          ...observingSession('turn-1'),
          transitionReason: 'adapter-turn-timeout',
        },
        events: [turnStartedEvent('turn-1', museDeclaration('turn-1'))],
      },
      metadata: METADATA,
    });
    expect(snapshot.transitionReason).toBeUndefined();
    expect(JSON.stringify(snapshot)).not.toContain('adapter-turn-timeout');
  });

  test('a declaration whose provider disagrees with the session is dropped', () => {
    const snapshot = snapshotFor({
      target: TARGET,
      detail: {
        session: {
          ...observingSession('turn-1'),
          provider: 'codex',
        },
        events: [turnStartedEvent('turn-1', museDeclaration('turn-1'))],
      },
      metadata: METADATA,
    });
    expect(snapshot.supervision).toBeUndefined();
  });

  test('the declaration is matched by observed turn id, not by latest start', () => {
    // A newer turn.started without a declaration must not shadow the
    // observed turn's own declaration: the match is by turnId identity.
    const supervision = delegatedTurnSupervision(observingSession('turn-1'), [
      turnStartedEvent('turn-1', museDeclaration('turn-1')),
      {
        method: 'turn.started',
        turnId: 'turn-2',
        createdAt: '2026-09-20T23:00:00.000Z',
      },
    ]);
    expect(supervision?.turnId).toBe('turn-1');
    expect(supervision?.provider).toBe('muse');
  });
});
