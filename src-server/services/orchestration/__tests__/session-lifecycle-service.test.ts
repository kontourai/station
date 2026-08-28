import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { describe, expect, test } from 'vitest';
import {
  activeTurnIdForEvents,
  createManualSessionTransitionEvent,
  interruptibleTurnIdForEvents,
  isDeferredRetriableTurnError,
  normalizeCanonicalRuntimeEventLifecycle,
  projectSessionLifecycle,
} from '../session-lifecycle-service.js';

describe('session-lifecycle-service', () => {
  test('normalizes approval requests into review_pending lifecycle metadata', () => {
    const event = normalizeCanonicalRuntimeEventLifecycle(
      {
        eventId: 'evt-1',
        provider: 'codex',
        threadId: 'thread-1',
        createdAt: '2026-05-03T10:00:00.000Z',
        method: 'request.opened',
        requestId: 'req-1',
        requestType: 'approval',
        title: 'Approve tool',
      },
      'running',
    );

    expect(event).toEqual(
      expect.objectContaining({
        sessionState: 'review_pending',
        previousState: 'running',
        transitionReason: 'review_requested',
        transitionSource: 'runtime',
      }),
    );
  });

  test('does not let an untargeted resume completion stomp a starting turn (#2383)', () => {
    const startingTurn = {
      eventId: 'evt-start',
      provider: 'claude' as const,
      threadId: 'thread-handshake',
      createdAt: '2026-08-10T00:00:00.000Z',
      method: 'turn.started' as const,
      turnId: 'turn-real',
    };
    const handshakeCompletion = {
      eventId: 'evt-resume-result',
      provider: 'claude' as const,
      threadId: 'thread-handshake',
      createdAt: '2026-08-10T00:00:01.000Z',
      method: 'turn.completed' as const,
    } as CanonicalRuntimeEvent;

    expect(
      normalizeCanonicalRuntimeEventLifecycle(
        handshakeCompletion,
        'running',
        'turn-real',
      ),
    ).toBe(handshakeCompletion);
    expect(
      projectSessionLifecycle({
        session: {
          provider: 'claude',
          threadId: 'thread-handshake',
          status: 'running',
          createdAt: '2026-08-10T00:00:00.000Z',
          updatedAt: '2026-08-10T00:00:01.000Z',
        },
        events: [startingTurn, handshakeCompletion],
      }),
    ).toMatchObject({ lifecycleState: 'running' });
  });

  test('projects pending review and project metadata from events', () => {
    const projection = projectSessionLifecycle({
      session: {
        provider: 'claude',
        threadId: 'thread-2',
        status: 'running',
        createdAt: '2026-05-03T10:00:00.000Z',
        updatedAt: '2026-05-03T10:00:01.000Z',
      },
      events: [
        {
          eventId: 'evt-2',
          provider: 'claude',
          threadId: 'thread-2',
          createdAt: '2026-05-03T10:00:00.000Z',
          method: 'session.configured',
          sessionId: 'thread-2',
          metadata: { projectSlug: 'alpha', agentSlug: 'reviewer' },
        },
        {
          eventId: 'evt-3',
          provider: 'claude',
          threadId: 'thread-2',
          createdAt: '2026-05-03T10:00:02.000Z',
          method: 'request.opened',
          requestId: 'req-2',
          requestType: 'confirmation',
          title: 'Review output',
        },
      ],
    });

    expect(projection).toEqual(
      expect.objectContaining({
        lifecycleState: 'review_pending',
        pendingReview: true,
        projectSlug: 'alpha',
        assignedAgentSlug: 'reviewer',
      }),
    );
  });

  test('creates validated manual transition events for board actions', () => {
    const event = createManualSessionTransitionEvent({
      provider: 'codex',
      threadId: 'thread-3',
      from: 'blocked',
      to: 'running',
      reason: 'request_resolved',
      source: 'user_action',
    });

    expect(event).toEqual(
      expect.objectContaining({
        method: 'session.state-changed',
        sessionState: 'running',
        previousState: 'blocked',
        transitionReason: 'request_resolved',
        transitionSource: 'user_action',
      }),
    );
  });

  // archive#1073: session.configured is published whenever a runtime attaches —
  // including for every persisted session resumed at a service restart — so
  // it must not fabricate a 'running' lifecycle state.
  test('an attach-only session (started + configured, no turn) does not project running (#1073)', () => {
    const projection = projectSessionLifecycle({
      session: {
        provider: 'claude',
        threadId: 'thread-attach',
        status: 'ready',
        createdAt: '2026-07-28T10:00:00.000Z',
        updatedAt: '2026-07-28T10:00:01.000Z',
      },
      events: [
        {
          eventId: 'evt-a1',
          provider: 'claude',
          threadId: 'thread-attach',
          createdAt: '2026-07-28T10:00:00.000Z',
          method: 'session.started',
          sessionId: 'thread-attach',
        },
        {
          eventId: 'evt-a2',
          provider: 'claude',
          threadId: 'thread-attach',
          createdAt: '2026-07-28T10:00:01.000Z',
          method: 'session.configured',
          sessionId: 'thread-attach',
          model: 'sonnet',
        },
      ],
    });

    expect(projection.lifecycleState).toBe('queued');
  });

  test('a turn still drives running, and completion sticks across a re-attach with legacy-stamped events (#1073)', () => {
    const base = {
      provider: 'claude' as const,
      threadId: 'thread-reattach',
      sessionId: 'thread-reattach',
    };
    const projection = projectSessionLifecycle({
      session: {
        provider: 'claude',
        threadId: 'thread-reattach',
        status: 'ready',
        createdAt: '2026-07-28T10:00:00.000Z',
        updatedAt: '2026-07-28T11:00:00.000Z',
      },
      events: [
        {
          ...base,
          eventId: 'evt-r1',
          createdAt: '2026-07-28T10:00:00.000Z',
          method: 'session.started',
        },
        {
          ...base,
          eventId: 'evt-r2',
          createdAt: '2026-07-28T10:00:01.000Z',
          method: 'session.configured',
        },
        {
          ...base,
          eventId: 'evt-r3',
          createdAt: '2026-07-28T10:00:02.000Z',
          method: 'turn.started',
          turnId: 'turn-1',
          prompt: 'do the thing',
        },
        {
          ...base,
          eventId: 'evt-r4',
          createdAt: '2026-07-28T10:00:10.000Z',
          method: 'turn.completed',
          turnId: 'turn-1',
          finishReason: 'stop',
        },
        // Service restart: the runtime re-attaches. These two events carry
        // the exact stamps the pre-#1073 normalize fabricated onto persisted
        // rows — the projection must distrust them, or history keeps lying.
        {
          ...base,
          eventId: 'evt-r5',
          createdAt: '2026-07-28T11:00:00.000Z',
          method: 'session.started',
          // The REAL adapter shape: every adapter sends initialState
          // 'created' on every startSession, reattach included.
          initialState: 'created',
          sessionState: 'queued',
          previousState: 'completed',
          transitionReason: 'session_started',
          transitionSource: 'runtime',
        },
        {
          ...base,
          eventId: 'evt-r6',
          createdAt: '2026-07-28T11:00:01.000Z',
          method: 'session.configured',
          sessionState: 'running',
          previousState: 'queued',
          transitionReason: 'session_configured',
          transitionSource: 'runtime',
        },
      ],
    });

    expect(projection.lifecycleState).toBe('completed');
  });

  test('normalize leaves bare attach events transition-neutral but honors explicit initial state (#1073)', () => {
    const configured = normalizeCanonicalRuntimeEventLifecycle(
      {
        eventId: 'evt-n1',
        provider: 'claude',
        threadId: 'thread-n',
        createdAt: '2026-07-28T10:00:00.000Z',
        method: 'session.configured',
        sessionId: 'thread-n',
      },
      'completed',
    );
    expect(configured.sessionState).toBeUndefined();
    expect(configured.transitionReason).toBeUndefined();

    // initialState 'created' is the shape EVERY adapter emits on every
    // startSession (reattach included) — it must stay unstamped too
    // (archive#1073 review round 1).
    const started = normalizeCanonicalRuntimeEventLifecycle(
      {
        eventId: 'evt-n2',
        provider: 'claude',
        threadId: 'thread-n',
        createdAt: '2026-07-28T10:00:00.000Z',
        method: 'session.started',
        sessionId: 'thread-n',
        initialState: 'created',
      },
      undefined,
    );
    expect(started.sessionState).toBeUndefined();
    expect(started.transitionReason).toBeUndefined();

    const startedExplicit = normalizeCanonicalRuntimeEventLifecycle(
      {
        eventId: 'evt-n3',
        provider: 'claude',
        threadId: 'thread-n',
        createdAt: '2026-07-28T10:00:00.000Z',
        method: 'session.started',
        sessionId: 'thread-n',
        initialState: 'running',
      },
      undefined,
    );
    expect(startedExplicit.sessionState).toBe('running');
    expect(startedExplicit.transitionReason).toBe('session_started');
  });

  test('a board/manual state-changed stamp is still trusted (#1073 guard scope)', () => {
    const projection = projectSessionLifecycle({
      session: {
        provider: 'codex',
        threadId: 'thread-manual',
        status: 'ready',
        createdAt: '2026-07-28T10:00:00.000Z',
        updatedAt: '2026-07-28T10:00:02.000Z',
      },
      events: [
        {
          eventId: 'evt-m1',
          provider: 'codex',
          threadId: 'thread-manual',
          createdAt: '2026-07-28T10:00:01.000Z',
          method: 'session.state-changed',
          sessionId: 'thread-manual',
          from: 'running',
          to: 'errored',
          sessionState: 'blocked',
          previousState: 'running',
          transitionReason: 'blocked_by_user',
          transitionSource: 'user_action',
          reason: 'paused for review',
        },
      ],
    });

    expect(projection.lifecycleState).toBe('blocked');
    expect(projection.blockedReason).toBe('paused for review');
  });

  function attachEvents(
    base: { provider: 'claude'; threadId: string; sessionId: string },
    at: string,
    suffix: string,
  ) {
    return [
      {
        ...base,
        eventId: `evt-${suffix}-started`,
        createdAt: at,
        method: 'session.started' as const,
        initialState: 'created' as const,
      },
      {
        ...base,
        eventId: `evt-${suffix}-configured`,
        createdAt: at,
        method: 'session.configured' as const,
      },
    ];
  }

  test('unstamped completed and failed reattaches keep their terminal states (#1073 review HIGH)', () => {
    const base = {
      provider: 'claude' as const,
      threadId: 'thread-matrix',
      sessionId: 'thread-matrix',
    };
    const session = {
      provider: 'claude' as const,
      threadId: 'thread-matrix',
      status: 'ready' as const,
      createdAt: '2026-07-28T10:00:00.000Z',
      updatedAt: '2026-07-28T11:00:00.000Z',
    };
    const turn = (finish: 'turn.completed' | 'runtime.error') => [
      {
        ...base,
        eventId: 'evt-x-turn',
        createdAt: '2026-07-28T10:00:02.000Z',
        method: 'turn.started' as const,
        turnId: 'turn-1',
        prompt: 'go',
      },
      finish === 'turn.completed'
        ? {
            ...base,
            eventId: 'evt-x-done',
            createdAt: '2026-07-28T10:00:10.000Z',
            method: 'turn.completed' as const,
            turnId: 'turn-1',
            finishReason: 'stop' as const,
          }
        : {
            ...base,
            eventId: 'evt-x-err',
            createdAt: '2026-07-28T10:00:10.000Z',
            method: 'runtime.error' as const,
            severity: 'error' as const,
            message: 'boom',
          },
    ];

    const completed = projectSessionLifecycle({
      session,
      events: [
        ...attachEvents(base, '2026-07-28T10:00:00.000Z', 'a'),
        ...turn('turn.completed'),
        ...attachEvents(base, '2026-07-28T11:00:00.000Z', 'b'),
      ],
    });
    expect(completed.lifecycleState).toBe('completed');

    const failed = projectSessionLifecycle({
      session,
      events: [
        ...attachEvents(base, '2026-07-28T10:00:00.000Z', 'a'),
        ...turn('runtime.error'),
        ...attachEvents(base, '2026-07-28T11:00:00.000Z', 'b'),
      ],
    });
    expect(failed.lifecycleState).toBe('failed');
  });

  test('a mid-turn reattach stays running (#1073 review HIGH)', () => {
    const base = {
      provider: 'claude' as const,
      threadId: 'thread-midturn',
      sessionId: 'thread-midturn',
    };
    const projection = projectSessionLifecycle({
      session: {
        provider: 'claude',
        threadId: 'thread-midturn',
        status: 'running',
        createdAt: '2026-07-28T10:00:00.000Z',
        updatedAt: '2026-07-28T11:00:00.000Z',
      },
      events: [
        ...attachEvents(base, '2026-07-28T10:00:00.000Z', 'a'),
        {
          ...base,
          eventId: 'evt-mt-turn',
          createdAt: '2026-07-28T10:00:02.000Z',
          method: 'turn.started',
          turnId: 'turn-1',
          prompt: 'long job',
        },
        ...attachEvents(base, '2026-07-28T11:00:00.000Z', 'b'),
      ],
    });
    expect(projection.lifecycleState).toBe('running');
  });

  test('a non-created initialState is still honored on session.started (#1073 guard scope)', () => {
    const projection = projectSessionLifecycle({
      session: {
        provider: 'claude',
        threadId: 'thread-explicit',
        status: 'ready',
        createdAt: '2026-07-28T10:00:00.000Z',
        updatedAt: '2026-07-28T10:00:01.000Z',
      },
      events: [
        {
          eventId: 'evt-e1',
          provider: 'claude',
          threadId: 'thread-explicit',
          createdAt: '2026-07-28T10:00:00.000Z',
          method: 'session.started',
          sessionId: 'thread-explicit',
          initialState: 'running',
        },
      ],
    });
    expect(projection.lifecycleState).toBe('running');
  });

  // Boundary pin (archive#1073 review LOW): request.resolved maps to 'running'
  // unconditionally. In every real adapter sequence requests open inside a
  // turn, so this is correct there; a lone resolved request after an
  // attach-only session would fabricate running. Pinned so a future change
  // to this boundary is a deliberate decision, not drift.
  test('request.opened → request.resolved inside a turn returns to running', () => {
    const base = {
      provider: 'claude' as const,
      threadId: 'thread-req',
      sessionId: 'thread-req',
    };
    const projection = projectSessionLifecycle({
      session: {
        provider: 'claude',
        threadId: 'thread-req',
        status: 'running',
        createdAt: '2026-07-28T10:00:00.000Z',
        updatedAt: '2026-07-28T10:00:05.000Z',
      },
      events: [
        ...attachEvents(base, '2026-07-28T10:00:00.000Z', 'a'),
        {
          ...base,
          eventId: 'evt-q-turn',
          createdAt: '2026-07-28T10:00:01.000Z',
          method: 'turn.started',
          turnId: 'turn-1',
          prompt: 'go',
        },
        {
          ...base,
          eventId: 'evt-q-open',
          createdAt: '2026-07-28T10:00:02.000Z',
          method: 'request.opened',
          requestId: 'req-1',
          requestType: 'approval',
          title: 'Approve tool',
        },
        {
          ...base,
          eventId: 'evt-q-res',
          createdAt: '2026-07-28T10:00:03.000Z',
          method: 'request.resolved',
          requestId: 'req-1',
          status: 'approved',
        },
      ],
    });
    expect(projection.lifecycleState).toBe('running');
    expect(projection.pendingReview).toBe(false);
  });

  // archive#1296: pendingReview must not survive the session's own terminal
  // transition — a resolution that bypassed respondToRequest/stopSession
  // (server restart, lost in-memory pending entry, ...) previously left the
  // whole-log union `true` forever, which `orchestrationLifecycleLabel`
  // checked BEFORE the completed check, pinning "Needs attention" on a
  // cleanly finished session.
  describe('pendingReview reconciles against the session actually ending (#1296)', () => {
    const base = {
      provider: 'claude' as const,
      threadId: 'thread-pending',
      sessionId: 'thread-pending',
    };
    const session = {
      provider: 'claude',
      threadId: 'thread-pending',
      status: 'ready' as const,
      createdAt: '2026-07-29T10:00:00.000Z',
      updatedAt: '2026-07-29T10:00:10.000Z',
    };

    test('an unresolved approval on a session that then completes is not pendingReview', () => {
      const projection = projectSessionLifecycle({
        session,
        events: [
          {
            ...base,
            eventId: 'evt-p1',
            createdAt: '2026-07-29T10:00:01.000Z',
            method: 'turn.started',
            turnId: 'turn-1',
            prompt: 'go',
          },
          {
            ...base,
            eventId: 'evt-p2',
            createdAt: '2026-07-29T10:00:02.000Z',
            method: 'request.opened',
            requestId: 'req-p1',
            requestType: 'approval',
            title: 'Approve tool',
          },
          // The approval is never resolved through request.resolved — the
          // turn (and session) simply ends anyway, exactly the reported
          // "resolution that didn't flow through the normal path" shape.
          {
            ...base,
            eventId: 'evt-p3',
            createdAt: '2026-07-29T10:00:10.000Z',
            method: 'turn.completed',
            turnId: 'turn-1',
            finishReason: 'stop',
          },
        ],
      });

      expect(projection.lifecycleState).toBe('completed');
      expect(projection.pendingReview).toBe(false);
    });

    test('the same unresolved approval on a still-running session keeps flagging', () => {
      const projection = projectSessionLifecycle({
        session: { ...session, status: 'running' },
        events: [
          {
            ...base,
            eventId: 'evt-p4',
            createdAt: '2026-07-29T10:00:01.000Z',
            method: 'turn.started',
            turnId: 'turn-1',
            prompt: 'go',
          },
          {
            ...base,
            eventId: 'evt-p5',
            createdAt: '2026-07-29T10:00:02.000Z',
            method: 'request.opened',
            requestId: 'req-p2',
            requestType: 'approval',
            title: 'Approve tool',
          },
          // No turn.completed / session.exited / runtime.error — the session
          // is still live and waiting on this approval.
        ],
      });

      expect(projection.lifecycleState).toBe('review_pending');
      expect(projection.pendingReview).toBe(true);
    });

    test('an unresolved approval survives a runtime.error (failed is itself an attention state)', () => {
      const projection = projectSessionLifecycle({
        session,
        events: [
          {
            ...base,
            eventId: 'evt-p6',
            createdAt: '2026-07-29T10:00:01.000Z',
            method: 'turn.started',
            turnId: 'turn-1',
            prompt: 'go',
          },
          {
            ...base,
            eventId: 'evt-p7',
            createdAt: '2026-07-29T10:00:02.000Z',
            method: 'request.opened',
            requestId: 'req-p3',
            requestType: 'approval',
            title: 'Approve tool',
          },
          {
            ...base,
            eventId: 'evt-p8',
            createdAt: '2026-07-29T10:00:10.000Z',
            method: 'runtime.error',
            severity: 'error' as const,
            message: 'boom',
          },
        ],
      });

      // archive#1548 REVERSED THIS ASSERTION, deliberately. The original
      // read "the session ended (failed is terminal), so the stale
      // pendingReview flag is reconciled away — the UI still shows attention
      // via lifecycleState === 'failed' itself, not via this flag." Both
      // halves were wrong: `SESSION_LIFECYCLE_TRANSITIONS` declares
      // `failed -> queued | running`, so a failed session is retryable and
      // the approval is still genuinely outstanding; and nothing in
      // `attention-projection.ts` implemented the compensating path the
      // comment asserted, so the net effect was NO attention item at all.
      //
      // The failure itself is still what the state reports — `failed` is
      // `stopped`, so the review_pending relabel below never fires on it.
      expect(projection.lifecycleState).toBe('failed');
      expect(projection.pendingReview).toBe(true);
    });

    test('#1548: a canceled session still reconciles the stale flag away — cancel cannot resume', () => {
      const projection = projectSessionLifecycle({
        session,
        events: [
          {
            ...base,
            eventId: 'evt-p9',
            createdAt: '2026-07-29T10:00:01.000Z',
            method: 'turn.started',
            turnId: 'turn-1',
            prompt: 'go',
          },
          {
            ...base,
            eventId: 'evt-p10',
            createdAt: '2026-07-29T10:00:02.000Z',
            method: 'request.opened',
            requestId: 'req-p4',
            requestType: 'approval',
            title: 'Approve tool',
          },
          {
            ...base,
            eventId: 'evt-p11',
            createdAt: '2026-07-29T10:00:10.000Z',
            method: 'turn.aborted',
            turnId: 'turn-1',
            reason: 'user stopped it',
          },
        ],
      });

      // The archive#1296 protection, intact: `canceled -> queued` only, never
      // straight back to `running`, so the work cannot resume and nothing is
      // waiting on the approval. This is the assertion that fails if the fix
      // is over-rotated into "no state ever reconciles the flag away".
      expect(projection.lifecycleState).toBe('canceled');
      expect(projection.pendingReview).toBe(false);
    });

    test('#1548: a blocked session with an open approval keeps both the flag and the block', () => {
      const projection = projectSessionLifecycle({
        session,
        events: [
          {
            ...base,
            eventId: 'evt-p12',
            createdAt: '2026-07-29T10:00:02.000Z',
            method: 'request.opened',
            requestId: 'req-p5',
            requestType: 'approval',
            title: 'Approve tool',
          },
          {
            ...base,
            eventId: 'evt-p13',
            createdAt: '2026-07-29T10:00:10.000Z',
            method: 'session.state-changed',
            sessionId: 'thread-pending',
            from: 'running' as const,
            to: 'errored' as const,
            sessionState: 'blocked' as const,
            reason: 'waiting on the user',
          },
        ],
      });

      expect(projection.lifecycleState).toBe('blocked');
      expect(projection.pendingReview).toBe(true);
    });
  });

  test('an authored attach stamp with a differing state or source stays trusted (#1073 review round 2)', () => {
    const projection = projectSessionLifecycle({
      session: {
        provider: 'claude',
        threadId: 'thread-authored',
        status: 'ready',
        createdAt: '2026-07-28T10:00:00.000Z',
        updatedAt: '2026-07-28T10:00:01.000Z',
      },
      events: [
        {
          eventId: 'evt-auth-1',
          provider: 'claude',
          threadId: 'thread-authored',
          createdAt: '2026-07-28T10:00:01.000Z',
          method: 'session.configured',
          sessionId: 'thread-authored',
          // Same canonical reason as the legacy stamp, but a DIFFERENT
          // state — outside the fabricated tuple, so it is honored.
          sessionState: 'blocked',
          transitionReason: 'session_configured',
          transitionSource: 'runtime',
        },
      ],
    });
    expect(projection.lifecycleState).toBe('blocked');
  });
});

