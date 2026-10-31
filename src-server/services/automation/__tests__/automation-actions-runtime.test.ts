import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type CanonicalRuntimeEvent,
  SERVER_EVENTS,
} from '@kontourai/station-contracts/runtime-events';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { afterEach, expect, test, vi } from 'vitest';
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
import { currentUnattendedPrincipal } from '../../../runtime/agents/unattended-principal-context.js';
import { createAutomationActionsRuntime } from '../../../runtime/automation-actions-runtime.js';
import { FeaturePreviewRegistry } from '../../feature-previews/feature-preview-registry.js';
import { createRuntimeResourcePostureController } from '../../infra/resource-posture.js';
import { EventBus } from '../../orchestration/event-bus.js';
import { EventStore } from '../../orchestration/event-store.js';
import { OrchestrationService } from '../../orchestration/orchestration-service.js';
import { ACTIVE_TURN_FOLD_METHODS } from '../../orchestration/session-lifecycle-service.js';
import { ThreadInboxDelivery } from '../../orchestration/thread-inbox.js';
import {
  FIXTURE_TASK_AGENT,
  fixtureAgentStartResolver,
  fixtureTaskAgentSessionResolver,
} from '../../projects/__tests__/task-dispatch-test-helpers.js';
import { createTaskBriefSource } from '../../projects/task-brief-source.js';
import { composeTaskDispatcher } from '../../projects/task-dispatch-composition.js';
import { TaskGraphService } from '../../projects/task-graph-service.js';
import { GitHubWorkItemObserver } from '../../work-item-providers/github-work-item-observer.js';
import { recordAutomationEvent } from '../automation-intake.js';
import { createAutomationLedger } from '../automation-ledger.js';
import { AutomationStore } from '../automation-store.js';
import { normalizeGitHubWorkflowRun } from '../github-workflow-run.js';
import {
  QUALIFICATION_RULE,
  workflowRun,
} from './fixtures/workflow-run-fixture.js';

const makeTempDir = trackTempDirs();
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

class RecordingAdapter extends GateTestAdapter {
  readonly sends: {
    input: string;
    principal: ReturnType<typeof currentUnattendedPrincipal>;
    invocationId?: string;
  }[] = [];
  override async startSession(input: ProviderSessionStartInput) {
    const session = await super.startSession(input);
    this.events.push({
      method: 'session.started',
      eventId: `started-${input.threadId}`,
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      createdAt: new Date().toISOString(),
      initialState: 'created',
      metadata: input.metadata,
    } as CanonicalRuntimeEvent);
    return session;
  }
  override async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    this.sends.push({
      input: input.input,
      principal: currentUnattendedPrincipal(),
      invocationId: input.invocationId,
    });
    const turnId = `turn-${this.sends.length}`;
    this.events.push({
      method: 'turn.started',
      eventId: `start-${turnId}`,
      provider: this.provider,
      threadId: input.threadId,
      turnId,
      createdAt: new Date().toISOString(),
      prompt: input.input,
      invocationId: input.invocationId,
    } as CanonicalRuntimeEvent);
    return { threadId: input.threadId, turnId };
  }
}

