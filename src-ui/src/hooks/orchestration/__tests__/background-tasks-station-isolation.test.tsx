// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { activeChatsStore } from '../../../contexts/active-chats-store';
import { backgroundTasksStore } from '../../../contexts/background-tasks-store';
import { useChatBackgroundTasks } from '../../useBackgroundTasks';
import { handleOrchestrationEvent } from '../eventHandlers';
import { applyOrchestrationSnapshot } from '../snapshotHandlers';

const stationA = 'http://station-a.test';
const stationB = 'http://station-b.test';
const parent = 'shared-parent';

beforeEach(() => {
  backgroundTasksStore.reset();
  activeChatsStore.initChat(parent, {
    agentSlug: 'agent',
    agentName: 'Agent',
    title: 'Parent',
  });
});
afterEach(() => {
  cleanup();
  activeChatsStore.removeChat(parent);
  backgroundTasksStore.reset();
});

test('events and full snapshots reconcile only their Station, including colliding session IDs', () => {
  const a = renderHook(() => useChatBackgroundTasks(parent, stationA));
  const b = renderHook(() => useChatBackgroundTasks(parent, stationB));
  const started = (threadId: string, title: string) => ({
    eventId: `${threadId}:${title}`,
    provider: 'claude',
    threadId,
    sessionId: threadId,
    createdAt: '2026-10-30T00:00:00.000Z',
    method: 'session.started' as const,
    metadata: { taskId: threadId, parentTaskId: parent, title },
  });
  act(() => {
    handleOrchestrationEvent(stationA, started('shared-child', 'A child'));
    handleOrchestrationEvent(stationA, started('only-a', 'A other'));
  });
  const aBeforeB = a.result.current;
  expect(aBeforeB.running.map((row) => row.id).sort()).toEqual([
    'only-a',
    'shared-child',
  ]);
  act(() => {
    handleOrchestrationEvent(stationB, started('shared-child', 'B child'));
    applyOrchestrationSnapshot(
      {
        sessions: [
          {
            provider: 'claude',
            threadId: 'shared-child',
            status: 'running',
            hasActiveTurn: true,
            delegation: {
              taskId: 'shared-child',
              parentTaskId: parent,
              title: 'B child',
            },
          },
        ],
      },
      { apiBase: stationB },
    );
  });
  expect(a.result.current).toBe(aBeforeB);
  expect(a.result.current.running.map((row) => row.id).sort()).toEqual([
    'only-a',
    'shared-child',
  ]);
  expect(b.result.current.running.map((row) => row.id)).toEqual([
    'shared-child',
  ]);
  const bBeforeA = b.result.current;
  act(() =>
    applyOrchestrationSnapshot({ sessions: [] }, { apiBase: stationA }),
  );
  expect(a.result.current.running).toHaveLength(0);
  expect(a.result.current.finished.map((row) => row.state)).toEqual([
    'unresolved',
    'unresolved',
  ]);
  expect(b.result.current).toBe(bBeforeA);
  expect(b.result.current.running.map((row) => row.id)).toEqual([
    'shared-child',
  ]);
});

test('provider children with colliding IDs stay with their Station and retained continuation reporter', () => {
  activeChatsStore.updateChat(parent, { currentSessionId: 'continuation' });
  const a = renderHook(() => useChatBackgroundTasks(parent, stationA));
  const b = renderHook(() => useChatBackgroundTasks(parent, stationB));
  const child = (title: string) => ({
    eventId: `event:${title}`,
    provider: 'codex',
    threadId: 'continuation',
    createdAt: '2026-10-30T00:00:00.000Z',
    method: 'child-work.updated' as const,
    delta: {
      kind: 'upsert' as const,
      item: {
        producer: 'engine-subagent' as const,
        reporterThreadId: 'continuation',
        childId: 'same-child',
        status: 'running' as const,
        title,
      },
    },
  });
  act(() => handleOrchestrationEvent(stationA, child('A provider child')));
  const aBefore = a.result.current;
  act(() => handleOrchestrationEvent(stationB, child('B provider child')));
  expect(a.result.current).toBe(aBefore);
  expect(a.result.current.running.map((row) => row.title)).toEqual([
    'A provider child',
  ]);
  expect(b.result.current.running.map((row) => row.title)).toEqual([
    'B provider child',
  ]);
  act(() =>
    activeChatsStore.updateChat(parent, {
      currentSessionId: 'new-continuation',
    }),
  );
  act(() => handleOrchestrationEvent(stationA, child('A updated child')));
  expect(a.result.current.running.map((row) => row.title)).toEqual([
    'A updated child',
  ]);
  expect(b.result.current.running.map((row) => row.title)).toEqual([
    'B provider child',
  ]);
});

