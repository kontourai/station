import { beforeEach, describe, expect, test } from 'vitest';
import { selectSessionInventoryLiveNow } from '../../components/chat-dock/sessionInventoryLiveProjection';
import type {
  OrchestrationEvent,
  OrchestrationSnapshotPayload,
} from '../../hooks/orchestration/types';
import {
  BackgroundTasksStore,
  createEmptyBackgroundTasksState,
  ingestBackgroundTaskEvent,
  reconcileBackgroundTasksSnapshot,
  selectChatBackgroundTasks,
} from '../background-tasks-store';

function event(
  method: string,
  overrides: Record<string, unknown> = {},
): OrchestrationEvent {
  return {
    provider: 'claude',
    threadId: 'chat-1',
    createdAt: '2026-07-29T00:00:00.000Z',
    method,
    ...overrides,
  } as unknown as OrchestrationEvent;
}

describe('ingestBackgroundTaskEvent — tool cards', () => {
  test('tool.started opens a running tool card', () => {
    const state = ingestBackgroundTaskEvent(
      createEmptyBackgroundTasksState(),
      event('tool.started', {
        toolCallId: 'call-1',
        toolName: 'bash',
        arguments: { description: 'Run tests' },
      }),
    );
    expect(state.entries['call-1']).toMatchObject({
      id: 'call-1',
      kind: 'tool',
      source: 'tool-event',
      chatThreadId: 'chat-1',
      title: 'Run tests',
      state: 'running',
    });
  });

  test('tool.started falls back to toolName when no description arg is present', () => {
    const state = ingestBackgroundTaskEvent(
      createEmptyBackgroundTasksState(),
      event('tool.started', { toolCallId: 'call-1', toolName: 'bash' }),
    );
    expect(state.entries['call-1'].title).toBe('bash');
  });

  test('tool.progress refreshes detail on the running card', () => {
    let state = ingestBackgroundTaskEvent(
      createEmptyBackgroundTasksState(),
      event('tool.started', { toolCallId: 'call-1', toolName: 'bash' }),
    );
    state = ingestBackgroundTaskEvent(
      state,
      event('tool.progress', {
        toolCallId: 'call-1',
        message: 'Running vitest…',
      }),
    );
    expect(state.entries['call-1'].detail).toBe('Running vitest…');
  });

  test('tool.progress for an unknown toolCallId is a no-op (identical reference)', () => {
    const initial = createEmptyBackgroundTasksState();
    const state = ingestBackgroundTaskEvent(
      initial,
      event('tool.progress', { toolCallId: 'missing', message: 'x' }),
    );
    expect(state).toBe(initial);
  });

  test('tool.completed(success) closes the card as completed', () => {
    let state = ingestBackgroundTaskEvent(
      createEmptyBackgroundTasksState(),
      event('tool.started', { toolCallId: 'call-1', toolName: 'bash' }),
    );
    state = ingestBackgroundTaskEvent(
      state,
      event('tool.completed', {
        toolCallId: 'call-1',
        toolName: 'bash',
        status: 'success',
        createdAt: '2026-07-29T00:00:05.000Z',
      }),
    );
    expect(state.entries['call-1']).toMatchObject({
      state: 'completed',
      endedAt: Date.parse('2026-07-29T00:00:05.000Z'),
    });
  });

  test('tool.completed(cancelled) closes the card as stopped', () => {
    let state = ingestBackgroundTaskEvent(
      createEmptyBackgroundTasksState(),
      event('tool.started', { toolCallId: 'call-1', toolName: 'bash' }),
    );
    state = ingestBackgroundTaskEvent(
      state,
      event('tool.completed', {
        toolCallId: 'call-1',
        toolName: 'bash',
        status: 'cancelled',
      }),
    );
    expect(state.entries['call-1'].state).toBe('stopped');
  });

  test('tool.completed(error) closes the card as failed', () => {
    let state = ingestBackgroundTaskEvent(
      createEmptyBackgroundTasksState(),
      event('tool.started', { toolCallId: 'call-1', toolName: 'bash' }),
    );
    state = ingestBackgroundTaskEvent(
      state,
      event('tool.completed', {
        toolCallId: 'call-1',
        toolName: 'bash',
        status: 'error',
      }),
    );
    expect(state.entries['call-1'].state).toBe('failed');
  });

  test('turn-terminal safety net closes an orphaned running tool card as stopped', () => {
    let state = ingestBackgroundTaskEvent(
      createEmptyBackgroundTasksState(),
      event('tool.started', { toolCallId: 'call-1', toolName: 'bash' }),
    );
    // No tool.completed ever arrives — the turn just ends.
    state = ingestBackgroundTaskEvent(
      state,
      event('turn.completed', { turnId: 't1' }),
    );
    expect(state.entries['call-1'].state).toBe('stopped');
  });

  test.each(['turn.completed', 'turn.aborted', 'session.exited'])(
    '%s closes orphaned tool cards on that thread',
    (method) => {
      let state = ingestBackgroundTaskEvent(
        createEmptyBackgroundTasksState(),
        event('tool.started', { toolCallId: 'call-1', toolName: 'bash' }),
      );
      state = ingestBackgroundTaskEvent(state, event(method));
      expect(state.entries['call-1'].state).toBe('stopped');
    },
  );

  test('the safety net never reopens an already-finished card (no-op)', () => {
    let state = ingestBackgroundTaskEvent(
      createEmptyBackgroundTasksState(),
      event('tool.started', { toolCallId: 'call-1', toolName: 'bash' }),
    );
    state = ingestBackgroundTaskEvent(
      state,
      event('tool.completed', {
        toolCallId: 'call-1',
        toolName: 'bash',
        status: 'success',
      }),
    );
    const afterCompletion = state;
    state = ingestBackgroundTaskEvent(
      state,
      event('turn.completed', { turnId: 't1' }),
    );
    expect(state).toBe(afterCompletion);
    expect(state.entries['call-1'].state).toBe('completed');
  });

  test('content.text-delta and content.reasoning-delta are no-ops (identical reference)', () => {
    const initial = ingestBackgroundTaskEvent(
      createEmptyBackgroundTasksState(),
      event('tool.started', { toolCallId: 'call-1', toolName: 'bash' }),
    );
    const afterText = ingestBackgroundTaskEvent(
      initial,
      event('content.text-delta', { itemId: 'i1', delta: 'hi' }),
    );
    expect(afterText).toBe(initial);
    const afterReasoning = ingestBackgroundTaskEvent(
      initial,
      event('content.reasoning-delta', { itemId: 'i1', delta: 'hi' }),
    );
    expect(afterReasoning).toBe(initial);
  });
});

