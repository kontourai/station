import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';

const taskMetrics = vi.hoisted(() => ({
  graphLinkCreatedTotal: { add: vi.fn() },
  graphQueryTotal: { add: vi.fn() },
  taskDispatchStartLatencyMs: { record: vi.fn() },
  taskAssignmentClaimTotal: { add: vi.fn() },
  taskDispatchTotal: { add: vi.fn() },
  taskReferenceCreatedTotal: { add: vi.fn() },
  taskWorkspaceBindingTotal: { add: vi.fn() },
  taskWorkspaceOpenTotal: { add: vi.fn() },
  // archive#1501: the workspace seam now resolves through
  // `project-resource-resolver.ts`, which records this instrument from the
  // SAME module this mock replaces wholesale. Omitting it left it undefined
  // and every resolution threw a TypeError.
  projectResourceResolutions: { add: vi.fn() },
  // The §4.1 pin drives a real `OrchestrationService` start to assert the
  // CHAT half of the split (slice 3b review, FIX 4). These are the
  // instruments that path records; this mock replaces the module wholesale,
  // so an omission surfaces as an unrelated TypeError rather than as a
  // missing metric.
  adapterReadiness: { add: vi.fn() },
  adapterSessionStartDuration: { record: vi.fn() },
  adapterTurnDuration: { record: vi.fn() },
  attachedSessionMutationRejected: { add: vi.fn() },
  chatAttachmentBytesDispatched: { add: vi.fn() },
  chatAttachmentsDispatched: { add: vi.fn() },
  chatStartGate: { add: vi.fn() },
  flowEvidenceAttached: { add: vi.fn() },
  flowEvidenceAutoSuperseded: { add: vi.fn() },
  flowExceptionsAccepted: { add: vi.fn() },
  flowGateEvaluations: { add: vi.fn() },
  flowReportsGenerated: { add: vi.fn() },
  flowRunsStarted: { add: vi.fn() },
  flowSessionGateChecks: { add: vi.fn() },
  modelLaunchResolutionTotal: { add: vi.fn() },
  orchestrationCommandsDispatched: { add: vi.fn() },
  orchestrationEventsPersisted: { add: vi.fn() },
  orchestrationEventPersistDuration: { record: vi.fn() },
  orchestrationTurnDedup: { add: vi.fn() },
  policyChecks: { add: vi.fn() },
  sessionCwdResolution: { add: vi.fn() },
  sessionOwnerCacheOps: { add: vi.fn() },
  sessionStateDuration: { record: vi.fn() },
  sessionTransitions: { add: vi.fn() },
  turnProvenanceProjections: { add: vi.fn() },
  uiSessionBoardActions: { add: vi.fn() },
  uiSessionBoardLoadDuration: { record: vi.fn() },
  veritasReadinessDuration: { record: vi.fn() },
  veritasReadinessRuns: { add: vi.fn() },
  workflowSidecarBindings: { add: vi.fn() },
  workflowSidecarTransitions: { add: vi.fn() },
}));

vi.mock('../../../telemetry/metrics.js', () => taskMetrics);

import { engineRuntimeId } from '@kontourai/station-contracts/agent-identity';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { putProject } from '../../../domain/__tests__/file-storage-test-helpers.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import type {
  ProviderAdapterMetadata,
  ProviderAdapterShape,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from '../../../providers/adapter-shape.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { AsyncEventQueue } from '../../../providers/sessions/async-event-queue.js';
import { EventBus } from '../../orchestration/event-bus.js';
import { EventStore } from '../../orchestration/event-store.js';
import { OrchestrationService } from '../../orchestration/orchestration-service.js';
import {
  TaskDeclaredOutputKeepConflictError,
  TaskDeclaredOutputKeepDeletedError,
  TaskGraphService,
  TaskReferenceAuthorizationError,
} from '../task-graph-service.js';
import { dispatchTaskForTest } from './task-dispatch-test-helpers.js';

const TASK_RACE_ID = '11111111-1111-4111-8111-111111111111';
const TASK_DUPLICATE_ID = '22222222-2222-4222-8222-222222222222';
const TASK_DISPATCH_RACE_ID = '33333333-3333-4333-8333-333333333333';
const TASK_EXPIRED_ID = '44444444-4444-4444-8444-444444444444';
const TASK_CANCEL_ID = '55555555-5555-4555-8555-555555555555';
const TASK_CLAIM_ID = '66666666-6666-4666-8666-666666666666';
const DISPATCH_CLAIM_ID = '77777777-7777-4777-8777-777777777777';
const TASK_UNSUPPORTED_ID = '88888888-8888-4888-8888-888888888888';

/**
 * The smallest engine that `OrchestrationService.startSession` will drive, so
 * the §4.1 pin can read the `cwd` the chat seam actually hands an adapter.
 * Deliberately NOT imported from `orchestration-service.test.ts`: a sibling PR
 * is editing that file, and a shared fixture would couple the two.
 */
class PinFakeAdapter implements ProviderAdapterShape {
  readonly provider = 'claude' as const;
  readonly sessions = new Map<string, ProviderSession>();
  private readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  readonly metadata: ProviderAdapterMetadata = {
    displayName: 'Claude Runtime',
    description: 'minimal adapter for the §4.1 pin',
    capabilities: ['agent-runtime'],
    runtimeId: engineRuntimeId('claude-runtime'),
    builtin: true,
    executionClass: 'connected',
    modelLaunch: {
      defaultAtStart: 'engine-selected',
      omissionAtResume: 'engine-selected',
      omissionPerTurn: 'engine-selected',
      overrideAtStart: true,
      overrideAtResume: true,
      overridePerTurn: true,
    },
  };
  readonly startSession = vi
    .fn<(input: ProviderSessionStartInput) => Promise<ProviderSession>>()
    .mockImplementation(async (input) => {
      const now = new Date().toISOString();
      const session: ProviderSession = {
        provider: 'claude',
        threadId: input.threadId,
        status: 'ready',
        model: input.modelId,
        createdAt: now,
        updatedAt: now,
      };
      this.sessions.set(input.threadId, session);
      return session;
    });
  readonly sendTurn = vi
    .fn<(input: ProviderSendTurnInput) => Promise<ProviderTurnStartResult>>()
    .mockImplementation(async (input) => ({
      threadId: input.threadId,
      turnId: 'pin-turn',
    }));
  readonly interruptTurn = vi
    .fn<() => Promise<{ outcome: 'no-active-turn' }>>()
    .mockResolvedValue({ outcome: 'no-active-turn' });
  readonly respondToRequest = vi.fn<() => Promise<void>>().mockResolvedValue();
  readonly stopSession = vi.fn<() => Promise<void>>().mockResolvedValue();
  readonly stopAll = vi.fn<() => Promise<void>>().mockResolvedValue();

  async listSessions(): Promise<ProviderSession[]> {
    return [...this.sessions.values()];
  }

  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }

  streamEvents(options?: {
    signal?: AbortSignal;
  }): AsyncIterable<CanonicalRuntimeEvent> {
    return this.events.iterable(options);
  }

  async getPrerequisites(): Promise<[]> {
    return [];
  }
}

