/**
 * Host-binding resolution + never-authority + consent-gating + subject-ref
 * trust tests for Station's `createStationHostIntentBindings` (roadmap
 * archive#585, part of epic archive#580, S5).
 *
 * Uses a real `TaskGraphService` against a runtime-fs temp dir (matching
 * `task-graph-service.test.ts`'s own fixture convention) and a stub
 * `OrchestrationService` (narrowed to `Pick<OrchestrationService,
 * 'dispatch' | 'readSession'>`, matching `TaskGraphService`'s own
 * established dependency-narrowing pattern) — no shell redirects, no
 * sidecar-shaped mock paths.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveIntentBinding } from '@kontourai/console-core';
import type { TaskDispatchResult } from '@kontourai/station-contracts';
import type {
  OrchestrationCommand,
  OrchestrationSessionDetail,
} from '@kontourai/station-contracts/orchestration';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { TaskDispatcher } from '../../services/projects/task-dispatcher.js';
import { TaskGraphService } from '../../services/projects/task-graph-service.js';
import { STATION_HOST_COMMAND_CATALOG } from '../station-descriptor.js';
import {
  createStationHostIntentBindings,
  type StationIntent,
} from '../station-intent-bindings.js';

const intentAuthority = () =>
  sessionReadAuthorityFromRequest('intent-test-user', undefined, undefined);

const hostedRegistry = parseHostedTenantRegistry({
  schemaVersion: 1,
  tenants: [
    { id: 'alpha', authority: 'alpha.station.test' },
    { id: 'bravo', authority: 'bravo.station.test' },
  ],
});

function hostedAuthority(tenant?: 'alpha' | 'bravo') {
  return sessionReadAuthorityFromRequest(
    'shared-user',
    tenant ? { tenantId: tenantId(tenant) } : undefined,
    hostedRegistry,
  );
}

/**
 * A service that can actually create tasks. `createTask` derives the Task's
 * workspace binding from its Project, so a service with no `projectService`
 * cannot create one at all — binding is a precondition, not a decoration.
 */
function createTempTaskGraphService() {
  const workspace = mkdtempSync(join(tmpdir(), 'station-caps-workspace-'));
  return new TaskGraphService(mkdtempSync(join(tmpdir(), 'station-caps-')), {
    projectService: {
      getProject: (slug: string) => ({
        id: slug,
        slug,
        name: slug,
        workingDirectory: workspace,
        createdAt: '2026-05-03T00:00:00.000Z',
        updatedAt: '2026-05-03T00:00:00.000Z',
      }),
    },
  });
}

const taskDispatcher = {
  dispatch: vi.fn<TaskDispatcher['dispatch']>(async () => ({
    kind: 'failed' as const,
    reason: 'not configured',
  })),
} satisfies TaskDispatcher;

beforeEach(() => {
  taskDispatcher.dispatch.mockClear();
});

