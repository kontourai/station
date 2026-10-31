/**
 * An automation that targets a conversation reaches that conversation's
 * engine: scheduler run -> thread inbox -> dispatch -> engine prompt.
 *
 * Real pieces: the `BuiltinScheduler` over a SQLite `SchedulerLedger`, the
 * `ScheduledConversationRuns` runner with the ports production gives it
 * (`runtime-routes.ts`), the `ThreadInboxDelivery` wired as the check-back
 * dispatch test wires it, the `OrchestrationService` over a SQLite
 * `EventStore`, and the engine adapters themselves. Only each engine's child
 * process is faked (`adapter-conformance-fixtures.ts`): ACP, and Codex as
 * the native-engine case.
 *
 * What this pins: a targeted run never touches the Station-engine turn
 * adapter, the engine receives the framed prompt with the "since last
 * successful run" watermark, the run settles from the turn's own terminal,
 * and a restart between the inbox hand-off and settlement yields exactly one
 * turn.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { automationRunClientTurnId } from '@kontourai/station-contracts/scheduler';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import {
  type ConformanceEngine,
  createConformanceEngine,
} from '../../../providers/__tests__/adapter-conformance-fixtures.js';
import { FakeAcpProcess } from '../../../providers/__tests__/fake-acp-process.js';
import { AcpAdapter } from '../../../providers/adapters/acp-adapter.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { createSchedulerRoutes } from '../../../routes/operations/scheduler.js';
import { composeAgentSchedule } from '../../../runtime/routes/agent-schedule-composition.js';
import type { ACPProcess } from '../../acp/acp-process.js';
import { EventBus } from '../../orchestration/event-bus.js';
import { EventStore } from '../../orchestration/event-store.js';
import { OrchestrationService } from '../../orchestration/orchestration-service.js';
import { ACTIVE_TURN_FOLD_METHODS } from '../../orchestration/session-lifecycle-service.js';
import { ThreadInboxDelivery } from '../../orchestration/thread-inbox.js';
import { BuiltinScheduler } from '../builtin-scheduler.js';
import {
  automationRunMessage,
  readScheduledTurnTerminal,
  readStoredScheduledTurnTerminal,
  SCHEDULED_TURN_TERMINAL_METHODS,
  SCHEDULED_TURN_TERMINAL_READ_LIMIT,
  ScheduledConversationRuns,
} from '../scheduled-conversation-runs.js';
import { createSchedulerLedger } from '../scheduler-ledger.js';

const makeTempDir = trackTempDirs();

const THREAD = 'automation-target-chat';
const OWNER = 'human:local:operator';
const JOB = 'repo-digest';
const PROMPT = 'Summarize what changed in the repository.';

async function waitFor<T>(
  read: () => T,
  matches: (value: T) => boolean,
  what: string,
  timeoutMs = 5_000,
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

/**
 * The ACP engine as the check-back dispatch test builds it: a connection
 * whose command exists, so the adapter's prerequisite check passes, and a
 * faked child process.
 */
function createAcpEngine(): ConformanceEngine {
  let child: FakeAcpProcess | undefined;
  const adapter = new AcpAdapter({
    getConnections: async () => [
      {
        id: 'conformance',
        name: 'Scripted Fake',
        command: process.execPath,
        args: [],
        enabled: true,
      },
    ],
    logger: { debug: () => {}, warn: () => {}, error: () => {} },
    processFactory: (opts) => {
      child = new FakeAcpProcess(opts);
      return child as unknown as ACPProcess;
    },
  });
  return {
    adapter,
    inputs: () => child?.promptContents ?? [],
    complete: () => child?.resolvePrompt('end_turn'),
    cleanup: async () => {
      child?.resolvePrompt('cancelled');
      await adapter.stopAll();
    },
  } as unknown as ConformanceEngine;
}

/** The prompt text an engine received, whatever its wire shape. */
function promptText(input: unknown): string {
  const parts = Array.isArray(input)
    ? input
    : ((input as { input?: unknown[] }).input ?? []);
  return (parts as Array<{ text?: string }>)
    .map((part) => part.text ?? '')
    .join('');
}