function createChatHarness(adapter: FileStorageAdapter) {
  const engine = new PinFakeAdapter();
  const registry: IProviderAdapterRegistry = {
    register() {},
    get: (provider) => (provider === 'claude' ? engine : undefined),
    list: () => [engine],
  };
  const tmp = mkdtempSync(join(tmpdir(), 'station-1501-pin-chat-'));
  const eventStore = new EventStore(join(tmp, 'orchestration.sqlite'));
  const orchestration = new OrchestrationService({
    adapterRegistry: registry,
    eventBus: new EventBus(),
    eventStore,
    // The SAME project store the dispatch half reads.
    listProjects: () => adapter.listProjects(),
    logger: { debug: vi.fn(), warn: vi.fn() },
  });
  return {
    engine,
    orchestration,
    dispose: () => {
      eventStore.close();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

function createTempService(
  deps?: ConstructorParameters<typeof TaskGraphService>[1],
) {
  const workspace = mkdtempSync(join(tmpdir(), 'station-task-workspace-'));
  return new TaskGraphService(mkdtempSync(join(tmpdir(), 'station-tasks-')), {
    projectService: {
      getProject: (slug: string) => {
        if (slug !== 'project-alpha') throw new Error('missing project');
        return {
          id: slug,
          slug,
          name: 'Project alpha',
          workingDirectory: workspace,
          createdAt: '2026-05-03T00:00:00.000Z',
          updatedAt: '2026-05-03T00:00:00.000Z',
        };
      },
    },
    ...deps,
  });
}

describe('TaskGraphService', () => {
  test('keeps an exact declared PR with TaskGraph-owned operation deduplication', async () => {
    const service = createTempService();
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Keep PR',
    });
    const input = {
      taskId: task.id,
      operationId: 'keep-pr-1',
      provider: 'github',
      host: 'github.com',
      repository: { owner: 'owner', name: 'repo' },
      ref: '42',
      nativeId: 'PR_kw',
      provenance: {
        sessionId: 'session-a',
        turnId: 'turn-a',
        toolCallId: 'call-a',
        declarationId: 'declaration-a',
        eventId: 'event-a',
      },
    };
    const authorization = {
      expectedProjectId: 'project-alpha',
      isAuthorized: () => true,
    };
    await expect(
      service.keepDeclaredPullRequest(input, authorization),
    ).resolves.toMatchObject({
      outcome: 'kept',
      reference: { nativeId: 'PR_kw' },
    });
    await expect(
      service.keepDeclaredPullRequest(input, authorization),
    ).resolves.toMatchObject({ outcome: 'already-kept' });
    expect(
      service.readKeptDeclaredPullRequest(task.id, 'session-a', 'event-a'),
    ).toMatchObject({
      provider: 'github',
      nativeId: 'PR_kw',
      provenance: expect.objectContaining({ toolCallId: 'call-a' }),
    });
    expect(
      service.listKeptDeclaredPullRequestsForSession(task.id, 'session-a'),
    ).toMatchObject([
      { provenance: { sessionId: 'session-a', eventId: 'event-a' } },
    ]);
    expect(
      service.listKeptDeclaredPullRequestsForSession(task.id, 'session-other'),
    ).toEqual([]);
    await expect(
      service.deleteKeptDeclaredPullRequest(
        task.id,
        'session-a',
        'event-a',
        authorization,
      ),
    ).resolves.toBe(true);
    await expect(
      service.keepDeclaredPullRequest(input, authorization),
    ).rejects.toBeInstanceOf(TaskDeclaredOutputKeepDeletedError);
  });

  test('checks PR operation receipts before exact-target deduplication', async () => {
    const service = createTempService();
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Receipt ordering',
    });
    const base = {
      taskId: task.id,
      provider: 'github',
      host: 'github.com',
      repository: { owner: 'owner', name: 'repo' },
      ref: '42',
      provenance: {
        sessionId: 's',
        turnId: 't',
        toolCallId: 'c',
        declarationId: 'd',
        eventId: 'e',
      },
    };
    const authorization = {
      expectedProjectId: 'project-alpha',
      isAuthorized: () => true,
    };
    await service.keepDeclaredPullRequest(
      { ...base, operationId: 'op-a', nativeId: 'A' },
      authorization,
    );
    await service.keepDeclaredPullRequest(
      { ...base, operationId: 'op-b', nativeId: 'B' },
      authorization,
    );
    await expect(
      service.keepDeclaredPullRequest(
        { ...base, operationId: 'op-a', nativeId: 'B' },
        authorization,
      ),
    ).rejects.toBeInstanceOf(TaskDeclaredOutputKeepConflictError);
  });

  test('has no post-construction project or workflow dependency setters', () => {
    // Production composes both adapters before publishing the graph. Keeping
    // this ratchet at the Module's Interface prevents a future startup-order
    // requirement from returning as a convenient setter.
    expect(TaskGraphService.prototype).not.toHaveProperty('setProjectService');
    expect(TaskGraphService.prototype).not.toHaveProperty(
      'setWorkflowSidecarReader',
    );
  });

  test('fails closed on an ill-shaped persisted graph without changing its bytes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-task-graph-corrupt-'));
    const path = join(home, 'task-graph.json');
    const corrupt = JSON.stringify({
      tasks: [],
      links: [],
      dispatches: [],
      extra: true,
    });
    writeFileSync(path, corrupt, 'utf8');
    const service = new TaskGraphService(home);

    await expect(
      service.createLink({
        sourceType: 'task',
        sourceId: 'task-1',
        targetType: 'external',
        targetId: 'issue:1',
        relationType: 'references_external',
      }),
    ).rejects.toThrow('Task graph store is unavailable');
    expect(readFileSync(path, 'utf8')).toBe(corrupt);
    expect(existsSync(`${path}.mutation`)).toBe(false);
  });

  test('serializes distinct link writes from two service instances against a fresh graph', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-task-graph-race-'));
    const second = new TaskGraphService(home);
    let interleaved = false;
    const first = new TaskGraphService(home, {
      // Async since archive#2646: the interleaved commit must be AWAITED here, or the
      // concurrent write this test exists to preserve never lands before the
      // lock is handed back and the assertion below silently stops testing it.
      acquireMutationLock: async () => {
        if (!interleaved) {
          interleaved = true;
          await second.createLink({
            sourceType: 'task',
            sourceId: 'task-second',
            targetType: 'external',
            targetId: 'issue:second',
            relationType: 'references_external',
          });
        }
        return () => {};
      },
    });

    await first.createLink({
      sourceType: 'task',
      sourceId: 'task-first',
      targetType: 'external',
      targetId: 'issue:first',
      relationType: 'references_external',
    });

    const graph = JSON.parse(
      readFileSync(join(home, 'task-graph.json'), 'utf8'),
    );
    expect(
      graph.links.map((link: { sourceId: string }) => link.sourceId).sort(),
    ).toEqual(['task-first', 'task-second']);
  });

  test('freshly validates a status transition after another instance changes the task', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-task-graph-status-race-'));
    const path = join(home, 'task-graph.json');
    writeFileSync(
      path,
      JSON.stringify({
        tasks: [
          {
            id: TASK_RACE_ID,
            projectId: 'project-alpha',
            title: 'Race task',
            description: '',
            priority: 'normal',
            status: 'todo',
            createdBy: 'user',
            createdAt: '2026-08-09T00:00:00.000Z',
            updatedAt: '2026-08-09T00:00:00.000Z',
            workspaceBinding: { availability: 'unavailable' },
          },
        ],
        links: [],
        dispatches: [],
      }),
      'utf8',
    );
    const second = new TaskGraphService(home);
    let interleaved = false;
    const stale = new TaskGraphService(home, {
      // Async since archive#2646 — `void` no longer completes the concurrent write
      // before the lock is released, which would leave the stale transition
      // below succeeding and the test asserting nothing.
      acquireMutationLock: async () => {
        if (!interleaved) {
          interleaved = true;
          await second.updateTaskStatus(TASK_RACE_ID, 'canceled');
        }
        return () => {};
      },
    });

    await expect(stale.updateTaskStatus(TASK_RACE_ID, 'ready')).rejects.toThrow(
      'Cannot transition task from canceled to ready',
    );
    expect(new TaskGraphService(home).readTask(TASK_RACE_ID)?.status).toBe(
      'canceled',
    );
  });

  test('refuses a task graph mutation when its lock cannot be acquired', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-task-graph-lock-'));
    const service = new TaskGraphService(home, {
      acquireMutationLock: () => {
        throw new Error('task graph mutation lock is held');
      },
    });

    await expect(
      service.createLink({
        sourceType: 'task',
        sourceId: 'task-locked',
        targetType: 'external',
        targetId: 'issue:locked',
        relationType: 'references_external',
      }),
    ).rejects.toThrow('task graph mutation lock is held');
    expect(existsSync(join(home, 'task-graph.json'))).toBe(false);
  });

  test('releases the mutation lock when a durable graph write fails', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-task-graph-write-fail-'));
    const service = new TaskGraphService(home);
    const internal = service as unknown as {
      store: { write(data: unknown): void };
    };
    internal.store.write = () => {
      throw new Error('injected durable write failure');
    };

    await expect(
      service.createLink({
        sourceType: 'task',
        sourceId: 'task-write-fail',
        targetType: 'external',
        targetId: 'issue:write-fail',
        relationType: 'references_external',
      }),
    ).rejects.toThrow('injected durable write failure');
    expect(existsSync(join(home, 'task-graph.json'))).toBe(false);
    expect(existsSync(join(home, 'task-graph.json.mutation'))).toBe(false);
  });

  test('rejects duplicate persisted task identities without repairing the graph', () => {
    const home = mkdtempSync(join(tmpdir(), 'station-task-graph-id-conflict-'));
    const path = join(home, 'task-graph.json');
    const task = {
      id: TASK_DUPLICATE_ID,
      projectId: 'project-alpha',
      title: 'Original task',
      description: '',
      priority: 'normal',
      status: 'todo',
      createdBy: 'user',
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
      workspaceBinding: { availability: 'unavailable' },
    };
    const duplicate = JSON.stringify({
      tasks: [task, { ...task, title: 'Replacement task' }],
      links: [],
      dispatches: [],
    });
    writeFileSync(path, duplicate, 'utf8');

    expect(() => new TaskGraphService(home).listTasks()).toThrow(
      'duplicate task id',
    );
    expect(readFileSync(path, 'utf8')).toBe(duplicate);
  });

  test('reserves dispatch before awaiting a provider so another instance cannot start it twice', async () => {
    const home = mkdtempSync(
      join(tmpdir(), 'station-task-graph-dispatch-race-'),
    );
    const path = join(home, 'task-graph.json');
    writeFileSync(
      path,
      JSON.stringify({
        tasks: [
          {
            id: TASK_DISPATCH_RACE_ID,
            projectId: 'project-alpha',
            title: 'Dispatch race task',
            description: '',
            priority: 'normal',
            status: 'ready',
            createdBy: 'user',
            createdAt: '2026-08-09T00:00:00.000Z',
            updatedAt: '2026-08-09T00:00:00.000Z',
            workspaceBinding: { availability: 'unavailable' },
          },
        ],
        links: [],
        dispatches: [],
      }),
      'utf8',
    );
    let resolveStart: ((session: ProviderSession) => void) | undefined;
    const started = vi.fn(
      () =>
        new Promise<ProviderSession>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const first = new TaskGraphService(home, {
      orchestrationService: { dispatch: started } as any,
    });
    const second = new TaskGraphService(home);

    const firstDispatch = dispatchTaskForTest(first, TASK_DISPATCH_RACE_ID, {
      provider: 'claude',
    });
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
    const reservation = JSON.parse(readFileSync(path, 'utf8')).tasks[0]
      .dispatchReservation;
    expect(reservation.phase).toBe('provider_starting');
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.parse(reservation.expiresAt) + 1));
      await expect(
        dispatchTaskForTest(second, TASK_DISPATCH_RACE_ID, {
          provider: 'claude',
        }),
      ).rejects.toThrow('explicit reconciliation is required');
      expect(started).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }

    resolveStart?.({
      provider: 'claude',
      threadId: `task:${TASK_DISPATCH_RACE_ID}:1`,
      status: 'ready',
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
    });
    await firstDispatch;
    const graph = JSON.parse(readFileSync(path, 'utf8'));
    expect(graph.dispatches).toHaveLength(1);
    expect(graph.tasks[0].status).toBe('in_progress');
  });

  test('does not call a provider after the exact reservation generation is superseded', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-task-graph-generation-'));
    const path = join(home, 'task-graph.json');
    writeFileSync(
      path,
      JSON.stringify({
        tasks: [
          {
            id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            projectId: 'project-alpha',
            title: 'Generation fence',
            description: '',
            priority: 'normal',
            status: 'ready',
            createdBy: 'user',
            createdAt: '2026-08-09T00:00:00.000Z',
            updatedAt: '2026-08-09T00:00:00.000Z',
            workspaceBinding: { availability: 'unavailable' },
          },
        ],
        links: [],
        dispatches: [],
      }),
      'utf8',
    );
    const started = vi.fn();
    let lockCount = 0;
    const service = new TaskGraphService(home, {
      orchestrationService: { dispatch: started } as any,
      acquireMutationLock: () => {
        lockCount += 1;
        if (lockCount === 2) {
          const graph = JSON.parse(readFileSync(path, 'utf8'));
          graph.tasks[0] = {
            ...graph.tasks[0],
            status: 'ready',
            dispatchedAt: undefined,
            sessionId: undefined,
            dispatchReservation: undefined,
            updatedAt: new Date().toISOString(),
          };
          writeFileSync(path, JSON.stringify(graph), 'utf8');
        }
        return () => {};
      },
    });

    await expect(
      dispatchTaskForTest(service, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', {
        provider: 'claude',
      }),
    ).rejects.toThrow('Task dispatch reservation was superseded');
    expect(started).not.toHaveBeenCalled();
  });

  test('reconciles an expired provider-start reservation so a crash cannot permanently block retry', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-task-graph-expired-'));
    const path = join(home, 'task-graph.json');
    const reservedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const expiresAt = new Date(
      Date.parse(reservedAt) + 5 * 60 * 1000,
    ).toISOString();
    writeFileSync(
      path,
      JSON.stringify({
        tasks: [
          {
            id: TASK_EXPIRED_ID,
            projectId: 'project-alpha',
            title: 'Retry after crash',
            description: '',
            priority: 'normal',
            status: 'in_progress',
            createdBy: 'user',
            createdAt: '2026-08-09T00:00:00.000Z',
            updatedAt: reservedAt,
            dispatchedAt: reservedAt,
            sessionId: `task:${TASK_EXPIRED_ID}:1`,
            workspaceBinding: { availability: 'unavailable' },
            dispatchReservation: {
              generation: '99999999-9999-4999-8999-999999999999',
              phase: 'pre_provider',
              sessionId: `task:${TASK_EXPIRED_ID}:1`,
              reservedAt,
              expiresAt,
              priorStatus: 'ready',
            },
          },
        ],
        links: [],
        dispatches: [],
      }),
      'utf8',
    );

    const expiredService = new TaskGraphService(home);
    const result = await dispatchTaskForTest(
      expiredService,
      TASK_EXPIRED_ID,
      {},
    );

    expect(result.dispatch.outcome).toBe('seeded');
    const graph = JSON.parse(readFileSync(path, 'utf8'));
    expect(graph.tasks[0].dispatchReservation).toBeUndefined();
    expect(graph.tasks[0].status).toBe('ready');
    expect(graph.dispatches).toHaveLength(1);
  });

  test('refuses cancellation while a provider start is reserved, then records the started dispatch before a later cancel', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-task-graph-cancel-race-'));
    let resolveStart: ((session: ProviderSession) => void) | undefined;
    const started = vi.fn(
      () =>
        new Promise<ProviderSession>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const service = new TaskGraphService(home, {
      orchestrationService: { dispatch: started } as any,
    });
    const task = {
      id: TASK_CANCEL_ID,
      projectId: 'project-alpha',
      title: 'Provider start cancellation race',
      description: '',
      priority: 'normal',
      status: 'ready',
      createdBy: 'user',
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
      workspaceBinding: { availability: 'unavailable' },
    };
    writeFileSync(
      join(home, 'task-graph.json'),
      JSON.stringify({ tasks: [task], links: [], dispatches: [] }),
      'utf8',
    );

    const dispatching = dispatchTaskForTest(service, task.id, {
      provider: 'claude',
    });
    await vi.waitFor(() => expect(started).toHaveBeenCalledTimes(1));
    await expect(service.updateTaskStatus(task.id, 'canceled')).rejects.toThrow(
      'Task dispatch is being established',
    );

    resolveStart?.({
      provider: 'claude',
      threadId: `task:${task.id}:1`,
      status: 'ready',
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z',
    });
    await dispatching;
    await service.updateTaskStatus(task.id, 'canceled');

    const graph = JSON.parse(
      readFileSync(join(home, 'task-graph.json'), 'utf8'),
    );
    expect(graph.tasks[0].status).toBe('canceled');
    expect(graph.dispatches).toEqual([
      expect.objectContaining({ outcome: 'started', taskId: task.id }),
    ]);
  });

  test('rejects non-UUIDv4 identities and noncanonical timestamps in persisted data without repairing bytes', () => {
    const home = mkdtempSync(join(tmpdir(), 'station-task-graph-canonical-'));
    const path = join(home, 'task-graph.json');
    const malformed = JSON.stringify({
      tasks: [
        {
          id: '99999999-9999-1999-8999-999999999999',
          projectId: ' project-alpha ',
          title: 'Canonical persistence',
          description: '',
          priority: 'normal',
          status: 'todo',
          createdBy: 'user',
          createdAt: '2026-08-09T00:00:00.000Z',
          updatedAt: '2026-08-09T00:00:00+00:00',
          workspaceBinding: { availability: 'unavailable' },
        },
      ],
      links: [],
      dispatches: [],
    });
    writeFileSync(path, malformed, 'utf8');

    expect(() => new TaskGraphService(home).listTasks()).toThrow('canonical');
    expect(readFileSync(path, 'utf8')).toBe(malformed);
  });

  test('rejects contradictory persisted claim discriminants without repairing bytes', () => {
    const home = mkdtempSync(join(tmpdir(), 'station-task-graph-claim-shape-'));
    const path = join(home, 'task-graph.json');
    const malformed = JSON.stringify({
      tasks: [
        {
          id: TASK_CLAIM_ID,
          projectId: 'project-alpha',
          title: 'Claim shape',
          description: '',
          priority: 'normal',
          status: 'in_progress',
          createdBy: 'user',
          createdAt: '2026-08-09T00:00:00.000Z',
          updatedAt: '2026-08-09T00:00:00.000Z',
          workspaceBinding: { availability: 'unavailable' },
        },
      ],
      links: [],
      dispatches: [
        {
          id: DISPATCH_CLAIM_ID,
          taskId: TASK_CLAIM_ID,
          sessionId: `task:${TASK_CLAIM_ID}:1`,
          provider: 'claude',
          outcome: 'started',
          createdAt: '2026-08-09T00:00:00.000Z',
          sourceSurface: 'api',
          claim: { outcome: 'claimed', subjectId: 'github:owner/repo#1' },
        },
      ],
    });
    writeFileSync(path, malformed, 'utf8');

    expect(() => new TaskGraphService(home).listTasks()).toThrow(
      'claim.actor: required',
    );
    expect(readFileSync(path, 'utf8')).toBe(malformed);
  });

  test('rejects a noncanonical claimedAt timestamp without repairing bytes', () => {
    const home = mkdtempSync(join(tmpdir(), 'station-task-graph-claim-time-'));
    const path = join(home, 'task-graph.json');
    const malformed = JSON.stringify({
      tasks: [
        {
          id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          projectId: 'project-alpha',
          title: 'Claim timestamp',
          description: '',
          priority: 'normal',
          status: 'in_progress',
          createdBy: 'user',
          createdAt: '2026-08-09T00:00:00.000Z',
          updatedAt: '2026-08-09T00:00:00.000Z',
          workspaceBinding: { availability: 'unavailable' },
        },
      ],
      links: [],
      dispatches: [
        {
          id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          taskId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          sessionId: 'task:dddddddd-dddd-4ddd-8ddd-dddddddddddd:1',
          provider: 'claude',
          outcome: 'started',
          createdAt: '2026-08-09T00:00:00.000Z',
          sourceSurface: 'api',
          claim: {
            outcome: 'claimed',
            subjectId: 'github:owner/repo#1',
            actor: {
              runtime: 'station',
              sessionId: 'task:dddddddd-dddd-4ddd-8ddd-dddddddddddd:1',
              host: 'station.test',
              human: null,
            },
            claimedAt: '2026-08-09T00:00:00+00:00',
          },
        },
      ],
    });
    writeFileSync(path, malformed, 'utf8');

    expect(() => new TaskGraphService(home).listTasks()).toThrow(
      'canonical ISO timestamp',
    );
    expect(readFileSync(path, 'utf8')).toBe(malformed);
  });

  test('validates task creation and status transitions', async () => {
    const service = createTempService();
    await expect(
      service.createTask({
        projectId: '',
        title: '',
      }),
    ).rejects.toThrow(/projectId is required/);

    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Dispatch task',
      priority: 'high',
    });
    expect(task.workspaceBinding).toMatchObject({ availability: 'available' });

    await expect(
      service.updateTaskStatus(task.id, 'ready'),
    ).resolves.toMatchObject({
      id: task.id,
      status: 'ready',
    });
    await expect(service.updateTaskStatus(task.id, 'done')).rejects.toThrow(
      /Cannot transition/,
    );
  });

  test('persists only server-supplied client origin on Task mutations', async () => {
    const service = createTempService();
    const origin = {
      version: 1 as const,
      actor: { kind: 'device' as const, deviceId: 'server-device-1' },
      reported: {
        version: 1 as const,
        surface: 'mobile' as const,
        build: '1.2.3',
      },
    };
    const task = await service.createTask(
      { projectId: 'project-alpha', title: 'Origin task' },
      origin,
    );
    await service.updateTaskStatus(task.id, 'ready', origin);
    const link = await service.createTaskReference(
      task.id,
      { kind: 'receipt', targetId: 'receipt://origin', sourceSurface: 'ui' },
      origin,
    );
    expect(service.readTask(task.id)).toMatchObject({
      createdClientOrigin: origin,
      updatedClientOrigin: origin,
    });
    expect(link.clientOrigin).toEqual(origin);
  });

  test('persists a server-derived workspace binding and task references across reconstruction', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-tasks-reconstruct-'));
    const workspace = mkdtempSync(join(tmpdir(), 'station-task-workspace-'));
    const projectService = {
      getProject: () => ({
        id: 'project-alpha',
        slug: 'project-alpha',
        name: 'Project alpha',
        workingDirectory: workspace,
        createdAt: '2026-05-03T00:00:00.000Z',
        updatedAt: '2026-05-03T00:00:00.000Z',
      }),
    };
    const service = new TaskGraphService(home, { projectService });
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Bound task',
      workspaceBinding: {
        sourceSurface: 'ui',
      },
    });
    const artifact = await service.createTaskReference(task.id, {
      kind: 'artifact',
      targetId: '/tmp/plan.md',
      metadata: { label: 'Plan' },
      sourceSurface: 'ui',
    });
    const receipt = await service.createTaskReference(task.id, {
      kind: 'receipt',
      targetId: 'receipt://build-1',
      sourceSurface: 'ui',
    });

    const reconstructed = new TaskGraphService(home, { projectService });
    expect(reconstructed.readTask(task.id)).toEqual(task);
    expect(await reconstructed.readTaskGraph(task.id)).toEqual({
      task,
      links: [artifact, receipt],
    });
  });

  test('persists distinct turn references as identity-only Session/turn tuples across reconstruction', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-task-turn-references-'));
    const workspace = mkdtempSync(join(tmpdir(), 'station-task-workspace-'));
    const projectService = {
      getProject: () => ({
        id: 'project-alpha',
        slug: 'project-alpha',
        name: 'Project alpha',
        workingDirectory: workspace,
        createdAt: '2026-05-03T00:00:00.000Z',
        updatedAt: '2026-05-03T00:00:00.000Z',
      }),
    };
    const service = new TaskGraphService(home, { projectService });
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Answer basis',
    });

    const first = await service.createTaskReference(task.id, {
      kind: 'turn',
      sessionId: 'session-a',
      turnId: 'turn-1',
    });
    const secondTurn = await service.createTaskReference(task.id, {
      kind: 'turn',
      sessionId: 'session-a',
      turnId: 'turn-2',
    });
    const secondSession = await service.createTaskReference(task.id, {
      kind: 'turn',
      sessionId: 'session-b',
      turnId: 'turn-1',
    });
    const duplicate = await service.createTaskReference(task.id, {
      kind: 'turn',
      sessionId: 'session-a',
      turnId: 'turn-1',
    });

    expect(duplicate).toEqual(first);
    expect([
      first.targetId,
      secondTurn.targetId,
      secondSession.targetId,
    ]).toEqual(
      expect.arrayContaining([
        'turn/session-a/turn-1',
        'turn/session-a/turn-2',
        'turn/session-b/turn-1',
      ]),
    );
    expect(await service.readTaskTurnReferenceLinks(task.id)).toEqual([
      first,
      secondTurn,
      secondSession,
    ]);

    const persisted = readFileSync(join(home, 'task-graph.json'), 'utf8');
    expect(persisted).not.toContain('assistant answer text');
    expect(persisted).not.toContain('provenance');
    expect(persisted).toContain('"references_turn"');

    const reconstructed = new TaskGraphService(home, { projectService });
    expect(await reconstructed.readTaskTurnReferenceLinks(task.id)).toEqual([
      first,
      secondTurn,
      secondSession,
    ]);
  });

  test('pins one exact narrative revision atomically with a new turn Keep and never retargets a duplicate', async () => {
    const service = createTempService();
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Pinned answer basis',
    });
    const first = await service.createTaskReference(
      task.id,
      { kind: 'turn', sessionId: 'session-a', turnId: 'turn-a' },
      undefined,
      undefined,
      { associationRevision: 3, isCurrent: () => true },
    );
    const duplicate = await service.createTaskReference(
      task.id,
      { kind: 'turn', sessionId: 'session-a', turnId: 'turn-a' },
      undefined,
      undefined,
      { associationRevision: 4, isCurrent: () => true },
    );
    expect(duplicate).toEqual(first);
    expect(service.readTaskAnswerNarrativePin(task.id, first.targetId)).toBe(3);
    const restarted = new TaskGraphService(
      (service as any).storePath.slice(0, -'/task-graph.json'.length),
    );
    expect(restarted.readTaskAnswerNarrativePin(task.id, first.targetId)).toBe(
      3,
    );
    expect(restarted.readTaskGraph(task.id)).resolves.toMatchObject({
      links: [first],
    });
  });

  test('persists distinct user-input event tuples across restart and makes duplicate concurrent attaches idempotent', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-task-input-references-'));
    const workspace = mkdtempSync(join(tmpdir(), 'station-task-workspace-'));
    const projectService = {
      getProject: () => ({
        id: 'project-alpha',
        slug: 'project-alpha',
        name: 'Project alpha',
        workingDirectory: workspace,
        createdAt: '2026-05-03T00:00:00.000Z',
        updatedAt: '2026-05-03T00:00:00.000Z',
      }),
    };
    const service = new TaskGraphService(home, { projectService });
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Input basis',
    });
    const [first, duplicate] = await Promise.all([
      service.createTaskReference(task.id, {
        kind: 'user-input',
        sessionId: 'session-a',
        eventId: 'event-1',
      }),
      service.createTaskReference(task.id, {
        kind: 'user-input',
        sessionId: 'session-a',
        eventId: 'event-1',
      }),
    ]);
    const second = await service.createTaskReference(task.id, {
      kind: 'user-input',
      sessionId: 'session-a',
      eventId: 'event-2',
    });
    expect(duplicate).toEqual(first);
    const restarted = new TaskGraphService(home, { projectService });
    expect(await restarted.readTaskUserInputReferenceLinks(task.id)).toEqual([
      first,
      second,
    ]);
  });

  test('rejects persisted tasks without required workspace bindings without rewriting bytes', () => {
    const home = mkdtempSync(join(tmpdir(), 'station-tasks-legacy-'));
    const path = join(home, 'task-graph.json');
    const malformed = JSON.stringify({
      tasks: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          projectId: 'project-alpha',
          title: 'Legacy task',
          description: '',
          priority: 'normal',
          status: 'todo',
          createdBy: 'user',
          createdAt: '2026-05-03T00:00:00.000Z',
          updatedAt: '2026-05-03T00:00:00.000Z',
        },
      ],
      links: [],
      dispatches: [],
    });
    writeFileSync(path, malformed, 'utf8');

    expect(() => new TaskGraphService(home).listTasks()).toThrow(
      'workspaceBinding: required',
    );
    expect(readFileSync(path, 'utf8')).toBe(malformed);
  });

  test('derives the Project workspace and rejects contradictory caller paths', async () => {
    taskMetrics.taskWorkspaceBindingTotal.add.mockClear();
    const service = createTempService();

    await expect(
      service.createTask({
        projectId: 'project-alpha',
        title: 'Contradictory path',
        workspaceBinding: { workingDirectory: '/not-the-project' },
      }),
    ).rejects.toThrow('conflicts with the server-derived Project workspace');
    expect(taskMetrics.taskWorkspaceBindingTotal.add).toHaveBeenCalledWith(1, {
      outcome: 'ambiguous',
      source_surface: 'other',
    });
  });

  test('reports an ambiguous reopen when the Project workspace has changed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-tasks-ambiguous-'));
    const firstWorkspace = mkdtempSync(join(tmpdir(), 'station-task-first-'));
    const secondWorkspace = mkdtempSync(join(tmpdir(), 'station-task-second-'));
    let workingDirectory = firstWorkspace;
    const projectService = {
      getProject: () => ({
        id: 'project-alpha',
        slug: 'project-alpha',
        name: 'Project alpha',
        workingDirectory,
        createdAt: '2026-05-03T00:00:00.000Z',
        updatedAt: '2026-05-03T00:00:00.000Z',
      }),
    };
    const service = new TaskGraphService(home, { projectService });
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Stale workspace',
    });
    workingDirectory = secondWorkspace;

    expect(
      (await service.readTaskGraph(task.id))?.task.workspaceBinding,
    ).toMatchObject({
      availability: 'ambiguous',
      workingDirectory: realpathSync(firstWorkspace),
    });
  });

  test('reports an ambiguous reopen when the captured Git branch has changed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-tasks-branch-drift-'));
    const workspace = mkdtempSync(join(tmpdir(), 'station-task-git-'));
    let branch = 'main';
    const runGit = vi.fn(async (args: string[]) => ({
      stdout: args.includes('--show-toplevel')
        ? `${workspace}\n`
        : `${branch}\n`,
      stderr: '',
    }));
    const service = new TaskGraphService(home, {
      projectService: {
        getProject: () => ({
          id: 'project-alpha',
          slug: 'project-alpha',
          name: 'Project alpha',
          workingDirectory: workspace,
          createdAt: '2026-05-03T00:00:00.000Z',
          updatedAt: '2026-05-03T00:00:00.000Z',
        }),
      },
      execGit: runGit,
    });
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Branch-bound task',
    });
    expect(task.workspaceBinding).toMatchObject({ branch: 'main' });

    branch = 'feature/other-task';

    expect(
      (await service.readTaskGraph(task.id))?.task.workspaceBinding,
    ).toMatchObject({ availability: 'ambiguous', branch: 'main' });
  });

  test('reports unavailable after the configured Project workspace disappears', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-tasks-unavailable-'));
    const workspace = mkdtempSync(join(tmpdir(), 'station-task-vanished-'));
    const projectService = {
      getProject: () => ({
        id: 'project-alpha',
        slug: 'project-alpha',
        name: 'Project alpha',
        workingDirectory: workspace,
        createdAt: '2026-05-03T00:00:00.000Z',
        updatedAt: '2026-05-03T00:00:00.000Z',
      }),
    };
    const service = new TaskGraphService(home, { projectService });
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Vanished workspace',
    });
    rmSync(workspace, { recursive: true, force: true });

    expect(
      (await service.readTaskGraph(task.id))?.task.workspaceBinding,
    ).toMatchObject({
      availability: 'unavailable',
    });
  });

  test('rejects unknown task and invalid references while preserving unique links', async () => {
    const service = createTempService();
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Reference task',
    });

    await expect(
      service.createTaskReference('missing', {
        kind: 'artifact',
        targetId: '/tmp/plan.md',
      }),
    ).rejects.toThrow('Task not found: missing');
    await expect(
      service.createTaskReference(task.id, {
        kind: 'artifact',
        targetId: ' ',
      }),
    ).rejects.toThrow('targetId is required');

    const first = await service.createTaskReference(task.id, {
      kind: 'external',
      targetId: 'flow:run-1',
    });
    const duplicate = await service.createTaskReference(task.id, {
      kind: 'external',
      targetId: 'flow:run-1',
    });
    expect(duplicate).toEqual(first);
    expect((await service.readTaskGraph(task.id))?.links).toEqual([first]);
  });

  test('rechecks a protected reference witness inside the queued mutation', async () => {
    let lockCount = 0;
    let credentialAndSessionCurrent = true;
    const service = createTempService({
      acquireMutationLock: () => {
        lockCount += 1;
        // Task creation takes the first lock. Revoke while the subsequent
        // reference write is queued at its mutation boundary, after any
        // route-side owner read would have completed.
        if (lockCount === 2) credentialAndSessionCurrent = false;
        return () => {};
      },
    });
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Queued protected reference',
    });

    await expect(
      service.createTaskReference(
        task.id,
        {
          kind: 'tool-result',
          sessionId: 'session-current',
          eventId: 'event-current',
        },
        undefined,
        {
          expectedProjectId: 'project-alpha',
          isAuthorized: (actualTask) =>
            actualTask.projectId === 'project-alpha' &&
            credentialAndSessionCurrent,
        },
      ),
    ).rejects.toBeInstanceOf(TaskReferenceAuthorizationError);
    expect(await service.readTaskToolResultReferenceLinks(task.id)).toEqual([]);
  });

  // This deliberately performs 100 individually durable writes. Under the
  // related-test selection it can exceed Vitest's default 5s while preserving
  // the same bounded-reference behavior, so give this durability proof its
  // own budget instead of weakening the suite-wide default.
  test('caps Task-owned user-input references without a partial 101st write', {
    timeout: 15_000,
  }, async () => {
    const service = createTempService();
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Bound references',
    });
    for (let index = 0; index < 100; index += 1) {
      await service.createTaskReference(task.id, {
        kind: 'user-input',
        sessionId: 'session-capacity',
        eventId: `event-${index}`,
      });
    }

    await expect(
      service.createTaskReference(task.id, {
        kind: 'user-input',
        sessionId: 'session-capacity',
        eventId: 'event-over-limit',
      }),
    ).rejects.toThrow('Task may have at most 100 references');
    expect(await service.readTaskUserInputReferenceLinks(task.id)).toHaveLength(
      100,
    );
  });

  test('records bounded workspace and reference metric outcomes', async () => {
    taskMetrics.taskWorkspaceBindingTotal.add.mockClear();
    taskMetrics.taskReferenceCreatedTotal.add.mockClear();
    taskMetrics.taskWorkspaceOpenTotal.add.mockClear();
    const service = createTempService();
    await expect(
      service.createTask({ projectId: '', title: '' }),
    ).rejects.toThrow('projectId is required');
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Metered task',
      workspaceBinding: { sourceSurface: 'ui' },
    });
    await service.createTaskReference(task.id, {
      kind: 'artifact',
      targetId: '/tmp/plan.md',
      sourceSurface: 'cli',
    });
    await service.readTaskGraph(task.id);

    expect(taskMetrics.taskWorkspaceBindingTotal.add).toHaveBeenCalledWith(1, {
      outcome: 'unavailable',
      source_surface: 'other',
    });
    expect(taskMetrics.taskWorkspaceBindingTotal.add).toHaveBeenCalledWith(1, {
      outcome: 'available',
      source_surface: 'ui',
    });
    expect(taskMetrics.taskReferenceCreatedTotal.add).toHaveBeenCalledWith(1, {
      kind: 'artifact',
      source_surface: 'cli',
      outcome: 'created',
    });
    expect(taskMetrics.taskWorkspaceOpenTotal.add).toHaveBeenCalledWith(1, {
      availability_bucket: 'available',
      source_surface: 'ui',
    });
  });

  test('dispatch seeds a deterministic session record and relation links', async () => {
    const seedSessionRecord = vi.fn((input) => ({
      provider: input.provider,
      threadId: input.threadId,
      status: 'ready' as const,
      model: input.model,
      createdAt: '2026-05-03T00:00:00.000Z',
      updatedAt: '2026-05-03T00:00:00.000Z',
    }));
    const service = createTempService({
      orchestrationService: {
        dispatch: vi.fn(),
        seedSessionRecord,
      },
    });
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Dispatch task',
      agentId: 'agent-one',
      skillName: 'skill-one',
    });

    const result = await dispatchTaskForTest(service, task.id, {
      relatedFiles: ['src/index.ts'],
      sourceSurface: 'test',
      clientOrigin: {
        version: 1,
        actor: { kind: 'device', deviceId: 'dispatch-device' },
        reported: { version: 1, surface: 'desktop', build: '1.0.0' },
      },
    });

    expect(result.dispatch).toMatchObject({
      taskId: task.id,
      sessionId: `task-${task.id}-1`,
      provider: 'task-dispatch',
      outcome: 'seeded',
      clientOrigin: expect.objectContaining({
        actor: { kind: 'device', deviceId: 'dispatch-device' },
      }),
    });
    expect(seedSessionRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: `task-${task.id}-1`,
        provider: 'task-dispatch',
      }),
    );
    expect(result.task).toMatchObject({
      status: 'ready',
      sessionId: `task-${task.id}-1`,
    });
    expect(result.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relationType: 'spawned_session' }),
        expect.objectContaining({ relationType: 'owned_by_agent' }),
        expect.objectContaining({ relationType: 'uses_skill' }),
        expect.objectContaining({ relationType: 'touches_file' }),
      ]),
    );

    expect((await service.readTaskGraph(task.id))?.links).toHaveLength(4);
    expect(
      service.readSessionRelations(`task-${task.id}-1`).links,
    ).toHaveLength(1);
  });

  test('dispatch starts orchestration when a runtime provider is supplied', async () => {
    const dispatch = vi.fn().mockResolvedValue({
      provider: 'codex',
      threadId: 'task-runtime-1',
      status: 'ready',
      createdAt: '2026-05-03T00:00:00.000Z',
      updatedAt: '2026-05-03T00:00:00.000Z',
    });
    const service = createTempService({
      orchestrationService: {
        dispatch,
        seedSessionRecord: vi.fn(),
      },
    });
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Start runtime',
    });

    const result = await dispatchTaskForTest(service, task.id, {
      runtimeConfig: {
        provider: 'codex',
        modelId: 'gpt-5.5',
        cwd: '/tmp/project-alpha',
      },
    });

    expect(dispatch).toHaveBeenCalledWith(
      {
        type: 'startSession',
        input: expect.objectContaining({
          threadId: `task-${task.id}-1`,
          provider: 'codex',
          modelId: 'gpt-5.5',
          cwd: '/tmp/project-alpha',
        }),
      },
      undefined,
      // This task names no builder sidecar, so nothing is declared and no
      // attach mode is forced (archive#189 S4).
      undefined,
    );
    expect(result.dispatch.outcome).toBe('started');
    expect(result.task.status).toBe('in_progress');
  });

  describe('station#189 S4: metadata.taskSlug at builder-session start', () => {
    async function dispatchWithSidecar(options: {
      workItemRef?: string;
      readState: (cwd: string, taskSlug: string) => unknown;
    }) {
      const dispatch = vi.fn().mockResolvedValue({
        provider: 'codex',
        threadId: 'task-runtime-1',
        status: 'ready',
        createdAt: '2026-05-03T00:00:00.000Z',
        updatedAt: '2026-05-03T00:00:00.000Z',
      });
      const readState = vi.fn(options.readState);
      const service = createTempService({
        orchestrationService: { dispatch, seedSessionRecord: vi.fn() },
        workflowSidecarReader: { readState } as never,
        // A namespaced workItemRef routes through dispatch-as-claim (archive#584)
        // on its way to session start; stub it so these tests observe the
        // slug decision rather than the claim gate.
        resolveProjectWorkspace: () => '/tmp/project-alpha',
        assignmentClaimService: {
          claim: vi.fn().mockResolvedValue({
            outcome: 'claimed',
            record: { claimed_at: '2026-08-01T00:00:00.000Z' },
          }),
          release: vi.fn(),
          status: vi.fn(),
        } as never,
      });
      const task = await service.createTask({
        projectId: 'project-alpha',
        title: 'Continue the builder run',
        ...(options.workItemRef ? { workItemRef: options.workItemRef } : {}),
      });
      await dispatchTaskForTest(service, task.id, {
        runtimeConfig: { provider: 'codex', cwd: '/tmp/project-alpha' },
      });
      return { dispatch, readState };
    }

    test('declares the slug when the task names a sidecar that exists', async () => {
      const { dispatch, readState } = await dispatchWithSidecar({
        workItemRef: 'kontourai-station-1388',
        readState: () => ({ task_slug: 'kontourai-station-1388' }),
      });

      expect(readState).toHaveBeenCalledWith(
        '/tmp/project-alpha',
        'kontourai-station-1388',
      );
      expect(dispatch).toHaveBeenCalledWith(
        {
          type: 'startSession',
          input: expect.objectContaining({
            metadata: { taskSlug: 'kontourai-station-1388' },
          }),
        },
        undefined,
        // Review M1: the Builder run behind this slug is driven by
        // flow-agents, so the attach must read it, never write it.
        { workflowSidecarAttachMode: 'read-only-join' },
      );
    });

    test('declares nothing when the named sidecar does not exist', async () => {
      // `metadata.taskSlug` is create-or-resume downstream, so declaring an
      // unverified slug would have Station manufacture a Builder task
      // directory in the user's repo as a side effect of a READ-side join.
      const { dispatch } = await dispatchWithSidecar({
        workItemRef: 'never-started-here',
        readState: () => null,
      });

      expect(dispatch.mock.calls[0][0].input.metadata).toBeUndefined();
    });

    test('never derives a slug from a namespaced work item ref', async () => {
      // `github:kontourai/archive#1388` names a work item, not a sidecar
      // directory. Slugifying it would be exactly the heuristic archive#582 forbade.
      const { dispatch, readState } = await dispatchWithSidecar({
        workItemRef: 'github:kontourai/station#1388',
        readState: () => ({ task_slug: 'anything' }),
      });

      expect(readState).not.toHaveBeenCalled();
      expect(dispatch.mock.calls[0][0].input.metadata).toBeUndefined();
      // No slug means no join, so the attach mode must not be forced either.
      expect(dispatch.mock.calls[0][2]).toBeUndefined();
    });

    test('never derives a slug from the task title', async () => {
      const { dispatch, readState } = await dispatchWithSidecar({
        readState: () => ({ task_slug: 'continue-the-builder-run' }),
      });

      expect(readState).not.toHaveBeenCalled();
      expect(dispatch.mock.calls[0][0].input.metadata).toBeUndefined();
    });

    test('declares nothing when the dispatch supplies no cwd', async () => {
      // Without a cwd the session resolves to $HOME, not the project
      // directory, and the sidecar binding downstream no-ops entirely.
      // Checking the project workspace and binding somewhere else would turn
      // the verified-existence check back into an unverified one.
      const dispatch = vi.fn().mockResolvedValue({
        provider: 'codex',
        threadId: 'task-runtime-1',
        status: 'ready',
        createdAt: '2026-05-03T00:00:00.000Z',
        updatedAt: '2026-05-03T00:00:00.000Z',
      });
      const readState = vi.fn(() => ({ task_slug: 'kontourai-station-1388' }));
      const service = createTempService({
        orchestrationService: { dispatch, seedSessionRecord: vi.fn() },
        workflowSidecarReader: { readState } as never,
        resolveProjectWorkspace: () => '/tmp/project-alpha',
      });
      const task = await service.createTask({
        projectId: 'project-alpha',
        title: 'No cwd',
        workItemRef: 'kontourai-station-1388',
      });
      await dispatchTaskForTest(service, task.id, {
        runtimeConfig: { provider: 'codex' },
      });

      expect(readState).not.toHaveBeenCalled();
      expect(dispatch.mock.calls[0][0].input.metadata).toBeUndefined();
    });

    test('an unreadable sidecar degrades to no slug instead of failing the dispatch', async () => {
      const { dispatch } = await dispatchWithSidecar({
        workItemRef: 'corrupt-sidecar',
        readState: () => {
          throw new Error('Invalid JSON in state.json');
        },
      });

      expect(dispatch.mock.calls[0][0].input.metadata).toBeUndefined();
    });
  });

  test('rejects unsupported queued/running persisted statuses without rewriting bytes', () => {
    const home = mkdtempSync(
      join(tmpdir(), 'station-task-graph-status-shape-'),
    );
    const path = join(home, 'task-graph.json');
    const unsupported = JSON.stringify({
      tasks: [
        {
          id: TASK_UNSUPPORTED_ID,
          projectId: 'project-alpha',
          title: 'Unsupported state',
          description: '',
          priority: 'normal',
          status: 'queued',
          createdBy: 'user',
          createdAt: '2026-08-09T00:00:00.000Z',
          updatedAt: '2026-08-09T00:00:00.000Z',
          workspaceBinding: { availability: 'unavailable' },
        },
      ],
      links: [],
      dispatches: [],
    });
    writeFileSync(path, unsupported, 'utf8');

    expect(() => new TaskGraphService(home).listTasks()).toThrow(
      'invalid task status',
    );
    expect(readFileSync(path, 'utf8')).toBe(unsupported);
  });
});