test('inactive uncertain Station history is bounded while a mounted Station stays retained', () => {
  const mounted = renderHook(() => useChatBackgroundTasks(parent, stationA));
  const start = (origin: string, id: string) => {
    handleOrchestrationEvent(origin, {
      provider: 'claude',
      threadId: id,
      sessionId: id,
      createdAt: '2026-10-30T00:00:00.000Z',
      method: 'session.started',
      metadata: { taskId: id, parentTaskId: parent },
    });
    applyOrchestrationSnapshot({ sessions: [] }, { apiBase: origin });
  };
  act(() => {
    start(stationA, 'retained-uncertain');
    for (let index = 0; index < 5; index++)
      start(`http://closed-${index}.test`, `closed-${index}`);
  });
  expect(mounted.result.current.finished.map((entry) => entry.state)).toEqual([
    'unresolved',
  ]);
  expect(
    Object.keys(
      backgroundTasksStore.getSnapshot('http://closed-0.test').entries,
    ),
  ).toHaveLength(0);
  expect(
    Object.keys(
      backgroundTasksStore.getSnapshot('http://closed-4.test').entries,
    ),
  ).toHaveLength(1);
  mounted.unmount();
  act(() => start('http://closed-5.test', 'closed-5'));
  expect(
    Object.keys(backgroundTasksStore.getSnapshot(stationA).entries),
  ).toHaveLength(0);
});

test('chat lifecycle completes while multiple Station partitions hold live work', () => {
  act(() => {
    for (const [origin, id] of [
      [stationA, 'a-live'],
      [stationB, 'b-live'],
    ] as const) {
      handleOrchestrationEvent(origin, {
        provider: 'claude',
        threadId: id,
        sessionId: id,
        createdAt: '2026-10-30T00:00:00.000Z',
        method: 'session.started',
        metadata: { taskId: id, parentTaskId: parent },
      });
    }
    activeChatsStore.removeChat(parent);
    activeChatsStore.initChat(parent, {
      agentSlug: 'agent',
      agentName: 'Agent',
      title: 'Parent',
    });
  });
  expect(
    backgroundTasksStore.getSnapshot(stationA).entries['a-live']?.state,
  ).toBe('running');
  expect(
    backgroundTasksStore.getSnapshot(stationB).entries['b-live']?.state,
  ).toBe('running');
});

test('a cold full snapshot associates an older continuation with its durable conversation', () => {
  activeChatsStore.updateChat(parent, {
    conversationId: 'durable-conversation',
    currentSessionId: 'new-session',
  });
  const view = renderHook(() => useChatBackgroundTasks(parent, stationA));
  act(() =>
    applyOrchestrationSnapshot(
      {
        sessions: [
          {
            provider: 'claude',
            threadId: 'old-session',
            conversationId: 'durable-conversation',
            status: 'ready',
            hasActiveTurn: false,
            childWork: {
              children: {
                observability: 'reported',
                observedAt: '2026-10-30T00:00:00.000Z',
                running: [
                  {
                    producer: 'engine-subagent',
                    reporterThreadId: 'old-session',
                    childId: 'older-child',
                    status: 'running',
                    title: 'Older live child',
                  },
                ],
              },
            },
          },
          {
            provider: 'claude',
            threadId: 'new-session',
            conversationId: 'durable-conversation',
            status: 'ready',
            hasActiveTurn: false,
          },
        ],
      },
      { apiBase: stationA },
    ),
  );
  expect(view.result.current.running.map((row) => row.title)).toContain(
    'Older live child',
  );
  expect(activeChatsStore.getSnapshot()[parent]?.currentSessionId).toBe(
    'new-session',
  );
  act(() =>
    applyOrchestrationSnapshot(
      {
        sessions: [
          {
            provider: 'claude',
            threadId: 'new-session',
            conversationId: 'durable-conversation',
            status: 'ready',
            hasActiveTurn: false,
          },
        ],
      },
      { apiBase: stationA },
    ),
  );
  expect(view.result.current.running).toHaveLength(0);
  expect(
    backgroundTasksStore.getSnapshot(stationA).providerReporters?.[
      'old-session'
    ],
  ).toBe(parent);
});

