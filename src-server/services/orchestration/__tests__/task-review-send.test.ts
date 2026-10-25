import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { TaskRecord } from '@kontourai/station-contracts/task-graph';
import { deriveThreadState } from '@kontourai/station-contracts/task-review';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type {
  ProviderSendTurnInput,
  ProviderTurnStartResult,
} from '../../../providers/adapter-shape.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { ACTIVE_TURN_FOLD_METHODS } from '../session-lifecycle-service.js';
import { TURN_DEDUP_MAX_ENTRIES } from '../sqlite-turn-dedup-persistence.js';
import { createTaskLeadReader } from '../task-question-wake.js';
import { TaskReviewSend } from '../task-review-send.js';
import { ThreadInboxDelivery } from '../thread-inbox.js';

const makeTempDir = trackTempDirs();
const LEAD = 'review-lead';
const OWNER = 'human:local:owner';
const write = {
  taskId: 'task-review',
  taskCreatedAt: '2026-10-25T00:00:00.000Z',
  projectId: 'project-review',
  author: { kind: 'person' as const, principalId: OWNER },
  beforeCommit: () => true,
};
let sends: ProviderSendTurnInput[] = [];
let birth = 0;
class CountingAdapter extends GateTestAdapter {
  steerTurn = vi.fn();
  override async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    sends.push(input);
    return { threadId: input.threadId, turnId: `turn-${sends.length}` };
  }
}
interface World {
  store: EventStore;
  service: OrchestrationService;
  adapter: CountingAdapter;
  inbox: ThreadInboxDelivery;
  send: TaskReviewSend;
  committedAtSubmit: string[][];
  detachAdapter(): void;
}
const open: World[] = [];
function boot(path: string, indeterminate = false): World {
  const identity = `review-boot-${++birth}`;
  const store = new EventStore(path, TURN_DEDUP_MAX_ENTRIES, {
    exact: () => ({ pid: process.pid, start: identity }),
    probe: () => ({
      state: 'exact',
      identity: { pid: process.pid, start: identity },
    }),
  });
  const bus = new EventBus();
  const adapter = new CountingAdapter();
  const registry = createGateTestRegistry(adapter);
  const service = new OrchestrationService({
    adapterRegistry: registry,
    eventBus: bus,
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  const inbox = new ThreadInboxDelivery({
    store: store.threadInboxStore(),
    foldEvents: (id) =>
      store
        .listEventsByMethods(id, ACTIVE_TURN_FOLD_METHODS)
        .map((e) => ({ sequence: e.sequence, event: e.payload })),
    headSequence: (id) => store.readSessionInventoryHighWater(id),
    coordinatorBusy: (id) => service.hasActiveTurn(id),
    hasPossibleEffect: (id) =>
      store.sessionTurnBoundaryAuthority().hasPossibleEffect(id),
    readInputlessTurnDisposition: (id) =>
      store.readInputlessTurnDisposition(id),
    readInvocationTerminal: (id, invocation, turn) =>
      store.readInvocationTerminal(id, invocation, turn),
    conversationOf: (id) =>
      store.conversationForSession(id)?.conversationId ?? id,
    currentSessionId: (id) => service.currentConversationSessionId(id),
    mayContinue: (id, owner) =>
      service.sessionRecordedOwnerId(
        service.currentConversationSessionId(id),
      ) === owner,
    inspectDelivery: (id, key) =>
      service.inspectTurnDelivery(id, key, INTERNAL_SESSION_READ_SCOPE),
    start: async ({ threadId, payload, clientTurnId }) => {
      if (indeterminate) return { outcome: 'indeterminate' };
      const started = (await service.dispatch({
        type: 'sendTurn',
        input: { threadId, input: payload.message, clientTurnId },
      })) as ProviderTurnStartResult;
      return {
        outcome: 'started',
        conversationId: threadId,
        sessionId: threadId,
        turnId: started.turnId,
      };
    },
    subscribe: (listener) =>
      bus.subscribe((frame) => {
        const event = (frame.data as { event?: CanonicalRuntimeEvent })?.event;
        if (frame.event === 'orchestration:event' && event)
          listener({ threadId: event.threadId, method: event.method });
      }),
    logger: { warn: vi.fn() },
    retryDelaysMs: [5, 10, 20],
  });
  const task = {
    id: write.taskId,
    projectId: write.projectId,
    createdAt: write.taskCreatedAt,
    status: 'in_progress',
    sessionId: LEAD,
  } as TaskRecord;
  const committedAtSubmit: string[][] = [];
  const send = new TaskReviewSend({
    store: store.taskReviewStore(),
    readTask: () => task,
    readLead: createTaskLeadReader({ eventStore: store, service }),
    conversationOf: (id) => id,
    inbox: {
      entry: (...args) => inbox.entry(...args),
      submit: (input) => {
        committedAtSubmit.push(
          store
            .taskReviewStore()
            .listThreads(write)
            .flatMap((t) => t.events.map((e) => e.kind)),
        );
        return inbox.submit(input);
      },
    },
    logger: { warn: vi.fn() },
  });
  inbox.start();
  const world = {
    store,
    service,
    adapter,
    inbox,
    send,
    committedAtSubmit,
    detachAdapter: () => {
      registry.list = () => [];
    },
  };
  open.push(world);
  return world;
}
async function close(w: ReturnType<typeof boot>, crash = false) {
  open.splice(open.indexOf(w), 1);
  w.inbox.stop();
  await w.inbox.idle();
  // Retire fixture resources without publishing the provider's graceful exit on a crash.
  if (crash) w.detachAdapter();
  await w.service.shutdown();
  w.adapter.events.close();
  w.store.close();
}
async function emit(
  w: ReturnType<typeof boot>,
  method: string,
  fields: Record<string, unknown> = {},
) {
  const eventId = `review-${crypto.randomUUID()}`;
  w.adapter.events.push({
    eventId,
    provider: 'claude',
    threadId: LEAD,
    createdAt: new Date().toISOString(),
    method,
    ...fields,
  } as CanonicalRuntimeEvent);
  await vi.waitFor(() =>
    expect(
      w.store.listEvents(LEAD).some((e) => e.payload.eventId === eventId),
    ).toBe(true),
  );
}
async function lead(w: ReturnType<typeof boot>) {
  await w.service.dispatch({
    type: 'startSession',
    input: { threadId: LEAD, provider: 'claude' },
  });
  await emit(w, 'session.started', {
    sessionId: LEAD,
    metadata: { userId: OWNER },
  });
}
function thread(w: ReturnType<typeof boot>, operationId = 'create') {
  const result = w.store.taskReviewStore().createThread({
    ...write,
    operationId,
    artifact: {
      kind: 'plan',
      id: 'plan',
      revision: 'v1',
      digest: `sha256:${'a'.repeat(64)}`,
    },
    anchor: {
      kind: 'text-quote',
      start: 0,
      end: 5,
      exact: 'quote',
      prefix: '',
      suffix: '',
    },
    body: 'Please fix the quoted section.',
  });
  if (!result.success) throw new Error(result.error);
  return result.data.threadId;
}
const send = (
  w: ReturnType<typeof boot>,
  threadId: string,
  operationId = 'send',
  mode: 'send' | 'send-and-resolve' = 'send',
) => w.send.send(write, { threadIds: [threadId], operationId, mode });
const read = (w: ReturnType<typeof boot>, threadId: string) =>
  w.store.taskReviewStore().readThread({ ...write, threadId })!;
afterEach(async () => {
  for (const w of [...open]) await close(w);
  sends = [];
});

describe('Task review send over the durable inbox', () => {
  test('an idle lead gets one owner turn after sent is committed, with anchor, comment, replies and tool instructions', async () => {
    const w = boot(join(makeTempDir('review-send-'), 'events.sqlite'));
    await lead(w);
    const id = thread(w);
    expect(
      w.store.taskReviewStore().appendEvent({
        ...write,
        threadId: id,
        event: {
          kind: 'reply',
          body: 'Also cover CRLF.',
          operationId: 'reply',
        },
      }).success,
    ).toBe(true);
    const result = await send(w, id);
    expect(result).toMatchObject({
      success: true,
      data: {
        status: 'queued',
        deliveryKey: expect.stringMatching(/^tr-[a-f0-9]{40}$/),
      },
    });
    await w.inbox.idle();
    expect(sends).toHaveLength(1);
    const text = sends[0]!.input;
    for (const value of [
      id,
      '"kind":"plan"',
      '> quote',
      '> Please fix the quoted section.',
      '> Also cover CRLF.',
      'task_thread_reply',
      'task_thread_resolve',
      'Commit your changes before claiming a commit.',
    ])
      expect(text).toContain(value);
    expect(w.committedAtSubmit).toEqual([['comment', 'reply', 'sent']]);
    const payload = JSON.parse(
      w.store.threadInboxStore().list(LEAD)[0]!.payload,
    );
    expect(payload.actor.userId).toBe(OWNER);
  });
  test('a busy lead queues until turn.completed and is never steered; the same selection twice has one inbox entry', async () => {
    const w = boot(join(makeTempDir('review-send-'), 'events.sqlite'));
    await lead(w);
    await w.service.dispatch({
      type: 'sendTurn',
      input: { threadId: LEAD, input: 'work', clientTurnId: 'initial' },
    });
    await emit(w, 'turn.started', {
      turnId: 'turn-1',
      prompt: 'work',
      invocationId: sends[0]?.invocationId,
    });
    const id = thread(w);
    const first = await send(w, id);
    const second = await send(w, id, 'retry-selection');
    expect(second).toEqual(first);
    await w.inbox.idle();
    expect(sends).toHaveLength(1);
    expect(w.inbox.list(LEAD)).toMatchObject([{ state: 'queued' }]);
    expect(read(w, id).events.map((e) => e.kind)).toEqual(['comment', 'sent']);
    await emit(w, 'turn.completed', {
      turnId: 'turn-1',
      invocationId: sends[0]?.invocationId,
    });
    await w.inbox.idle();
    await vi.waitFor(() => expect(sends).toHaveLength(2));
    expect(w.adapter.steerTurn).not.toHaveBeenCalled();
  });
  test('a restart re-drives a queued send once and a later restart never sends it twice', async () => {
    const path = join(makeTempDir('review-send-'), 'events.sqlite');
    const first = boot(path);
    await lead(first);
    await first.service.dispatch({
      type: 'sendTurn',
      input: { threadId: LEAD, input: 'work', clientTurnId: 'initial' },
    });
    await emit(first, 'turn.started', {
      turnId: 'turn-1',
      prompt: 'work',
      invocationId: sends[0]?.invocationId,
    });
    const id = thread(first);
    const original = await send(first, id);
    await first.inbox.idle();
    await close(first, true);
    const second = boot(path);
    expect(await send(second, id)).toEqual(original);
    await emit(second, 'turn.completed', {
      turnId: 'turn-1',
      invocationId: sends[0]?.invocationId,
    });
    await second.inbox.idle();
    await vi.waitFor(() => expect(sends).toHaveLength(2));
    await close(second, true);
    const third = boot(path);
    expect(await send(third, id)).toMatchObject({ success: true });
    await third.inbox.idle();
    expect(sends).toHaveLength(2);
    expect(third.inbox.list(LEAD)).toHaveLength(1);
  });
  test('a stopped lead is refused with no sent event', async () => {
    const w = boot(join(makeTempDir('review-send-'), 'events.sqlite'));
    await lead(w);
    await emit(w, 'session.exited', { sessionId: LEAD, reason: 'done' });
    const id = thread(w);
    expect(await send(w, id)).toMatchObject({
      success: false,
      code: 'no-live-agent',
    });
    expect(read(w, id).events.map((e) => e.kind)).toEqual(['comment']);
    expect(w.inbox.list(LEAD)).toEqual([]);
  });
  test('capacity records send-failed and reopens the thread, including send-and-resolve', async () => {
    const w = boot(join(makeTempDir('review-send-'), 'events.sqlite'));
    await lead(w);
    await w.service.dispatch({
      type: 'sendTurn',
      input: { threadId: LEAD, input: 'work', clientTurnId: 'initial' },
    });
    await emit(w, 'turn.started', {
      turnId: 'turn-1',
      prompt: 'work',
      invocationId: sends[0]?.invocationId,
    });
    for (let n = 0; n < 50; n++)
      expect(
        w.inbox.submit({
          conversationId: LEAD,
          clientTurnId: `filler-${n}`,
          payload: { message: 'Wait', actor: { userId: OWNER } },
        }).outcome,
      ).toBe('queued');
    const id = thread(w);
    expect(await send(w, id, 'send', 'send-and-resolve')).toMatchObject({
      success: true,
      data: { status: 'failed', reason: 'capacity' },
    });
    expect(read(w, id).events.map((e) => e.kind)).toEqual([
      'comment',
      'sent',
      'send-failed',
    ]);
    expect(deriveThreadState(read(w, id).events)).toBe('open');
  });
  test('send-and-resolve appends resolved only after queue acceptance and is idempotent', async () => {
    const w = boot(join(makeTempDir('review-send-'), 'events.sqlite'));
    await lead(w);
    const id = thread(w);
    expect(await send(w, id, 'send', 'send-and-resolve')).toMatchObject({
      success: true,
      data: { status: 'queued' },
    });
    expect(await send(w, id, 'send', 'send-and-resolve')).toMatchObject({
      success: true,
    });
    expect(read(w, id).events.map((e) => e.kind)).toEqual([
      'comment',
      'sent',
      'resolved',
    ]);
    expect(read(w, id).events.at(-1)).toMatchObject({
      reason: 'sent-and-resolved',
    });
  });
  test('a recorded intent with no inbox entry is Send unconfirmed and is never resubmitted', async () => {
    const w = boot(join(makeTempDir('review-send-'), 'events.sqlite'));
    await lead(w);
    const id = thread(w);
    expect(
      w.store.taskReviewStore().recordSend({
        ...write,
        threadIds: [id],
        deliveryKey: `tr-${'b'.repeat(40)}`,
        operationId: 'send',
      }).success,
    ).toBe(true);
    expect(await send(w, id)).toMatchObject({
      success: true,
      data: {
        status: 'unconfirmed',
        reason: 'Send unconfirmed',
        threads: [{ deliveryStatus: 'unconfirmed' }],
      },
    });
    await w.inbox.idle();
    expect(sends).toEqual([]);
    expect(w.inbox.list(LEAD)).toEqual([]);
  });
  test('an unconfirmed inbox entry is reported as Send unconfirmed on retry', async () => {
    const w = boot(join(makeTempDir('review-send-'), 'events.sqlite'), true);
    await lead(w);
    const id = thread(w);
    expect(await send(w, id)).toMatchObject({ success: true });
    await w.inbox.idle();
    expect(w.inbox.list(LEAD)).toMatchObject([{ state: 'unconfirmed' }]);
    expect(await send(w, id)).toMatchObject({
      success: true,
      data: {
        status: 'unconfirmed',
        reason: 'Send unconfirmed',
        threads: [{ deliveryStatus: 'unconfirmed' }],
      },
    });
    expect(sends).toEqual([]);
    expect(w.committedAtSubmit).toHaveLength(1);
  });
});