describe('session.configured does not imply work in flight (#1073)', () => {
  const event = (
    method: string,
    extra: Record<string, unknown> = {},
  ): CanonicalRuntimeEvent =>
    ({
      eventId: `${method}-${Math.random()}`,
      provider: 'codex',
      threadId: 'thread-1',
      createdAt: '2026-07-28T12:00:00Z',
      method,
      ...extra,
    }) as CanonicalRuntimeEvent;

  const session = {
    provider: 'codex',
    threadId: 'thread-1',
    status: 'ready',
    createdAt: '2026-07-28T12:00:00Z',
    updatedAt: '2026-07-28T12:00:00Z',
  } as never;

  test('a freshly attached session is queued, not running', () => {
    const projection = projectSessionLifecycle({
      session,
      events: [
        event('session.started', { initialState: 'created' }),
        event('session.configured'),
      ],
    });
    expect(projection.lifecycleState).toBe('queued');
  });

  test('a turn still moves it to running', () => {
    const projection = projectSessionLifecycle({
      session,
      events: [
        event('session.started', { initialState: 'created' }),
        event('session.configured'),
        event('turn.started'),
      ],
    });
    expect(projection.lifecycleState).toBe('running');
  });

  test('re-attaching after completion does not resurrect finished work', () => {
    // The live shape: a session that ran and completed, then got a fresh
    // session.configured when the service restarted and re-attached it.
    const projection = projectSessionLifecycle({
      session,
      events: [
        event('session.started', { initialState: 'created' }),
        event('session.configured'),
        event('turn.started', { turnId: 'turn-completed' }),
        event('turn.completed', { turnId: 'turn-completed' }),
        event('session.configured'),
      ],
    });
    expect(projection.lifecycleState).toBe('completed');
  });

  test('re-attaching after cancellation keeps it canceled', () => {
    const projection = projectSessionLifecycle({
      session,
      events: [
        event('session.started', { initialState: 'created' }),
        event('turn.started', { turnId: 'turn-aborted' }),
        event('turn.aborted', { turnId: 'turn-aborted' }),
        event('session.configured'),
      ],
    });
    expect(projection.lifecycleState).toBe('canceled');
  });
});