describe.each([
  {
    engineName: 'acp' as const,
    startMetadata: { connectionId: 'conformance' },
  },
  { engineName: 'codex' as const, startMetadata: {} },
])(
  'a targeted automation on a $engineName chat reaches the engine',
  ({ engineName, startMetadata }) => {
    let tmp: string;
    let previousStationHome: string | undefined;
    let store: EventStore;
    let bus: EventBus;
    let service: OrchestrationService;
    let engine: ConformanceEngine;
    let inbox: ThreadInboxDelivery;
    let stationTurns: { invoke: ReturnType<typeof vi.fn> };
    const schedulers: BuiltinScheduler[] = [];

    beforeEach(() => {
      tmp = makeTempDir(`automation-${engineName}-`);
      previousStationHome = process.env.STATION_HOME;
      process.env.STATION_HOME = join(tmp, 'home');
      mkdirSync(process.env.STATION_HOME, { recursive: true });
      store = new EventStore(join(tmp, 'orchestration.sqlite'));
      bus = new EventBus();
      engine =
        engineName === 'acp'
          ? createAcpEngine()
          : createConformanceEngine(engineName, tmp);
      const adapter = engine.adapter;
      // The Codex process is scripted; host CLI and login do not participate.
      if (engineName === 'codex')
        vi.spyOn(adapter, 'getPrerequisites').mockResolvedValue([]);
      service = new OrchestrationService({
        adapterRegistry: {
          register() {},
          get: (provider: string) =>
            provider === engineName ? adapter : undefined,
          list: () => [adapter],
        } as unknown as IProviderAdapterRegistry,
        eventBus: bus,
        eventStore: store,
        resolveSessionAgent: async (input: unknown) => ({
          ...(input as object),
          agent: { slug: 'ops-bot' },
        }),
        logger: { debug: vi.fn(), warn: vi.fn() },
      } as never);
      inbox = new ThreadInboxDelivery({
        store: store.threadInboxStore(),
        foldEvents: (threadId) =>
          store
            .listEventsByMethods(threadId, ACTIVE_TURN_FOLD_METHODS)
            .map((stored) => ({
              sequence: stored.sequence,
              event: stored.payload,
            })),
        headSequence: (threadId) =>
          store.readSessionInventoryHighWater(threadId),
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
        mayContinue: (_conversationId, userId) => userId === OWNER,
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
      stationTurns = { invoke: vi.fn() };
    });

    afterEach(async () => {
      for (const scheduler of schedulers.splice(0)) await scheduler.stop();
      inbox.stop();
      await inbox.idle();
      await engine.cleanup();
      await service.shutdown();
      store.close();
      if (previousStationHome === undefined) delete process.env.STATION_HOME;
      else process.env.STATION_HOME = previousStationHome;
    });

    /** A scheduler process over the shared ledger directory. */
    const startScheduler = () => {
      const scheduler = new BuiltinScheduler({
        ledger: createSchedulerLedger({ directory: join(tmp, 'scheduler') }),
        turnAdapter: stationTurns as never,
        conversationRuns: new ScheduledConversationRuns({
          submit: (input) => inbox.submit(input),
          entry: (conversationId, key) => inbox.entry(conversationId, key),
          turnTerminal: (sessionId, turnId) =>
            readScheduledTurnTerminal(
              store
                .listTurnEventsByMethods(
                  sessionId,
                  turnId,
                  SCHEDULED_TURN_TERMINAL_METHODS,
                  SCHEDULED_TURN_TERMINAL_READ_LIMIT,
                )
                .map((stored) => stored.payload),
            ),
          startDedicated: async () => {
            throw new Error('not a dedicated target');
          },
          isIndeterminateStart: () => false,
          pollMs: 10,
        }),
      });
      schedulers.push(scheduler);
      return scheduler;
    };

    const methods = () =>
      store.listEvents(THREAD).map((row) => row.payload.method);
    const prompts = () => engine.inputs().map(promptText);

    const startChat = async () => {
      await service.dispatch(
        {
          type: 'startSession',
          input: {
            threadId: THREAD,
            provider: engineName,
            cwd: tmp,
            ...(engineName === 'codex' ? { modelId: 'test-model' } : {}),
            metadata: { ...startMetadata, userId: OWNER },
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

    const addAutomation = async (scheduler: BuiltinScheduler) => {
      await scheduler.addJob({
        name: JOB,
        schedule: { kind: 'every', everyMs: 60 * 60_000 },
        prompt: PROMPT,
        target: { kind: 'conversation', conversationId: THREAD },
        createdBy: { userId: OWNER },
      });
    };

    test('the run lands in the chat as a framed Station turn and settles from that turn', async () => {
      await startChat();
      const scheduler = startScheduler();
      await addAutomation(scheduler);

      const firstRun = scheduler.runJob(JOB);
      await waitFor(prompts, (seen) => seen.length === 1, 'the first run');
      expect(prompts()[0]).toContain(
        automationRunMessage({
          jobName: JOB,
          prompt: PROMPT,
          lastSuccessAt: undefined,
        }),
      );
      // The Station-engine adapter is never the path for a targeted job.
      expect(stationTurns.invoke).not.toHaveBeenCalled();
      // Still running: the run waits on the turn, not on the hand-off.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(
        store.listEvents(THREAD).map((row) => row.payload.method),
      ).not.toContain('turn.completed');
      engine.complete();
      await expect(firstRun).resolves.toMatchObject({ outcome: 'completed' });

      const [firstLog] = await scheduler.getJobLogs(JOB);
      expect(firstLog).toMatchObject({ success: true, state: 'completed' });
      // It is Station's turn under the run's own key.
      const started = store
        .listEvents(THREAD)
        .map((row) => row.payload)
        .filter((event) => event.method === 'turn.started');
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({
        clientOrigin: { actor: { kind: 'internal' } },
      });
      expect(
        inbox
          .list(THREAD)
          .map((entry) => entry.clientTurnId)
          .every((key) => key?.startsWith('scheduler:')),
      ).toBe(true);

      // The next run's prompt carries the first run's success as its watermark.
      const lastSuccessAt = (await scheduler.listJobs())[0]!.lastSuccessAt;
      expect(lastSuccessAt).toBe(firstLog!.completedAt);
      const secondRun = scheduler.runJob(JOB);
      await waitFor(prompts, (seen) => seen.length === 2, 'the second run');
      expect(prompts()[1]).toContain(`Last successful run: ${lastSuccessAt}.`);
      engine.complete();
      await expect(secondRun).resolves.toMatchObject({ outcome: 'completed' });
    });

    // The reported bug: a job an agent proposed from a non-Station-engine chat,
    // once approved, failed at run time with "Agent not found". The proposal
    // targets the proposing chat, so the approved job runs on its engine.
    // The approval is the real composition and scheduler create route; the
    // proposal row is written as the propose_job route writes it (its target
    // is asserted in agent-schedule-authority.routes.test.ts).
    test('an approved propose_job runs as a turn in the proposing chat, on its engine', async () => {
      await startChat();
      const scheduler = startScheduler();
      const agentSchedule = store.agentScheduleStore();
      const proposed = agentSchedule.insertJobProposal({
        conversationId: THREAD,
        sessionId: THREAD,
        job: {
          name: JOB,
          schedule: { kind: 'every', everyMs: 60 * 60_000 },
          prompt: PROMPT,
          agent: 'ops-bot',
          target: { kind: 'conversation', conversationId: THREAD },
        },
        now: Date.now(),
      });
      if (proposed.outcome !== 'proposed') throw new Error('not proposed');
      const composition = composeAgentSchedule({
        store: agentSchedule,
        threadInbox: undefined,
        scope: undefined,
        orchestration: {
          canUserReadConversation: () => true,
          canUserMutateSession: (_threadId, userId) => userId === OWNER,
          currentConversationSessionId: (conversationId) => conversationId,
          readUsageLimitRecovery: async () => undefined,
        },
        hosted: false,
        isInternalRequest: () => false,
        isRequestPrincipalCurrent: () => true,
        requestUserId: () => OWNER,
        readAuthorityFor: () => ({ mode: 'personal' }) as never,
        tenantFor: () => undefined,
        dispatchActor: () => ({ userId: OWNER }),
        agentProject: async () => undefined,
        logger: { warn: vi.fn() },
      });
      const routes = createSchedulerRoutes(
        {
          addJob: (opts: Parameters<BuiltinScheduler['addJob']>[0]) =>
            scheduler.addJob(opts),
          listJobs: () => scheduler.listJobs(),
        } as never,
        { error: vi.fn(), info: vi.fn(), debug: vi.fn() } as never,
        {
          jobProposals: composition.jobProposals,
          admitAutomationTarget: composition.admitAutomationTarget,
          admitAutomationJob: composition.admitAutomationJob,
        },
      );
      const approved = await routes.request('/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...proposed.proposal.job,
          proposalId: proposed.proposal.id,
        }),
      });
      expect(approved.status).toBe(200);
      expect(agentSchedule.jobProposal(proposed.proposal.id)?.state).toBe(
        'approved',
      );

      const run = scheduler.runJob(JOB);
      await waitFor(prompts, (seen) => seen.length === 1, 'the approved run');
      expect(prompts()[0]).toContain(PROMPT);
      expect(stationTurns.invoke).not.toHaveBeenCalled();
      engine.complete();
      await expect(run).resolves.toMatchObject({ outcome: 'completed' });
    });

    test('a restart between the hand-off and settling yields exactly one turn', async () => {
      await startChat();
      const first = startScheduler();
      await addAutomation(first);

      const interrupted = first.runJob(JOB);
      await waitFor(prompts, (seen) => seen.length === 1, 'the run');
      // The process stops while the run's turn is still open.
      await first.stop();
      schedulers.splice(schedulers.indexOf(first), 1);
      await expect(interrupted).resolves.toMatchObject({
        outcome: 'indeterminate',
      });
      engine.complete();
      await waitFor(
        methods,
        (seen) => seen.includes('turn.completed'),
        'the turn to end',
      );

      // A fresh scheduler over the same ledger: the dead run is never
      // replayed, and handing the same key over again is the same entry.
      const restarted = startScheduler();
      const logs = await restarted.getJobLogs(JOB);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ success: false, state: 'indeterminate' });
      const runId = logs[0]!.id.replace(/-1$/, '');
      const again = inbox.submit({
        conversationId: THREAD,
        clientTurnId: automationRunClientTurnId(runId),
        payload: {
          message: automationRunMessage({
            jobName: JOB,
            prompt: PROMPT,
            lastSuccessAt: undefined,
          }),
          actor: { userId: OWNER },
        },
      });
      expect(again.outcome).toBe('queued');
      await inbox.idle();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(prompts()).toHaveLength(1);
      expect(
        store
          .listEvents(THREAD)
          .filter((row) => row.payload.method === 'turn.started'),
      ).toHaveLength(1);
    });
  },
);