test('a cold snapshot preserves all live continuation associations beyond the inactive alias limit', () => {
  activeChatsStore.updateChat(parent, {
    conversationId: 'many-continuations',
    currentSessionId: 'new-session',
  });
  const view = renderHook(() => useChatBackgroundTasks(parent, stationA));
  const sessions = Array.from({ length: 60 }, (_, index) => ({
    provider: 'claude',
    threadId: `reporter-${index}`,
    conversationId: 'many-continuations',
    status: 'ready',
    hasActiveTurn: false,
    childWork: {
      children: {
        observability: 'reported' as const,
        observedAt: '2026-10-30T00:00:00.000Z',
        running: [
          {
            producer: 'engine-subagent' as const,
            reporterThreadId: `reporter-${index}`,
            childId: `live-${index}`,
            status: 'running' as const,
          },
        ],
      },
    },
  }));
  act(() => applyOrchestrationSnapshot({ sessions }, { apiBase: stationA }));
  expect(view.result.current.running).toHaveLength(60);
});

test('a cold snapshot refuses ambiguous conversation association', () => {
  activeChatsStore.updateChat(parent, {
    conversationId: 'shared-conversation',
    currentSessionId: 'new-session',
  });
  activeChatsStore.initChat('ambiguous-other', {
    agentSlug: 'agent',
    agentName: 'Agent',
    title: 'Other',
    conversationId: 'shared-conversation',
    currentSessionId: 'other-session',
  });
  try {
    const view = renderHook(() => useChatBackgroundTasks(parent, stationA));
    act(() =>
      applyOrchestrationSnapshot(
        {
          sessions: [
            {
              provider: 'claude',
              threadId: 'old-ambiguous',
              conversationId: 'shared-conversation',
              status: 'ready',
              hasActiveTurn: false,
              childWork: {
                children: {
                  observability: 'reported',
                  observedAt: '2026-10-30T00:00:00.000Z',
                  running: [
                    {
                      producer: 'engine-subagent',
                      reporterThreadId: 'old-ambiguous',
                      childId: 'unknown-owner',
                      status: 'running',
                    },
                  ],
                },
              },
            },
          ],
        },
        { apiBase: stationA },
      ),
    );
    expect(view.result.current.running).toHaveLength(0);
  } finally {
    activeChatsStore.removeChat('ambiguous-other');
  }
});

test('settled continuation reporter aliases stay bounded while live and uncertain associations remain', () => {
  const emit = (reporter: string, child: string, finish: boolean) => {
    activeChatsStore.updateChat(parent, { currentSessionId: reporter });
    handleOrchestrationEvent(stationA, {
      provider: 'codex',
      threadId: reporter,
      createdAt: '2026-10-30T00:00:00.000Z',
      method: 'child-work.updated',
      delta: {
        kind: 'upsert',
        item: {
          producer: 'engine-subagent',
          reporterThreadId: reporter,
          childId: child,
          status: 'running',
        },
      },
    });
    if (finish)
      handleOrchestrationEvent(stationA, {
        provider: 'codex',
        threadId: reporter,
        createdAt: '2026-10-30T00:00:00.000Z',
        method: 'child-work.updated',
        delta: {
          kind: 'settle',
          producer: 'engine-subagent',
          reporterThreadId: reporter,
          childId: child,
          status: 'completed',
        },
      });
  };
  act(() => {
    emit('live-reporter', 'live', false);
    for (let index = 0; index < 100; index++)
      emit(`settled-${index}`, `child-${index}`, true);
    emit('uncertain-reporter', 'uncertain', false);
    handleOrchestrationEvent(stationA, {
      provider: 'codex',
      threadId: 'uncertain-reporter',
      createdAt: '2026-10-30T00:00:00.000Z',
      method: 'child-work.updated',
      delta: {
        kind: 'snapshot',
        producer: 'engine-subagent',
        reporterThreadId: 'uncertain-reporter',
        running: [],
      },
    });
  });
  const aliases =
    backgroundTasksStore.getSnapshot(stationA).providerReporters ?? {};
  expect(aliases['live-reporter']).toBe(parent);
  expect(aliases['uncertain-reporter']).toBe(parent);
  expect(Object.keys(aliases).length).toBeLessThanOrEqual(52);
});