describe('an attached-but-idle runtime does not overwrite the outcome (#1121 review)', () => {
  const event = (
    method: string,
    extra: Record<string, unknown> = {},
  ): CanonicalRuntimeEvent =>
    ({
      eventId: `${method}-${Math.random()}`,
      provider: 'bedrock',
      threadId: 'thread-1',
      createdAt: '2026-07-28T12:00:00Z',
      method,
      ...extra,
    }) as CanonicalRuntimeEvent;

  const session = {
    provider: 'bedrock',
    threadId: 'thread-1',
    status: 'ready',
    createdAt: '2026-07-28T12:00:00Z',
    updatedAt: '2026-07-28T12:00:00Z',
  } as never;

  test('bedrock/ollama publishing state-changed -> idle after a turn keeps completed', () => {
    // The exact emission order in bedrock-adapter.ts and ollama-adapter.ts:
    // turn.completed, then session.state-changed from running to idle. Before
    // this fix that final event folded the session back to 'running' after
    // every single completed turn.
    const projection = projectSessionLifecycle({
      session,
      events: [
        event('session.started', { initialState: 'created' }),
        event('turn.started', { turnId: 'turn-idle' }),
        event('turn.completed', { turnId: 'turn-idle' }),
        event('session.state-changed', { from: 'running', to: 'idle' }),
      ],
    });
    expect(projection.lifecycleState).toBe('completed');
  });

  test('an idle report on a non-terminal session reads queued, not running', () => {
    const projection = projectSessionLifecycle({
      session,
      events: [
        event('session.started', { initialState: 'created' }),
        event('session.state-changed', { from: 'created', to: 'idle' }),
      ],
    });
    expect(projection.lifecycleState).toBe('queued');
  });

  test('a genuine running report still applies from a terminal state', () => {
    const projection = projectSessionLifecycle({
      session,
      events: [
        event('turn.started'),
        event('turn.completed'),
        event('session.state-changed', { from: 'idle', to: 'running' }),
      ],
    });
    expect(projection.lifecycleState).toBe('running');
  });

  test('a failure report still applies from a terminal state', () => {
    const projection = projectSessionLifecycle({
      session,
      events: [
        event('turn.started'),
        event('turn.completed'),
        event('session.state-changed', { from: 'idle', to: 'errored' }),
      ],
    });
    expect(projection.lifecycleState).toBe('failed');
  });
});