describe('ingestBackgroundTaskEvent — delegate/agent cards', () => {
  function bindEvent(overrides: Record<string, unknown> = {}) {
    return event('session.started', {
      threadId: 'task:delegate-1',
      sessionId: 'task:delegate-1',
      metadata: { taskId: 'task:delegate-1', parentTaskId: 'chat-1' },
      ...overrides,
    });
  }

  test('session.started with taskId===threadId + parentTaskId binds and opens the card', () => {
    const state = ingestBackgroundTaskEvent(
      createEmptyBackgroundTasksState(),
      bindEvent(),
    );
    expect(state.delegateParents['task:delegate-1']).toBe('chat-1');
    expect(state.entries['task:delegate-1']).toMatchObject({
      kind: 'agent',
      source: 'delegate-session',
      chatThreadId: 'chat-1',
      delegateThreadId: 'task:delegate-1',
      stop: { kind: 'delegate-interrupt' },
      state: 'running',
    });
  });

  test('a bind event missing parentTaskId is a no-op (identical reference)', () => {
    const initial = createEmptyBackgroundTasksState();
    const state = ingestBackgroundTaskEvent(
      initial,
      event('session.started', {
        threadId: 'task:delegate-1',
        sessionId: 'task:delegate-1',
        metadata: { taskId: 'task:delegate-1' },
      }),
    );
    expect(state).toBe(initial);
  });

  test('turn.started on the delegate thread refines the title from the prompt', () => {
    let state = ingestBackgroundTaskEvent(
      createEmptyBackgroundTasksState(),
      bindEvent(),
    );
    state = ingestBackgroundTaskEvent(
      state,
      event('turn.started', {
        threadId: 'task:delegate-1',
        turnId: 'turn-1',
        prompt: 'Fix the failing test\nmore context here',
      }),
    );
    expect(state.entries['task:delegate-1'].title).toBe('Fix the failing test');
  });

  test.each([
    ['turn.completed', 'completed'],
    ['turn.aborted', 'stopped'],
    ['session.exited', 'stopped'],
    ['runtime.error', 'failed'],
  ] as const)('%s closes the delegate card as %s', (method, outcome) => {
    let state = ingestBackgroundTaskEvent(
      createEmptyBackgroundTasksState(),
      bindEvent(),
    );
    state = ingestBackgroundTaskEvent(
      state,
      event(method, { threadId: 'task:delegate-1' }),
    );
    expect(state.entries['task:delegate-1'].state).toBe(outcome);
  });

  test('a new turn reopens a finished resumable delegate card', () => {
    let state = ingestBackgroundTaskEvent(
      createEmptyBackgroundTasksState(),
      bindEvent(),
    );
    state = ingestBackgroundTaskEvent(
      state,
      event('turn.completed', { threadId: 'task:delegate-1' }),
    );
    state = ingestBackgroundTaskEvent(
      state,
      event('turn.started', {
        threadId: 'task:delegate-1',
        prompt: 'Continue the investigation',
        createdAt: '2026-07-29T00:02:00.000Z',
      }),
    );

    expect(state.entries['task:delegate-1']).toMatchObject({
      state: 'running',
      title: 'Continue the investigation',
      startedAt: Date.parse('2026-07-29T00:02:00.000Z'),
      stop: { kind: 'delegate-interrupt' },
    });
    expect(state.entries['task:delegate-1'].endedAt).toBeUndefined();
  });

  test('closing an unbound thread is a no-op (identical reference)', () => {
    const initial = createEmptyBackgroundTasksState();
    const state = ingestBackgroundTaskEvent(
      initial,
      event('turn.completed', { threadId: 'some-other-thread' }),
    );
    expect(state).toBe(initial);
  });

  test('a delegate card never binds to its own thread as chat (taskId must equal threadId)', () => {
    const state = ingestBackgroundTaskEvent(
      createEmptyBackgroundTasksState(),
      event('session.started', {
        threadId: 'task:delegate-1',
        sessionId: 'task:delegate-1',
        // taskId points elsewhere — this is not this session's own bind.
        metadata: { taskId: 'task:other', parentTaskId: 'chat-1' },
      }),
    );
    expect(state.entries['task:delegate-1']).toBeUndefined();
    expect(state.delegateParents['task:delegate-1']).toBeUndefined();
  });
});