function createUnsupportedTaskGraphService() {
  const projectHomeDir = mkdtempSync(join(tmpdir(), 'station-caps-shape-'));
  const taskGraphPath = join(projectHomeDir, 'task-graph.json');
  writeFileSync(
    taskGraphPath,
    JSON.stringify({
      tasks: [
        {
          id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
          projectId: 'project-alpha',
          title: 'Unsupported task shape',
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
    }),
    'utf8',
  );
  return {
    taskGraphService: new TaskGraphService(projectHomeDir),
    taskGraphPath,
  };
}

function stationIntent(command: string, taskId: string): StationIntent {
  return {
    authority: { product: 'station', command },
    subjectRefs: [{ product: 'station', kind: 'task', id: taskId }],
  };
}

function sessionDetail(
  overrides: Partial<OrchestrationSessionDetail['session']> = {},
): OrchestrationSessionDetail {
  const now = new Date().toISOString();
  return {
    session: {
      provider: 'claude',
      threadId: 'thread-abc',
      status: 'ready',
      resumeCursor: { turnId: 'turn-1', source: 'record' },
      isLoaded: true,
      isPersisted: true,
      eventCount: 0,
      controlMode: 'station-owned',
      answerability: { answerable: true },
      createdAt: now,
      updatedAt: now,
      ...overrides,
    },
    events: [],
  };
}

describe('createStationHostIntentBindings', () => {
  test('every catalog command produces exactly one host binding with matching authority metadata', () => {
    const taskGraphService = createTempTaskGraphService();
    const orchestrationDispatch = vi.fn(async () => undefined);
    const bindings = createStationHostIntentBindings({
      taskGraphService,
      taskDispatcher,
      orchestrationService: {
        dispatch: orchestrationDispatch,
        readSession: vi.fn(async () => null),
      },
    });

    expect(
      bindings.map(({ product, command, sideEffect, confirmation }) => ({
        product,
        command,
        sideEffect,
        confirmation,
      })),
    ).toEqual(
      STATION_HOST_COMMAND_CATALOG.map((catalogCommand) => ({
        product: 'station',
        command: catalogCommand.path.join(' '),
        sideEffect: catalogCommand.sideEffect,
        confirmation: catalogCommand.confirmation,
      })),
    );
  });

  test('a board "dispatch" intent crosses the TaskDispatcher Interface with its console-board intent', async () => {
    const taskGraphService = createTempTaskGraphService();
    const orchestrationDispatch = vi.fn(async () => undefined);
    const bindings = createStationHostIntentBindings({
      taskGraphService,
      taskDispatcher,
      orchestrationService: {
        dispatch: orchestrationDispatch,
        readSession: vi.fn(async () => null),
      },
    });

    const task = await taskGraphService.createTask({
      projectId: 'project-alpha',
      title: 'Board-dispatched task',
    });

    const resolution = resolveIntentBinding(
      stationIntent('task dispatch', task.id),
      bindings,
    );
    expect(resolution.bound).toBe(true);
    if (!resolution.bound) throw new Error('unreachable');
    expect(resolution.confirmation).toBe('user-request');
    expect(resolution.sideEffect).toBe('write-local');

    taskDispatcher.dispatch.mockResolvedValueOnce({
      kind: 'dispatched',
      result: {} as TaskDispatchResult,
    });

    await resolution.execute(stationIntent('task dispatch', task.id));

    expect(taskDispatcher.dispatch).toHaveBeenCalledWith(task.id, {
      sourceSurface: 'console-board',
    });
    expect(orchestrationDispatch).not.toHaveBeenCalled();
  });

  test('a board "block"/"unblock" intent resolves to the REAL TaskGraphService.updateTaskStatus handler', async () => {
    const taskGraphService = createTempTaskGraphService();
    const bindings = createStationHostIntentBindings({
      taskGraphService,
      taskDispatcher,
      orchestrationService: {
        dispatch: vi.fn(async () => undefined),
        readSession: vi.fn(async () => null),
      },
    });

    const task = await taskGraphService.createTask({
      projectId: 'project-alpha',
      title: 'Blockable task',
    });
    await taskGraphService.updateTaskStatus(task.id, 'ready');

    const blockResolution = resolveIntentBinding(
      stationIntent('task block', task.id),
      bindings,
    );
    if (!blockResolution.bound) throw new Error('unreachable');
    await blockResolution.execute(stationIntent('task block', task.id));
    expect(taskGraphService.readTask(task.id)?.status).toBe('blocked');

    const unblockResolution = resolveIntentBinding(
      stationIntent('task unblock', task.id),
      bindings,
    );
    if (!unblockResolution.bound) throw new Error('unreachable');
    await unblockResolution.execute(stationIntent('task unblock', task.id));
    expect(taskGraphService.readTask(task.id)?.status).toBe('ready');
  });

  test.each(['alpha', 'bravo'] as const)(
    'hosted %s task intents are inert before TaskGraph reads or mutations',
    async (tenant) => {
      const taskGraphService = createTempTaskGraphService();
      const readTaskView = vi.spyOn(taskGraphService, 'readTaskView');
      const dispatchTask = taskDispatcher.dispatch;
      const updateTaskStatus = vi.spyOn(taskGraphService, 'updateTaskStatus');
      const bindings = createStationHostIntentBindings({
        taskGraphService,
        taskDispatcher,
        orchestrationService: {
          dispatch: vi.fn(async () => undefined),
          readSession: vi.fn(async () => null),
        },
        getSessionReadAuthority: () => hostedAuthority(tenant),
      });
      const task = await taskGraphService.createTask({
        projectId: 'project-alpha',
        title: 'Hosted intent no-op',
      });

      for (const command of [
        'task status',
        'task dispatch',
        'task block',
        'task unblock',
      ]) {
        const intent = stationIntent(command, task.id);
        const resolution = resolveIntentBinding(intent, bindings);
        if (!resolution.bound) throw new Error('unreachable');
        await resolution.execute(intent);
      }

      expect(readTaskView).not.toHaveBeenCalled();
      expect(dispatchTask).not.toHaveBeenCalled();
      expect(updateTaskStatus).not.toHaveBeenCalled();
      expect(taskGraphService.readTask(task.id)?.status).toBe('todo');
    },
  );

  test('subject-ref trust: a "task dispatch" intent whose first subjectRef is a FOREIGN product does NOT dispatch, even though the id collides with a real task', async () => {
    const taskGraphService = createTempTaskGraphService();
    const dispatchTaskSpy = taskDispatcher.dispatch;
    const bindings = createStationHostIntentBindings({
      taskGraphService,
      taskDispatcher,
      orchestrationService: {
        dispatch: vi.fn(async () => undefined),
        readSession: vi.fn(async () => null),
      },
    });

    const task = await taskGraphService.createTask({
      projectId: 'project-alpha',
      title: 'Collision-id probe',
    });

    const foreignProductIntent: StationIntent = {
      authority: { product: 'station', command: 'task dispatch' },
      subjectRefs: [{ product: 'flow', kind: 'task', id: task.id }],
    };
    const resolution = resolveIntentBinding(foreignProductIntent, bindings);
    // The (product, command) AUTHORITY is legitimately bound — this is not
    // a never-authority case. The subject-ref TYPE mismatch is caught
    // inside `execute`, which is the point of this test.
    expect(resolution.bound).toBe(true);
    if (!resolution.bound) throw new Error('unreachable');
    await resolution.execute(foreignProductIntent);

    expect(dispatchTaskSpy).not.toHaveBeenCalled();
    expect(taskGraphService.readTask(task.id)?.status).toBe('todo');
  });

  test('subject-ref trust: a "task dispatch" intent whose first subjectRef has the wrong `kind` does NOT dispatch', async () => {
    const taskGraphService = createTempTaskGraphService();
    const dispatchTaskSpy = taskDispatcher.dispatch;
    const bindings = createStationHostIntentBindings({
      taskGraphService,
      taskDispatcher,
      orchestrationService: {
        dispatch: vi.fn(async () => undefined),
        readSession: vi.fn(async () => null),
      },
    });

    const task = await taskGraphService.createTask({
      projectId: 'project-alpha',
      title: 'Wrong-kind probe',
    });

    const wrongKindIntent: StationIntent = {
      authority: { product: 'station', command: 'task dispatch' },
      subjectRefs: [{ product: 'station', kind: 'session', id: task.id }],
    };
    const resolution = resolveIntentBinding(wrongKindIntent, bindings);
    if (!resolution.bound) throw new Error('unreachable');
    await resolution.execute(wrongKindIntent);

    expect(dispatchTaskSpy).not.toHaveBeenCalled();
    expect(taskGraphService.readTask(task.id)?.status).toBe('todo');
  });

  test('a "session resume" intent resolves to the REAL OrchestrationService.dispatch path, using the STATION-OWNED SESSION RECORD\'s provider/resumeCursor', async () => {
    const taskGraphService = createTempTaskGraphService();
    let receivedCommand: OrchestrationCommand | undefined;
    const orchestrationDispatch = vi.fn(
      async (command: OrchestrationCommand) => {
        receivedCommand = command;
        return undefined;
      },
    );
    const readSession = vi.fn(async (threadId: string) => {
      expect(threadId).toBe('thread-abc');
      return sessionDetail();
    });
    const bindings = createStationHostIntentBindings({
      taskGraphService,
      taskDispatcher,
      orchestrationService: { dispatch: orchestrationDispatch, readSession },
      getSessionReadAuthority: intentAuthority,
    });

    const intent: StationIntent = {
      authority: { product: 'station', command: 'session resume' },
      subjectRefs: [{ product: 'station', kind: 'session', id: 'thread-abc' }],
    };
    const resolution = resolveIntentBinding(intent, bindings);
    if (!resolution.bound) throw new Error('unreachable');
    expect(resolution.sideEffect).toBe('write-external');
    await resolution.execute(intent);

    expect(readSession).toHaveBeenCalledWith('thread-abc', intentAuthority());
    expect(orchestrationDispatch).toHaveBeenCalledTimes(1);
    expect(receivedCommand).toEqual({
      type: 'startSession',
      input: {
        threadId: 'thread-abc',
        provider: 'claude',
        resumeCursor: { turnId: 'turn-1', source: 'record' },
      },
    });
  });

  test('a same-tenant hosted session resume forwards the fresh request authority to dispatch', async () => {
    const taskGraphService = createTempTaskGraphService();
    const readSession = vi.fn(async () => sessionDetail());
    const dispatch = vi.fn(async () => undefined);
    const authority = hostedAuthority('alpha');
    const bindings = createStationHostIntentBindings({
      taskGraphService,
      taskDispatcher,
      orchestrationService: { dispatch, readSession },
      getSessionReadAuthority: () => authority,
    });
    const intent: StationIntent = {
      authority: { product: 'station', command: 'session resume' },
      subjectRefs: [{ product: 'station', kind: 'session', id: 'thread-abc' }],
    };
    const resolution = resolveIntentBinding(intent, bindings);
    if (!resolution.bound) throw new Error('unreachable');

    await resolution.execute(intent);

    expect(readSession).toHaveBeenCalledWith('thread-abc', authority);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'startSession' }),
      {
        userId: 'shared-user',
        tenantExecutionContext: authority.tenantExecutionContext,
      },
    );
  });

  test('subject-ref trust + payload distrust: an intent-supplied provider/resumeCursor that DISAGREES with the stored session record is ignored — the record always wins', async () => {
    const taskGraphService = createTempTaskGraphService();
    let receivedCommand: OrchestrationCommand | undefined;
    const orchestrationDispatch = vi.fn(
      async (command: OrchestrationCommand) => {
        receivedCommand = command;
        return undefined;
      },
    );
    const readSession = vi.fn(async () =>
      sessionDetail({
        provider: 'codex',
        resumeCursor: { turnId: 'turn-9', source: 'record' },
      }),
    );
    const bindings = createStationHostIntentBindings({
      taskGraphService,
      taskDispatcher,
      orchestrationService: { dispatch: orchestrationDispatch, readSession },
      getSessionReadAuthority: intentAuthority,
    });

    // The intent's subjectRef smuggles a DIFFERENT provider/resumeCursor
    // than the stored record — these must never reach `dispatch`.
    const intent: StationIntent = {
      authority: { product: 'station', command: 'session resume' },
      subjectRefs: [
        {
          product: 'station',
          kind: 'session',
          id: 'thread-abc',
          provider: 'claude',
          resumeCursor: { turnId: 'attacker-supplied' },
        },
      ],
    };
    const resolution = resolveIntentBinding(intent, bindings);
    if (!resolution.bound) throw new Error('unreachable');
    await resolution.execute(intent);

    expect(receivedCommand).toEqual({
      type: 'startSession',
      input: {
        threadId: 'thread-abc',
        provider: 'codex',
        resumeCursor: { turnId: 'turn-9', source: 'record' },
      },
    });
  });

  test('subject-ref trust: a "session resume" intent whose first subjectRef is not a station/session ref does NOT resume', async () => {
    const taskGraphService = createTempTaskGraphService();
    const orchestrationDispatch = vi.fn(async () => undefined);
    const readSession = vi.fn(async () => sessionDetail());
    const bindings = createStationHostIntentBindings({
      taskGraphService,
      taskDispatcher,
      orchestrationService: { dispatch: orchestrationDispatch, readSession },
      getSessionReadAuthority: intentAuthority,
    });

    const foreignIntent: StationIntent = {
      authority: { product: 'station', command: 'session resume' },
      subjectRefs: [{ product: 'flow', kind: 'session', id: 'thread-abc' }],
    };
    const resolution = resolveIntentBinding(foreignIntent, bindings);
    if (!resolution.bound) throw new Error('unreachable');
    await resolution.execute(foreignIntent);

    expect(readSession).not.toHaveBeenCalled();
    expect(orchestrationDispatch).not.toHaveBeenCalled();
  });

  test('a "session resume" intent naming a session id with NO Station-owned session record is a no-op', async () => {
    const taskGraphService = createTempTaskGraphService();
    const orchestrationDispatch = vi.fn(async () => undefined);
    const readSession = vi.fn(async () => null);
    const bindings = createStationHostIntentBindings({
      taskGraphService,
      taskDispatcher,
      orchestrationService: { dispatch: orchestrationDispatch, readSession },
      getSessionReadAuthority: intentAuthority,
    });

    const intent: StationIntent = {
      authority: { product: 'station', command: 'session resume' },
      subjectRefs: [
        { product: 'station', kind: 'session', id: 'no-such-thread' },
      ],
    };
    const resolution = resolveIntentBinding(intent, bindings);
    if (!resolution.bound) throw new Error('unreachable');
    await resolution.execute(intent);

    expect(readSession).toHaveBeenCalledWith(
      'no-such-thread',
      intentAuthority(),
    );
    expect(orchestrationDispatch).not.toHaveBeenCalled();
  });

  test('a session resume without trusted runtime authority is inert', async () => {
    const taskGraphService = createTempTaskGraphService();
    const readSession = vi.fn(async () => sessionDetail());
    const dispatch = vi.fn(async () => undefined);
    const bindings = createStationHostIntentBindings({
      taskGraphService,
      taskDispatcher,
      orchestrationService: { dispatch, readSession },
    });
    const intent: StationIntent = {
      authority: { product: 'station', command: 'session resume' },
      subjectRefs: [{ product: 'station', kind: 'session', id: 'thread-abc' }],
    };
    const resolution = resolveIntentBinding(intent, bindings);
    if (!resolution.bound) throw new Error('unreachable');

    await resolution.execute(intent);

    expect(readSession).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('a hosted session resume with missing tenant context is inert before session lookup', async () => {
    const taskGraphService = createTempTaskGraphService();
    const readSession = vi.fn(async () => sessionDetail());
    const dispatch = vi.fn(async () => undefined);
    const bindings = createStationHostIntentBindings({
      taskGraphService,
      taskDispatcher,
      orchestrationService: { dispatch, readSession },
      getSessionReadAuthority: () => hostedAuthority(),
    });
    const intent: StationIntent = {
      authority: { product: 'station', command: 'session resume' },
      subjectRefs: [{ product: 'station', kind: 'session', id: 'thread-abc' }],
    };
    const resolution = resolveIntentBinding(intent, bindings);
    if (!resolution.bound) throw new Error('unreachable');

    await resolution.execute(intent);

    expect(readSession).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('a hosted session resume whose session read is denied never dispatches', async () => {
    const taskGraphService = createTempTaskGraphService();
    const readSession = vi.fn(async () => null);
    const dispatch = vi.fn(async () => undefined);
    const bindings = createStationHostIntentBindings({
      taskGraphService,
      taskDispatcher,
      orchestrationService: { dispatch, readSession },
      getSessionReadAuthority: () => hostedAuthority('bravo'),
    });
    const intent: StationIntent = {
      authority: { product: 'station', command: 'session resume' },
      subjectRefs: [
        { product: 'station', kind: 'session', id: 'alpha-thread' },
      ],
    };
    const resolution = resolveIntentBinding(intent, bindings);
    if (!resolution.bound) throw new Error('unreachable');

    await resolution.execute(intent);

    expect(readSession).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('never-authority invariant: an intent naming an authority Station never declared resolves inert and never calls any Station handler', async () => {
    const taskGraphService = createTempTaskGraphService();
    const dispatchTaskSpy = taskDispatcher.dispatch;
    const updateStatusSpy = vi.spyOn(taskGraphService, 'updateTaskStatus');
    const orchestrationDispatch = vi.fn(async () => undefined);
    const bindings = createStationHostIntentBindings({
      taskGraphService,
      taskDispatcher,
      orchestrationService: {
        dispatch: orchestrationDispatch,
        readSession: vi.fn(async () => null),
      },
    });

    const task = await taskGraphService.createTask({
      projectId: 'project-alpha',
      title: 'Foreign-authority probe',
    });

    // A foreign product's authority (`flow cancel`) that merely happens to
    // carry a Station-shaped subjectRef.
    const foreignIntent: StationIntent = {
      authority: { product: 'flow', command: 'cancel' },
      subjectRefs: [{ product: 'station', kind: 'task', id: task.id }],
    };
    const resolution = resolveIntentBinding(foreignIntent, bindings);
    expect(resolution.bound).toBe(false);
    if (resolution.bound) throw new Error('unreachable');
    expect(resolution.reason).toBe('no-matching-binding');
    expect('execute' in resolution).toBe(false);

    // A Station COMMAND STRING Station never published as a descriptor
    // command either (an authority Station simply never declared at all).
    const unpublishedIntent: StationIntent = {
      authority: { product: 'station', command: 'task delete' },
      subjectRefs: [{ product: 'station', kind: 'task', id: task.id }],
    };
    const unpublishedResolution = resolveIntentBinding(
      unpublishedIntent,
      bindings,
    );
    expect(unpublishedResolution.bound).toBe(false);

    expect(dispatchTaskSpy).not.toHaveBeenCalled();
    expect(updateStatusSpy).not.toHaveBeenCalled();
    expect(orchestrationDispatch).not.toHaveBeenCalled();
    // The underlying task record is untouched.
    expect(taskGraphService.readTask(task.id)?.status).toBe('todo');
  });

  test('consent-gating: resolveIntentBinding surfaces confirmation metadata but NEVER calls execute itself — a side-effecting binding stays un-invoked until a caller-side consent gate decides to run it', async () => {
    const taskGraphService = createTempTaskGraphService();
    const dispatchTaskSpy = taskDispatcher.dispatch;
    const bindings = createStationHostIntentBindings({
      taskGraphService,
      taskDispatcher,
      orchestrationService: {
        dispatch: vi.fn(async () => undefined),
        readSession: vi.fn(async () => null),
      },
    });

    const task = await taskGraphService.createTask({
      projectId: 'project-alpha',
      title: 'Consent-gated dispatch',
    });

    const resolution = resolveIntentBinding(
      stationIntent('task dispatch', task.id),
      bindings,
    );
    expect(resolution.bound).toBe(true);
    if (!resolution.bound) throw new Error('unreachable');
    // The confirmation tier a consent layer (Station's native policy
    // classes, or S6's confirmation UI) must gate on before invoking
    // `execute` — resolution itself never makes that call.
    expect(resolution.confirmation).toBe('user-request');
    expect(dispatchTaskSpy).not.toHaveBeenCalled();
    expect(taskGraphService.readTask(task.id)?.status).toBe('todo');
  });

  test('consent-gating: the read-only status command carries confirmation "never" — safe to auto-execute with no gate, unlike the write commands', async () => {
    const taskGraphService = createTempTaskGraphService();
    const bindings = createStationHostIntentBindings({
      taskGraphService,
      taskDispatcher,
      orchestrationService: {
        dispatch: vi.fn(async () => undefined),
        readSession: vi.fn(async () => null),
      },
    });
    const task = await taskGraphService.createTask({
      projectId: 'project-alpha',
      title: 'Read-only status',
    });

    const resolution = resolveIntentBinding(
      stationIntent('task status', task.id),
      bindings,
    );
    expect(resolution.bound).toBe(true);
    if (!resolution.bound) throw new Error('unreachable');
    expect(resolution.confirmation).toBe('never');
    expect(resolution.sideEffect).toBe('read-local');
  });

  test('descriptor honesty: the "task status" executor rejects an unsupported store shape without writing it', async () => {
    const { taskGraphService, taskGraphPath } =
      createUnsupportedTaskGraphService();
    const bindingsDeps = {
      taskGraphService,
      taskDispatcher,
      orchestrationService: {
        dispatch: vi.fn(async () => undefined),
        readSession: vi.fn(async () => null),
      },
    };
    const bindings = createStationHostIntentBindings(bindingsDeps);

    const beforeBytes = readFileSync(taskGraphPath, 'utf-8');

    const resolution = resolveIntentBinding(
      stationIntent('task status', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
      bindings,
    );
    expect(resolution.bound).toBe(true);
    if (!resolution.bound) throw new Error('unreachable');
    expect(() =>
      resolution.execute(
        stationIntent('task status', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
      ),
    ).toThrow('Task graph store is unavailable');

    const afterBytes = readFileSync(taskGraphPath, 'utf-8');
    expect(afterBytes).toBe(beforeBytes);
  });
});