// archive#3442: a turn/session that fails must record `failed`, not
// `completed`. `session.exited` is the one other route (besides
// `runtime.error`) into a terminal lifecycle state, and only
// `codex-adapter-transport.ts`'s unexpected-exit path ever supplies a real
// `exitCode` — every adapter's own user-initiated stopSession/interruptTurn
// publishes `session.exited` with no `exitCode` at all.
describe('session.exited exit-code derivation (#3442)', () => {
  const base = {
    provider: 'codex' as const,
    threadId: 'thread-exit',
    sessionId: 'thread-exit',
  };
  const session = {
    provider: 'codex',
    threadId: 'thread-exit',
    status: 'running' as const,
    createdAt: '2026-08-18T10:00:00.000Z',
    updatedAt: '2026-08-18T10:00:00.000Z',
  };

  test('a defined non-zero exit code is a failure, not a cancellation', () => {
    const projection = projectSessionLifecycle({
      session,
      events: [
        {
          ...base,
          eventId: 'evt-exit-1',
          createdAt: '2026-08-18T10:00:01.000Z',
          method: 'turn.started',
          turnId: 'turn-1',
          prompt: 'go',
        },
        {
          ...base,
          eventId: 'evt-exit-2',
          createdAt: '2026-08-18T10:00:02.000Z',
          method: 'session.exited',
          exitCode: 1,
          reason: 'process-exit',
        },
      ],
    });
    expect(projection.lifecycleState).toBe('failed');
    // archive#3442 review finding: `mapEventToLifecycleTransition`'s
    // `session.exited` case sets `reason: 'runtime_error'` on this branch,
    // but nothing asserted it — it reaches
    // `OrchestrationSessionSummary.transitionReason` and the
    // `sessionTransitions` OTel counter's `reason` label.
    expect(projection.transitionReason).toBe('runtime_error');
  });

  test('exit code 0 still reads completed', () => {
    const projection = projectSessionLifecycle({
      session,
      events: [
        {
          ...base,
          eventId: 'evt-exit-3',
          createdAt: '2026-08-18T10:00:01.000Z',
          method: 'turn.started',
          turnId: 'turn-1',
          prompt: 'go',
        },
        {
          ...base,
          eventId: 'evt-exit-4',
          createdAt: '2026-08-18T10:00:02.000Z',
          method: 'session.exited',
          exitCode: 0,
          reason: 'completed',
        },
      ],
    });
    expect(projection.lifecycleState).toBe('completed');
  });

  // archive#3451 finding M1: exitCode 0 must FILL, not override, a failure
  // this same event stream already recorded. archive#3473 made this
  // reachable: finalizeUnexpectedExit now always synthesizes a runtime.error
  // before session.exited, and a process CAN die with an unresolved turn yet
  // still exit 0 (a graceful-shutdown handler, a kill racing a clean-exit
  // path) — the exit code is a fact about the OS process, not the turn.
  test('a preceding runtime.error survives a following exitCode:0 (M1)', () => {
    const projection = projectSessionLifecycle({
      session,
      events: [
        {
          ...base,
          eventId: 'evt-exit-m1-1',
          createdAt: '2026-08-18T10:00:01.000Z',
          method: 'turn.started',
          turnId: 'turn-1',
          prompt: 'go',
        },
        {
          ...base,
          eventId: 'evt-exit-m1-2',
          createdAt: '2026-08-18T10:00:02.000Z',
          method: 'runtime.error',
          severity: 'error',
          turnId: 'turn-1',
          message:
            'Codex app-server exited before the turn finished (code: 0).',
        },
        {
          ...base,
          eventId: 'evt-exit-m1-3',
          createdAt: '2026-08-18T10:00:03.000Z',
          method: 'session.exited',
          exitCode: 0,
          reason: 'completed',
        },
      ],
    });
    expect(projection.lifecycleState).toBe('failed');
  });

  // Negative control: every non-codex adapter's user-initiated stop path
  // (bedrock/ollama/claude/acp/muse/station-agent `stopSession`) publishes
  // `session.exited` with NO exitCode at all — this must keep reading
  // 'canceled', exactly as it did before this fix, or every one of those
  // adapters' user-stop flows would regress to 'failed'.
  test('an exit with no exitCode (a user-initiated stop) still reads canceled', () => {
    const projection = projectSessionLifecycle({
      session,
      events: [
        {
          ...base,
          eventId: 'evt-exit-5',
          createdAt: '2026-08-18T10:00:01.000Z',
          method: 'turn.started',
          turnId: 'turn-1',
          prompt: 'go',
        },
        {
          ...base,
          eventId: 'evt-exit-6',
          createdAt: '2026-08-18T10:00:02.000Z',
          method: 'session.exited',
          reason: 'stopped',
        },
      ],
    });
    expect(projection.lifecycleState).toBe('canceled');
  });

  // The moot-set proof: an open approval must survive a `session.exited`
  // failure exactly as it already survives a `runtime.error` one (archive#1548) —
  // `failed` is retryable (`SESSION_LIFECYCLE_TRANSITIONS.failed` includes
  // `running`), so the request is still genuinely outstanding, not moot.
  test('an unresolved approval survives a session.exited failure (moot-set proof)', () => {
    const projection = projectSessionLifecycle({
      session,
      events: [
        {
          ...base,
          eventId: 'evt-exit-7',
          createdAt: '2026-08-18T10:00:01.000Z',
          method: 'turn.started',
          turnId: 'turn-1',
          prompt: 'go',
        },
        {
          ...base,
          eventId: 'evt-exit-8',
          createdAt: '2026-08-18T10:00:02.000Z',
          method: 'request.opened',
          requestId: 'req-exit-1',
          requestType: 'approval',
          title: 'Approve tool',
        },
        {
          ...base,
          eventId: 'evt-exit-9',
          createdAt: '2026-08-18T10:00:03.000Z',
          method: 'session.exited',
          exitCode: 1,
          reason: 'process-exit',
        },
      ],
    });
    expect(projection.lifecycleState).toBe('failed');
    expect(projection.pendingReview).toBe(true);
  });
});

