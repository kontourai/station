/**
 * #4003 lead wake: a Task question opened by another Session, or answered,
 * reaches the Task's lead Session once, through the real path.
 *
 * The real pieces: one on-disk EventStore (Task memory, the room execution
 * bindings, the conversation inbox's Monument tables and the turn-dedup
 * claims all share its connection), the real `ProjectTaskRoomRuntime` write
 * path (`task_record`'s and a person's), the real `TaskQuestionWake` with the
 * production lead reader, the real `ThreadInboxDelivery`, and a real
 * `OrchestrationService` whose `sendTurn` claims the wake's key before it
 * calls a counting engine. What the lead receives is read from that engine.
 * A "restart" closes every piece and opens new ones on the same file with a
 * new process birth.
 */
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { GateTestAdapter } from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type {
  ProviderSendTurnInput,
  ProviderTurnStartResult,
} from '../../../providers/adapter-shape.js';
import { isForegroundIndeterminateShape } from '../../../routes/orchestration/orchestration.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { ProjectTaskRoomRuntime } from '../project-task-room-runtime.js';
import { ACTIVE_TURN_FOLD_METHODS } from '../session-lifecycle-service.js';
import { TURN_DEDUP_MAX_ENTRIES } from '../sqlite-turn-dedup-persistence.js';
import {
  createTaskLeadReader,
  TaskQuestionWake,
  type TaskQuestionWakeOutcome,
  taskQuestionWakeKey,
} from '../task-question-wake.js';
import { ThreadInboxDelivery, type ThreadInboxStore } from '../thread-inbox.js';

const OWNER = 'human:local:owner';
const LEAD = 'session-lead';
const HELPER = 'session-helper';
const TASK_ID = 'task-1';
const CREATED_AT = '2026-08-20T00:00:00.000Z';

const makeTempDir = trackTempDirs();

/** Every engine send into the lead, across every incarnation. */
let sends: string[] = [];
let incarnation = 0;
let sequence = 0;

class CountingAdapter extends GateTestAdapter {
  override async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    sends.push(input.input);
    return { threadId: input.threadId, turnId: `turn-${sends.length}` };
  }
}

function baseTask(): TaskRecord {
  return {
    id: TASK_ID,
    projectId: 'project-1',
    title: 'Room task',
    description: '',
    priority: 'normal',
    status: 'in_progress',
    createdBy: 'owner-1',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    agentId: 'agent-lead',
    sessionId: LEAD,
  } as TaskRecord;
}

interface World {
  adapter: CountingAdapter;
  store: EventStore;
  service: OrchestrationService;
  inbox: ThreadInboxDelivery;
  runtime: ProjectTaskRoomRuntime;
  wakes: TaskQuestionWakeOutcome[];
  warn: ReturnType<typeof vi.fn>;
  task: { current: TaskRecord };
  /** What the wake saw committed when it submitted, per submit. */
  committedAtSubmit: number[];
}

const open: World[] = [];

