import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { ClientOrigin } from '@kontourai/station-contracts/client-origin';
import type {
  CanonicalRuntimeEvent,
  TurnDispatchOrigin,
} from '@kontourai/station-contracts/runtime-events';
import type { TaskStatus } from '@kontourai/station-contracts/task-graph';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { turnInterruptedContinueClientTurnId } from '@kontourai/station-shared/conversation-message';
import { TURN_INTERRUPTED_CONTINUE_PROMPT } from '@kontourai/station-shared/runtime-event-projection';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type {
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from '../../../providers/adapter-shape.js';
import {
  delegationResultStartPort,
  inboxPlacementStartPort,
  readSessionDispatchFacts,
} from '../../../runtime/routes/conversation-start-ports.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { memoryContinuationForInbox } from '../memory-exhaustion-continuation.js';
import { OrchestrationService } from '../orchestration-service.js';
import {
  RestartContinuation,
  type RestartContinuationOutcome,
} from '../restart-continuation.js';
import { ACTIVE_TURN_FOLD_METHODS } from '../session-lifecycle-service.js';
import { ThreadInboxDelivery } from '../thread-inbox.js';

/**
 * #4512 step 2, across real restarts: a real OrchestrationService over one
 * SQLite file is shut down (Station's own restart, which keeps an in-flight
 * turn's boundary for the next boot) and booted again. The next boot's
 * interrupted-turn recovery reports the turns it settled, and the
 * continuation hands them to a real conversation inbox whose start port is
 * production's. Each turn was dispatched with the origin its real caller
 * passes; the engine reports its start from inside `sendTurn` and never
 * finishes, so every turn is in flight at the restart.
 */
const makeTempDir = trackTempDirs();
const OWNER = 'owner-1';

/**
 * Sessions the engine keeps across Station restarts (a resumable engine):
 * the continuation's own reattachment is the foreground path's, not this
 * suite's subject.
 */
const engineSessions = new Set<string>();

class HangingAdapter extends GateTestAdapter {
  readonly sends: ProviderSendTurnInput[] = [];
  override async hasSession(threadId?: string): Promise<boolean> {
    return threadId !== undefined && engineSessions.has(threadId);
  }
  /** Real adapters publish the start metadata, where the owner is read. */
  override async startSession(input: ProviderSessionStartInput) {
    const session = await super.startSession(input);
    engineSessions.add(input.threadId);
    this.events.push({
      eventId: randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      createdAt: new Date().toISOString(),
      method: 'session.started',
      initialState: 'created',
      metadata: { ...input.metadata },
    } as CanonicalRuntimeEvent);
    return session;
  }
  override async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    this.sends.push(input);
    const turnId = `turn-${randomUUID()}`;
    this.events.push({
      eventId: randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      createdAt: new Date().toISOString(),
      method: 'turn.started',
      turnId,
      ...(input.invocationId ? { invocationId: input.invocationId } : {}),
    } as CanonicalRuntimeEvent);
    return { threadId: input.threadId, turnId };
  }
}

const person: ClientOrigin = {
  version: 1,
  actor: { kind: 'operator' },
  reported: { version: 1, surface: 'web', build: 'test' },
};

interface Boot {
  store: EventStore;
  service: OrchestrationService;
  adapter: HangingAdapter;
  inbox: ThreadInboxDelivery;
  continuation: RestartContinuation;
  restart(): Promise<void>;
}

const tasks = new Map<string, { status: TaskStatus; createdAt: string }>();
const live: Boot[] = [];
afterEach(async () => {
  for (const boot of live.splice(0)) {
    boot.inbox.stop();
    await boot.service.shutdown();
    boot.adapter.events.close();
    try {
      boot.store.close();
    } catch {}
  }
  tasks.clear();
  engineSessions.clear();
});