// archive#3451 finding 2: a session.exited crash (defined, nonzero exitCode)
// is the one 'failed' path with no `runtime.error` to read a cause from.
describe('session.exited crash blockedReason (station#3451 finding 2)', () => {
  const base = {
    provider: 'codex' as const,
    threadId: 'thread-exit-cause',
    sessionId: 'thread-exit-cause',
  };
  const session = {
    provider: 'codex',
    threadId: 'thread-exit-cause',
    status: 'running' as const,
    createdAt: '2026-08-18T10:00:00.000Z',
    updatedAt: '2026-08-18T10:00:00.000Z',
  };

  test('fills blockedReason from the observed exit code when no runtime.error exists', () => {
    const projection = projectSessionLifecycle({
      session,
      events: [
        {
          ...base,
          eventId: 'evt-1',
          createdAt: '2026-08-18T10:00:01.000Z',
          method: 'turn.started',
          turnId: 'turn-1',
          prompt: 'go',
        },
        {
          ...base,
          eventId: 'evt-2',
          createdAt: '2026-08-18T10:00:02.000Z',
          method: 'session.exited',
          exitCode: 1,
          reason: 'process-exit',
        },
      ],
    });
    expect(projection.lifecycleState).toBe('failed');
    expect(projection.blockedReason).toBe(
      'Session process exited with code 1.',
    );
  });

  test('never overrides a real runtime.error cause', () => {
    const projection = projectSessionLifecycle({
      session,
      events: [
        {
          ...base,
          eventId: 'evt-3',
          createdAt: '2026-08-18T10:00:01.000Z',
          method: 'turn.started',
          turnId: 'turn-1',
          prompt: 'go',
        },
        {
          ...base,
          eventId: 'evt-4',
          createdAt: '2026-08-18T10:00:02.000Z',
          method: 'runtime.error',
          severity: 'error',
          turnId: 'turn-1',
          message:
            'Codex app-server exited before the turn finished (code: 1).',
        },
        {
          ...base,
          eventId: 'evt-5',
          createdAt: '2026-08-18T10:00:03.000Z',
          method: 'session.exited',
          exitCode: 1,
          reason: 'process-exit',
        },
      ],
    });
    expect(projection.lifecycleState).toBe('failed');
    expect(projection.blockedReason).toBe(
      'Codex app-server exited before the turn finished (code: 1).',
    );
  });

  test('leaves blockedReason unset for a clean or intentional exit', () => {
    const projection = projectSessionLifecycle({
      session,
      events: [
        {
          ...base,
          eventId: 'evt-6',
          createdAt: '2026-08-18T10:00:01.000Z',
          method: 'turn.started',
          turnId: 'turn-1',
          prompt: 'go',
        },
        {
          ...base,
          eventId: 'evt-7',
          createdAt: '2026-08-18T10:00:02.000Z',
          method: 'session.exited',
          exitCode: 0,
          reason: 'completed',
        },
      ],
    });
    expect(projection.lifecycleState).toBe('completed');
    expect(projection.blockedReason).toBeUndefined();
  });
});

