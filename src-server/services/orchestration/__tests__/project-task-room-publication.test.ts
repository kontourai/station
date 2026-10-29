import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';
import { projectTaskRoomDocumentId } from '../project-task-room-document-id.js';
import { ProjectTaskRoomRuntime } from '../project-task-room-runtime.js';

const makeTempDir = trackTempDirs();
const task = {
  id: 'task-1',
  projectId: 'project-1',
  title: 'Room task',
  description: '',
  priority: 'normal',
  status: 'ready',
  createdBy: 'operator',
  createdAt: '2026-08-20T00:00:00.000Z',
  updatedAt: '2026-08-20T00:00:00.000Z',
} as const;

test.each(['answer-read', 'room-open'] as const)(
  'replacing a Task during %s publishes nothing',
  async (boundary) => {
    const directory = makeTempDir('room-answer-recheck-');
    const store = new EventStore(join(directory, 'events.sqlite'));
    let current: TaskRecord = {
      ...task,
      agentId: 'agent',
      sessionId: 'session',
    };
    let answersRead = false;
    const runtime = new ProjectTaskRoomRuntime({
      taskGraph: { readTaskView: () => current },
      projectForId: (id) => ({ id, slug: 'project' }),
      history: (authority) => {
        const history = store.createProjectTaskRoomHistory(authority);
        return {
          ...history,
          open: async (input) => {
            const result = await history.open(input);
            if (answersRead && boundary === 'room-open')
              current = { ...current, createdAt: '2026-10-15T00:00:00.000Z' };
            return result;
          },
        };
      },
      working: store.createProjectTaskRoomWorkingState(),
      requestAuthority: {
        resolve: async () => ({
          kind: 'granted',
          operatorId: 'operator',
          deviceId: 'device',
          policyRevision: 'test',
        }),
      },
      readAgentAnswers: async () => {
        answersRead = true;
        if (boundary === 'answer-read')
          current = { ...current, createdAt: '2026-10-15T00:00:00.000Z' };
        return [
          {
            turnId: 'turn-1',
            text: 'Stale answer',
            occurredAt: task.createdAt,
          },
        ];
      },
    });
    const request = new Request('http://station');
    try {
      await runtime.discover({ taskId: task.id, request });
      await runtime.publishAgentAnswers(task.id, 'session');
      const history = await runtime.history({ taskId: task.id, request });
      expect(history).toMatchObject({ kind: 'available', records: [] });
    } finally {
      await runtime.close();
      store.close();
    }
  },
);

