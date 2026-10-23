/**
 * #4003 Task memory authority at the room seam: the real
 * `ProjectTaskRoomRuntime` over a real orchestration SQLite database (its
 * room execution binding table and the Task memory store). Every outcome is
 * read back from the store.
 */
import { join } from 'node:path';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { afterEach, describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';
import { ProjectTaskRoomRuntime } from '../project-task-room-runtime.js';

const makeTempDir = trackTempDirs();
const LEAD = 'session-lead';
const HELPER = 'session-helper';
const STRANGER = 'session-stranger';

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

function baseTask(): TaskRecord {
  return {
    id: 'task-1',
    projectId: 'project-1',
    title: 'Room task',
    description: '',
    priority: 'normal',
    status: 'in_progress',
    createdBy: 'owner-1',
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    agentId: 'agent-lead',
    sessionId: LEAD,
  } as TaskRecord;
}

async function setup() {
  const directory = makeTempDir('station-task-memory-room-');
  const store = new EventStore(join(directory, 'orchestration.sqlite'));
  let task = baseTask();
  /** Runs once, on the binding read that follows the authority check. */
  let onSecondBindingRead: (() => void) | undefined;
  let bindingReads = 0;
  const runtime = new ProjectTaskRoomRuntime({
    taskGraph: { readTaskView: (id) => (id === task.id ? task : null) },
    projectForId: (id) =>
      id === task.projectId ? { id, slug: 'project' } : undefined,
    history: (authority) =>
      store.createProjectTaskRoomHistory({
        capabilities: authority.capabilities,
        agents: authority.agents,
        ...(authority.links ? { links: authority.links } : {}),
      }),
    working: store.createProjectTaskRoomWorkingState(),
    requestAuthority: {
      resolve: async (request) =>
        request.headers.get('x-test-principal') === 'revoked'
          ? { kind: 'revoked' as const }
          : {
              kind: 'granted' as const,
              operatorId: 'owner-1',
              deviceId: 'device-1',
              policyRevision: 'pairing-v1',
            },
    },
    readExecutionBinding: (sessionId) => {
      bindingReads += 1;
      if (bindingReads === 2) onSecondBindingRead?.();
      return store.readProjectTaskRoomExecutionBinding(sessionId);
    },
    memory: store.taskMemoryStore(),
    // HELPER is an independently requested agent of this Task incarnation.
    readAgentRequests: async () => [
      {
        sessionId: HELPER,
        agentId: 'agent-helper',
        ownerOperatorId: 'owner-1',
        taskCreatedAt: task.createdAt,
        createdAt: task.createdAt,
      },
    ],
  });
  closers.push(() => {
    store.close();
  });
  closers.push(async () => {
    await runtime.close();
  });
  const bind = async (sessionId: string) =>
    expect(
      await store.bindProjectTaskRoomExecution({
        projectId: task.projectId,
        taskId: task.id,
        sessionId,
      }),
    ).toEqual({ kind: 'bound' });
  const incarnation = () => ({
    taskId: task.id,
    taskCreatedAt: task.createdAt,
  });
  const memory = () => ({
    summary: store.taskMemoryStore().readSummary(incarnation()),
    records: store.taskMemoryStore().listRecords(incarnation()),
  });
  return {
    runtime,
    bind,
    memory,
    get task() {
      return task;
    },
    replaceTask(next: TaskRecord) {
      task = next;
    },
    armSecondBindingRead(run: () => void) {
      bindingReads = 0;
      onSecondBindingRead = run;
    },
  };
}

describe('Task memory authority through the Task room', () => {
  test('the lead Session and a recorded independent request may write; Task status never changes', async () => {
    const room = await setup();
    await room.bind(LEAD);
    await room.bind(HELPER);
    const statusBefore = room.task.status;
    expect(
      await room.runtime.updateTaskSummaryForSession({
        sessionId: LEAD,
        text: 'Parser fixed.',
        baseRevision: 0,
      }),
    ).toMatchObject({
      kind: 'updated',
      taskId: 'task-1',
      summary: { revision: 1, author: { kind: 'session', sessionId: LEAD } },
    });
    expect(
      await room.runtime.writeTaskRecordForSession({
        sessionId: HELPER,
        write: { kind: 'question', key: 'tier', text: 'Which tier?' },
      }),
    ).toMatchObject({
      kind: 'recorded',
      record: { author: { kind: 'session', sessionId: HELPER } },
    });
    expect(room.memory()).toMatchObject({
      summary: { text: 'Parser fixed.' },
      records: [{ key: 'tier', state: 'open' }],
    });
    expect(room.task.status).toBe(statusBefore);
  });

  test('a Session with no binding, or bound but neither lead nor request, is refused and writes nothing', async () => {
    const room = await setup();
    const attempt = (sessionId: string) =>
      Promise.all([
        room.runtime.updateTaskSummaryForSession({
          sessionId,
          text: 'Not mine.',
          baseRevision: 0,
        }),
        room.runtime.writeTaskRecordForSession({
          sessionId,
          write: { kind: 'decision', key: 'mine', text: 'Not mine.' },
        }),
      ]);
    // No binding at all.
    expect(await attempt(STRANGER)).toEqual([
      { kind: 'no-task' },
      { kind: 'no-task' },
    ]);
    // Bound to the Task's room, but not its lead and no recorded request.
    await room.bind(STRANGER);
    expect(await attempt(STRANGER)).toEqual([
      { kind: 'no-task' },
      { kind: 'no-task' },
    ]);
    expect(room.memory()).toEqual({ summary: undefined, records: [] });
  });

  test('authority is re-checked at commit: a lead replaced before the write records nothing', async () => {
    const room = await setup();
    await room.bind(LEAD);
    // The first binding read is the authority check; the second runs inside
    // the write transaction. Between them the Task gets a new lead Session.
    room.armSecondBindingRead(() =>
      room.replaceTask({ ...room.task, sessionId: 'session-new-lead' }),
    );
    expect(
      await room.runtime.writeTaskRecordForSession({
        sessionId: LEAD,
        write: { kind: 'decision', key: 'late', text: 'Late.' },
      }),
    ).toEqual({ kind: 'no-task' });
    expect(room.memory().records).toEqual([]);
  });

  test('a person edits the summary and answers with the room authority; a revoked request does neither', async () => {
    const room = await setup();
    await room.bind(LEAD);
    await room.runtime.writeTaskRecordForSession({
      sessionId: LEAD,
      write: { kind: 'question', key: 'ship', text: 'Ship Friday?' },
    });
    const request = new Request('http://station');
    expect(
      await room.runtime.updateTaskSummaryForPerson({
        taskId: 'task-1',
        request,
        text: 'Person view.',
        baseRevision: 0,
      }),
    ).toMatchObject({
      kind: 'updated',
      summary: { author: { kind: 'person', principalId: 'owner-1' } },
    });
    expect(
      await room.runtime.writeTaskRecordForPerson({
        taskId: 'task-1',
        request,
        write: {
          kind: 'question',
          key: 'ship',
          action: 'answer',
          text: 'Yes.',
        },
      }),
    ).toMatchObject({ kind: 'recorded', record: { state: 'answered' } });
    const revoked = new Request('http://station', {
      headers: { 'x-test-principal': 'revoked' },
    });
    expect(
      await room.runtime.updateTaskSummaryForPerson({
        taskId: 'task-1',
        request: revoked,
        text: 'Not mine.',
        baseRevision: 1,
      }),
    ).toEqual({ kind: 'not-found' });
    expect(
      await room.runtime.readTaskMemory({ taskId: 'task-1', request: revoked }),
    ).toEqual({ kind: 'not-found' });
    const read = await room.runtime.readTaskMemory({
      taskId: 'task-1',
      request,
      summaryHistory: 5,
    });
    expect(read).toMatchObject({
      kind: 'available',
      summary: { revision: 1, text: 'Person view.' },
      records: [{ key: 'ship', answer: 'Yes.' }],
      history: { total: 1 },
    });
  });
});
