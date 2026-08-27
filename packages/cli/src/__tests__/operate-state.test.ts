import { describe, expect, it } from 'vitest';
import {
  initialState,
  MAX_EVENTS_PER_SESSION,
  reduce,
} from '../commands/operate/state.js';
import type { OperateState } from '../commands/operate/types.js';

/**
 * Table-driven, TTY-free tests for `station operate`'s pure reducer core
 * (#168 Wave 1, Task 1A). Event sequences are modeled directly on real
 * event shapes: `request.opened`'s `payload.toolInput` shape from
 * `src-server/providers/adapters/claude-adapter.ts:361-367`, and the
 * `requestId`/`title` values in cases (8) below are quoted verbatim from
 * `.kontourai/flow-agents/s150-selfhosted/run-003-operator-log.md`'s
 * approvals table (rows 1 and 2).
 */

function requestOpened(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    eventId: 'evt-open-1',
    provider: 'claude',
    threadId: 'thread-1',
    createdAt: '2026-07-05T00:00:00.000Z',
    requestId: 'req-1',
    method: 'request.opened',
    requestType: 'approval',
    title: 'Allow Bash',
    payload: {
      toolName: 'Bash',
      toolInput: { command: 'rm -rf tmp/scratch' },
    },
    ...overrides,
  };
}

function requestResolved(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    eventId: 'evt-resolved-1',
    provider: 'claude',
    threadId: 'thread-1',
    createdAt: '2026-07-05T00:00:05.000Z',
    requestId: 'req-1',
    method: 'request.resolved',
    status: 'approved',
    ...overrides,
  };
}

describe('operate/state: initialState', () => {
  it('starts connecting, with an empty board, and focuses the given thread when supplied', () => {
    const state = initialState({ focusedThreadId: 'thread-1' });
    expect(state.connectionStatus).toBe('connecting');
    expect(state.board).toEqual([]);
    expect(state.focusedThreadId).toBe('thread-1');
    expect(state.sessions['thread-1']).toMatchObject({
      threadId: 'thread-1',
      events: [],
      approvals: [],
      gateState: { bound: false },
    });
  });

  it('starts with no focused thread and no sessions when none supplied', () => {
    const state = initialState({});
    expect(state.focusedThreadId).toBeUndefined();
    expect(state.sessions).toEqual({});
  });
});

describe('operate/state: reduce — (1) snapshot -> board rows', () => {
  it('maps the orchestration:snapshot session list into board rows', () => {
    const state = reduce(initialState({}), {
      type: 'snapshot',
      sessions: [
        {
          threadId: 'thread-1',
          provider: 'claude',
          status: 'running',
          isLoaded: true,
          isPersisted: true,
          eventCount: 3,
          lastEventMethod: 'turn.started',
          updatedAt: '2026-07-05T00:00:00.000Z',
        },
        {
          threadId: 'thread-2',
          provider: 'codex',
          status: 'ready',
          isLoaded: true,
          isPersisted: false,
          eventCount: 0,
          updatedAt: '2026-07-05T00:00:01.000Z',
        },
      ],
    });

    expect(state.board).toEqual([
      {
        threadId: 'thread-1',
        provider: 'claude',
        status: 'running',
        model: undefined,
        lastEventMethod: 'turn.started',
        updatedAt: '2026-07-05T00:00:00.000Z',
        isLoaded: true,
        isPersisted: true,
        eventCount: 3,
        // station#1782: the snapshot's sessions are decorated wire summaries,
        // so every board row carries the serving Station's observation. These
        // fixtures send no member, and `normalizeRequestAnswerability` reads
        // that as answerable — the absence of a claim is not a claim.
        answerability: { answerable: true },
      },
      {
        threadId: 'thread-2',
        provider: 'codex',
        status: 'ready',
        model: undefined,
        lastEventMethod: undefined,
        updatedAt: '2026-07-05T00:00:01.000Z',
        isLoaded: true,
        isPersisted: false,
        eventCount: 0,
        answerability: { answerable: true },
      },
    ]);
  });

  it("carries a decorated snapshot session's observation onto its board row", () => {
    const observation = {
      answerable: false,
      qualification: 'provider_absent',
      observedBy: 'station-7f3a',
      observedAt: '2026-08-03T12:04:03.000Z',
    };
    const state = reduce(initialState({}), {
      type: 'snapshot',
      sessions: [
        {
          threadId: 'thread-1',
          provider: 'acme',
          status: 'running',
          answerability: observation,
        },
      ],
    });
    expect(state.board[0]?.answerability).toEqual(observation);
  });

  it('a row invented from a live event says it has observed NOTHING', () => {
    // `null`, never `{ answerable: true }`: no snapshot has described this
    // thread, so folding it to a positive would render identically to a real
    // observation — a default that decides.
    const state = reduce(initialState({}), {
      type: 'event',
      event: {
        threadId: 'thread-unseen',
        method: 'session.started',
        createdAt: '2026-08-03T00:00:00.000Z',
      },
    });
    expect(state.board[0]?.threadId).toBe('thread-unseen');
    expect(state.board[0]?.answerability).toBeNull();
  });
});