// archive#3473 paths 3/4: `interruptibleTurnIdForEvents` must keep a codex
// deferred-retriable `runtime.error` interruptible, WITHOUT disturbing
// `activeTurnIdForEvents`'s existing, deliberately-tested under-report
// (see orchestration-session-state.test.ts's
// "is false after a codex-adapter-shaped turn error" — that tradeoff is
// pinned and must not move).
describe('interruptibleTurnIdForEvents / isDeferredRetriableTurnError (station#3473 paths 3/4)', () => {
  const codexRetriableError: CanonicalRuntimeEvent = {
    eventId: 'evt-retriable',
    provider: 'codex',
    threadId: 'thread-retry',
    createdAt: '2026-08-18T10:00:02.000Z',
    method: 'runtime.error',
    severity: 'error',
    turnId: 'turn-1',
    message: 'Codex runtime error',
    retriable: true,
  };
  const turnStarted: CanonicalRuntimeEvent = {
    eventId: 'evt-started',
    provider: 'codex',
    threadId: 'thread-retry',
    createdAt: '2026-08-18T10:00:01.000Z',
    method: 'turn.started',
    turnId: 'turn-1',
    prompt: 'go',
  };

  test('isDeferredRetriableTurnError is true only for codex + retriable === true', () => {
    expect(isDeferredRetriableTurnError(codexRetriableError)).toBe(true);
    expect(
      isDeferredRetriableTurnError({
        ...codexRetriableError,
        retriable: false,
      }),
    ).toBe(false);
    expect(
      isDeferredRetriableTurnError({
        ...codexRetriableError,
        provider: 'bedrock',
      }),
    ).toBe(false);
    expect(
      isDeferredRetriableTurnError({
        ...codexRetriableError,
        method: 'session.exited',
      } as any),
    ).toBe(false);
  });

  test('a codex deferred-retriable runtime.error keeps the turn interruptible, but activeTurnIdForEvents still under-reports (the pinned tradeoff)', () => {
    const events = [turnStarted, codexRetriableError];
    expect(interruptibleTurnIdForEvents(events)).toBe('turn-1');
    expect(activeTurnIdForEvents(events)).toBeUndefined();
  });

  test('a non-retriable codex runtime.error closes the turn on BOTH folds', () => {
    const events = [turnStarted, { ...codexRetriableError, retriable: false }];
    expect(interruptibleTurnIdForEvents(events)).toBeUndefined();
    expect(activeTurnIdForEvents(events)).toBeUndefined();
  });

  test('a station-agent runtime.error with retriable:true for an ALREADY-terminal turn closes the turn on BOTH folds (not codex-scoped)', () => {
    const events = [
      turnStarted,
      {
        ...codexRetriableError,
        provider: 'station-agent',
        code: 'station_agent_turn_failed',
      },
    ];
    expect(interruptibleTurnIdForEvents(events)).toBeUndefined();
    expect(activeTurnIdForEvents(events)).toBeUndefined();
  });

  test('a genuine later turn.completed for the SAME turn still closes it', () => {
    const events: CanonicalRuntimeEvent[] = [
      turnStarted,
      codexRetriableError,
      {
        eventId: 'evt-completed',
        provider: 'codex',
        threadId: 'thread-retry',
        createdAt: '2026-08-18T10:00:05.000Z',
        method: 'turn.completed',
        turnId: 'turn-1',
        finishReason: 'stop',
      },
    ];
    expect(interruptibleTurnIdForEvents(events)).toBeUndefined();
  });

  // archive#3451 finding B1 (blocking, review-found): `interruptibleTurnIdForEvents`
  // folds over `eventStore.listSessionProjectionEvents(threadId)`, a BOUNDED
  // fact set — not the full event log. At the time of this fix,
  // `firstTurnStartedWithPrompt` always returned the FIRST turn ever
  // announced, and `latestEventByMethods` kept exactly one lifecycle-method
  // slot, so a SECOND turn hitting a willRetry error left `turn.started(turn-2)`
  // holding NO slot at all (superseded in the single lifecycle slot by the
  // runtime.error that immediately follows it) — the fact set genuinely
  // observed was `{ turn.started(turn-1), runtime.error(turn-2, retriable) }`.
  // Before the identity-check fix, the preserve arm returned 'turn-1' — a
  // long-completed turn — instead of failing safe like `activeTurnIdForEvents`
  // does. Both UI Stop call sites omit an explicit turnId, so that stale value
  // would have been used, and codex's `interruptTurn` (pre-B1's OTHER fix)
  // cleared `activeTurnId` unconditionally — wiping turn-2's real tracking.
  //
  // archive#3524 gave `listSessionProjectionEvents` a dedicated current-turn
  // slot, so the real store no longer produces this EXACT bounded set (see
  // event-store.test.ts's "retains the CURRENT (second) turn's own
  // turn.started" — turn-2's start now DOES survive this shape). This test
  // still stands as a defense-in-depth unit test of the identity check
  // itself, on a hand-built input, and the guard is not merely
  // hypothetically still needed: two OTHER real-store shapes still produce a
  // mismatched-identity fact set today and are covered end-to-end in
  // event-store.test.ts ("the fail-closed identity guard still discriminates"
  // — a deferred-retriable error naming a turn that was never announced, and
  // one naming a stale EARLIER turn while a later one is current). Both still
  // rely on this exact `event.turnId === activeTurnId` check.
  test('B1: a bounded fact set missing turn-2s own turn.started must not target the stale turn-1 (fails safe to undefined, matching activeTurnIdForEvents)', () => {
    const turnOneStarted: CanonicalRuntimeEvent = {
      eventId: 'evt-turn1-started',
      provider: 'codex',
      threadId: 'thread-retry',
      createdAt: '2026-08-18T09:00:00.000Z',
      method: 'turn.started',
      turnId: 'turn-1',
      prompt: 'first turn',
    };
    // turn.started(turn-2) is DELIBERATELY absent — the bounded fact set
    // never retains it once a higher-sequence lifecycle event (the
    // runtime.error below) takes the single LIFECYCLE_METHODS slot.
    const turnTwoRetriableError: CanonicalRuntimeEvent = {
      eventId: 'evt-turn2-error',
      provider: 'codex',
      threadId: 'thread-retry',
      createdAt: '2026-08-18T09:05:00.000Z',
      method: 'runtime.error',
      severity: 'error',
      turnId: 'turn-2',
      message: 'Codex runtime error',
      retriable: true,
    };
    const boundedFactSet = [turnOneStarted, turnTwoRetriableError];

    expect(interruptibleTurnIdForEvents(boundedFactSet)).toBeUndefined();
    // The pinned baseline: activeTurnIdForEvents already fails safe here —
    // interruptibleTurnIdForEvents must not disagree with it in the
    // dangerous direction (naming a turn at all, let alone the wrong one).
    expect(activeTurnIdForEvents(boundedFactSet)).toBeUndefined();
  });

  // archive#3451 fix round D1: the SAME B1 scenario reproduces through the
  // OTHER arm — the `!event.turnId` escape the round-1 fix kept. The
  // adapter-stream-restart error (orchestration-service.ts: any provider,
  // retriable: true, deliberately no turnId) IS a LIFECYCLE_METHODS event
  // and can evict turn-2's turn.started from the bounded fact set exactly
  // like the turnId-bearing case: fact set = { turn.started(turn-1),
  // runtime.error(retriable, no turnId) }. Before D1, the escape preserved
  // 'turn-1' regardless of what the caller wanted to target.
  test('D1: a turnId-less deferred-retriable event (adapter-stream-restart shape) must not target the stale turn-1 either', () => {
    const turnOneStarted: CanonicalRuntimeEvent = {
      eventId: 'evt-d1-turn1-started',
      provider: 'codex',
      threadId: 'thread-retry-d1',
      createdAt: '2026-08-18T09:00:00.000Z',
      method: 'turn.started',
      turnId: 'turn-1',
      prompt: 'first turn',
    };
    // No turnId at all — mirrors orchestration-service.ts's
    // adapter-stream-restart runtime.error exactly.
    const sessionScopedRetriableError: CanonicalRuntimeEvent = {
      eventId: 'evt-d1-stream-restart',
      provider: 'codex',
      threadId: 'thread-retry-d1',
      createdAt: '2026-08-18T09:05:00.000Z',
      method: 'runtime.error',
      severity: 'error',
      message: 'Agent connection error: stream restarted',
      retriable: true,
    };
    const boundedFactSet = [turnOneStarted, sessionScopedRetriableError];

    expect(interruptibleTurnIdForEvents(boundedFactSet)).toBeUndefined();
    expect(activeTurnIdForEvents(boundedFactSet)).toBeUndefined();
  });
});