test('a reconcile with no new answers performs no history open or append, including after restart', async () => {
  const directory = makeTempDir('room-quiet-reconcile-');
  const store = new EventStore(join(directory, 'events.sqlite'));
  const opens = vi.fn();
  const appends = vi.fn();
  const create = () =>
    new ProjectTaskRoomRuntime({
      taskGraph: {
        readTaskView: () => ({
          ...task,
          agentId: 'agent',
          sessionId: 'session',
        }),
      },
      projectForId: (id) => ({ id, slug: 'project' }),
      history: (authority) => {
        const history = store.createProjectTaskRoomHistory(authority);
        return {
          ...history,
          open: async (input) => {
            opens();
            return history.open(input);
          },
          append: async (input) => {
            appends();
            return history.append(input);
          },
        };
      },
      working: store.createProjectTaskRoomWorkingState(),
      requestAuthority: {
        resolve: async () => ({
          kind: 'granted',
          operatorId: 'operator',
          deviceId: 'device',
          policyRevision: 'test',
        }),
      },
      readAgentRequests: async () => [
        {
          sessionId: 'session',
          agentId: 'agent',
          ownerOperatorId: task.createdBy,
          taskCreatedAt: task.createdAt,
          createdAt: task.createdAt,
        },
      ],
      readAgentLifecycle: async () => ({
        provider: 'claude',
        outcome: 'completed',
      }),
      readDisplayName: async (id) =>
        id === 'operator' ? 'Durable Alice' : undefined,
      readAgentLabel: async () => 'Durable Researcher',
      readAgentAnswers: async () => [
        { turnId: 'turn-1', text: 'Only answer', occurredAt: task.createdAt },
      ],
    });
  let runtime = create();
  try {
    const request = new Request('http://station');
    await runtime.discover({ taskId: task.id, request });
    await runtime.message({
      taskId: task.id,
      request,
      proposalId: 'durable-human',
      text: 'Human message',
    });
    await runtime.message({
      taskId: task.id,
      request,
      proposalId: 'owner-status',
      text: 'Status → In review',
      correlationId: 'room-status',
    });
    await runtime.message({
      taskId: task.id,
      request,
      proposalId: 'owner-thread',
      text: 'Owner-only thread reply',
      correlationId: 'room-thread:session',
    });
    await runtime.reconcileAgentLifecycles([task.id]);
    expect(appends.mock.calls.length).toBeGreaterThan(0);
    opens.mockClear();
    appends.mockClear();
    await runtime.reconcileAgentLifecycles([task.id]);
    expect(opens).not.toHaveBeenCalled();
    expect(appends).not.toHaveBeenCalled();
    await runtime.close();
    runtime = create();
    expect(
      await runtime.history({ taskId: task.id, request, project: true }),
    ).toMatchObject({
      kind: 'available',
      records: expect.arrayContaining([
        expect.objectContaining({
          actor: expect.objectContaining({ label: 'Durable Alice' }),
        }),
        expect.objectContaining({
          actor: expect.objectContaining({ label: 'Durable Researcher' }),
          execution: {
            sessionId: 'session',
            turnId: 'turn-1',
            runId: 'orchestration:claude:session',
          },
        }),
      ]),
    });
    await runtime.reconcileAgentLifecycles([task.id]);
    expect(opens).not.toHaveBeenCalled();
    expect(appends).not.toHaveBeenCalled();
    expect(
      await runtime.history({ taskId: task.id, request, project: true }),
    ).toMatchObject({
      kind: 'available',
      records: expect.arrayContaining([
        expect.objectContaining({
          actor: expect.objectContaining({ label: 'Durable Alice' }),
        }),
        expect.objectContaining({
          actor: expect.objectContaining({ label: 'Durable Researcher' }),
          execution: {
            sessionId: 'session',
            turnId: 'turn-1',
            runId: 'orchestration:claude:session',
          },
        }),
      ]),
    });
    const guest = await runtime.sharedHistory({
      taskId: task.id,
      request,
      current: async () => true,
    });
    const label = `Participant ${createHash('sha256').update('operator\u0000device').digest('hex').slice(-12)}`;
    expect(guest).toMatchObject({
      kind: 'available',
      records: expect.arrayContaining([
        expect.objectContaining({ actor: expect.objectContaining({ label }) }),
      ]),
    });
    expect(JSON.stringify(guest)).not.toContain('Durable Alice');
    expect(JSON.stringify(guest)).not.toContain('Status → In review');
    expect(JSON.stringify(guest)).not.toContain('Owner-only thread reply');
    const owner = await runtime.history({
      taskId: task.id,
      request,
      project: true,
    });
    expect(JSON.stringify(owner)).toContain('Status → In review');
    expect(JSON.stringify(owner)).toContain('Owner-only thread reply');
  } finally {
    await runtime.close();
    store.close();
  }
});