describe('operate/state: reduce — (2)/(3) request.opened/request.resolved', () => {
  it('(2) request.opened produces a pending approval carrying toolInput', () => {
    const state = reduce(initialState({ focusedThreadId: 'thread-1' }), {
      type: 'event',
      event: requestOpened(),
    });

    expect(state.sessions['thread-1'].approvals).toEqual([
      expect.objectContaining({
        threadId: 'thread-1',
        requestId: 'req-1',
        toolName: 'Bash',
        toolInput: { command: 'rm -rf tmp/scratch' },
      }),
    ]);
  });

  it('(3) a matching request.resolved clears the approval', () => {
    let state = initialState({ focusedThreadId: 'thread-1' });
    state = reduce(state, { type: 'event', event: requestOpened() });
    expect(state.sessions['thread-1'].approvals).toHaveLength(1);

    state = reduce(state, { type: 'event', event: requestResolved() });
    expect(state.sessions['thread-1'].approvals).toEqual([]);
  });
});

describe('operate/state: reduce — (4)/(5) flow gate folding', () => {
  const verdictCases = [
    { verdict: 'pass' as const },
    { verdict: 'wait' as const, missing: ['expectation-a'] },
    { verdict: 'block' as const, exceptionRequired: true },
    { verdict: 'route-back' as const, routeBackTo: 'plan' },
  ];

  it.each(verdictCases)(
    '(4) flow.run-attached then flow.gate-verdict($verdict) -> gate state reflects binding + latest verdict',
    ({ verdict, missing }) => {
      let state = initialState({ focusedThreadId: 'thread-1' });
      state = reduce(state, {
        type: 'event',
        event: {
          threadId: 'thread-1',
          provider: 'claude',
          createdAt: '2026-07-05T00:00:00.000Z',
          method: 'flow.run-attached',
          runId: 'run-1',
          definitionId: 'builder.build',
          cwd: '/repo',
          resumed: false,
        },
      });
      state = reduce(state, {
        type: 'event',
        event: {
          threadId: 'thread-1',
          provider: 'claude',
          createdAt: '2026-07-05T00:00:01.000Z',
          method: 'flow.gate-verdict',
          runId: 'run-1',
          verdict,
          gateId: 'gate-1',
          ...(missing ? { missing } : {}),
        },
      });

      const gateState = state.sessions['thread-1'].gateState;
      expect(gateState.bound).toBe(true);
      expect(gateState.runId).toBe('run-1');
      expect(gateState.definitionId).toBe('builder.build');
      expect(gateState.latestVerdict).toMatchObject({
        verdict,
        gateId: 'gate-1',
      });
      if (missing) {
        expect(gateState.latestVerdict?.missing).toEqual(missing);
      }
    },
  );

  it('(5) no flow.run-attached ever -> gate state is bound:false', () => {
    const state = reduce(initialState({ focusedThreadId: 'thread-1' }), {
      type: 'event',
      event: requestOpened(),
    });
    expect(state.sessions['thread-1'].gateState).toEqual({ bound: false });
  });
});