describe('bounded Finished list (drop-oldest per chat)', () => {
  test('a chat is capped at 50 finished entries, dropping the oldest first', () => {
    let state = createEmptyBackgroundTasksState();
    for (let i = 0; i < 55; i++) {
      state = ingestBackgroundTaskEvent(
        state,
        event('tool.started', { toolCallId: `call-${i}`, toolName: 'bash' }),
      );
      state = ingestBackgroundTaskEvent(
        state,
        event('tool.completed', {
          toolCallId: `call-${i}`,
          toolName: 'bash',
          status: 'success',
          createdAt: new Date(2026, 0, 1, 0, 0, i).toISOString(),
        }),
      );
    }
    const finishedIds = Object.values(state.entries)
      .filter((entry) => entry.chatThreadId === 'chat-1')
      .map((entry) => entry.id);
    expect(finishedIds).toHaveLength(50);
    expect(finishedIds).not.toContain('call-0');
    expect(finishedIds).not.toContain('call-4');
    expect(finishedIds).toContain('call-5');
    expect(finishedIds).toContain('call-54');
  });

  test('finished lists are scoped per chat — one chat filling up does not evict another', () => {
    let state = createEmptyBackgroundTasksState();
    for (let i = 0; i < 55; i++) {
      state = ingestBackgroundTaskEvent(
        state,
        event('tool.started', {
          threadId: 'chat-1',
          toolCallId: `call-${i}`,
          toolName: 'bash',
        }),
      );
      state = ingestBackgroundTaskEvent(
        state,
        event('tool.completed', {
          threadId: 'chat-1',
          toolCallId: `call-${i}`,
          toolName: 'bash',
          status: 'success',
        }),
      );
    }
    state = ingestBackgroundTaskEvent(
      state,
      event('tool.started', {
        threadId: 'chat-2',
        toolCallId: 'other-call',
        toolName: 'bash',
      }),
    );
    state = ingestBackgroundTaskEvent(
      state,
      event('tool.completed', {
        threadId: 'chat-2',
        toolCallId: 'other-call',
        toolName: 'bash',
        status: 'success',
      }),
    );
    expect(state.entries['other-call']).toBeDefined();
  });
});