function boot(
  path: string,
  options: {
    task?: TaskRecord;
    wrapStore?: (store: ThreadInboxStore) => ThreadInboxStore;
  } = {},
): World {
  incarnation += 1;
  const birth = `boot-${incarnation}`;
  const store = new EventStore(path, TURN_DEDUP_MAX_ENTRIES, {
    exact: () => ({ pid: process.pid, start: birth }),
    probe: () => ({
      state: 'exact',
      identity: { pid: process.pid, start: birth },
    }),
  });
  const bus = new EventBus();
  const adapter = new CountingAdapter();
  const service = new OrchestrationService({
    adapterRegistry: {
      register() {},
      get: (provider) => (provider === adapter.provider ? adapter : undefined),
      list: () => [adapter],
    },
    eventBus: bus,
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  const inboxStore = store.threadInboxStore();
  const inbox = new ThreadInboxDelivery({
    store: options.wrapStore ? options.wrapStore(inboxStore) : inboxStore,
    foldEvents: (threadId) =>
      store
        .listEventsByMethods(threadId, ACTIVE_TURN_FOLD_METHODS)
        .map((stored) => ({
          sequence: stored.sequence,
          event: stored.payload,
        })),
    headSequence: (threadId) => store.readSessionInventoryHighWater(threadId),
    coordinatorBusy: (threadId) => service.hasActiveTurn(threadId),
    conversationOf: (threadId) =>
      store.conversationForSession(threadId)?.conversationId ?? threadId,
    currentSessionId: (conversationId) =>
      service.currentConversationSessionId(conversationId),
    // The production rule's owner branch: the current Session's recorded owner.
    mayContinue: (conversationId, userId) =>
      service.sessionRecordedOwnerId(
        service.currentConversationSessionId(conversationId),
      ) === userId,
    inspectDelivery: (conversationId, clientTurnId) =>
      service.inspectTurnDelivery(
        conversationId,
        clientTurnId,
        INTERNAL_SESSION_READ_SCOPE,
      ),
    start: async ({ threadId, payload, clientTurnId }) => {
      try {
        const result = (await service.dispatch({
          type: 'sendTurn',
          input: { threadId, input: payload.message, clientTurnId },
        })) as ProviderTurnStartResult;
        return {
          outcome: 'started',
          conversationId: threadId,
          sessionId: threadId,
          turnId: result.turnId,
        };
      } catch (error) {
        if (isForegroundIndeterminateShape(error))
          return { outcome: 'indeterminate' };
        throw error;
      }
    },
    subscribe: (listener) =>
      bus.subscribe((frame) => {
        const event = (frame.data as { event?: CanonicalRuntimeEvent })?.event;
        if (frame.event === 'orchestration:event' && event)
          listener({ threadId: event.threadId, method: event.method });
      }),
    logger: { warn: vi.fn() },
    retryDelaysMs: [5, 10, 20, 40],
  });
  inbox.start();
  const task = { current: options.task ?? baseTask() };
  const warn = vi.fn();
  const wakes: TaskQuestionWakeOutcome[] = [];
  const committedAtSubmit: number[] = [];
  const wake = new TaskQuestionWake({
    readTask: (id) => (id === task.current.id ? task.current : null),
    conversationOf: (sessionId) =>
      store.conversationForSession(sessionId)?.conversationId ?? sessionId,
    readLead: createTaskLeadReader({ eventStore: store, service }),
    submit: (input) => {
      committedAtSubmit.push(
        store
          .taskMemoryStore()
          .listRecords({ taskId: TASK_ID, taskCreatedAt: CREATED_AT })
          .reduce((sum, record) => sum + record.version, 0),
      );
      return inbox.submit(input);
    },
    logger: { warn },
  });
  const runtime = new ProjectTaskRoomRuntime({
    taskGraph: {
      readTaskView: (id) => (id === task.current.id ? task.current : null),
    },
    projectForId: (id) =>
      id === task.current.projectId ? { id, slug: 'project' } : undefined,
    history: (authority) =>
      store.createProjectTaskRoomHistory({
        capabilities: authority.capabilities,
        agents: authority.agents,
        ...(authority.links ? { links: authority.links } : {}),
      }),
    working: store.createProjectTaskRoomWorkingState(),
    requestAuthority: {
      resolve: async () => ({
        kind: 'granted' as const,
        operatorId: 'owner-1',
        deviceId: 'device-1',
        policyRevision: 'pairing-v1',
      }),
    },
    readExecutionBinding: (sessionId) =>
      store.readProjectTaskRoomExecutionBinding(sessionId),
    memory: store.taskMemoryStore(),
    readAgentRequests: async () => [
      {
        sessionId: HELPER,
        agentId: 'agent-helper',
        ownerOperatorId: 'owner-1',
        taskCreatedAt: task.current.createdAt,
        createdAt: task.current.createdAt,
      },
    ],
    afterTaskRecord: async (input) => {
      const outcome = await wake.wake(input);
      wakes.push(outcome);
      return outcome;
    },
  });
  const world: World = {
    adapter,
    store,
    service,
    inbox,
    runtime,
    wakes,
    warn,
    task,
    committedAtSubmit,
  };
  open.push(world);
  return world;
}

async function crash(world: World) {
  world.inbox.stop();
  open.splice(open.indexOf(world), 1);
  await world.runtime.close();
  world.store.close();
}

async function emit(
  world: World,
  method: string,
  fields: Record<string, unknown>,
) {
  sequence += 1;
  world.adapter.events.push({
    eventId: `wake-event-${sequence}`,
    provider: 'claude',
    threadId: LEAD,
    createdAt: new Date().toISOString(),
    method,
    ...fields,
  } as unknown as CanonicalRuntimeEvent);
  await new Promise((resolve) => setTimeout(resolve, 5));
}

/** The lead Session is live and idle, owned by OWNER. */
async function startLead(world: World) {
  await world.service.dispatch({
    type: 'startSession',
    input: { threadId: LEAD, provider: 'claude' },
  });
  await emit(world, 'session.started', {
    sessionId: LEAD,
    metadata: { userId: OWNER },
  });
}

async function bindAll(world: World) {
  for (const sessionId of [LEAD, HELPER])
    expect(
      await world.store.bindProjectTaskRoomExecution({
        projectId: 'project-1',
        taskId: TASK_ID,
        sessionId,
      }),
    ).toEqual({ kind: 'bound' });
}

async function settle(world: World) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  await world.inbox.idle();
}

const QUESTION = 'Which storage tier should the cache use?';
const ANSWER = 'Use the warm tier.';

const askAsHelper = (world: World, key = 'tier') =>
  world.runtime.writeTaskRecordForSession({
    sessionId: HELPER,
    write: { kind: 'question', key, text: QUESTION },
  });

const records = (world: World) =>
  world.store
    .taskMemoryStore()
    .listRecords({ taskId: TASK_ID, taskCreatedAt: CREATED_AT });

const wakeSends = () =>
  sends.filter((text) => text.startsWith('Task question'));

afterEach(async () => {
  for (const world of open.splice(0)) {
    world.inbox.stop();
    await world.inbox.idle();
    await world.runtime.close();
    await world.service.shutdown();
    world.store.close();
  }
  sends = [];
});

describe('Task question lead wake (#4003)', () => {
  const path = () =>
    join(makeTempDir('task-question-wake-'), 'orchestration.sqlite');

  test("a helper Session's question reaches the idle lead once, as a turn naming the key, the asker and how to answer", async () => {
    const world = boot(path());
    await bindAll(world);
    await startLead(world);
    expect(await askAsHelper(world)).toMatchObject({ kind: 'recorded' });
    await settle(world);
    expect(wakeSends()).toHaveLength(1);
    const [text] = wakeSends();
    expect(text).toContain('"tier"');
    expect(text).toContain(`Session ${HELPER}`);
    expect(text).toContain(QUESTION);
    expect(text).toContain('action: "answer"');
    expect(world.wakes).toEqual([
      {
        kind: 'queued',
        conversationId: LEAD,
        clientTurnId: taskQuestionWakeKey(
          { taskId: TASK_ID, taskCreatedAt: CREATED_AT },
          { key: 'tier', version: 1, action: 'set' },
        ),
      },
    ]);
    // Record before effect: when the wake submitted, version 1 had committed.
    expect(world.committedAtSubmit).toEqual([1]);
    expect(world.inbox.list(LEAD)).toMatchObject([{ state: 'sent' }]);
  });

  test("a person's answer reaches the lead once; the open question is unchanged by the wake", async () => {
    const world = boot(path());
    await bindAll(world);
    await startLead(world);
    await askAsHelper(world);
    await settle(world);
    expect(wakeSends()).toHaveLength(1);
    expect(
      await world.runtime.writeTaskRecordForPerson({
        taskId: TASK_ID,
        request: new Request('http://station.test/'),
        write: {
          kind: 'question',
          key: 'tier',
          action: 'answer',
          text: ANSWER,
        },
      }),
    ).toMatchObject({ kind: 'recorded', record: { version: 2 } });
    await emit(world, 'turn.started', { turnId: 'turn-1' });
    await emit(world, 'turn.completed', { turnId: 'turn-1' });
    await settle(world);
    expect(wakeSends()).toHaveLength(2);
    expect(wakeSends()[1]).toContain('answered by a person (owner-1)');
    expect(wakeSends()[1]).toContain(ANSWER);
    expect(records(world)).toMatchObject([
      { key: 'tier', version: 2, state: 'answered', answer: ANSWER },
    ]);
  });

  test('a busy lead gets the wake queued, and only when its turn ends', async () => {
    const world = boot(path());
    await bindAll(world);
    await startLead(world);
    await world.service.dispatch({
      type: 'sendTurn',
      input: { threadId: LEAD, input: 'work', clientTurnId: 'first' },
    });
    await emit(world, 'turn.started', { turnId: 'turn-1', prompt: 'work' });
    await askAsHelper(world);
    await settle(world);
    expect(wakeSends()).toEqual([]);
    expect(world.inbox.list(LEAD)).toMatchObject([{ state: 'queued' }]);
    await emit(world, 'turn.completed', { turnId: 'turn-1' });
    await settle(world);
    expect(wakeSends()).toHaveLength(1);
  });

  test('a retry of the same version, and a restart before and after placement, never send twice', async () => {
    const file = path();
    const first = boot(file);
    await bindAll(first);
    await startLead(first);
    await first.service.dispatch({
      type: 'sendTurn',
      input: { threadId: LEAD, input: 'work', clientTurnId: 'first' },
    });
    await emit(first, 'turn.started', { turnId: 'turn-1', prompt: 'work' });
    await askAsHelper(first);
    const [record] = records(first);
    const incarnationKey = { taskId: TASK_ID, taskCreatedAt: CREATED_AT };
    // A retry of the same committed version (the hook run again).
    const wake = new TaskQuestionWake({
      readTask: () => first.task.current,
      conversationOf: (id) => id,
      readLead: createTaskLeadReader({
        eventStore: first.store,
        service: first.service,
      }),
      submit: (input) => first.inbox.submit(input),
      logger: { warn: vi.fn() },
    });
    expect(
      await wake.wake({ incarnation: incarnationKey, record: record! }),
    ).toMatchObject({ kind: 'queued' });
    await settle(first);
    expect(first.inbox.list(LEAD)).toHaveLength(1);
    expect(wakeSends()).toEqual([]);
    await crash(first);

    // Restart while the wake waits: the reattached lead's turn ends, and the
    // one queued wake is placed once.
    const second = boot(file);
    await second.inbox.reconcile();
    await startLead(second);
    await settle(second);
    expect(wakeSends()).toHaveLength(1);
    // The same version again after placement, then another restart.
    const again = new TaskQuestionWake({
      readTask: () => second.task.current,
      conversationOf: (id) => id,
      readLead: createTaskLeadReader({
        eventStore: second.store,
        service: second.service,
      }),
      submit: (input) => second.inbox.submit(input),
      logger: { warn: vi.fn() },
    });
    await again.wake({ incarnation: incarnationKey, record: record! });
    await settle(second);
    await crash(second);
    const third = boot(file);
    await startLead(third);
    await third.inbox.reconcile();
    await settle(third);
    expect(wakeSends()).toHaveLength(1);
    expect(third.inbox.list(LEAD)).toMatchObject([{ state: 'sent' }]);
  });

  test("the lead's own question and its own answer wake no one", async () => {
    const world = boot(path());
    await bindAll(world);
    await startLead(world);
    expect(
      await world.runtime.writeTaskRecordForSession({
        sessionId: LEAD,
        write: { kind: 'question', key: 'mine', text: 'Ask a person?' },
      }),
    ).toMatchObject({ kind: 'recorded' });
    await askAsHelper(world, 'theirs');
    await settle(world);
    expect(wakeSends()).toHaveLength(1);
    expect(
      await world.runtime.writeTaskRecordForSession({
        sessionId: LEAD,
        write: {
          kind: 'question',
          key: 'theirs',
          action: 'answer',
          text: 'Done.',
        },
      }),
    ).toMatchObject({ kind: 'recorded' });
    await emit(world, 'turn.started', { turnId: 'turn-1' });
    await emit(world, 'turn.completed', { turnId: 'turn-1' });
    await settle(world);
    expect(wakeSends()).toHaveLength(1);
    expect(world.wakes.map((outcome) => outcome.kind)).toEqual([
      'skipped',
      'queued',
      'skipped',
    ]);
    expect(world.wakes[0]).toEqual({ kind: 'skipped', reason: 'own' });
    expect(world.wakes[2]).toEqual({ kind: 'skipped', reason: 'own' });
  });

  test('no live lead sends nothing, and the question stays open for Needs you', async () => {
    const world = boot(path(), {
      task: { ...baseTask(), sessionId: undefined },
    });
    // The helper keeps write access as a recorded independent request.
    await bindAll(world);
    await startLead(world);
    expect(await askAsHelper(world)).toMatchObject({ kind: 'recorded' });
    // A lead Session that has stopped is not live either.
    world.task.current = baseTask();
    await emit(world, 'session.exited', { sessionId: LEAD, reason: 'done' });
    await askAsHelper(world, 'second');
    await settle(world);
    expect(wakeSends()).toEqual([]);
    expect(world.wakes).toEqual([
      { kind: 'skipped', reason: 'no-live-lead' },
      { kind: 'skipped', reason: 'no-live-lead' },
    ]);
    expect(world.inbox.list(LEAD)).toEqual([]);
    expect(
      world.store
        .taskMemoryStore()
        .countOpenQuestions([{ taskId: TASK_ID, taskCreatedAt: CREATED_AT }])
        .get(TASK_ID),
    ).toBe(2);
  });

  test('a failed delivery leaves the memory write committed and the failure logged', async () => {
    const world = boot(path(), {
      wrapStore: (store) => ({
        ...store,
        submit: () => {
          throw new Error('inbox disk full');
        },
      }),
    });
    await bindAll(world);
    await startLead(world);
    expect(await askAsHelper(world)).toMatchObject({
      kind: 'recorded',
      record: { key: 'tier', version: 1, state: 'open' },
    });
    await settle(world);
    expect(records(world)).toMatchObject([{ key: 'tier', state: 'open' }]);
    expect(wakeSends()).toEqual([]);
    expect(world.wakes).toMatchObject([{ kind: 'failed', reason: 'error' }]);
    expect(world.warn).toHaveBeenCalledWith(
      'task question wake not delivered',
      expect.objectContaining({
        taskId: TASK_ID,
        key: 'tier',
        version: 1,
        action: 'set',
        reason: 'error',
        detail: 'inbox disk full',
      }),
    );
  });

  test('a write refused at commit wakes no one', async () => {
    const world = boot(path());
    await bindAll(world);
    await startLead(world);
    // Fill the open-question cap, then ask one more: refused, nothing written.
    for (let index = 0; index < 20; index += 1)
      await world.runtime.writeTaskRecordForSession({
        sessionId: LEAD,
        write: { kind: 'question', key: `q-${index}`, text: 'Open.' },
      });
    expect(await askAsHelper(world, 'over-cap')).toMatchObject({
      kind: 'refused',
    });
    await settle(world);
    expect(wakeSends()).toEqual([]);
    expect(world.wakes.every((outcome) => outcome.kind === 'skipped')).toBe(
      true,
    );
    expect(world.wakes).toHaveLength(20);
  });
});