describe('operate/state: reduce — (6) flow-run-snapshot merge', () => {
  it('merges a pulled openGates/currentStep/status into gate state', () => {
    const state = reduce(initialState({ focusedThreadId: 'thread-1' }), {
      type: 'flow-run-snapshot',
      threadId: 'thread-1',
      snapshot: {
        runId: 'run-1',
        definitionId: 'builder.build',
        currentStep: 'implementation',
        status: 'running',
        openGates: [{ id: 'gate-review', step: 'review' }],
      },
    });

    expect(state.sessions['thread-1'].gateState).toEqual({
      bound: true,
      runId: 'run-1',
      definitionId: 'builder.build',
      currentStep: 'implementation',
      status: 'running',
      openGates: [{ id: 'gate-review', step: 'review' }],
    });
  });

  it('a confirmed not-bound pull (null) leaves gate state bound:false, never inventing a gate list', () => {
    const state = reduce(initialState({ focusedThreadId: 'thread-1' }), {
      type: 'flow-run-snapshot',
      threadId: 'thread-1',
      snapshot: null,
    });

    expect(state.sessions['thread-1'].gateState).toEqual({ bound: false });
  });

  it('preserves a pulled gate snapshot across a subsequent unrelated event', () => {
    let state = reduce(initialState({ focusedThreadId: 'thread-1' }), {
      type: 'flow-run-snapshot',
      threadId: 'thread-1',
      snapshot: {
        runId: 'run-1',
        definitionId: 'builder.build',
        openGates: [{ id: 'gate-review', step: 'review' }],
      },
    });
    state = reduce(state, { type: 'event', event: requestOpened() });

    expect(state.sessions['thread-1'].gateState.openGates).toEqual([
      { id: 'gate-review', step: 'review' },
    ]);
  });
});

describe('operate/state: reduce — (7) event buffer eviction at the 500-event cap', () => {
  it('caps the per-session raw-event buffer at 500, evicting the oldest first', () => {
    let state = initialState({ focusedThreadId: 'thread-1' });
    for (let i = 0; i < MAX_EVENTS_PER_SESSION + 10; i += 1) {
      state = reduce(state, {
        type: 'event',
        event: {
          threadId: 'thread-1',
          provider: 'claude',
          createdAt: new Date(2026, 6, 5, 0, 0, i).toISOString(),
          method: 'token-usage.updated',
          eventId: `evt-${i}`,
          totalTokens: i,
        },
      });
    }

    const events = state.sessions['thread-1'].events;
    expect(events).toHaveLength(MAX_EVENTS_PER_SESSION);
    expect(events[0].eventId).toBe('evt-10');
    expect(events.at(-1)?.eventId).toBe(`evt-${MAX_EVENTS_PER_SESSION + 9}`);
  });
});

describe('operate/state: reduce — (8) run-003 real event shapes', () => {
  it('a run-003-shaped Allow Bash request.opened/request.resolved pair clears cleanly', () => {
    let state = initialState({ focusedThreadId: 'station-self-003-issue-182' });
    state = reduce(state, {
      type: 'event',
      event: {
        provider: 'claude',
        threadId: 'station-self-003-issue-182',
        createdAt: '2026-07-05T05:42:20.000Z',
        requestId: '7a12dffe-6b24-4e78-9cea-6d39176edc52',
        method: 'request.opened',
        requestType: 'approval',
        title: 'Allow Bash',
        payload: {
          toolName: 'Bash',
          toolInput: { command: 'npm test' },
        },
      },
    });
    state = reduce(state, {
      type: 'event',
      event: {
        provider: 'claude',
        threadId: 'station-self-003-issue-182',
        createdAt: '2026-07-05T05:42:30.927Z',
        requestId: '7a12dffe-6b24-4e78-9cea-6d39176edc52',
        method: 'request.resolved',
        status: 'approved',
      },
    });

    expect(state.sessions['station-self-003-issue-182'].approvals).toEqual([]);
  });

  it('a run-003-shaped Allow Edit request.opened (row 2, unresolved) stays pending with toolInput', () => {
    const state = reduce(
      initialState({ focusedThreadId: 'station-self-003-issue-182' }),
      {
        type: 'event',
        event: {
          provider: 'claude',
          threadId: 'station-self-003-issue-182',
          createdAt: '2026-07-05T05:45:10.000Z',
          requestId: 'b389ed5b-ffd9-4ce7-9533-ef0b76fba00d',
          method: 'request.opened',
          requestType: 'approval',
          title: 'Allow Edit',
          payload: {
            toolName: 'Edit',
            toolInput: {
              file_path: 'src-server/routes/orchestration/orchestration.ts',
            },
          },
        },
      },
    );

    expect(state.sessions['station-self-003-issue-182'].approvals).toEqual([
      expect.objectContaining({
        requestId: 'b389ed5b-ffd9-4ce7-9533-ef0b76fba00d',
        toolName: 'Edit',
        toolInput: {
          file_path: 'src-server/routes/orchestration/orchestration.ts',
        },
      }),
    ]);
  });
});