async function world(
  options: {
    episode?: boolean;
    turnPreparation?: { entered(): void; wait: Promise<void> };
  } = {},
) {
  const home = makeTempDir('automation-actions-');
  const store = new AutomationStore(home);
  const source = (
    await store.createSource({
      kind: 'github-poll',
      name: 'fixture',
      repository: 'kontourai/station',
      grants: [
        {
          projectId: 'project',
          agentId: FIXTURE_TASK_AGENT,
          actions: ['dispatch-task'],
        },
      ],
    })
  ).source;
  const rule = await store.createRule({
    ...QUALIFICATION_RULE,
    ...(options.episode === false ? { episode: undefined } : {}),
    sourceId: source.id,
    action: {
      kind: 'dispatch-task',
      projectId: 'project',
      agentId: FIXTURE_TASK_AGENT,
      instructions: 'Investigate the failure.',
      budget: { maxTurns: 1, maxTokens: 20000, maxWallRuntimeMs: 60000 },
    },
  });
  const draft = store.read();
  writeFileSync(
    store.path,
    JSON.stringify({
      ...draft,
      sources: draft.sources.map((source) => ({ ...source, enabled: true })),
      rules: draft.rules.map((rule) => ({ ...rule, enabled: true })),
    }),
    { mode: 0o600 },
  );
  const config = store.read();
  const normalized = normalizeGitHubWorkflowRun(
    workflowRun({
      conclusion: 'failure',
      updatedAt: new Date(Date.now() - 1000).toISOString(),
    }),
    { source: config.sources[0]!, receivedAt: Date.now() },
  );
  if (normalized.kind !== 'event') throw new Error(normalized.reason);
  const ledger = createAutomationLedger({
    directory: join(home, 'automation'),
  });
  recordAutomationEvent({
    ledger,
    rules: [config.rules[0]!],
    source: config.sources[0],
    event: normalized.event,
    transportId: normalized.event.semanticKey,
    now: Date.now(),
  });
  const bus = new EventBus();
  const eventStore = new EventStore(join(home, 'events.sqlite'));
  const adapter = new RecordingAdapter();
  const controller = createRuntimeResourcePostureController();
  const service = new OrchestrationService({
    resourcePosture: controller,
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: bus,
    eventStore,
    resolveSessionAgent: fixtureTaskAgentSessionResolver,
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  const graphHome = join(home, 'graph');
  mkdirSync(graphHome);
  const graph = new TaskGraphService(graphHome, {
    projectService: {
      getProject: (slug) => ({
        id: slug,
        slug,
        name: slug,
        workingDirectory: home,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    },
  });
  const dispatcher = composeTaskDispatcher(graph, {
    orchestrationService: service,
    resolveAgentStart: (input) =>
      fixtureAgentStartResolver('claude')({ ...input, cwd: home }),
    resolveProjectWorkspace: () => home,
    ...(options.turnPreparation
      ? {
          taskBrief: createTaskBriefSource({
            readTask: (id) => graph.readTaskView(id),
            listTaskSessions: (id) => graph.listTaskDispatchSessions(id),
            readDocument: async () => ({
              kind: 'unavailable',
              reason: 'No fixture document',
            }),
            memory: eventStore.taskMemoryStore(),
            readBinding: (id) =>
              eventStore.readProjectTaskRoomExecutionBinding(id),
            workItemObserver: new GitHubWorkItemObserver(),
          }),
        }
      : {}),
  });
  if (options.turnPreparation)
    service.bindMandatoryTaskContextVerifier(async () => {
      options.turnPreparation!.entered();
      await options.turnPreparation!.wait;
    });
  const previews = new FeaturePreviewRegistry(home, {
    info: vi.fn(),
    error: vi.fn(),
  } as never);
  let inbox: ThreadInboxDelivery | undefined;
  const projectIds = new Set(['project']);
  const warnings = vi.fn();
  const ledgerReads = vi.fn(() => ledger);
  const runtime = createAutomationActionsRuntime({
    hosted: false,
    isProjectCurrent: (id) => projectIds.has(id),
    featurePreviews: previews,
    store,
    ledger: ledgerReads,
    taskGraph: graph,
    taskDispatcher: dispatcher,
    orchestration: service,
    eventStore,
    eventBus: bus,
    inbox: () => inbox,
    logger: { warn: warnings } as never,
  });
  inbox = new ThreadInboxDelivery({
    store: eventStore.threadInboxStore(),
    automation: runtime,
    foldEvents: (threadId) =>
      eventStore
        .listEventsByMethods(threadId, ACTIVE_TURN_FOLD_METHODS)
        .map((row) => ({ sequence: row.sequence, event: row.payload })),
    headSequence: (threadId) =>
      eventStore.readSessionInventoryHighWater(threadId),
    coordinatorBusy: (threadId) => service.hasActiveTurn(threadId),
    hasPossibleEffect: (threadId) =>
      eventStore.sessionTurnBoundaryAuthority().hasPossibleEffect(threadId),
    readInvocationTerminal: (threadId, invocationId, turnId) =>
      eventStore.readInvocationTerminal(threadId, invocationId, turnId),
    readInputlessTurnDisposition: (threadId) =>
      eventStore.readInputlessTurnDisposition(threadId),
    conversationOf: (threadId) =>
      eventStore.conversationForSession(threadId)?.conversationId ?? threadId,
    currentSessionId: (conversationId) =>
      service.currentConversationSessionId(conversationId),
    mayContinue: () => true,
    inspectDelivery: (conversationId, key) =>
      service.inspectTurnDelivery(
        conversationId,
        key,
        INTERNAL_SESSION_READ_SCOPE,
      ),
    start: async ({ threadId, conversationId, payload, clientTurnId }) => {
      const result = (await service.dispatch({
        type: 'sendTurn',
        input: {
          threadId,
          input: payload.message,
          clientTurnId,
          clientOrigin: payload.clientOrigin,
        },
      })) as ProviderTurnStartResult;
      return {
        outcome: 'started',
        conversationId,
        sessionId: threadId,
        turnId: result.turnId,
      };
    },
    subscribe: (listener) =>
      bus.subscribe((message) => {
        if (message.event === SERVER_EVENTS.ORCHESTRATION_EVENT) {
          const event = message.data.event as CanonicalRuntimeEvent;
          listener({ threadId: event.threadId, method: event.method });
        }
      }),
    logger: { warn: vi.fn() },
    retryDelaysMs: [5, 10],
  });
  inbox.start();
  cleanup.push(async () => {
    runtime.close();
    await inbox?.stop();
    await service.shutdown();
    eventStore.close();
    ledger.close();
  });
  return {
    controller,
    projectIds,
    ledgerReads,
    dispatcher,
    ledger,
    runtime,
    store,
    previews,
    adapter,
    rule,
    source,
    graph,
    warnings,
    service,
    eventStore,
    inbox,
  };
}

test('a normalized intent reaches a real Task, Session and first provider turn once with Automation authority', async () => {
  const w = await world();
  await w.runtime.tick();
  expect(w.adapter.sends).toEqual([]);
  await w.previews.setEnabled('github-automation-actions', true);
  const intentId = w.ledger.listActionIntents()[0]!.intentId;
  await w.runtime.tick();
  expect(
    w.ledger.readIntent(intentId)?.state,
    JSON.stringify(w.warnings.mock.calls),
  ).toMatch(/queued|running/);
  await vi.waitFor(() => expect(w.adapter.sends).toHaveLength(1));
  expect(w.adapter.sends[0]?.principal).toEqual({
    kind: 'automation-rule',
    ruleId: w.rule.id,
  });
  expect(w.adapter.sends[0]?.input).toContain('Investigate the failure.');
  expect(w.adapter.sends[0]?.input).toContain('quoted source data');
  const intent = w.ledger.listActionIntents()[0]!;
  expect(intent.taskId).toBeTruthy();
  expect(w.graph.readTaskView(intent.taskId!)?.sessionId).toBe(
    intent.sessionId,
  );
  await w.runtime.tick();
  expect(w.adapter.sends).toHaveLength(1);
});

test('revoking the source before dispatch refuses the retained intent without creating a Task or provider turn', async () => {
  const w = await world();
  await w.previews.setEnabled('github-automation-actions', true);
  const config = w.store.read();
  writeFileSync(
    w.store.path,
    JSON.stringify({
      ...config,
      sources: config.sources.map((source) => ({ ...source, enabled: false })),
    }),
    { mode: 0o600 },
  );
  await w.runtime.tick();
  expect(w.adapter.sends).toEqual([]);
  expect(w.ledger.listActionIntents()).toEqual([]);
  expect(w.ledger.listDeliveries()[0]?.outcome).toBe('refused');
});

test('actual engine-start capacity refusal retains one pending intent/Task and consumes no attempt until admitted', async () => {
  const w = await world();
  const intentId = w.ledger.listActionIntents()[0]!.intentId;
  await w.previews.setEnabled('github-automation-actions', true);
  const held = w.controller.reserveEngineStart();
  try {
    await w.runtime.tick();
    const retained = w.ledger.readIntent(intentId)!;
    expect(retained.state, JSON.stringify(w.warnings.mock.calls)).toBe(
      'pending',
    );
    expect(w.ledger.episode(retained.episodeKey)?.attemptCount).toBe(0);
    expect(w.adapter.sends).toEqual([]);
    expect(retained.taskId).toBeTruthy();
    await w.previews.setEnabled('github-automation-actions', false);
    w.ledgerReads.mockClear();
    await w.runtime.tick();
    expect(w.ledgerReads).not.toHaveBeenCalled();
    expect(w.adapter.sends).toEqual([]);
    await w.previews.setEnabled('github-automation-actions', true);
    held.release();
    await w.runtime.tick();
    await vi.waitFor(() => expect(w.adapter.sends).toHaveLength(1));
    expect(w.ledger.readIntent(intentId)?.taskId).toBe(retained.taskId);
    expect(w.ledger.episode(retained.episodeKey)?.attemptCount).toBe(1);
  } finally {
    held.release();
  }
});

test('canceling a capacity-deferred Task refuses its retained intent instead of restarting work', async () => {
  const w = await world();
  const intentId = w.ledger.listActionIntents()[0]!.intentId;
  await w.previews.setEnabled('github-automation-actions', true);
  const held = w.controller.reserveEngineStart();
  try {
    await w.runtime.tick();
    const pending = w.ledger.readIntent(intentId)!;
    expect(pending.state).toBe('pending');
    if (!pending.taskId) throw new Error('Expected retained Task');
    await w.graph.updateTaskStatus(pending.taskId, 'canceled');
    held.release();
    await w.runtime.tick();
    expect(w.ledger.readIntent(intentId)?.state).toBe('refused');
    expect(w.graph.readTaskView(pending.taskId)?.status).toBe('canceled');
    expect(w.adapter.sends).toEqual([]);
  } finally {
    held.release();
  }
});

test('withdrawing the immutable Project refuses work even while a same-named workspace lookup remains', async () => {
  const w = await world();
  const intentId = w.ledger.listActionIntents()[0]!.intentId;
  await w.previews.setEnabled('github-automation-actions', true);
  w.projectIds.delete('project');
  w.projectIds.add('replacement-project-id');
  await w.runtime.tick();
  expect(w.ledger.readIntent(intentId)?.state).toBe('refused');
  expect(w.ledger.readIntent(intentId)?.taskId).toBeUndefined();
  expect(w.adapter.sends).toEqual([]);
});

test('a rule without an episode policy keeps its delivery episode until the actual turn completes', async () => {
  const w = await world({ episode: false });
  await w.previews.setEnabled('github-automation-actions', true);
  const original = w.ledger.listActionIntents()[0]!;
  await w.runtime.tick();
  await vi.waitFor(() => expect(w.adapter.sends).toHaveLength(1));
  const running = w.ledger.readIntent(original.intentId)!;
  expect(w.ledger.episode(original.episodeKey)?.episodeId).toBe(
    original.episodeId,
  );
  expect(running.state).toBe('running');
  w.adapter.events.push({
    method: 'turn.completed',
    eventId: 'no-episode-completion',
    provider: w.adapter.provider,
    threadId: running.sessionId!,
    turnId: running.turnId!,
    createdAt: new Date().toISOString(),
    finishReason: 'stop',
    invocationId: w.adapter.sends[0]?.invocationId,
  } as CanonicalRuntimeEvent);
  await vi.waitFor(() =>
    expect(
      w.eventStore.latestEventByMethods(running.sessionId!, ['turn.completed']),
    ).toBeTruthy(),
  );
  await w.runtime.tick();
  expect(w.ledger.readIntent(original.intentId)?.state).toBe('completed');
  expect(w.ledger.episode(original.episodeKey)).toBeUndefined();
});

test('source withdrawal during awaited turn preparation refuses the physical send under the original inbox key', async () => {
  let reached = false;
  let release: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const w = await world({
    turnPreparation: {
      entered: () => {
        reached = true;
      },
      wait,
    },
  });
  await w.previews.setEnabled('github-automation-actions', true);
  await w.runtime.tick();
  await vi.waitFor(() => expect(reached).toBe(true));
  const intent = w.ledger.listActionIntents()[0]!;
  const config = w.store.read();
  writeFileSync(
    w.store.path,
    JSON.stringify({
      ...config,
      sources: config.sources.map((source) => ({ ...source, enabled: false })),
    }),
    { mode: 0o600 },
  );
  release();
  await vi.waitFor(() =>
    expect(
      w.inbox.entry(intent.conversationId!, `automation:${intent.intentId}`)
        ?.state,
    ).toBe('refused'),
  );
  expect(w.adapter.sends).toEqual([]);
});
