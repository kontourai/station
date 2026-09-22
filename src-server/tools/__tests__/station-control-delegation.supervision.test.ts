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
              'Muse turn was idle for 1800000ms with no verified protocol activity and no tool running (last activity at 2026-09-20T22:00:00.000Z), so Station stopped it.',
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
    expect(JSON.stringify(snapshot)).not.toContain(
      '1800000ms with no verified',
    );
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
              'Muse did not finish the turn within the 7200000ms turn budget declared for it, so Station stopped it.',
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

  test('a Muse turn with no declared budget reports its live idle window and no deadline', () => {
    // Owner direction on #2269: with no `turnTimeoutMs` the Muse adapter
    // declares only `idleLimitMs`. The idle deadline can still end the turn,
    // so the projection forwards it — and invents no deadline or total.
    const {
      deadlineAt: _deadline,
      totalLimitMs: _total,
      ...idleOnly
    } = museDeclaration('turn-1');
    const snapshot = snapshotFor({
      target: TARGET,
      detail: {
        session: { ...observingSession('turn-1'), provider: 'muse' },
        events: [turnStartedEvent('turn-1', idleOnly)],
      },
      metadata: METADATA,
    });
    expect(snapshot.supervision).toEqual({
      provider: 'muse',
      turnId: 'turn-1',
      elapsedMs: expect.any(Number),
      idleLimitMs: 30 * 60_000,
      lastProgressEventAt: '2026-09-20T22:10:00.000Z',
    });
  });

  test('a declaration carrying only half of a total budget is dropped, not repaired', () => {
    for (const drop of ['totalLimitMs', 'deadlineAt'] as const) {
      const declaration: Record<string, unknown> = museDeclaration('turn-1');
      delete declaration[drop];
      expect(
        delegatedTurnSupervision(
          { ...observingSession('turn-1'), provider: 'muse' },
          [turnStartedEvent('turn-1', declaration)],
        ),
      ).toBeUndefined();
    }
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

  test('a superseded turn budget never labels a later running turn', () => {
    // Root review 00:40: the reason used to scan the newest budget code
    // anywhere in history, so turn-1's idle expiry labeled turn-2 while it
    // was still running. The code is now scoped to the latest turn.
    const snapshot = snapshotFor({
      target: TARGET,
      detail: {
        session: observingSession('turn-2'),
        events: [
          turnStartedEvent('turn-1', museDeclaration('turn-1')),
          {
            method: 'runtime.error',
            turnId: 'turn-1',
            createdAt: '2026-09-20T22:30:01.000Z',
            code: 'muse-turn-idle-timeout',
            message: 'Muse turn was idle for 1800000ms and was terminated.',
            retriable: false,
          },
          turnStartedEvent('turn-2', museDeclaration('turn-2')),
        ],
      },
      metadata: METADATA,
    });
    expect(snapshot.reason).toBeUndefined();
    expect(snapshot.status).toBe('running');
  });

  test('a clean completion ends the story even with an older budget error', () => {
    const snapshot = snapshotFor({
      target: TARGET,
      detail: {
        session: {
          threadId: 'task:supervision-1',
          lifecycleState: 'completed',
          status: 'ready',
        },
        events: [
          turnStartedEvent('turn-1', museDeclaration('turn-1')),
          {
            method: 'runtime.error',
            turnId: 'turn-1',
            createdAt: '2026-09-20T22:30:01.000Z',
            code: 'muse-turn-timeout',
            message: 'Muse did not finish the turn within 7200000ms.',
            retriable: false,
          },
          {
            method: 'turn.started',
            turnId: 'turn-2',
            createdAt: '2026-09-20T23:00:00.000Z',
          },
          {
            method: 'turn.completed',
            turnId: 'turn-2',
            createdAt: '2026-09-20T23:01:00.000Z',
            finishReason: 'stop',
          },
        ],
      },
      metadata: METADATA,
    });
    expect(snapshot.reason).toBeUndefined();
  });

  test('a newer different failure masks the older budget code', () => {
    const snapshot = snapshotFor({
      target: TARGET,
      detail: {
        session: {
          ...observingSession('turn-2'),
          lifecycleState: 'failed',
          terminalAttribution: { kind: 'runtime_error' },
        },
        events: [
          turnStartedEvent('turn-1', museDeclaration('turn-1')),
          {
            method: 'runtime.error',
            turnId: 'turn-1',
            createdAt: '2026-09-20T22:30:01.000Z',
            code: 'muse-turn-idle-timeout',
            message: 'Muse turn was idle for 1800000ms and was terminated.',
            retriable: false,
          },
          turnStartedEvent('turn-2', museDeclaration('turn-2')),
          {
            method: 'runtime.error',
            turnId: 'turn-2',
            createdAt: '2026-09-20T23:30:01.000Z',
            code: 'muse-exit-without-terminal',
            message: 'Muse exited before reporting a terminal result.',
            retriable: false,
          },
        ],
      },
      metadata: METADATA,
    });
    expect(snapshot.reason).toEqual({ code: 'runtime_error' });
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
