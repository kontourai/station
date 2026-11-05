import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AutomationActionIntent } from '@kontourai/station-contracts/automation';
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
import { installManagedApprovalCeiling } from '../../../security/managed-approval-ceiling.js';
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
import {
  automationEpisodeKey,
  recordAutomationEvent,
} from '../automation-intake.js';
import {
  automationConfigurationFingerprint,
  automationIntentId,
  automationPolicyFingerprint,
} from '../automation-intent.js';
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
  readonly starts: ProviderSessionStartInput[] = [];
  override async startSession(input: ProviderSessionStartInput) {
    this.starts.push(input);
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
    /** One rule per entry, written in this mode (#4509). */
    ruleModes?: readonly ('observe' | 'live')[];
    /** Store the rules in the pre-#4509 `enabled: true` shape. */
    legacyEnabled?: boolean;
    /** The rule action's posture (`dispatch-task` `approvalMode`). */
    approvalMode?: 'ask' | 'auto';
  } = {},
) {
  const ruleModes = options.ruleModes ?? ['live'];
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
  const rules = [];
  for (const [index] of ruleModes.entries())
    rules.push(
      await store.createRule({
        ...QUALIFICATION_RULE,
        name: index === 0 ? QUALIFICATION_RULE.name : `rule ${index}`,
        ...(options.episode === false ? { episode: undefined } : {}),
        sourceId: source.id,
        action: {
          kind: 'dispatch-task',
          projectId: 'project',
          agentId: FIXTURE_TASK_AGENT,
          instructions: 'Investigate the failure.',
          budget: { maxTurns: 1, maxTokens: 20000, maxWallRuntimeMs: 60000 },
          ...(options.approvalMode
            ? { approvalMode: options.approvalMode }
            : {}),
        },
      }),
    );
  const rule = rules[0]!;
  const draft = store.read();
  writeFileSync(
    store.path,
    JSON.stringify({
      ...draft,
      sources: draft.sources.map((source) => ({ ...source, enabled: true })),
      rules: draft.rules.map(({ mode: _mode, ...rule }, index) =>
        options.legacyEnabled
          ? { ...rule, enabled: true }
          : { ...rule, mode: ruleModes[index] },
      ),
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
  // As the poller does: the source's actionable rules, read for the delivery.
  const intake = (event = normalized.event) =>
    recordAutomationEvent({
      ledger,
      rules: store.actionableRules(source.id),
      source: store.read().sources[0],
      event,
      transportId: event.semanticKey,
      now: Date.now(),
    });
  intake();
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
  const makeRuntime = () =>
    createAutomationActionsRuntime({
      hosted: false,
      isProjectCurrent: (id) => projectIds.has(id),
      featurePreviews: previews,
      store,
      ledger: ledgerReads,
      existingLedger: () => ledger,
      taskGraph: graph,
      taskDispatcher: dispatcher,
      orchestration: service,
      eventStore,
      eventBus: bus,
      inbox: () => inbox,
      logger: { warn: warnings } as never,
    });
  let runtime = makeRuntime();
  inbox = new ThreadInboxDelivery({
    store: eventStore.threadInboxStore(),
    get automation() {
      return runtime;
    },
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
      const result = (await service.dispatch(
        {
          type: 'sendTurn',
          input: {
            threadId,
            input: payload.message,
            clientTurnId,
          },
        },
        { clientOrigin: payload.clientOrigin },
      )) as ProviderTurnStartResult;
      return {
        outcome: 'started',
        conversationId,
        sessionId: threadId,
        turnId: result.turnId,
      };
    },
    subscribe: (listener) =>
      bus.subscribe((message) => {
        if (
          message.event === SERVER_EVENTS.ORCHESTRATION_EVENT &&
          message.data
        ) {
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
    get runtime() {
      return runtime;
    },
    rebootController() {
      runtime.close();
      runtime = makeRuntime();
    },
    intake,
    firstEvent: normalized.event,
    rules,
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

test('Task dispatch reports retryable unavailable instead of waiting for engine capacity', async () => {
  const w = await world();
  const task = await w.graph.createTask({
    projectId: 'project',
    agentId: FIXTURE_TASK_AGENT,
    title: 'Capacity-constrained task',
  });
  const held = w.controller.reserveEngineStart();
  let queued!: () => void;
  const queuedSignal = new Promise<'queued'>((resolve) => {
    queued = () => resolve('queued');
  });
  const wait = w.controller.waitForEngineStart.bind(w.controller);
  vi.spyOn(w.controller, 'waitForEngineStart').mockImplementation((signal) => {
    const result = wait(signal);
    queued();
    return result;
  });
  const dispatch = w.dispatcher.dispatch(task.id, {
    ownerUserId: 'test-owner',
    fullAccessGrant: null,
    agentId: FIXTURE_TASK_AGENT,
    provider: 'claude',
  });
  try {
    expect(await Promise.race([dispatch, queuedSignal])).toMatchObject({
      kind: 'unavailable',
      retryable: true,
    });
  } finally {
    held.release();
    await dispatch;
  }
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

test('controller recovery enforces retained Automation authority before polling or tick even with the preview disabled', async () => {
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
  await w.previews.setEnabled('github-automation-actions', false);
  w.rebootController();
  await expect(
    w.service.dispatch({
      type: 'sendTurn',
      input: {
        threadId: intent.sessionId!,
        input: 'Another continuation',
        clientTurnId: 'different-original-key',
      },
    }),
  ).rejects.toThrow('Automation authority changed before turn dispatch');
  expect(w.adapter.sends).toEqual([]);
  release();
  await vi.waitFor(() =>
    expect(
      w.inbox.entry(intent.conversationId!, `automation:${intent.intentId}`)
        ?.state,
    ).toBe('refused'),
  );
  expect(w.adapter.sends).toEqual([]);
});

type World = Awaited<ReturnType<typeof world>>;
type NativeAction = Extract<
  AutomationActionIntent['action'],
  { kind: 'dispatch-task' }
>;

async function setRuleMode(
  w: World,
  ruleId: string,
  mode: 'off' | 'observe' | 'live',
) {
  await w.store.setEnabled({
    kind: 'rule',
    id: ruleId,
    expectedFingerprint: automationConfigurationFingerprint(w.store.read()),
    mode,
  });
}

function laterFailure(w: World) {
  const normalized = normalizeGitHubWorkflowRun(
    workflowRun({
      id: 37423043590,
      conclusion: 'failure',
      updatedAt: new Date(Date.now() - 500).toISOString(),
    }),
    { source: w.store.read().sources[0]!, receivedAt: Date.now() },
  );
  if (normalized.kind !== 'event') throw new Error(normalized.reason);
  return normalized.event;
}

test('an observe rule records would-start and creates no intent, Task or provider turn with the actions preview on (#4509)', async () => {
  const w = await world({ ruleModes: ['observe'] });
  expect(w.ledger.listActionIntents()).toEqual([]);
  await w.previews.setEnabled('github-automation-actions', true);
  await w.runtime.tick();
  await w.runtime.tick();
  expect(w.ledger.listDeliveries()).toEqual([
    expect.objectContaining({
      outcome: 'matched',
      ruleId: w.rule.id,
      decisions: [
        expect.objectContaining({
          ruleId: w.rule.id,
          ruleName: QUALIFICATION_RULE.name,
          mode: 'observe',
          outcome: 'would-start',
          actionKind: 'dispatch-task',
          projectId: 'project',
          agentId: FIXTURE_TASK_AGENT,
        }),
      ],
    }),
  ]);
  expect(w.ledger.listActionIntents()).toEqual([]);
  expect(w.ledger.listEpisodes()).toEqual([]);
  expect(w.graph.listTasks()).toEqual([]);
  expect(w.adapter.sends).toEqual([]);
});

test('switching an observe rule to live dispatches nothing for the earlier event; a later event acts (#4509)', async () => {
  const w = await world({ ruleModes: ['observe'] });
  expect(w.ledger.listActionIntents()).toEqual([]);
  await setRuleMode(w, w.rule.id, 'live');
  await w.previews.setEnabled('github-automation-actions', true);
  // The poller re-reads recent runs; the observed run is a semantic duplicate.
  expect(w.intake(w.firstEvent).outcome).toBe('duplicate');
  await w.runtime.tick();
  await w.runtime.tick();
  expect(w.ledger.listActionIntents()).toEqual([]);
  expect(w.graph.listTasks()).toEqual([]);
  expect(w.adapter.sends).toEqual([]);
  expect(w.intake(laterFailure(w)).outcome).toBe('matched');
  await w.runtime.tick();
  await vi.waitFor(() => expect(w.adapter.sends).toHaveLength(1));
  expect(w.adapter.sends[0]?.principal).toEqual({
    kind: 'automation-rule',
    ruleId: w.rule.id,
  });
  expect(w.graph.listTasks()).toHaveLength(1);
});

test('a delivery matching an observe and a live rule records both decisions and dispatches only the live rule (#4509)', async () => {
  const w = await world({ ruleModes: ['observe', 'live'] });
  const [observe, live] = w.rules;
  const [delivery] = w.ledger.listDeliveries();
  expect(delivery?.ruleId).toBe(live!.id);
  expect(
    [...(delivery?.decisions ?? [])]
      .map(({ ruleId, mode, outcome }) => ({ ruleId, mode, outcome }))
      .sort((a, b) => a.mode.localeCompare(b.mode)),
  ).toEqual([
    { ruleId: live!.id, mode: 'live', outcome: 'intent-retained' },
    { ruleId: observe!.id, mode: 'observe', outcome: 'would-start' },
  ]);
  expect(w.ledger.listActionIntents().map(({ ruleId }) => ruleId)).toEqual([
    live!.id,
  ]);
  await w.previews.setEnabled('github-automation-actions', true);
  await w.runtime.tick();
  await vi.waitFor(() => expect(w.adapter.sends).toHaveLength(1));
  await w.runtime.tick();
  expect(w.adapter.sends).toHaveLength(1);
  expect(w.adapter.sends[0]?.principal).toEqual({
    kind: 'automation-rule',
    ruleId: live!.id,
  });
  expect(w.graph.listTasks()).toHaveLength(1);
});

test('a pre-#4509 file with enabled: true still dispatches as a live rule (#4509)', async () => {
  const w = await world({ legacyEnabled: true });
  const stored = JSON.parse(readFileSync(w.store.path, 'utf8')).rules[0];
  expect(stored.enabled).toBe(true);
  expect(stored).not.toHaveProperty('mode');
  expect(w.store.read().rules[0]?.mode).toBe('live');
  expect(w.ledger.listDeliveries()[0]?.decisions).toEqual([
    expect.objectContaining({ mode: 'live', outcome: 'intent-retained' }),
  ]);
  await w.previews.setEnabled('github-automation-actions', true);
  await w.runtime.tick();
  await vi.waitFor(() => expect(w.adapter.sends).toHaveLength(1));
  expect(w.adapter.sends[0]?.principal).toEqual({
    kind: 'automation-rule',
    ruleId: w.rule.id,
  });
  expect(w.graph.listTasks()).toHaveLength(1);
});

test('a pending live intent is refused, not dispatched, once its rule is switched to observe (#4509)', async () => {
  const w = await world();
  const [intent] = w.ledger.listActionIntents();
  expect(intent?.state).toBe('pending');
  await setRuleMode(w, w.rule.id, 'observe');
  await w.previews.setEnabled('github-automation-actions', true);
  await w.runtime.tick();
  expect(w.ledger.readIntent(intent!.intentId)).toMatchObject({
    state: 'refused',
    reason: 'policy_changed',
  });
  expect(w.graph.listTasks()).toEqual([]);
  expect(w.adapter.sends).toEqual([]);
});

test('the mode check alone refuses an intent whose fingerprint matches the rule as it is now in observe (#4509)', async () => {
  const w = await world({ ruleModes: ['observe'] });
  const config = w.store.read();
  const source = config.sources[0]!;
  const rule = config.rules[0]!;
  expect(rule.mode).toBe('observe');
  // Intake never retains an intent for an observe rule, so write one through
  // the ledger's own intake transaction with the fingerprint of the current
  // observe rule: only the consumer's mode check can refuse it.
  const event = laterFailure(w);
  const episodeKey = automationEpisodeKey(rule, event)!;
  const episodeId = event.fields['run.id']!;
  w.ledger.recordIntake({
    delivery: {
      sourceId: source.id,
      transportId: event.semanticKey,
      semanticKey: event.semanticKey,
      eventType: event.type,
      receivedAt: Date.now(),
      outcome: 'matched',
      ruleId: rule.id,
    },
    openings: [
      {
        ruleId: rule.id,
        episodeKey,
        episodeId,
        maxAttempts: 1,
        now: Date.now(),
      },
    ],
    closings: [],
    intents: [
      {
        intentId: automationIntentId(rule.id, episodeKey, episodeId),
        sourceId: source.id,
        ruleId: rule.id,
        episodeKey,
        episodeId,
        policyFingerprint: automationPolicyFingerprint(source, rule),
        event,
        action: rule.action as NativeAction,
      },
    ],
    now: Date.now(),
  });
  const [intent] = w.ledger.listActionIntents();
  expect(intent?.state).toBe('pending');
  await w.previews.setEnabled('github-automation-actions', true);
  await w.runtime.tick();
  expect(w.ledger.readIntent(intent!.intentId)).toMatchObject({
    state: 'refused',
    reason: 'policy_changed',
  });
  expect(w.graph.listTasks()).toEqual([]);
  expect(w.adapter.sends).toEqual([]);
});

/**
 * #4518: an automation rule's posture is a default, so under the machine's
 * managed approval ceiling its run starts at the ceiling. Driven through the
 * real automation runtime, Task dispatcher and `OrchestrationService`.
 */
test('an Auto automation rule starts its engine at a managed ceiling of Ask', async () => {
  const w = await world({ approvalMode: 'auto' });
  installManagedApprovalCeiling({
    summary: {
      organization: 'Acme',
      supportUrl: null,
      lockedSettings: [],
      limits: { maxApprovalMode: 'ask' },
    },
  });
  cleanup.push(async () => installManagedApprovalCeiling(null));
  await w.previews.setEnabled('github-automation-actions', true);
  await w.runtime.tick();
  await vi.waitFor(() => expect(w.adapter.sends).toHaveLength(1));
  expect(w.adapter.starts.length).toBeGreaterThan(0);
  expect(
    w.adapter.starts.map((start) => start.modelOptions?.approvalMode),
  ).toEqual(w.adapter.starts.map(() => 'ask'));
});

test('control: without a ceiling the same Auto rule starts at Auto', async () => {
  const w = await world({ approvalMode: 'auto' });
  await w.previews.setEnabled('github-automation-actions', true);
  await w.runtime.tick();
  await vi.waitFor(() => expect(w.adapter.sends).toHaveLength(1));
  expect(w.adapter.starts[0]?.modelOptions?.approvalMode).toBe('auto');
});