describe('station#3581 review BLOCK 1: the stamp early-return distrusts a stale terminal', () => {
  // Isolates the READ-SIDE half of BLOCK 1 from the write-side half. The
  // orchestration-service.test.ts end-to-end BLOCK 1 test drives BOTH
  // halves together — with the write-path fix in place, the fixed write
  // path never mints a bad stamp for a live stale terminal in the first
  // place (`deriveLifecycleTransition` sees `event.sessionState ===
  // undefined` and skips the stamp early-return entirely), so that test
  // alone cannot prove the read-side `isStaleTurnTerminal` distrust is
  // doing anything. This test constructs the event exactly as an
  // ALREADY-PERSISTED row from BEFORE this fix (or a hypothetical future
  // write path) would look on disk — `sessionState: 'completed'` already
  // stamped — which is precisely the shape a write-path-only fix can never
  // heal, per the review's own point: "the write path has been minting
  // this stamp since before your branch, so real machines already carry
  // it."
  test('a persisted turn.completed row already stamped sessionState:"completed" is still rejected when the identity anchor names a different, later turn', () => {
    const base = {
      provider: 'codex' as const,
      threadId: 'thread-3581-block1-stamped',
      sessionId: 'thread-3581-block1-stamped',
    };
    const session = {
      provider: 'codex' as const,
      threadId: 'thread-3581-block1-stamped',
      status: 'error' as const,
      createdAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-19T00:00:03.000Z',
    };
    const events: CanonicalRuntimeEvent[] = [
      {
        ...base,
        eventId: 'evt-1',
        createdAt: '2026-08-19T00:00:01.000Z',
        method: 'turn.started',
        turnId: 'turn-1',
        prompt: 'first turn',
      },
      {
        ...base,
        eventId: 'evt-2',
        createdAt: '2026-08-19T00:00:02.000Z',
        method: 'turn.started',
        turnId: 'turn-2',
        prompt: 'second turn',
      },
      {
        ...base,
        eventId: 'evt-3',
        createdAt: '2026-08-19T00:00:03.000Z',
        method: 'runtime.error',
        severity: 'error',
        message: 'usage limit reached',
        retriable: false,
        turnId: 'turn-2',
      },
      // The stale terminal for turn-1, ALREADY carrying the stamp the OLD
      // (pre-#3581) write path would have written for it — exactly the
      // byte shape a real machine's already-persisted row has.
      {
        ...base,
        eventId: 'evt-4',
        createdAt: '2026-08-19T00:00:04.000Z',
        method: 'turn.completed',
        turnId: 'turn-1',
        finishReason: 'other',
        sessionState: 'completed',
        previousState: 'failed',
        transitionReason: 'turn_completed',
        transitionSource: 'runtime',
      } as CanonicalRuntimeEvent,
    ];

    const projection = projectSessionLifecycle({ session, events });
    expect(projection.lifecycleState).toBe('failed');
    expect(projection.blockedReason).toBe('usage limit reached');
  });
});

describe('station#3581 review BLOCK 1: the write path stops minting the bad stamp', () => {
  // The narrower, faster complement to the orchestration-service.test.ts
  // end-to-end test: calls `normalizeCanonicalRuntimeEventLifecycle`
  // directly (the exact function `consumeAdapterEvents` calls) with the
  // identity anchor a FIXED write path computes
  // (`turnIdentityAnchorForEvents`, folded by the caller in production —
  // simulated here as the literal value it would produce: 'turn-2', the
  // superseding turn's id, retained across its own `runtime.error`).
  test('normalizeCanonicalRuntimeEventLifecycle does not stamp sessionState onto a turn.completed the identity anchor rejects', () => {
    const staleEvent: CanonicalRuntimeEvent = {
      provider: 'codex',
      threadId: 'thread-3581-block1-write',
      eventId: 'evt-stale',
      createdAt: '2026-08-19T00:00:04.000Z',
      method: 'turn.completed',
      turnId: 'turn-1',
      finishReason: 'other',
    };

    const normalized = normalizeCanonicalRuntimeEventLifecycle(
      staleEvent,
      'failed',
      'turn-2', // the identity anchor a fixed write path would compute
    );

    expect(normalized.sessionState).toBeUndefined();
    expect(normalized.transitionReason).toBeUndefined();
  });

  test('normalizeCanonicalRuntimeEventLifecycle DOES stamp completed for the anchor turn own genuine completion', () => {
    const genuineEvent: CanonicalRuntimeEvent = {
      provider: 'codex',
      threadId: 'thread-3581-block1-write-genuine',
      eventId: 'evt-genuine',
      createdAt: '2026-08-19T00:00:04.000Z',
      method: 'turn.completed',
      turnId: 'turn-2',
      finishReason: 'stop',
    };

    const normalized = normalizeCanonicalRuntimeEventLifecycle(
      genuineEvent,
      'running',
      'turn-2',
    );

    expect(normalized.sessionState).toBe('completed');
  });
});