describe('reconcileBackgroundTasksSnapshot', () => {
  function payload(
    sessions: OrchestrationSnapshotPayload['sessions'],
  ): OrchestrationSnapshotPayload {
    return { sessions };
  }

  test('seeds a running delegate card the client never saw live', () => {
    const state = reconcileBackgroundTasksSnapshot(
      createEmptyBackgroundTasksState(),
      payload([
        {
          provider: 'claude',
          threadId: 'task:delegate-1',
          status: 'running',
          hasActiveTurn: true,
          createdAt: '2026-07-29T00:00:00.000Z',
          delegation: { taskId: 'task:delegate-1', parentTaskId: 'chat-1' },
        },
      ]),
    );
    expect(state.entries['task:delegate-1']).toMatchObject({
      kind: 'agent',
      source: 'delegate-session',
      stop: { kind: 'delegate-interrupt' },
      chatThreadId: 'chat-1',
      state: 'running',
    });
    expect(state.delegateParents['task:delegate-1']).toBe('chat-1');
  });

  test('does not seed a finished card for a delegate never seen live (nothing to backfill)', () => {
    const state = reconcileBackgroundTasksSnapshot(
      createEmptyBackgroundTasksState(),
      payload([
        {
          provider: 'claude',
          threadId: 'task:delegate-1',
          status: 'idle',
          hasActiveTurn: false,
          delegation: { taskId: 'task:delegate-1', parentTaskId: 'chat-1' },
        },
      ]),
    );
    expect(state.entries['task:delegate-1']).toBeUndefined();
  });

  test('hasActiveTurn === false demotes a client-tracked running delegate to stopped', () => {
    let state = ingestBackgroundTaskEvent(
      createEmptyBackgroundTasksState(),
      event('session.started', {
        threadId: 'task:delegate-1',
        sessionId: 'task:delegate-1',
        metadata: { taskId: 'task:delegate-1', parentTaskId: 'chat-1' },
      }),
    );
    state = reconcileBackgroundTasksSnapshot(
      state,
      payload([
        {
          provider: 'claude',
          threadId: 'task:delegate-1',
          status: 'idle',
          hasActiveTurn: false,
          lastEventAt: '2026-07-29T00:05:00.000Z',
          delegation: { taskId: 'task:delegate-1', parentTaskId: 'chat-1' },
        },
      ]),
    );
    expect(state.entries['task:delegate-1']).toMatchObject({
      state: 'stopped',
      endedAt: Date.parse('2026-07-29T00:05:00.000Z'),
    });
  });

  test('a session with no delegation context is ignored (identical reference)', () => {
    const initial = createEmptyBackgroundTasksState();
    const state = reconcileBackgroundTasksSnapshot(
      initial,
      payload([{ provider: 'claude', threadId: 'chat-1', status: 'idle' }]),
    );
    expect(state).toBe(initial);
  });
});

describe('selectChatBackgroundTasks — provider-task dedup by toolCallId', () => {
  test('a provider task suppresses the raw tool card sharing its toolCallId', () => {
    const state = ingestBackgroundTaskEvent(
      createEmptyBackgroundTasksState(),
      event('tool.started', {
        toolCallId: 'call-1',
        toolName: 'Task',
        createdAt: '2026-07-29T00:00:00.000Z',
      }),
    );
    const view = selectChatBackgroundTasks(state, 'chat-1', [
      {
        taskId: 'provider-task-1',
        toolCallId: 'call-1',
        description: 'Investigate flaky test',
        subagentType: 'general-purpose',
      },
    ]);
    expect(view.running).toHaveLength(1);
    expect(view.running[0]).toMatchObject({
      id: 'provider-task-1',
      kind: 'agent',
      source: 'provider-task',
      title: 'Investigate flaky test',
      // Inherits the suppressed tool card's startedAt via the toolCallId link.
      startedAt: Date.parse('2026-07-29T00:00:00.000Z'),
    });
  });

  test('a tool card with no matching provider task is not suppressed', () => {
    const state = ingestBackgroundTaskEvent(
      createEmptyBackgroundTasksState(),
      event('tool.started', { toolCallId: 'call-1', toolName: 'bash' }),
    );
    const view = selectChatBackgroundTasks(state, 'chat-1', []);
    expect(view.running.map((entry) => entry.id)).toEqual(['call-1']);
  });

  test('running and finished entries are scoped to the requested chat only', () => {
    let state = ingestBackgroundTaskEvent(
      createEmptyBackgroundTasksState(),
      event('tool.started', {
        threadId: 'chat-1',
        toolCallId: 'call-1',
        toolName: 'bash',
      }),
    );
    state = ingestBackgroundTaskEvent(
      state,
      event('tool.started', {
        threadId: 'chat-2',
        toolCallId: 'call-2',
        toolName: 'bash',
      }),
    );
    const view = selectChatBackgroundTasks(state, 'chat-1', undefined);
    expect(view.running.map((entry) => entry.id)).toEqual(['call-1']);
  });
});