describe('operate/state: reduce — (9) focus-change (#168 iteration-2 review finding L1)', () => {
  it('creates a new session entry and focuses it when no session exists yet for the thread', () => {
    const state = reduce(initialState({}), {
      type: 'focus-change',
      threadId: 'thread-new',
    });
    expect(state.focusedThreadId).toBe('thread-new');
    expect(state.sessions['thread-new']).toEqual({
      threadId: 'thread-new',
      events: [],
      approvals: [],
      selectedApprovalIndex: 0,
      gateState: { bound: false },
      gateSnapshot: undefined,
    });
  });

  it('reuses an existing session entry (keeps its events/approvals) rather than replacing it', () => {
    let state = initialState({ focusedThreadId: 'thread-1' });
    state = reduce(state, { type: 'event', event: requestOpened() });
    state = reduce(state, {
      type: 'event',
      event: requestOpened({ requestId: 'req-2', eventId: 'evt-open-2' }),
    });
    expect(state.sessions['thread-1'].events).toHaveLength(2);
    expect(state.sessions['thread-1'].approvals).toHaveLength(2);

    state = reduce(state, { type: 'focus-change', threadId: 'thread-1' });

    expect(state.focusedThreadId).toBe('thread-1');
    expect(state.sessions['thread-1'].events).toHaveLength(2);
    expect(state.sessions['thread-1'].approvals).toHaveLength(2);
  });

  it('resets selectedApprovalIndex to 0 on focus, even when a non-zero index was previously selected', () => {
    let state = initialState({ focusedThreadId: 'thread-1' });
    state = reduce(state, { type: 'event', event: requestOpened() });
    state = reduce(state, {
      type: 'event',
      event: requestOpened({ requestId: 'req-2', eventId: 'evt-open-2' }),
    });
    // Move the selection off 0 so the reset-on-focus is observable.
    state = reduce(state, {
      type: 'keypress',
      key: { name: 'down', ctrl: false, shift: false, sequence: '' },
    });
    expect(state.sessions['thread-1'].selectedApprovalIndex).toBe(1);

    state = reduce(state, { type: 'focus-change', threadId: 'thread-1' });

    expect(state.sessions['thread-1'].selectedApprovalIndex).toBe(0);
  });

  it('switches focusedThreadId to the target thread when it differs from the current focus', () => {
    const state = reduce(initialState({ focusedThreadId: 'thread-1' }), {
      type: 'focus-change',
      threadId: 'thread-2',
    });
    expect(state.focusedThreadId).toBe('thread-2');
    expect(state.sessions['thread-1']).toBeDefined();
    expect(state.sessions['thread-2']).toBeDefined();
  });
});

describe('operate/state: reduce — connection-status/tick/clear-intent', () => {
  it('connection-status sets status and error', () => {
    const state = reduce(initialState({}), {
      type: 'connection-status',
      status: 'error',
      error: 'ECONNRESET',
    });
    expect(state.connectionStatus).toBe('error');
    expect(state.connectionError).toBe('ECONNRESET');
  });

  it('tick updates now', () => {
    const state = reduce(initialState({}), { type: 'tick', now: 12345 });
    expect(state.now).toBe(12345);
  });

  it('clear-intent nulls pendingIntent', () => {
    const withIntent: OperateState = {
      ...initialState({}),
      pendingIntent: { type: 'quit' },
    };
    const state = reduce(withIntent, { type: 'clear-intent' });
    expect(state.pendingIntent).toBeNull();
  });
});