function bootAt(path: string, enabled = true): Boot {
  const store = new EventStore(path);
  const bus = new EventBus();
  const adapter = new HangingAdapter();
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: bus,
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  const inbox = new ThreadInboxDelivery({
    store: store.threadInboxStore(),
    foldEvents: (threadId) =>
      store
        .listEventsByMethods(threadId, ACTIVE_TURN_FOLD_METHODS)
        .map((stored) => ({
          sequence: stored.sequence,
          event: stored.payload,
        })),
    headSequence: (threadId) => store.readSessionInventoryHighWater(threadId),
    coordinatorBusy: (threadId) => service.hasActiveTurn(threadId),
    hasPossibleEffect: (threadId) =>
      store.sessionTurnBoundaryAuthority().hasPossibleEffect(threadId),
    readInputlessTurnDisposition: (threadId) =>
      store.readInputlessTurnDisposition(threadId),
    readInvocationTerminal: (threadId, invocationId, turnId) =>
      store.readInvocationTerminal(threadId, invocationId, turnId),
    conversationOf: (threadId) =>
      store.conversationForSession(threadId)?.conversationId ?? threadId,
    currentSessionId: (conversationId) =>
      service.currentConversationSessionId(conversationId),
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
    start: inboxPlacementStartPort({
      readProjectTaskRoomExecutionBinding: (sessionId) =>
        store.readProjectTaskRoomExecutionBinding(sessionId),
      continueAsRecordedActor: async (input, threadId) => {
        const dispatched = await service.dispatchWithReceipt(
          {
            type: 'sendTurn',
            input: {
              threadId,
              input: input.message,
              clientTurnId: input.clientTurnId,
            },
          },
          // Read authority is the foreground path's (tested with it); this
          // pins what the continuation sends and how it is classified.
          { clientOrigin: input.clientOrigin },
          input.dispatchOrigin
            ? { dispatchOrigin: input.dispatchOrigin }
            : undefined,
        );
        const result = dispatched.result as { turnId?: string } | undefined;
        if (!result?.turnId) return { outcome: 'indeterminate' };
        return {
          outcome: 'started',
          conversationId: input.conversationId,
          sessionId: threadId,
          turnId: result.turnId,
        };
      },
    }),
    subscribe: (listener) =>
      bus.subscribe((frame) => {
        const event = (frame.data as { event?: CanonicalRuntimeEvent })?.event;
        if (frame.event === 'orchestration:event' && event)
          listener({ threadId: event.threadId, method: event.method });
      }),
    logger: { warn: vi.fn() },
    retryDelaysMs: [5, 10, 20],
  });
  inbox.start();
  const continuation = new RestartContinuation({
    enabled: () => enabled,
    eventStore: store,
    currentConversationSessionId: (conversationId) =>
      service.currentConversationSessionId(conversationId),
    sessionRecordedOwnerId: (threadId) =>
      service.sessionRecordedOwnerId(threadId),
    readTask: (taskId) => tasks.get(taskId) ?? null,
    submit: (input) => inbox.submit(input),
    logger: { warn: vi.fn() },
  });
  const boot: Boot = {
    store,
    service,
    adapter,
    inbox,
    continuation,
    // Station's own restart: the in-flight turns' boundaries stay.
    restart: async () => {
      live.splice(live.indexOf(boot), 1);
      inbox.stop();
      await inbox.idle();
      await service.shutdown();
      adapter.events.close();
      store.close();
    },
  };
  live.push(boot);
  return boot;
}

/** Boot over the file and run what runtime routes run after recovery. */
async function nextBoot(
  path: string,
  enabled = true,
): Promise<{ boot: Boot; outcomes: RestartContinuationOutcome[] }> {
  const boot = bootAt(path, enabled);
  boot.service.initialize();
  const turns = await boot.service.whenInterruptedTurnsRecovered();
  const outcomes = boot.continuation.continueRecovered(turns);
  await boot.inbox.idle();
  return { boot, outcomes };
}

async function startWork(
  boot: Boot,
  threadId: string,
  origin: TurnDispatchOrigin | 'person',
  task?: { taskId: string; status: TaskStatus; createdAt: string },
): Promise<void> {
  await boot.service.dispatch(
    {
      type: 'startSession',
      input: {
        threadId,
        provider: 'claude',
        metadata: { userId: OWNER },
      },
    },
    { userId: OWNER },
  );
  if (task) {
    expect(
      await boot.store.bindProjectTaskRoomExecution({
        projectId: 'project-1',
        taskId: task.taskId,
        sessionId: threadId,
      }),
    ).toEqual({ kind: 'bound' });
    tasks.set(task.taskId, {
      status: task.status,
      createdAt: task.createdAt,
    });
  }
  await boot.service.dispatchWithReceipt(
    {
      type: 'sendTurn',
      input: { threadId, input: 'do the work', clientTurnId: randomUUID() },
    },
    origin === 'person'
      ? { userId: OWNER, clientOrigin: person }
      : { userId: OWNER },
    origin === 'person' || origin === 'unknown'
      ? undefined
      : { dispatchOrigin: origin },
  );
  await vi.waitFor(() =>
    expect(
      boot.store
        .listEventsByMethods(threadId, ['turn.started'])
        .some(
          (event) =>
            (event.payload as { dispatchOrigin?: string }).dispatchOrigin ===
              (origin === 'person' ? 'interactive' : origin) ||
            origin === 'unknown',
        ),
    ).toBe(true),
  );
}

