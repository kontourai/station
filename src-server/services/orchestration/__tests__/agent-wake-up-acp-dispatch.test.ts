/**
 * An approved check-back reaches the engine: fire -> inbox -> dispatch.
 *
 * Real pieces: the `AcpAdapter` (only its child process is faked, through
 * the `processFactory` seam its own suite uses), the `OrchestrationService`
 * over a SQLite `EventStore`, that store's turn boundaries and inbox, the
 * `ThreadInboxDelivery` wired with the ports production gives it
 * (`runtime-routes.ts`), and the `AgentWakeUpDelivery` over the store's
 * wake-up table.
 *
 * The regression this pins: every send records a prepared intent whose row
 * retires only on a terminal naming its invocation. An adapter that drops
 * the invocation id from its events leaves the row behind after the turn
 * ends, so the inbox reads the chat as busy for good: a person's own send
 * still goes through, a queued check-back never does.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { FakeAcpProcess } from '../../../providers/__tests__/fake-acp-process.js';
import type { ProviderSessionStartInput } from '../../../providers/adapter-shape.js';
import { AcpAdapter } from '../../../providers/adapters/acp-adapter.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import type { ACPProcess } from '../../acp/acp-process.js';
import {
  AgentWakeUpDelivery,
  wakeUpClientTurnId,
  wakeUpMessage,
} from '../agent-schedule.js';
import { ConversationTurnActivityProjection } from '../conversation-turn-activity.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';
import { ACTIVE_TURN_FOLD_METHODS } from '../session-lifecycle-service.js';
import { ThreadInboxDelivery } from '../thread-inbox.js';

const CONNECTION_ID = 'fake-acp-connection';
const THREAD = 'opsbot:wake-up-acp';
const OWNER = 'human:local:operator';
const MINUTE = 60_000;

async function waitFor<T>(
  read: () => T,
  matches: (value: T) => boolean,
  what: string,
  timeoutMs = 4_000,
): Promise<T> {
  const startedAt = Date.now();
  for (;;) {
    const value = read();
    if (matches(value)) return value;
    if (Date.now() - startedAt > timeoutMs)
      throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('an approved check-back on an ACP chat reaches the engine', () => {
  let tmp: string;
  let previousStationHome: string | undefined;
  let store: EventStore;
  let bus: EventBus;
  let service: OrchestrationService;
  let processes: FakeAcpProcess[];
  // Lets an engine re-establish its session (a credential-refusal restart).
  let loadSessionCapable = false;
  let inbox: ThreadInboxDelivery;
  let wakeUps: AgentWakeUpDelivery;
  const clock = { now: Date.now() };

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'wake-up-acp-'));
    previousStationHome = process.env.STATION_HOME;
    process.env.STATION_HOME = join(tmp, 'home');
    mkdirSync(process.env.STATION_HOME, { recursive: true });
    store = new EventStore(join(tmp, 'orchestration.sqlite'));
    bus = new EventBus();
    processes = [];
    loadSessionCapable = false;
    const adapter = new AcpAdapter({
      getConnections: async () => [
        {
          id: CONNECTION_ID,
          name: 'Scripted Fake',
          command: process.execPath,
          args: [],
          enabled: true,
        },
      ],
      logger: { debug: () => {}, warn: () => {}, error: () => {} },
      processFactory: (opts) => {
        const child = new FakeAcpProcess(opts);
        if (loadSessionCapable)
          child.initResult!.agentCapabilities.loadSession = true;
        processes.push(child);
        return child as unknown as ACPProcess;
      },
    });
    service = new OrchestrationService({
      adapterRegistry: {
        register() {},
        get: (provider: string) => (provider === 'acp' ? adapter : undefined),
        list: () => [adapter],
      } as IProviderAdapterRegistry,
      eventBus: bus,
      eventStore: store,
      resolveSessionAgent: async (input: ProviderSessionStartInput) => ({
        ...input,
        agent: { slug: 'ops-bot' },
      }),
      logger: { debug: vi.fn(), warn: vi.fn() },
    } as never);
    // The ports `createThreadInboxDelivery` gives production, minus the
    // HTTP continuation: `start` sends the entry as its recorded actor.
    inbox = new ThreadInboxDelivery({
      store: store.threadInboxStore(),
      foldEvents: (threadId) =>
        store
          .listEventsByMethods(threadId, ACTIVE_TURN_FOLD_METHODS)
          .map((stored) => ({
            sequence: stored.sequence,
            event: stored.payload,
          })),
      headSequence: (threadId) => store.readSessionInventoryHighWater(threadId),
      readInputlessTurnDisposition: (threadId) =>
        store.readInputlessTurnDisposition(threadId),
      readInvocationTerminal: (threadId, invocationId, turnId) =>
        store.readInvocationTerminal(threadId, invocationId, turnId),
      coordinatorBusy: (threadId) => service.hasActiveTurn(threadId),
      hasPossibleEffect: (threadId) =>
        store.sessionTurnBoundaryAuthority().hasPossibleEffect(threadId),
      conversationOf: (threadId) =>
        store.conversationForSession(threadId)?.conversationId ?? threadId,
      currentSessionId: (conversationId) =>
        service.currentConversationSessionId(conversationId),
      mayContinue: () => true,
      deviceMaySend: () => true,
      inspectDelivery: (conversationId, clientTurnId, inputDigest) =>
        service.inspectTurnDelivery(
          conversationId,
          clientTurnId,
          INTERNAL_SESSION_READ_SCOPE,
          inputDigest,
        ),
      start: async ({ conversationId, threadId, payload, clientTurnId }) => {
        const dispatched = await service.dispatchWithReceipt(
          {
            type: 'sendTurn',
            input: { threadId, input: payload.message, clientTurnId },
          },
          {
            userId: payload.actor.userId,
            ...(payload.clientOrigin
              ? { clientOrigin: payload.clientOrigin }
              : {}),
          },
        );
        const result = dispatched.result as { turnId?: string } | undefined;
        if (!result?.turnId) return { outcome: 'indeterminate' };
        return {
          outcome: 'started',
          conversationId,
          sessionId: threadId,
          turnId: result.turnId,
        };
      },
      subscribe: (listener) =>
        bus.subscribe((frame) => {
          const event = (frame.data as { event?: CanonicalRuntimeEvent })
            ?.event;
          if (frame.event === 'orchestration:event' && event)
            listener({ threadId: event.threadId, method: event.method });
        }),
      logger: { warn: vi.fn() },
      retryDelaysMs: [20, 50, 100],
    });
    inbox.start();
    wakeUps = new AgentWakeUpDelivery({
      store: store.agentScheduleStore(),
      // The fire-time scope decision is the composition's; this test is
      // about what happens after it admits.
      admit: () => true,
      submit: (input) => inbox.submit(input),
      logger: { warn: vi.fn() },
      now: () => clock.now,
    });
  });

  afterEach(async () => {
    wakeUps.stop();
    inbox.stop();
    await inbox.idle();
    await service.shutdown();
    store.close();
    rmSync(tmp, { recursive: true, force: true });
    if (previousStationHome === undefined) delete process.env.STATION_HOME;
    else process.env.STATION_HOME = previousStationHome;
  });

  const methods = () =>
    store.listEvents(THREAD).map((row) => row.payload.method);
  const prompts = () =>
    (processes[0]?.promptContents ?? []).map((blocks) =>
      blocks.map((block) => ('text' in block ? block.text : '')).join(''),
    );

  test('the turn that scheduled it ends, the check-back fires, and the engine is prompted with it', async () => {
    await service.dispatch(
      {
        type: 'startSession',
        input: {
          threadId: THREAD,
          provider: 'acp',
          cwd: tmp,
          metadata: { connectionId: CONNECTION_ID, userId: OWNER },
        },
      },
      { userId: OWNER },
    );
    await waitFor(
      methods,
      (seen) => seen.includes('session.started'),
      'session.started',
    );

    // The person's turn, in which the agent asks to check back.
    await service.dispatchWithReceipt(
      { type: 'sendTurn', input: { threadId: THREAD, input: 'schedule it' } },
      { userId: OWNER },
    );
    await waitFor(prompts, (seen) => seen.length === 1, 'the first prompt');
    processes[0]!.resolvePrompt('end_turn');
    await waitFor(
      methods,
      (seen) => seen.includes('turn.completed'),
      'the first turn to end',
    );
    // That turn's terminal names its invocation, so its row retired.
    const completed = store
      .listEvents(THREAD)
      .map((row) => row.payload)
      .find((event) => event.method === 'turn.completed');
    expect(completed).toMatchObject({ invocationId: expect.any(String) });
    expect(
      store.sessionTurnBoundaryAuthority().hasPossibleEffect(THREAD),
    ).toEqual({ kind: 'available', active: false });

    // An unconfined chat's check-back waits for a person's Approve.
    const scheduled = wakeUps.schedule({
      conversationId: THREAD,
      sessionId: THREAD,
      actor: { userId: OWNER, attribution: 'unattributed-agent' },
      caller: { assurance: 'delegated-custody', sessionId: THREAD },
      note: 'Check back on the build',
      delayMs: MINUTE,
      needsApproval: true,
    });
    if (scheduled.outcome !== 'scheduled') throw new Error('not scheduled');
    const id = scheduled.wakeUp.id;
    expect(wakeUps.approve(id, OWNER)).toMatchObject({ outcome: 'approved' });

    clock.now += MINUTE;
    wakeUps.fire(id);
    expect(store.agentScheduleStore().wakeUp(id)?.state).toBe('sent');

    // The inbox places it: the engine gets the check-back as its next prompt.
    await waitFor(prompts, (seen) => seen.length === 2, 'the check-back');
    expect(prompts()[1]).toContain(wakeUpMessage('Check back on the build'));
    await waitFor(
      () => inbox.list(THREAD),
      (entries) =>
        entries.length === 1 &&
        entries[0]!.clientTurnId === wakeUpClientTurnId(id) &&
        entries[0]!.state === 'sent',
      'the inbox entry to settle sent',
    );
    // It is Station's turn, not an unattributed sender's.
    const started = store
      .listEvents(THREAD)
      .map((row) => row.payload)
      .filter((event) => event.method === 'turn.started');
    expect(started).toHaveLength(2);
    expect(started[1]).toMatchObject({
      clientOrigin: { actor: { kind: 'internal' } },
    });
  });

  const startChat = async () => {
    await service.dispatch(
      {
        type: 'startSession',
        input: {
          threadId: THREAD,
          provider: 'acp',
          cwd: tmp,
          metadata: { connectionId: CONNECTION_ID, userId: OWNER },
        },
      },
      { userId: OWNER },
    );
    await waitFor(
      methods,
      (seen) => seen.includes('session.started'),
      'session.started',
    );
  };
  const stored = (method: string) =>
    store
      .listEvents(THREAD)
      .map((row) => row.payload)
      .filter((event) => event.method === method);
  const summary = async () =>
    (
      await service.listSessionReadModel(INTERNAL_SESSION_READ_SCOPE, {
        threadIds: [THREAD],
      })
    ).find((session) => session.threadId === THREAD);
  const coldActivity = () => {
    const cold = new ConversationTurnActivityProjection({
      eventStore: store,
      readTurnProgress: () => undefined,
      readRunningChildWork: () => [],
      logger: { warn: vi.fn() },
    });
    try {
      return cold.readForThread(THREAD);
    } finally {
      cold.dispose();
    }
  };

  // The open turn's activity counts a tool only when the tool names the
  // turn's invocation; an ACP chat whose tools did not showed no work.
  test('a tool an ACP turn is running shows as running, live and freshly seeded, then as its last tool', async () => {
    await startChat();
    await service.dispatchWithReceipt(
      { type: 'sendTurn', input: { threadId: THREAD, input: 'build it' } },
      { userId: OWNER },
    );
    await waitFor(prompts, (seen) => seen.length === 1, 'the prompt');
    const update = (body: Record<string, unknown>) =>
      processes[0]!.client.sessionUpdate({
        sessionId: processes[0]!.sessionId ?? 'native-kiro-cli',
        update: body,
      } as never);
    await update({
      sessionUpdate: 'tool_call',
      toolCallId: 'call-build',
      title: 'Run the build',
      name: 'shell',
      status: 'in_progress',
    });
    const [toolStarted] = await waitFor(
      () => stored('tool.started'),
      (seen) => seen.length === 1,
      'tool.started',
    );
    const [turnStarted] = stored('turn.started');
    expect(toolStarted).toMatchObject({
      turnId: turnStarted!.turnId,
      invocationId: turnStarted!.invocationId,
    });
    const running = [
      {
        name: 'shell',
        callId: 'call-build',
        startedAt: toolStarted!.createdAt,
      },
    ];
    const live = await summary();
    expect(live?.conversationActivity?.runningTools).toEqual(running);
    // The tool is the turn's progress, so the stall watch saw it.
    expect(live?.turnProgress?.lastProgressEventAt).toBe(
      toolStarted!.createdAt,
    );
    expect(coldActivity()?.runningTools).toEqual(running);

    await update({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-build',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
    });
    const [toolCompleted] = await waitFor(
      () => stored('tool.completed'),
      (seen) => seen.length === 1,
      'tool.completed',
    );
    const done = await summary();
    expect(done?.conversationActivity?.runningTools).toBeUndefined();
    expect(done?.conversationActivity?.lastTool).toMatchObject({
      name: 'shell',
      callId: 'call-build',
      completedAt: toolCompleted!.createdAt,
    });
    processes[0]!.resolvePrompt('end_turn');
    await waitFor(
      methods,
      (seen) => seen.includes('turn.completed'),
      'the turn to end',
    );
  });

  // The restart's abort must name the send's invocation, or its row never
  // retires and the chat reads busy for good.
  test('a credential-refusal restart ends the turn, and the chat is not busy after', async () => {
    loadSessionCapable = true;
    await startChat();
    await service.dispatchWithReceipt(
      { type: 'sendTurn', input: { threadId: THREAD, input: 'go on' } },
      { userId: OWNER },
    );
    await waitFor(prompts, (seen) => seen.length === 1, 'the prompt');
    expect(service.hasActiveTurn(THREAD)).toBe(true);

    await expect(
      processes[0]!.client.extMethod!('_kiro/auth/getAccessToken', {}),
    ).rejects.toMatchObject({ code: -32601 });
    const [aborted] = await waitFor(
      () => stored('turn.aborted'),
      (seen) => seen.length === 1,
      'turn.aborted',
    );
    const [turnStarted] = stored('turn.started');
    expect(aborted).toMatchObject({
      turnId: turnStarted!.turnId,
      invocationId: turnStarted!.invocationId,
      reason: 'engine-restarted',
    });
    await waitFor(
      () => processes.length,
      (count) => count === 2,
      'restart',
    );
    await waitFor(
      () => store.sessionTurnBoundaryAuthority().hasPossibleEffect(THREAD),
      (effect) =>
        effect.kind === 'available' && !(effect as { active: boolean }).active,
      'the turn row to retire',
    );
    expect(service.hasActiveTurn(THREAD)).toBe(false);
  });
});