/**
 * archive#1501, seam S4
 * (`docs/design/portable-project-identity.md` §2.2.1).
 *
 * These use a REAL `FileStorageAdapter` over the same home the service is
 * constructed with — the production shape — so the whole
 * `readProjectWorkingDirectory` → `resolveProjectResource` path is exercised
 * end to end rather than stubbed at its own boundary.
 */
describe('TaskGraphService workspace binding — migrated onto resolveProjectResource', () => {
  function seamHome() {
    const home = mkdtempSync(join(tmpdir(), 'station-1501-tg-home-'));
    const adapter = new FileStorageAdapter(home);
    return { home, adapter };
  }

  async function saveSeamProject(
    adapter: FileStorageAdapter,
    overrides: { slug: string; workingDirectory?: string },
  ) {
    const now = '2026-05-03T00:00:00.000Z';
    const project = {
      id: overrides.slug,
      name: 'Acme',
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
    await putProject(adapter, project);
    return project;
  }

  async function bindingFor(
    home: string,
    adapter: FileStorageAdapter,
    slug: string,
  ) {
    const service = new TaskGraphService(home, { projectService: adapter });
    const task = await service.createTask({ projectId: slug, title: 'T' });
    return task.workspaceBinding;
  }

  test('BEHAVIOR DELTA: a tilde-stored working directory now binds AVAILABLE (it was unavailable, so dispatch was blocked)', async () => {
    const { home, adapter } = seamHome();
    await saveSeamProject(adapter, { slug: 'tilde', workingDirectory: '~' });

    // Before this slice `deriveWorkspaceBinding` ran `existsSync('~')` on the
    // UNEXPANDED string, which is false on every platform, so a project
    // created through the UI (where `~` is the stored norm) could never bind
    // a Task workspace and `claimForDispatch` refused.
    expect(await bindingFor(home, adapter, 'tilde')).toMatchObject({
      availability: 'available',
      workingDirectory: realpathSync(homedir()),
    });
  });

  /**
   * archive#1501 review, FIX 5. The tilde fix reaches NEWLY DERIVED
   * bindings only. A Task created while the same `~`-stored project did not
   * resolve persisted `availability: 'unavailable'`; reopening it after the
   * fix reports `ambiguous`, because `sameWorkspace` requires the STORED side
   * to be `available` too. That is deliberate — see `resolveWorkspaceForOpen`'s
   * docblock for why a read path does not auto-re-bind — and it is the exact
   * population the fix was for, so it is pinned rather than left implicit.
   */
  test('BEHAVIOR DELTA, pre-existing Tasks: an unavailable→available project reopens AMBIGUOUS, never silently available', async () => {
    const { home, adapter } = seamHome();
    await saveSeamProject(adapter, { slug: 'tilde', workingDirectory: '~' });

    // The pre-slice world, reproduced: the seam answered with the UNEXPANDED
    // string, `existsSync('~')` failed, and the Task bound `unavailable`.
    const beforeSlice = new TaskGraphService(home, {
      resolveProjectWorkspace: () => '~',
    });
    const task = await beforeSlice.createTask({
      projectId: 'tilde',
      title: 'T',
    });
    expect(task.workspaceBinding).toMatchObject({
      availability: 'unavailable',
    });

    // Same store, this slice's resolver. A Task created NOW binds available…
    const afterSlice = new TaskGraphService(home, { projectService: adapter });
    expect(await bindingFor(home, adapter, 'tilde')).toMatchObject({
      availability: 'available',
    });

    // …but the pre-existing one reports the disagreement instead of adopting
    // a workspace it never bound.
    const reopened = await afterSlice.readTaskForOpen(task.id);
    expect(reopened?.workspaceBinding).toMatchObject({
      availability: 'ambiguous',
    });
    expect(reopened?.workspaceBinding?.availability).not.toBe('available');
    // The same projection reaches the graph read, which is what the Task
    // workspace view renders.
    expect(
      (await afterSlice.readTaskGraph(task.id))?.task.workspaceBinding,
    ).toMatchObject({ availability: 'ambiguous' });
  });

  test('the `Project not found` throw is PRESERVED for an unknown project', async () => {
    const { home, adapter } = seamHome();
    const service = new TaskGraphService(home, { projectService: adapter });
    await expect(
      service.createTask({ projectId: 'no-such-project', title: 'T' }),
    ).rejects.toThrow('Project not found: no-such-project');
  });

  test('a project whose manifest cannot be READ fails closed, and does NOT masquerade as "not found"', async () => {
    const { home, adapter } = seamHome();
    const workspace = mkdtempSync(join(tmpdir(), 'station-1501-tg-ws-'));
    await saveSeamProject(adapter, {
      slug: 'broken',
      workingDirectory: workspace,
    });
    writeFileSync(join(home, 'projects', 'broken', 'manifest.json'), '{ nope');

    const service = new TaskGraphService(home, { projectService: adapter });
    // Fail closed — a Task is never bound to a workspace nobody could verify…
    const error = await service
      .createTask({ projectId: 'broken', title: 'T' })
      .then(
        () => null,
        (caught: Error) => caught,
      );
    expect(error).toBeInstanceOf(Error);
    // …and it says what actually happened. Reporting an unreadable manifest
    // as `Project not found` would be a claim with no source.
    expect(error?.message).not.toContain('Project not found');
    expect(error?.message.toLowerCase()).toMatch(/manifest|json|parse|read/);
  });

  /**
   * §4.1 says the two subsystems answer for two different kinds of
   * participation: a chat in a directory-less project is a valid global chat
   * that terminates at `$HOME`, and a dispatch into the same project is
   * blocked. The property is a DISAGREEMENT, so pinning one half is not
   * pinning it (slice 3b review, FIX 4): a future slice that "reconciles" the
   * split by hardening the CHAT side — refusing a directory-less project, or
   * dropping `cwdDefaulted` — leaves a dispatch-only assertion green while
   * destroying exactly the property this test is named after. Both halves are
   * asserted here, for the same project record.
   *
   * The chat half is exercised through `OrchestrationService.startSession`
   * because `resolveStartSessionCwd` is module-private. This suite owns the
   * pin (not `orchestration-service.test.ts`) so the two halves stay in one
   * file and one failure.
   */
  test('§4.1 PIN: dispatch and chat disagree ON PURPOSE about a directory-less project — do not "reconcile" them', async () => {
    const { home, adapter } = seamHome();
    await saveSeamProject(adapter, { slug: 'scope-only' });

    // Half 1 — dispatch. task-graph refuses: `unavailable`, so
    // `claimForDispatch` blocks. A later slice that "fixes" the inconsistency
    // by defaulting THIS side to $HOME turns a blocked dispatch into one
    // silently running in the user's home directory.
    const binding = await bindingFor(home, adapter, 'scope-only');
    expect(binding).toMatchObject({ availability: 'unavailable' });
    expect(binding?.workingDirectory).toBeUndefined();

    // Half 2 — chat, for the SAME directory-less project. It must still
    // launch, at $HOME, flagged as a default rather than as a real binding
    // (archive#1023/#1174). A slice that hardens this side into a refusal would
    // break a first-run affordance the UI advertises as "~ (defaults to
    // home)" — and half 1 alone would not notice.
    const chat = createChatHarness(adapter);
    try {
      await chat.orchestration.dispatch({
        type: 'startSession',
        input: {
          threadId: 'pin-1501-scope-only',
          provider: 'claude',
          metadata: { projectSlug: 'scope-only' },
        },
      });
      const started = chat.engine.startSession.mock.calls.at(-1)?.[0];
      expect(started?.cwd).toBe(homedir());
      expect(started?.cwdDefaulted).toBe(true);
    } finally {
      chat.dispose();
    }
  });

  test('A → B → A: the project gains a working directory, loses it, and regains it', async () => {
    const { home, adapter } = seamHome();
    const dirA = mkdtempSync(join(tmpdir(), 'station-1501-tg-a-'));
    const dirB = mkdtempSync(join(tmpdir(), 'station-1501-tg-b-'));
    const project = await saveSeamProject(adapter, { slug: 'acme' });

    expect(await bindingFor(home, adapter, 'acme')).toMatchObject({
      availability: 'unavailable',
    });

    await putProject(adapter, { ...project, workingDirectory: dirA });
    expect(await bindingFor(home, adapter, 'acme')).toMatchObject({
      availability: 'available',
      workingDirectory: realpathSync(dirA),
    });

    await putProject(adapter, { ...project, workingDirectory: dirB });
    expect(await bindingFor(home, adapter, 'acme')).toMatchObject({
      availability: 'available',
      workingDirectory: realpathSync(dirB),
    });

    await putProject(adapter, { ...project, workingDirectory: undefined });
    expect(await bindingFor(home, adapter, 'acme')).toMatchObject({
      availability: 'unavailable',
    });

    await putProject(adapter, { ...project, workingDirectory: dirA });
    expect(await bindingFor(home, adapter, 'acme')).toMatchObject({
      availability: 'available',
      workingDirectory: realpathSync(dirA),
    });
  });

  test('the DIRECTORY itself is deleted and recreated', async () => {
    const { home, adapter } = seamHome();
    const workspace = mkdtempSync(join(tmpdir(), 'station-1501-tg-dir-'));
    await saveSeamProject(adapter, {
      slug: 'acme',
      workingDirectory: workspace,
    });

    expect(await bindingFor(home, adapter, 'acme')).toMatchObject({
      availability: 'available',
    });
    rmSync(workspace, { recursive: true, force: true });
    expect(await bindingFor(home, adapter, 'acme')).toMatchObject({
      availability: 'unavailable',
    });
    mkdirSync(workspace, { recursive: true });
    expect(await bindingFor(home, adapter, 'acme')).toMatchObject({
      availability: 'available',
      workingDirectory: realpathSync(workspace),
    });
  });

  test('restart-after-write and the upgrade path: a fresh service over the same home, with project.json and NO manifest sidecar', async () => {
    const { home, adapter } = seamHome();
    const workspace = mkdtempSync(join(tmpdir(), 'station-1501-tg-restart-'));
    await saveSeamProject(adapter, {
      slug: 'acme',
      workingDirectory: workspace,
    });
    const manifest = join(home, 'projects', 'acme', 'manifest.json');

    const first = await bindingFor(home, adapter, 'acme');
    expect(first).toMatchObject({ availability: 'available' });
    expect(existsSync(manifest)).toBe(false);

    // A completely fresh service AND a fresh storage adapter over the same
    // home: nothing may be answered from memory, and the read still writes
    // no sidecar.
    const restartedAdapter = new FileStorageAdapter(home);
    const second = await bindingFor(home, restartedAdapter, 'acme');
    // `capturedAt` is an observation timestamp and legitimately differs; the
    // RESOLUTION must not.
    expect({
      availability: second?.availability,
      workingDirectory: second?.workingDirectory,
    }).toEqual({
      availability: first?.availability,
      workingDirectory: first?.workingDirectory,
    });
    expect(second?.workingDirectory).toBe(realpathSync(workspace));
    expect(existsSync(manifest)).toBe(false);
  });
});