// UX audit AW-R8 (reports/2-agent-workflows/REPORT.md): a session's
// OUTCOME is derived from its recorded terminal TURN events. Station keeps
// pooled engine processes resident long after a turn ends, so the
// `session.exited` describing that process's eventual death routinely arrives
// minutes after the work finished — and used to rewrite two answered,
// `✓ Done` sessions to `✗ Failed` while their transcripts still held the
// completed answers.
describe('a recorded turn outcome survives the engine process (AW-R8)', () => {
  const base = {
    provider: 'claude' as const,
    threadId: 'thread-outcome',
    sessionId: 'thread-outcome',
  };
  const session = {
    provider: 'claude',
    threadId: 'thread-outcome',
    status: 'running' as const,
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
  };
  const turnStarted: CanonicalRuntimeEvent = {
    ...base,
    eventId: 'evt-outcome-1',
    createdAt: '2026-08-20T10:00:01.000Z',
    method: 'turn.started',
    turnId: 'turn-1',
    prompt: 'go',
  };
  const turnCompleted: CanonicalRuntimeEvent = {
    ...base,
    eventId: 'evt-outcome-2',
    createdAt: '2026-08-20T10:00:02.000Z',
    method: 'turn.completed',
    turnId: 'turn-1',
    finishReason: 'stop',
  };

  test('a completed turn stays completed when the pooled process later dies (exitCode 1)', () => {
    const projection = projectSessionLifecycle({
      session,
      events: [
        turnStarted,
        turnCompleted,
        {
          ...base,
          eventId: 'evt-outcome-3',
          createdAt: '2026-08-20T10:24:00.000Z',
          method: 'session.exited',
          exitCode: 1,
          reason: 'process-exit',
        },
      ],
    });
    expect(projection.lifecycleState).toBe('completed');
  });

  test('a completed turn stays completed when the process is stopped with no exitCode', () => {
    const projection = projectSessionLifecycle({
      session,
      events: [
        turnStarted,
        turnCompleted,
        {
          ...base,
          eventId: 'evt-outcome-4',
          createdAt: '2026-08-20T10:24:00.000Z',
          method: 'session.exited',
          reason: 'stopped',
        },
      ],
    });
    expect(projection.lifecycleState).toBe('completed');
  });

  test('a persisted engine status of dead does not outrank a recorded completed turn', () => {
    const projection = projectSessionLifecycle({
      session: { ...session, status: 'dead' },
      events: [turnStarted, turnCompleted],
    });
    expect(projection.lifecycleState).toBe('completed');
  });

  // The discriminating negative: a turn that was still IN PROGRESS when the
  // process died has no recorded outcome, so the exit IS the outcome
  // (archive#3451 finding 1, unchanged by the guard above).
  test('a turn still in progress when the process exits abnormally is failed', () => {
    const projection = projectSessionLifecycle({
      session,
      events: [
        turnStarted,
        {
          ...base,
          eventId: 'evt-outcome-5',
          createdAt: '2026-08-20T10:00:03.000Z',
          method: 'session.exited',
          exitCode: 1,
          reason: 'process-exit',
        },
      ],
    });
    expect(projection.lifecycleState).toBe('failed');
    expect(projection.transitionReason).toBe('runtime_error');
  });

  test('a turn still in progress that hits runtime.error is failed', () => {
    const projection = projectSessionLifecycle({
      session,
      events: [
        turnStarted,
        {
          ...base,
          eventId: 'evt-outcome-6',
          createdAt: '2026-08-20T10:00:03.000Z',
          method: 'runtime.error',
          severity: 'error',
          turnId: 'turn-1',
          message: 'Engine exited before the turn finished (code: 1).',
        },
      ],
    });
    expect(projection.lifecycleState).toBe('failed');
  });

  // The route the audit actually reproduced live: killing a pooled Claude Code
  // engine after its turn finished publishes a session-scoped `runtime.error`
  // with NO turn id, not a `session.exited`.
  test('a completed turn stays completed when the pooled engine is killed afterwards', () => {
    const projection = projectSessionLifecycle({
      session: { ...session, status: 'error' },
      events: [
        turnStarted,
        turnCompleted,
        {
          ...base,
          eventId: 'evt-outcome-kill',
          createdAt: '2026-08-20T10:24:00.000Z',
          method: 'runtime.error',
          severity: 'error',
          message:
            'Claude model "claude-opus-5[1m]" failed: Claude Code process terminated by signal SIGKILL',
        },
      ],
    });
    expect(projection.lifecycleState).toBe('completed');
  });

  // The two neighbours that must NOT be caught by that guard.
  test("a turn's own late failure, naming that turn, still fails the session", () => {
    const projection = projectSessionLifecycle({
      session,
      events: [
        turnStarted,
        { ...turnCompleted, finishReason: 'other' },
        {
          ...base,
          eventId: 'evt-outcome-own-error',
          createdAt: '2026-08-20T10:00:03.000Z',
          method: 'runtime.error',
          severity: 'error',
          turnId: 'turn-1',
          message: 'usage limit reached',
        },
      ],
    });
    expect(projection.lifecycleState).toBe('failed');
    expect(projection.blockedReason).toBe('usage limit reached');
  });

  test('a ghost turn that never started still fails the session', () => {
    const projection = projectSessionLifecycle({
      session,
      events: [
        turnStarted,
        turnCompleted,
        {
          ...base,
          eventId: 'evt-outcome-ghost',
          createdAt: '2026-08-20T10:00:10.000Z',
          method: 'runtime.error',
          severity: 'error',
          turnId: 'turn-2',
          message: 'engine session binding is dead',
        },
      ],
    });
    expect(projection.lifecycleState).toBe('failed');
  });

  // UX audit V3: a mid-turn kill left a transcript stopping mid-word under a
  // red chip, with "No failure detail was recorded" where the reason belongs.
  test('names the engine binding when nothing else recorded a cause', () => {
    const projection = projectSessionLifecycle({
      session: { ...session, status: 'dead' },
      events: [],
    });
    expect(projection.lifecycleState).toBe('failed');
    expect(projection.blockedReason).toContain('engine process is gone');
  });

  test('a recorded cause still wins over the binding status', () => {
    const projection = projectSessionLifecycle({
      session: { ...session, status: 'dead' },
      events: [
        turnStarted,
        {
          ...base,
          eventId: 'evt-outcome-8',
          createdAt: '2026-08-20T10:00:03.000Z',
          method: 'runtime.error',
          severity: 'error',
          turnId: 'turn-1',
          message: 'Engine exited before the turn finished (code: 1).',
        },
      ],
    });
    expect(projection.blockedReason).toBe(
      'Engine exited before the turn finished (code: 1).',
    );
  });

  // The write-side mirror: `consumeAdapterEvents` stamps a persisted event's
  // `sessionState` from this same fold, and the read fold's stamp
  // early-return then honors that stamp ahead of its own switch. If the
  // stamp said `failed`, every already-persisted row would carry the lie
  // forever regardless of the read-side guard.
  test('the write-time stamp records no lifecycle state for a post-completion exit', () => {
    const normalized = normalizeCanonicalRuntimeEventLifecycle(
      {
        ...base,
        eventId: 'evt-outcome-7',
        createdAt: '2026-08-20T10:24:00.000Z',
        method: 'session.exited',
        exitCode: 1,
        reason: 'process-exit',
      },
      'completed',
      'turn-1',
    );
    expect(normalized.sessionState).toBeUndefined();
  });
});