/** End the newest turn the engine left running on `threadId`. */
async function finishTurn(boot: Boot, threadId: string): Promise<void> {
  const started = boot.store
    .listEventsByMethods(threadId, ['turn.started'])
    .map((event) => event.payload as { turnId: string; invocationId?: string })
    .at(-1)!;
  boot.adapter.events.push({
    eventId: randomUUID(),
    provider: boot.adapter.provider,
    threadId,
    createdAt: new Date().toISOString(),
    method: 'turn.completed',
    turnId: started.turnId,
    ...(started.invocationId ? { invocationId: started.invocationId } : {}),
  } as CanonicalRuntimeEvent);
  await vi.waitFor(() =>
    expect(boot.service.hasActiveTurn(threadId)).toBe(false),
  );
}

const continuationsTo = (boot: Boot, threadId: string) =>
  boot.adapter.sends.filter(
    (send) =>
      send.threadId === threadId &&
      send.input === TURN_INTERRUPTED_CONTINUE_PROMPT,
  );

describe('continue unattended work after a restart (#4512)', () => {
  test('a dispatched Task Session and a delegated one get exactly one continuation; interactive, unknown and Automation Sessions none; a second restart adds none', async () => {
    const path = join(makeTempDir('station-restart-continue-'), 'o.sqlite');
    const first = bootAt(path);
    first.service.initialize();
    await first.service.whenInterruptedTurnsRecovered();
    await startWork(first, 'task-session', 'task-dispatch', {
      taskId: 'task-a',
      status: 'in_progress',
      createdAt: '2026-11-01T00:00:00.000Z',
    });
    await startWork(first, 'delegated-session', 'delegation');
    await startWork(first, 'person-session', 'person');
    await startWork(first, 'unknown-session', 'unknown');
    await startWork(first, 'automation-session', 'automation');
    await first.restart();

    const { boot: second, outcomes } = await nextBoot(path);
    await vi.waitFor(() =>
      expect(continuationsTo(second, 'task-session')).toHaveLength(1),
    );
    await vi.waitFor(() =>
      expect(continuationsTo(second, 'delegated-session')).toHaveLength(1),
    );
    expect(continuationsTo(second, 'person-session')).toHaveLength(0);
    expect(continuationsTo(second, 'unknown-session')).toHaveLength(0);
    expect(continuationsTo(second, 'automation-session')).toHaveLength(0);
    expect(second.adapter.sends).toHaveLength(2);
    expect(
      outcomes
        .filter((outcome) => outcome.kind === 'skipped')
        .map((outcome) => outcome.threadId)
        .sort(),
    ).toEqual(['automation-session', 'person-session', 'unknown-session']);
    // The continuation is the person's Continue key for that interruption,
    // sent as Station's own turn, marked as a continuation.
    const banner = second.store
      .listEventsByMethods('task-session', ['session.state-changed'])
      .map(
        (event) =>
          (
            event.payload as {
              interruptedTurnBoundary?: { boundaryId: string };
            }
          ).interruptedTurnBoundary,
      )
      .find(Boolean)!;
    const continued = second.store
      .listEventsByMethods('task-session', ['turn.started'])
      .map((event) => event.payload as unknown as Record<string, unknown>)
      .at(-1)!;
    expect(continued).toMatchObject({
      clientTurnId: turnInterruptedContinueClientTurnId(banner.boundaryId),
      clientOrigin: { actor: { kind: 'internal' } },
      dispatchOrigin: 'task-dispatch',
    });

    // Restarted again while both continuations are still running.
    await second.restart();
    const { boot: third, outcomes: again } = await nextBoot(path);
    await third.inbox.idle();
    expect(third.adapter.sends).toHaveLength(0);
    expect(again.filter((outcome) => outcome.kind === 'queued')).toEqual([]);
  });

  test("#4512 review: a delegated result delivered into a person's own chat is not continued after a restart", async () => {
    const path = join(makeTempDir('station-restart-continue-'), 'o.sqlite');
    const first = bootAt(path);
    first.service.initialize();
    await first.service.whenInterruptedTurnsRecovered();
    await startWork(first, 'person-chat', 'person');
    await finishTurn(first, 'person-chat');
    // The child's result, through production's delivery start port.
    await delegationResultStartPort({
      origin: {
        version: 1,
        actor: { kind: 'internal' },
        reported: { version: 1, surface: 'unknown', build: null },
      },
      readProjectTaskRoomExecutionBinding: (sessionId) =>
        first.store.readProjectTaskRoomExecutionBinding(sessionId),
      sessionFacts: (sessionId) =>
        readSessionDispatchFacts(first.store, sessionId),
      continueAsRecordedActor: async (input, threadId) => {
        const dispatched = await first.service.dispatchWithReceipt(
          {
            type: 'sendTurn',
            input: {
              threadId,
              input: input.message,
              clientTurnId: input.clientTurnId,
            },
          },
          { clientOrigin: input.clientOrigin },
          input.dispatchOrigin
            ? { dispatchOrigin: input.dispatchOrigin }
            : undefined,
        );
        return {
          outcome: 'started',
          conversationId: input.conversationId,
          sessionId: threadId,
          turnId: (dispatched.result as { turnId: string }).turnId,
        };
      },
    })({
      parentConversationId: 'person-chat',
      threadId: 'person-chat',
      actor: { userId: OWNER, attribution: 'verified-bound' },
      sender: { kind: 'delegation-result', sessionId: 'child-1' },
      text: 'The child finished: here is the result.',
      clientTurnId: 'delegation-result:child-1',
    });
    await vi.waitFor(() =>
      expect(
        first.store
          .listEventsByMethods('person-chat', ['turn.started'])
          .map(
            (event) =>
              (event.payload as { dispatchOrigin?: string }).dispatchOrigin,
          ),
      ).toEqual(['interactive', 'interactive']),
    );
    await first.restart();

    const { boot: second, outcomes } = await nextBoot(path);
    await second.inbox.idle();
    expect(continuationsTo(second, 'person-chat')).toHaveLength(0);
    expect(outcomes).toEqual([
      { kind: 'skipped', threadId: 'person-chat', reason: 'origin' },
    ]);
  });

  test("#4512 review: Station's automatic memory continuation of a person's turn on a Task's Session is not continued after a restart", async () => {
    const path = join(makeTempDir('station-restart-continue-'), 'o.sqlite');
    const first = bootAt(path);
    first.service.initialize();
    await first.service.whenInterruptedTurnsRecovered();
    await startWork(first, 'task-person', 'person', {
      taskId: 'task-a',
      status: 'in_progress',
      createdAt: '2026-11-01T00:00:00.000Z',
    });
    // The engine is killed for memory mid-turn.
    const killed = first.store
      .listEventsByMethods('task-person', ['turn.started'])
      .map(
        (event) => event.payload as { turnId: string; invocationId?: string },
      )
      .at(-1)!;
    first.adapter.events.push({
      eventId: randomUUID(),
      provider: first.adapter.provider,
      threadId: 'task-person',
      createdAt: new Date().toISOString(),
      method: 'runtime.error',
      turnId: killed.turnId,
      ...(killed.invocationId ? { invocationId: killed.invocationId } : {}),
      severity: 'error',
      code: 'engine-memory-exhausted',
      message: 'Claude ran out of memory and was stopped.',
      retriable: false,
    } as CanonicalRuntimeEvent);
    await vi.waitFor(() =>
      expect(first.service.hasActiveTurn('task-person')).toBe(false),
    );
    // Station continues it on its own, through the same inbox.
    const memory = memoryContinuationForInbox({
      eventStore: first.store,
      service: first.service,
      inbox: first.inbox,
      logger: { warn: vi.fn() },
    });
    expect(memory.continueAutomatically('task-person')).toMatchObject({
      kind: 'queued',
    });
    await vi.waitFor(() =>
      expect(
        first.store
          .listEventsByMethods('task-person', ['turn.started'])
          .map(
            (event) =>
              (event.payload as { dispatchOrigin?: string }).dispatchOrigin,
          ),
      ).toEqual(['interactive', 'interactive']),
    );
    await first.restart();

    const { boot: second, outcomes } = await nextBoot(path);
    await second.inbox.idle();
    expect(continuationsTo(second, 'task-person')).toHaveLength(0);
    expect(outcomes).toEqual([
      { kind: 'skipped', threadId: 'task-person', reason: 'origin' },
    ]);
  });

  test('done, canceled and blocked Tasks are skipped, and the oldest open Task is continued first', async () => {
    const path = join(makeTempDir('station-restart-continue-'), 'o.sqlite');
    const first = bootAt(path);
    first.service.initialize();
    await first.service.whenInterruptedTurnsRecovered();
    await startWork(first, 'newer-task', 'task-dispatch', {
      taskId: 'task-newer',
      status: 'in_progress',
      createdAt: '2026-11-03T00:00:00.000Z',
    });
    await startWork(first, 'older-task', 'task-dispatch', {
      taskId: 'task-older',
      status: 'review',
      createdAt: '2026-11-01T00:00:00.000Z',
    });
    for (const status of ['done', 'canceled', 'blocked'] as const)
      await startWork(first, `${status}-task`, 'task-dispatch', {
        taskId: `task-${status}`,
        status,
        createdAt: '2026-10-01T00:00:00.000Z',
      });
    await first.restart();

    const { boot: second, outcomes } = await nextBoot(path);
    await vi.waitFor(() => expect(second.adapter.sends).toHaveLength(2));
    expect(
      outcomes
        .filter((outcome) => outcome.kind === 'queued')
        .map((outcome) => outcome.threadId),
    ).toEqual(['older-task', 'newer-task']);
    expect(
      outcomes
        .filter((outcome) => outcome.kind === 'skipped')
        .map((outcome) => [outcome.threadId, outcome.reason]),
    ).toEqual(
      expect.arrayContaining([
        ['done-task', 'task-closed'],
        ['canceled-task', 'task-closed'],
        ['blocked-task', 'task-closed'],
      ]),
    );
  });

  test("with the preview off nothing is continued, and the person's Continue for the same interruption is the same entry", async () => {
    const path = join(makeTempDir('station-restart-continue-'), 'o.sqlite');
    const first = bootAt(path);
    first.service.initialize();
    await first.service.whenInterruptedTurnsRecovered();
    await startWork(first, 'task-session', 'task-dispatch', {
      taskId: 'task-a',
      status: 'in_progress',
      createdAt: '2026-11-01T00:00:00.000Z',
    });
    await first.restart();

    const { boot: off, outcomes } = await nextBoot(path, false);
    await off.inbox.idle();
    expect(outcomes).toEqual([]);
    expect(off.adapter.sends).toHaveLength(0);

    // The person's Continue (chat dock: same prompt, key on the boundary)
    // after which an automatic pass for the same turn sends nothing more.
    const banner = off.store
      .listEventsByMethods('task-session', ['session.state-changed'])
      .map(
        (event) =>
          (
            event.payload as {
              interruptedTurnBoundary?: { boundaryId: string };
            }
          ).interruptedTurnBoundary,
      )
      .find(Boolean)!;
    const turns = (await off.service.whenInterruptedTurnsRecovered()).filter(
      (turn) => turn.threadId === 'task-session',
    );
    expect(turns.map((turn) => turn.boundaryId)).toEqual([banner.boundaryId]);
    await off.service.dispatchWithReceipt(
      {
        type: 'sendTurn',
        input: {
          threadId: 'task-session',
          input: TURN_INTERRUPTED_CONTINUE_PROMPT,
          clientTurnId: turnInterruptedContinueClientTurnId(banner.boundaryId),
        },
      },
      { clientOrigin: person },
    );
    expect(continuationsTo(off, 'task-session')).toHaveLength(1);
    const late = new RestartContinuation({
      enabled: () => true,
      eventStore: off.store,
      currentConversationSessionId: (id) =>
        off.service.currentConversationSessionId(id),
      sessionRecordedOwnerId: (id) => off.service.sessionRecordedOwnerId(id),
      readTask: (taskId) => tasks.get(taskId) ?? null,
      submit: (input) => off.inbox.submit(input),
      logger: { warn: vi.fn() },
    }).continueRecovered(turns);
    await off.inbox.idle();
    expect(late).toEqual([
      { kind: 'skipped', threadId: 'task-session', reason: 'moved-on' },
    ]);
    expect(continuationsTo(off, 'task-session')).toHaveLength(1);
  });
});