test('REVIEW: a completed turn after 50 deferred retry errors still settles', async () => {
  const root = makeTempDir('review-terminal-prefix-');
  const store = new EventStore(join(root, 'events.sqlite'));
  try {
    for (let i = 0; i < SCHEDULED_TURN_TERMINAL_READ_LIMIT + 1; i++)
      store.appendEvent({
        eventId: `retry-${i}`,
        provider: 'codex',
        threadId: 'review-chat',
        turnId: 'review-turn',
        method: 'runtime.error',
        createdAt: '2026-10-28T00:00:00.000Z',
        message: 'reconnecting',
        severity: 'error',
        retriable: true,
      });
    store.appendEvent({
      eventId: 'completed-after-retries',
      provider: 'codex',
      threadId: 'review-chat',
      turnId: 'review-turn',
      method: 'turn.completed',
      createdAt: '2026-10-28T00:01:00.000Z',
      finishReason: 'stop',
    } as never);
    expect(
      readScheduledTurnTerminal(
        store
          .listTurnEventsByMethods(
            'review-chat',
            'review-turn',
            SCHEDULED_TURN_TERMINAL_METHODS,
            SCHEDULED_TURN_TERMINAL_READ_LIMIT + 2,
          )
          .map((row) => row.payload),
      ),
    ).toEqual({ kind: 'completed' });
    const runner = new ScheduledConversationRuns({
      submit: () =>
        ({ outcome: 'queued', entry: { state: 'queued' } }) as never,
      entry: () =>
        ({
          state: 'sent',
          sessionId: 'review-chat',
          turnId: 'review-turn',
        }) as never,
      turnTerminal: (sessionId, turnId) =>
        readStoredScheduledTurnTerminal(store, sessionId, turnId),
      startDedicated: async () => {
        throw new Error('not dedicated');
      },
      isIndeterminateStart: () => false,
      pollMs: 1,
      deadlineMs: 10,
    });
    const outcome = await runner.run({
      jobId: 'review-job',
      jobName: 'review-job',
      runId: 'review-run',
      prompt: 'x',
      target: { kind: 'conversation', conversationId: 'review-chat' },
      createdBy: { userId: OWNER },
      lastSuccessAt: undefined,
      onConversationStarted: () => {},
      onHandedOff: () => {},
      signal: new AbortController().signal,
    });
    expect(outcome).toMatchObject({ kind: 'completed' });
  } finally {
    store.close();
  }
});