test('answer read and append failures retain a visible full-run fallback, then successful publication clears it', async () => {
  const store = new EventStore(
    join(makeTempDir('room-unposted-answer-'), 'events.sqlite'),
  );
  let failRead = false,
    failAppend = false;
  let turnId = 'turn-1';
  const request = new Request('http://station');
  const runtime = new ProjectTaskRoomRuntime({
    taskGraph: {
      readTaskView: () => ({ ...task, agentId: 'agent', sessionId: 'session' }),
    },
    projectForId: (id) => ({ id, slug: 'project' }),
    history: (authority) => {
      const history = store.createProjectTaskRoomHistory(authority);
      return {
        ...history,
        append: async (input) =>
          failAppend && input.intent.proposalId.startsWith('room-answer:')
            ? { kind: 'unavailable' as const }
            : history.append(input),
      };
    },
    working: store.createProjectTaskRoomWorkingState(),
    requestAuthority: {
      resolve: async () => ({
        kind: 'granted',
        operatorId: 'operator',
        deviceId: 'device',
        policyRevision: 'test',
      }),
    },
    readAgentRequests: async () => [
      {
        sessionId: 'session',
        agentId: 'agent',
        ownerOperatorId: task.createdBy,
        taskCreatedAt: task.createdAt,
        createdAt: task.createdAt,
      },
    ],
    readAgentLifecycle: async () => ({
      provider: 'claude',
      outcome: 'completed',
    }),
    readAgentAnswers: async () => {
      if (failRead) throw new Error('Controlled answer read failure');
      return [{ turnId, text: `Answer ${turnId}`, occurredAt: task.createdAt }];
    },
  });
  try {
    await runtime.reconcileAgentLifecycles([task.id]);
    turnId = 'turn-2';
    failRead = true;
    await expect(runtime.reconcileAgentLifecycles([task.id])).rejects.toThrow(
      'Controlled answer read failure',
    );
    const blocked = async () =>
      expect(await runtime.liveActivity({ request })).toMatchObject({
        kind: 'available',
        projection: {
          participants: [
            expect.objectContaining({
              work: expect.objectContaining({
                workState: 'blocked',
                workName: "Answer couldn't be posted",
              }),
            }),
          ],
        },
      });
    await blocked();
    failRead = false;
    failAppend = true;
    await runtime.reconcileAgentLifecycles([task.id]);
    await blocked();
    expect(
      JSON.stringify(await runtime.history({ taskId: task.id, request })),
    ).not.toContain('Answer turn-2');
    failAppend = false;
    await runtime.reconcileAgentLifecycles([task.id]);
    expect(
      JSON.stringify(await runtime.history({ taskId: task.id, request })),
    ).toContain('Answer turn-2');
    expect(await runtime.liveActivity({ request })).toMatchObject({
      kind: 'available',
      projection: { participants: [] },
    });
  } finally {
    await runtime.close();
    store.close();
  }
});

test('restart removes a committed lifecycle from the pending outbox without reappending history', async () => {
  const store = new EventStore(
    join(makeTempDir('room-lifecycle-cleanup-'), 'events.sqlite'),
  );
  const scope = {
    projectId: task.projectId,
    taskId: task.id,
    documentId: projectTaskRoomDocumentId({
      projectId: task.projectId,
      taskId: task.id,
    }),
  };
  let failCleanup = true;
  const append = vi.fn();
  const create = () => {
    const working = store.createProjectTaskRoomWorkingState();
    return new ProjectTaskRoomRuntime({
      taskGraph: {
        readTaskView: () => ({
          ...task,
          agentId: 'agent',
          sessionId: 'session',
        }),
      },
      projectForId: (id) => ({ id, slug: 'project' }),
      history: (authority) => {
        const history = store.createProjectTaskRoomHistory(authority);
        return {
          ...history,
          append: async (input) => {
            append(input.intent.proposalId);
            return history.append(input);
          },
        };
      },
      working: {
        ...working,
        removeAgentLifecycle: async (input) => {
          if (failCleanup) throw new Error('Controlled crash after append');
          return working.removeAgentLifecycle(input);
        },
      },
      requestAuthority: {
        resolve: async () => ({
          kind: 'granted',
          operatorId: 'operator',
          deviceId: 'device',
          policyRevision: 'test',
        }),
      },
    });
  };
  let runtime = create();
  try {
    await expect(
      runtime.publishAgentFinished({
        taskId: task.id,
        sessionId: 'session',
        provider: 'claude',
        outcome: 'completed',
        occurredAt: task.createdAt,
      }),
    ).rejects.toThrow('Controlled crash after append');
    await runtime.close();
    failCleanup = false;
    runtime = create();
    append.mockClear();
    await runtime.reconcileAgentLifecycles([task.id]);
    const observer = store.createProjectTaskRoomWorkingState();
    try {
      expect(await observer.readAgentLifecycles({ scope })).toEqual([]);
    } finally {
      await observer.close();
    }
    expect(append.mock.calls.map(([proposalId]) => proposalId)).toEqual([
      'agent:started:session',
    ]);
  } finally {
    await runtime.close();
    store.close();
  }
});