describe('selectSessionInventoryLiveNow', () => {
  test('admits only running raw entries from the exact captured Session', () => {
    const state = {
      entries: {
        exact: {
          id: 'exact',
          kind: 'tool' as const,
          source: 'tool-event' as const,
          chatThreadId: 'session-a',
          title: 'Exact',
          startedAt: 1,
          state: 'running' as const,
        },
        other: {
          id: 'other',
          kind: 'tool' as const,
          source: 'tool-event' as const,
          chatThreadId: 'conversation-a',
          title: 'Wrong identity',
          startedAt: 2,
          state: 'running' as const,
        },
        settled: {
          id: 'settled',
          kind: 'tool' as const,
          source: 'tool-event' as const,
          chatThreadId: 'session-a',
          title: 'Settled',
          startedAt: 3,
          state: 'completed' as const,
        },
      },
      delegateParents: {},
    };
    expect(
      selectSessionInventoryLiveNow(state, 'session-a', undefined).map(
        (row) => row.id,
      ),
    ).toEqual(['exact']);
    expect(selectSessionInventoryLiveNow(state, null, undefined)).toEqual([]);
  });

  test('requires a same-Session toolCallId join before admitting a provider task', () => {
    const state = {
      entries: {
        'call-a': {
          id: 'call-a',
          kind: 'tool' as const,
          source: 'tool-event' as const,
          chatThreadId: 'session-a',
          title: 'Raw',
          startedAt: 1,
          state: 'running' as const,
        },
      },
      delegateParents: {},
    };
    expect(
      selectSessionInventoryLiveNow(state, 'session-a', [
        { taskId: 'provider-a', toolCallId: 'call-a', description: 'Joined' },
        {
          taskId: 'provider-b',
          toolCallId: 'unknown',
          description: 'Unjoined',
        },
      ]).map((row) => row.id),
    ).toEqual(['provider-a']);
  });
});

describe('BackgroundTasksStore — the singleton wiring', () => {
  let store: BackgroundTasksStore;

  beforeEach(() => {
    store = new BackgroundTasksStore();
  });

  test('ingest() notifies subscribers only on an actual state change', () => {
    const listener = () => {
      notifications += 1;
    };
    let notifications = 0;
    const unsubscribe = store.subscribe(listener);

    // A no-op event (unknown toolCallId progress) must not notify.
    store.ingest(
      event('tool.progress', { toolCallId: 'missing', message: 'x' }),
    );
    expect(notifications).toBe(0);

    store.ingest(
      event('tool.started', { toolCallId: 'call-1', toolName: 'bash' }),
    );
    expect(notifications).toBe(1);

    unsubscribe();
  });

  test('reconcileSnapshot() also skips notifying on a no-op snapshot', () => {
    let notifications = 0;
    const unsubscribe = store.subscribe(() => {
      notifications += 1;
    });
    store.reconcileSnapshot({
      sessions: [{ provider: 'claude', threadId: 'chat-1', status: 'idle' }],
    });
    expect(notifications).toBe(0);
    unsubscribe();
  });

  test('getSnapshot() reflects ingested events', () => {
    store.ingest(
      event('tool.started', { toolCallId: 'call-1', toolName: 'bash' }),
    );
    expect(store.getSnapshot().entries['call-1']).toBeDefined();
  });
});
