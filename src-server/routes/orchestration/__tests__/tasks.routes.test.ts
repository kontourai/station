import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  STATION_TASK_BASIS_COLLECTION_VERSION,
  type StationTaskBasisCollection,
} from '@kontourai/station-contracts/task-basis';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
  tenantId,
} from '@kontourai/station-contracts/tenancy';
import { Hono } from 'hono';
import { describe, expect, type Mock, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { setRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import { TaskAnswerSupportUnavailableError } from '../../../services/evidence/task-answer-support-module.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import type { SessionToolResultQueryOutcome } from '../../../services/orchestration/session-query-module.js';
import { createSessionQueryModule } from '../../../services/orchestration/session-query-module.js';
import { composeAuthorizedSessionAnswerBasis } from '../../../services/projects/task-basis-module.js';
import { createTaskBasisRuntimeComposition } from '../../../services/projects/task-basis-runtime-composition.js';
import { composeTaskDispatcher } from '../../../services/projects/task-dispatch-composition.js';
import { TaskGraphService } from '../../../services/projects/task-graph-service.js';
import { createOrchestrationRoutes } from '../orchestration.js';
import { createTaskRoutes } from '../tasks.js';

/**
 * A service wired with a `projectService`, which the workspace-binding routes
 * need: `createTask` derives the binding from the project's working directory,
 * so a service without one cannot produce an `available` binding.
 */
function createRouteService(
  extra: ConstructorParameters<typeof TaskGraphService>[1] = {},
) {
  const workspace = mkdtempSync(join(tmpdir(), 'station-task-workspace-'));
  return new TaskGraphService(
    mkdtempSync(join(tmpdir(), 'station-task-routes-')),
    {
      ...extra,
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
    },
  );
}

const inertTaskDispatcher = {
  dispatch: vi.fn(async () => ({
    kind: 'failed' as const,
    reason: 'task dispatch is unavailable in this route fixture',
  })),
};
const unassessedSupport = {
  standing: async () => ({ state: 'unassessed' as const }),
};

function snapshotFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory)) {
      // SQLite's WAL bookkeeping changes as readers open/close; it is not an
      // owner mutation. The durable database and all JSON/snapshot stores are
      // compared byte-for-byte below.
      if (entry.endsWith('-wal') || entry.endsWith('-shm')) continue;
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) visit(path);
      else
        files[path.slice(root.length)] = readFileSync(path).toString('base64');
    }
  };
  visit(root);
  return files;
}

describe('Task routes', () => {
  test.each(['denied', 'corrupt'] as const)(
    'publishes a selected answer despite an unrelated %s kept-result gap',
    async (kind) => {
      const service = createRouteService();
      const task = await service.createTask({
        projectId: 'project-alpha',
        title: 'Selected answer fence',
      });
      await service.createTaskReference(task.id, {
        kind: 'turn',
        sessionId: 'session-a',
        turnId: 'turn-a',
      });
      if (kind === 'denied') {
        await service.createTaskReference(task.id, {
          kind: 'tool-result',
          sessionId: 'session-b',
          eventId: 'event-b',
        });
      } else {
        vi.spyOn(service, 'readTaskToolResultReferenceLinks').mockReturnValue([
          { id: 'corrupt-keep', targetId: 'not-a-tool-result' },
        ] as any);
      }
      const projection = composeAuthorizedSessionAnswerBasis({
        status: 'found',
        sessionId: 'session-a',
        turnId: 'turn-a',
        observedAt: '2026-08-25T00:00:00.000Z',
        projectSlug: 'project-alpha',
        binding: {
          version: 'station-answer-binding/v1',
          sessionId: 'session-a',
          turnId: 'turn-a',
          answer: {
            authority: '@kontourai/thread',
            schemaVersion: '1.2.0',
            kind: 'assistant-message',
            standing: 'observed',
            threadId: 'session-a',
            messageId: 'answer-a',
          },
        },
        inputs: [],
        results: [],
      });
      const app = createTaskRoutes(service, {
        taskDispatcher: inertTaskDispatcher,
        readAuthorityForRequest: () =>
          sessionReadAuthorityFromRequest('owner', undefined, undefined),
        isRequestPrincipalCurrent: () => true,
        canReadSession: (sessionId) => sessionId === 'session-a',
        readTaskBasis: async () => ({ status: 'found', data: projection }),
      });
      const answerReferenceId = service.readTaskTurnReferenceLinks(task.id)?.[0]
        ?.id;
      const response = await app.request(
        `/${task.id}/basis?answerReferenceId=${encodeURIComponent(answerReferenceId!)}`,
      );
      expect(response.status).toBe(200);
      await expect(readJson(response)).resolves.toMatchObject({
        success: true,
        data: { answer: { value: { ref: { threadId: 'session-a' } } } },
      });
    },
  );

  test('composes direct and Task Basis from durable owners without GET writes or protected Project leakage', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-basis-owners-'));
    const workspace = join(home, 'workspace');
    let store = new EventStore(join(home, 'orchestration.sqlite'));
    try {
      const threadId = 'session-a';
      const turnId = 'turn-a';
      store.upsertSession({
        provider: 'claude',
        threadId,
        status: 'ready',
        createdAt: '2026-08-25T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
      });
      store.appendEvent({
        eventId: 'session-started',
        provider: 'claude',
        threadId,
        createdAt: '2026-08-25T00:00:00.000Z',
        method: 'session.started',
        sessionId: threadId,
        metadata: {
          projectSlug: 'project-alpha',
          assignedAgentSlug: 'station',
        },
      } as any);
      store.appendEvent({
        eventId: 'input-a',
        provider: 'claude',
        threadId,
        turnId,
        createdAt: '2026-08-25T00:00:01.000Z',
        method: 'turn.started',
        prompt: 'initial prompt',
      } as any);
      store.appendEvent({
        eventId: 'answer-a',
        provider: 'claude',
        threadId,
        turnId,
        createdAt: '2026-08-25T00:00:02.000Z',
        method: 'content.text-delta',
        delta: 'answer',
      } as any);
      store.appendEvent({
        eventId: 'done-a',
        provider: 'claude',
        threadId,
        turnId,
        createdAt: '2026-08-25T00:00:03.000Z',
        method: 'turn.completed',
      } as any);
      // The descriptor route must survive a durable owner restart; no query
      // fixture carries its answer facts across this boundary.
      store.close();
      store = new EventStore(join(home, 'orchestration.sqlite'));
      const sessionQueries = createSessionQueryModule({
        findSession: async (id) => store.readSessionByThread(id) ?? null,
        projectConversation: () => null,
        canReadSession: () => true,
        listEvents: () => [],
        userInputEventById: (eventId) => {
          const event = store.userInputEventById(eventId);
          return event
            ? {
                ...event,
                attachments: event.attachments.map((item) => ({
                  name: item.name,
                  mediaType: item.mimeType,
                  size: item.size,
                })),
              }
            : undefined;
        },
        toolCompletedEventById: (id, eventId) =>
          store.toolCompletedEventById(id, eventId),
        listBasisEventsForTurn: (id, turn) =>
          store.listBasisEventsForTurn(id, turn),
        projectSlugForSession: (_session, id) =>
          store.readConversationProjectSlug(id),
      });
      mkdirSync(workspace);
      const graph = new TaskGraphService(home, {
        projectService: {
          getProject: (id: string) => ({
            id,
            slug: id,
            name: id,
            workingDirectory: workspace,
            createdAt: '2026-08-25T00:00:00.000Z',
            updatedAt: '2026-08-25T00:00:00.000Z',
          }),
        } as any,
      });
      writeFileSync(join(workspace, 'output.txt'), 'output');
      const task = await graph.createTask({
        projectId: 'project-alpha',
        title: 'Basis',
      });
      await graph.createTaskReference(task.id, {
        kind: 'turn',
        sessionId: threadId,
        turnId,
      });
      await graph.createTaskReference(task.id, {
        kind: 'user-input',
        sessionId: threadId,
        eventId: 'input-a',
      });
      const { taskOutputs: outputs, taskBasis: basis } =
        createTaskBasisRuntimeComposition({
          homeDir: home,
          taskGraphService: graph,
          sessionQueries,
          canReadSession: () => true,
        });
      await outputs.create(task.id, {
        operationId: 'output-a',
        relativePath: 'output.txt',
        title: 'Output',
      });
      const authority = sessionReadAuthorityFromRequest(
        'owner',
        undefined,
        undefined,
      );
      const app = new Hono();
      app.route(
        '/api/orchestration',
        createOrchestrationRoutes(
          { sessionQueries, canUserReadSession: () => true } as any,
          {
            eventBus: { subscribe: () => () => {} },
            logger: { debug: vi.fn() },
            getUserId: () => 'owner',
            isRequestPrincipalCurrent: () => true,
          },
        ),
      );
      app.route(
        '/api/tasks',
        createTaskRoutes(graph, {
          taskDispatcher: inertTaskDispatcher,
          readAuthorityForRequest: () => authority,
          readTaskBasis: (input) => basis.read(input),
        }),
      );
      const before = snapshotFiles(home);
      const direct = await app.request(
        `/api/orchestration/sessions/${threadId}/turns/${turnId}/basis`,
      );
      expect(direct.status).toBe(200);
      await expect(readJson(direct)).resolves.toMatchObject({
        data: {
          version: 'surface.basis-projection/v1',
          standing: 'execution-only',
          answer: {
            state: 'available',
            value: { ref: { threadId } },
          },
        },
      });
      const whole = await app.request(`/api/tasks/${task.id}/basis`);
      await expect(readJson(whole)).resolves.toMatchObject({
        data: {
          version: 'station.task-basis-collection/v4',
          taskId: task.id,
          answers: [
            expect.objectContaining({
              answerReferenceId: expect.any(String),
              projection: expect.objectContaining({
                standing: 'execution-only',
              }),
            }),
          ],
          unassociated: [
            expect.objectContaining({ kind: 'task-output', kept: true }),
          ],
          gaps: [],
        },
      });
      expect(snapshotFiles(home)).toEqual(before);
      await graph.createTaskReference(task.id, {
        kind: 'turn',
        sessionId: 'other-project',
        turnId: 'private-turn',
      });
      const protectedBefore = snapshotFiles(home);
      const protectedWhole = await readJson(
        await app.request(`/api/tasks/${task.id}/basis`),
      );
      expect(protectedWhole).toMatchObject({
        data: {
          gaps: [{ state: 'restricted' }],
        },
      });
      expect(JSON.stringify(protectedWhole)).not.toContain('other-project');
      expect(snapshotFiles(home)).toEqual(protectedBefore);
    } finally {
      store.close();
    }
  });
  test('reads a bounded Basis projection task-first without mutations', async () => {
    const service = createRouteService();
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Basis',
    });
    // Use the public collection version and full read union, including misses.
    const readTaskBasis: Mock<
      () => Promise<
        | { status: 'found'; data: StationTaskBasisCollection }
        | { status: 'not-found' }
        | { status: 'unavailable' }
      >
    > = vi.fn(async () => ({
      status: 'found' as const,
      data: {
        version: STATION_TASK_BASIS_COLLECTION_VERSION,
        taskId: task.id,
        answers: [],
        unassociated: [],
        keptToolResults: [],
        keptGateEvaluations: [],
        gaps: [],
      },
    }));
    const app = createTaskRoutes(service, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      readTaskBasis,
    });
    const response = await app.request(`/${task.id}/basis`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await readJson(response)).toMatchObject({
      data: { version: 'station.task-basis-collection/v4', taskId: task.id },
    });
    expect(readTaskBasis).toHaveBeenCalledOnce();
    readTaskBasis.mockResolvedValueOnce({ status: 'unavailable' });
    expect((await app.request(`/${task.id}/basis`)).status).toBe(503);
  });
  test('attaches and reopens a task-owned safe tool-result projection', async () => {
    const service = createRouteService();
    const authority = sessionReadAuthorityFromRequest(
      'owner',
      undefined,
      undefined,
    );
    const readToolResult = vi.fn(async ({ sessionId, eventId }) =>
      sessionId === 'session-1' && eventId === 'event-1'
        ? {
            status: 'found' as const,
            sessionId,
            eventId,
            projectSlug: 'project-alpha',
            result: {
              resultId: eventId,
              name: 'shell',
              terminalStatus: 'success' as const,
              content: [{ type: 'text' as const, text: 'inert output' }],
              truncated: false,
              omittedParts: 0,
              omittedTextBytes: 0,
              omittedMetadataBytes: 0,
            },
          }
        : { status: 'not-found' as const },
    );
    const app = createTaskRoutes(service, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: () => authority,
      readToolResult,
    });
    const created = await readJson(
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: 'project-alpha',
          title: 'Result basis',
        }),
      }),
    );
    const taskId = created.data.id as string;
    const attached = await app.request(`/${taskId}/references`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'tool-result',
        sessionId: 'session-1',
        eventId: 'event-1',
      }),
    });
    expect(attached.status).toBe(201);
    expect(await readJson(attached)).toMatchObject({
      data: {
        targetType: 'tool_result',
        relationType: 'references_tool_result',
        targetId: 'tool-result/session-1/event-1',
      },
    });
    const reopened = await app.request(`/${taskId}/tool-result-references`);
    expect(reopened.headers.get('Cache-Control')).toContain('no-store');
    await expect(readJson(reopened)).resolves.toMatchObject({
      success: true,
      data: [{ state: 'available', result: { resultId: 'event-1' } }],
    });
    const graph = await readJson(await app.request(`/${taskId}/graph`));
    expect(graph.data.links).toEqual([]);
  });

  test.each(['principal', 'workspace', 'task-binding'] as const)(
    'does not retain a gate evaluation when its %s admission witness changes',
    async (changed) => {
      const service = createRouteService();
      const task = await service.createTask({
        projectId: 'project-alpha',
        title: 'Bound Flow receipt',
      });
      const original = service.readTask(task.id)!;
      let principalCurrent = true;
      let workspace = original.workspaceBinding!.workingDirectory!;
      if (changed === 'task-binding') {
        vi.spyOn(service, 'readTask').mockReturnValue({
          ...original,
          workspaceBinding: {
            ...original.workspaceBinding,
            workingDirectory: '/workspace-rebound',
          },
        });
        workspace = '/workspace-rebound';
      }
      let release!: () => void;
      const readFlowGateEvaluation = vi.fn(
        async ({ authorize }: { authorize: () => boolean }) => {
          expect(authorize()).toBe(true);
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          return authorize()
            ? ({ status: 'found', evaluation: { verdict: 'pass' } } as any)
            : ({ status: 'missing' } as const);
        },
      );
      const app = createTaskRoutes(service, {
        taskDispatcher: inertTaskDispatcher,
        isRequestPrincipalCurrent: () => principalCurrent,
        resolveProjectWorkspace: () => workspace,
        readFlowGateEvaluation,
      });
      const response = app.request(`/${task.id}/references`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'gate-evaluation',
          ref: {
            runId: 'run-1',
            gateId: 'gate-1',
            evaluationId: '018f4b67-7f1d-4e68-8e10-5eb8a4958c51',
          },
        }),
      });
      await vi.waitFor(() =>
        expect(readFlowGateEvaluation).toHaveBeenCalledOnce(),
      );
      if (changed === 'principal') principalCurrent = false;
      if (changed === 'workspace') workspace = '/workspace-repointed';
      release();
      expect((await response).status).toBe(404);
      expect((await service.readTaskGraph(task.id))?.links).toEqual([]);
    },
  );

  test('publishes retained Flow evaluations through the bounded Task route only', async () => {
    const service = createRouteService();
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Flow receipt',
    });
    const evaluation = {
      ref: {
        runId: 'run-a',
        gateId: 'gate-a',
        evaluationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
      evaluatedAt: '2026-08-26T00:00:00.000Z',
      originalVerdict: 'block' as const,
      kind: 'initial' as const,
      trigger: 'ordinary' as const,
      currentStanding: 'current' as const,
      currentRun: { status: 'active', currentStep: null },
      selectedEvidence: [],
      validityAsOf: '2026-08-26T00:00:00.000Z',
      validityScope: 'retained-immutable-bundle' as const,
      externalRevocation: 'not-observed' as const,
    };
    const app = createTaskRoutes(service, {
      taskDispatcher: inertTaskDispatcher,
      readTaskGateEvaluationReferences: async () => ({
        status: 'found',
        references: [{ referenceId: 'keep-a', evaluation }],
      }),
    });
    const response = await app.request(
      `/${task.id}/gate-evaluation-references`,
    );
    expect(response.headers.get('cache-control')).toContain('no-store');
    await expect(readJson(response)).resolves.toEqual({
      success: true,
      data: [{ referenceId: 'keep-a', kept: true, evaluation }],
    });
  });

  test('keeps gate evaluation tuples out of the generic graph', async () => {
    const service = createRouteService();
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Private Flow receipt',
    });
    await service.createTaskReference(task.id, {
      kind: 'gate-evaluation',
      ref: {
        runId: 'run-1',
        gateId: 'gate-1',
        evaluationId: '018f4b67-7f1d-4e68-8e10-5eb8a4958c51',
      },
    });
    const app = createTaskRoutes(service, {
      taskDispatcher: inertTaskDispatcher,
    });
    const response = await app.request(`/${task.id}/graph`);
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.data.links).toEqual([]);
    expect(JSON.stringify(body)).not.toContain('run-1');
  });

  test('tool-result routes are Task-first, collapse protected misses, and dedupe exact tuples', async () => {
    const service = createRouteService();
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Tool matrix',
    });
    await service.createTaskReference(task.id, {
      kind: 'tool-result',
      sessionId: 'session',
      eventId: 'event',
    });
    await service.createLink({
      sourceType: 'task',
      sourceId: task.id,
      targetType: 'tool_result',
      targetId: 'tool-result/session/event',
      relationType: 'references_tool_result',
      source: 'system',
    });
    let mode: 'missing' | 'mismatch' | 'outage' | 'unscoped' = 'missing';
    const source = vi.fn(async () => {
      if (mode === 'outage') return { status: 'unavailable' as const };
      if (mode === 'mismatch')
        return {
          status: 'found' as const,
          sessionId: 'session',
          eventId: 'event',
          projectSlug: 'other',
          result: {
            resultId: 'event',
            name: 'shell',
            terminalStatus: 'error' as const,
            content: [{ type: 'text' as const, text: 'private' }],
            truncated: false,
            omittedParts: 0,
            omittedTextBytes: 0,
            omittedMetadataBytes: 0,
          },
        };
      if (mode === 'unscoped')
        return {
          status: 'found' as const,
          sessionId: 'session',
          eventId: 'event',
          result: {
            resultId: 'event',
            name: 'shell',
            terminalStatus: 'success' as const,
            content: [],
            truncated: false,
            omittedParts: 0,
            omittedTextBytes: 0,
            omittedMetadataBytes: 0,
          },
        };
      return { status: 'not-found' as const };
    });
    const app = createTaskRoutes(service, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      readToolResult: source,
    });
    const taskFirst = await app.request('/missing/references', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'tool-result',
        sessionId: 'session',
        eventId: 'event',
      }),
    });
    expect(taskFirst.status).toBe(404);
    expect(source).not.toHaveBeenCalled();
    for (const next of ['missing', 'mismatch'] as const) {
      mode = next;
      await expect(
        readJson(await app.request(`/${task.id}/tool-result-references`)),
      ).resolves.toEqual({ success: true, data: [{ state: 'unavailable' }] });
    }
    expect(source).toHaveBeenCalledTimes(2);
    mode = 'outage';
    const outage = await app.request(`/${task.id}/tool-result-references`);
    expect(outage.status).toBe(503);
    expect(outage.headers.get('cache-control')).toBe('private, no-store');
    mode = 'unscoped';
    await expect(
      readJson(await app.request(`/${task.id}/tool-result-references`)),
    ).resolves.toMatchObject({
      data: [{ state: 'available', result: { resultId: 'event' } }],
    });
    expect(source).toHaveBeenCalledTimes(4);
  });

  test.each(['caller', 'session', 'links'] as const)(
    'withholds all kept tool results when the %s snapshot changes during owner I/O',
    async (revocation) => {
      const service = createRouteService();
      const task = await service.createTask({
        projectId: 'project-alpha',
        title: 'Publication recheck',
      });
      await service.createTaskReference(task.id, {
        kind: 'tool-result',
        sessionId: 'session-current',
        eventId: 'event-current',
      });
      let callerCurrent = true;
      let sessionCurrent = true;
      let resolve!: (value: SessionToolResultQueryOutcome) => void;
      const source = vi.fn(
        () =>
          new Promise<SessionToolResultQueryOutcome>((done) => {
            resolve = done;
          }),
      );
      const app = createTaskRoutes(service, {
        taskDispatcher: inertTaskDispatcher,
        readAuthorityForRequest: () =>
          sessionReadAuthorityFromRequest('owner', undefined, undefined),
        isRequestPrincipalCurrent: () => callerCurrent,
        canReadSession: () => sessionCurrent,
        readToolResult: source,
      });
      const request = app.request(`/${task.id}/tool-result-references`);
      await vi.waitFor(() => expect(source).toHaveBeenCalledOnce());
      if (revocation === 'caller') callerCurrent = false;
      if (revocation === 'session') sessionCurrent = false;
      if (revocation === 'links') {
        await service.createTaskReference(task.id, {
          kind: 'tool-result',
          sessionId: 'session-current',
          eventId: 'event-later',
        });
      }
      resolve({
        status: 'found',
        sessionId: 'session-current',
        eventId: 'event-current',
        projectSlug: 'project-alpha',
        result: {
          resultId: 'event-current',
          name: 'shell',
          terminalStatus: 'success',
          content: [],
          truncated: false,
          omittedParts: 0,
          omittedTextBytes: 0,
          omittedMetadataBytes: 0,
        },
      });
      const response = await request;
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(await readJson(response)).toEqual({
        success: false,
        error: 'Tool result is temporarily unavailable',
      });
    },
  );

  test('fails closed for malformed inner tool-result identity and owner/store faults', async () => {
    const service = createRouteService();
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Inner result identity',
    });
    const malformed = {
      status: 'found' as const,
      sessionId: 'session-a',
      eventId: 'event-a',
      projectSlug: 'project-alpha',
      result: {
        resultId: 'other-event',
        name: 'shell',
        terminalStatus: 'success' as const,
        content: [],
        truncated: false,
        omittedParts: 0,
        omittedTextBytes: 0,
        omittedMetadataBytes: 0,
      },
    };
    const app = createTaskRoutes(service, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      readToolResult: async () => malformed,
    });
    const attach = await app.request(`/${task.id}/references`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'tool-result',
        sessionId: 'session-a',
        eventId: 'event-a',
      }),
    });
    expect(attach.status).toBe(404);
    expect(await service.readTaskToolResultReferenceLinks(task.id)).toEqual([]);

    await service.createTaskReference(task.id, {
      kind: 'tool-result',
      sessionId: 'session-a',
      eventId: 'event-a',
    });
    await expect(
      readJson(await app.request(`/${task.id}/tool-result-references`)),
    ).resolves.toEqual({ success: true, data: [{ state: 'unavailable' }] });

    const ownerFault = createTaskRoutes(service, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      readToolResult: async () => {
        throw new Error('opaque-owner-canary');
      },
    });
    const ownerResponse = await ownerFault.request(`/${task.id}/references`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'tool-result',
        sessionId: 'session-a',
        eventId: 'event-a',
      }),
    });
    expect(ownerResponse.status).toBe(503);
    expect(ownerResponse.headers.get('cache-control')).toContain('no-store');
    expect(await readJson(ownerResponse)).toEqual({
      success: false,
      error: 'Tool result is temporarily unavailable',
    });

    const storeFault = createTaskRoutes(
      {
        readTaskUserInputReferenceScope: () => {
          throw new Error('opaque-store-canary');
        },
      } as never,
      {
        taskDispatcher: inertTaskDispatcher,
        readAuthorityForRequest: () =>
          sessionReadAuthorityFromRequest('owner', undefined, undefined),
        readToolResult: async () => malformed,
      },
    );
    const storeResponse = await storeFault.request('/task-fault/references', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'tool-result',
        sessionId: 'session-a',
        eventId: 'event-a',
      }),
    });
    expect(storeResponse.status).toBe(503);
    expect(storeResponse.headers.get('cache-control')).toContain('no-store');
    expect(JSON.stringify(await readJson(storeResponse))).not.toContain(
      'opaque-store-canary',
    );
  });

  test('hosted tool-result requests never fall back to the personal Task graph', async () => {
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [{ id: 'alpha', authority: 'alpha.station.test' }],
    });
    const globalService = {
      readTaskUserInputReferenceScope: vi.fn(),
      createTaskReference: vi.fn(),
      readTaskToolResultReferenceLinks: vi.fn(),
    };
    const source = vi.fn();
    const app = createTaskRoutes(globalService as never, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest(
          'hosted-user',
          { tenantId: tenantId('alpha') },
          registry,
        ),
      readToolResult: source,
    });
    expect((await app.request('/task/tool-result-references')).status).toBe(
      404,
    );
    expect(
      globalService.readTaskUserInputReferenceScope,
    ).not.toHaveBeenCalled();
    expect(
      globalService.readTaskToolResultReferenceLinks,
    ).not.toHaveBeenCalled();
    expect(source).not.toHaveBeenCalled();
  });

  test('creates, dispatches, and reads graph relations', async () => {
    const service = createRouteService({
      orchestrationService: {
        dispatch: vi.fn(),
        seedSessionRecord: vi.fn((input) => ({
          provider: input.provider,
          threadId: input.threadId,
          status: 'ready' as const,
          createdAt: '2026-05-03T00:00:00.000Z',
          updatedAt: '2026-05-03T00:00:00.000Z',
        })),
      },
    });
    const app = createTaskRoutes(service, {
      taskDispatcher: composeTaskDispatcher(service),
    });

    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'project-alpha',
        title: 'Route task',
        agentId: 'agent-one',
      }),
    });
    const createBody = await readJson(createRes);
    expect(createRes.status).toBe(201);
    expect(createBody.success).toBe(true);

    const taskId = createBody.data.id;
    const dispatchRes = await app.request(`/${taskId}/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relatedFiles: ['src/routes.ts'] }),
    });
    const dispatchBody = await readJson(dispatchRes);
    expect(dispatchBody.success).toBe(true);
    expect(dispatchBody.data.task.status).toBe('ready');

    const graphRes = await app.request(`/${taskId}/graph`);
    const graphBody = await readJson(graphRes);
    expect(graphBody).toEqual({
      success: true,
      data: expect.objectContaining({
        task: expect.objectContaining({ id: taskId }),
        links: expect.arrayContaining([
          expect.objectContaining({ relationType: 'spawned_session' }),
          expect.objectContaining({ relationType: 'touches_file' }),
        ]),
      }),
    });

    const relationsRes = await app.request(
      `/sessions/${dispatchBody.data.dispatch.sessionId}/relations`,
    );
    const relationsBody = await readJson(relationsRes);
    expect(relationsBody.data.links).toHaveLength(1);
  });

  test('dispatch ignores body-supplied origin and durably stamps the authenticated request origin on the Task and dispatch record (#3830)', async () => {
    const service = createRouteService({
      orchestrationService: {
        dispatch: vi.fn(),
        seedSessionRecord: vi.fn((input) => ({
          provider: input.provider,
          threadId: input.threadId,
          status: 'ready' as const,
          createdAt: '2026-05-03T00:00:00.000Z',
          updatedAt: '2026-05-03T00:00:00.000Z',
        })),
      },
    });
    const inner = createTaskRoutes(service, {
      taskDispatcher: composeTaskDispatcher(service),
    });
    const app = new Hono();
    app.use('*', async (c, next) => {
      setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
        credential: 'device-credential',
        authority: 'device-credential',
        deviceId: 'authenticated-device-99',
        source: 'bearer',
      });
      await next();
    });
    app.route('/', inner);
    const headers = {
      'Content-Type': 'application/json',
      'X-Station-Client-Origin': '1;desktop;2026.8.23',
    };

    const created = await readJson(
      await app.request('/', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          projectId: 'project-alpha',
          title: 'Authenticated dispatch',
          clientOrigin: {
            version: 1,
            actor: { kind: 'device', deviceId: 'forged-body-device' },
            reported: { version: 1, surface: 'cli', build: 'forged' },
          },
        }),
      }),
    );
    const taskId = created.data.id as string;
    const dispatched = await readJson(
      await app.request(`/${taskId}/dispatch`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          relatedFiles: ['src/routes.ts'],
          clientOrigin: {
            version: 1,
            actor: { kind: 'device', deviceId: 'forged-body-device' },
            reported: { version: 1, surface: 'cli', build: 'forged' },
          },
        }),
      }),
    );

    const origin = {
      version: 1,
      actor: { kind: 'device', deviceId: 'authenticated-device-99' },
      reported: { version: 1, surface: 'desktop', build: '2026.8.23' },
    };
    expect(dispatched).toMatchObject({
      success: true,
      data: {
        task: { updatedClientOrigin: origin },
        dispatch: { clientOrigin: origin },
      },
    });
    expect((await service.readTaskGraph(taskId))?.task).toMatchObject({
      updatedClientOrigin: origin,
    });
  });

  test('validates create and dispatch bodies', async () => {
    const app = createTaskRoutes(createRouteService(), {
      taskDispatcher: {
        dispatch: vi.fn(async () => ({
          kind: 'failed' as const,
          reason: 'Task not found: missing',
        })),
      },
    });

    const invalidCreate = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: '', title: '' }),
    });
    expect(invalidCreate.status).toBe(400);

    const missingTask = await app.request('/missing/dispatch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(missingTask.status).toBe(400);
    expect(await readJson(missingTask)).toEqual({
      success: false,
      error: 'Task not found: missing',
    });
  });

  // Roadmap archive#584, part of epic archive#580, S4, review finding #6.
  test('POST / round-trips sourceProvider and workItemRef so a provider-backed create enters dispatch-as-claim', async () => {
    const app = createTaskRoutes(
      createRouteService({
        assignmentClaimService: {
          claim: vi.fn(),
          release: vi.fn(),
          status: vi.fn().mockResolvedValue({ outcome: 'free' }),
        },
        resolveProjectWorkspace: () => '/tmp/project-alpha',
      }),
    );

    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'project-alpha',
        title: 'Provider-backed task',
        sourceProvider: 'github',
        workItemRef: 'github:kontourai/station#584',
      }),
    });
    const created = await readJson(createRes);
    expect(createRes.status).toBe(201);
    expect(created.data).toMatchObject({
      sourceProvider: 'github',
      workItemRef: 'github:kontourai/station#584',
    });

    // The round-tripped workItemRef is what makes the task eligible for
    // dispatch-as-claim: readClaimStatus reports 'free' (namespaced ref,
    // no active claim) rather than 'none' (no ref at all / stripped).
    const claimRes = await app.request(`/${created.data.id}/claim`);
    expect(await readJson(claimRes)).toEqual({
      success: true,
      data: { state: 'free', subjectId: 'github:kontourai/station#584' },
    });
  });

  // Roadmap archive#584, part of epic archive#580, S4.
  test('GET /:taskId/claim reports claim status, 400s for an unknown task', async () => {
    const service = createRouteService();
    const app = createTaskRoutes(service);

    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: 'project-alpha', title: 'Local' }),
    });
    const created = await readJson(createRes);
    const taskId = created.data.id;

    const claimRes = await app.request(`/${taskId}/claim`);
    expect(claimRes.status).toBe(200);
    expect(await readJson(claimRes)).toEqual({
      success: true,
      data: { state: 'none' },
    });

    const missingRes = await app.request('/missing/claim');
    expect(missingRes.status).toBe(400);
    expect(await readJson(missingRes)).toEqual({
      success: false,
      error: 'Task not found: missing',
    });
  });

  // archive#593: an independently-versioned client sending the pre-#581 status
  // vocabulary must be normalized at the HTTP boundary, not 400ed.
  describe('PATCH /:taskId/status normalizes legacy status aliases (#593)', () => {
    async function createTask(app: ReturnType<typeof createTaskRoutes>) {
      const createRes = await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'project-alpha', title: 'Task' }),
      });
      const created = await readJson(createRes);
      return created.data.id as string;
    }

    test('legacy "queued" is normalized to "ready"', async () => {
      const app = createTaskRoutes(createRouteService());
      const taskId = await createTask(app);

      const res = await app.request(`/${taskId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'queued' }),
      });
      const body = await readJson(res);

      expect(res.status).toBe(200);
      expect(body.data.status).toBe('ready');
    });

    test('legacy "running" is normalized to "in_progress"', async () => {
      const app = createTaskRoutes(createRouteService());
      const taskId = await createTask(app);

      const res = await app.request(`/${taskId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'running' }),
      });
      const body = await readJson(res);

      expect(res.status).toBe(200);
      expect(body.data.status).toBe('in_progress');
    });

    test('an unrecognized removed alias still 400s', async () => {
      const app = createTaskRoutes(createRouteService());
      const taskId = await createTask(app);

      const res = await app.request(`/${taskId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'in-flight' }),
      });

      expect(res.status).toBe(400);
    });

    // archive#593 finding 2: review/verification can now transition directly to
    // blocked (and resume directly back) without an in_progress detour.
    test('a task in review can transition directly to blocked and resume to review', async () => {
      const app = createTaskRoutes(createRouteService());
      const taskId = await createTask(app);

      for (const status of ['in_progress', 'review']) {
        const res = await app.request(`/${taskId}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status }),
        });
        expect(res.status).toBe(200);
      }

      const blockedRes = await app.request(`/${taskId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'blocked' }),
      });
      const blockedBody = await readJson(blockedRes);
      expect(blockedRes.status).toBe(200);
      expect(blockedBody.data.status).toBe('blocked');

      const resumedRes = await app.request(`/${taskId}/status`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'review' }),
      });
      const resumedBody = await readJson(resumedRes);
      expect(resumedRes.status).toBe(200);
      expect(resumedBody.data.status).toBe('review');
    });
  });

  test('creates, gets, graphs, and references a bound task', async () => {
    const app = createTaskRoutes(createRouteService());
    const createRes = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'project-alpha',
        title: 'Bound route task',
        workspaceBinding: {
          sourceSurface: 'ui',
        },
      }),
    });
    const created = await readJson(createRes);
    const taskId = created.data.id;

    const getRes = await app.request(`/${taskId}`);
    expect(getRes.status).toBe(200);
    expect((await readJson(getRes)).data.workspaceBinding).toMatchObject({
      availability: 'available',
      workingDirectory: expect.any(String),
    });

    const referenceRes = await app.request(`/${taskId}/references`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'receipt',
        targetId: 'receipt://build-1',
        sourceSurface: 'ui',
      }),
    });
    expect(referenceRes.status).toBe(201);
    expect((await readJson(referenceRes)).data).toMatchObject({
      targetType: 'receipt',
      relationType: 'references_receipt',
    });

    const graphRes = await app.request(`/${taskId}/graph`);
    expect(graphRes.status).toBe(200);
    expect((await readJson(graphRes)).data.links).toEqual([
      expect.objectContaining({ targetId: 'receipt://build-1' }),
    ]);
  });

  test('attaches only an authorized completed assistant answer and reopens unavailable sources without leaks', async () => {
    const service = createRouteService();
    const authority = sessionReadAuthorityFromRequest(
      'owner',
      undefined,
      undefined,
    );
    let available = true;
    const readAssistantTurn = vi.fn(async ({ sessionId, turnId }) => {
      if (!available || sessionId !== 'session-1' || turnId !== 'turn-1') {
        return { status: 'not-found' as const };
      }
      return {
        status: 'found' as const,
        sessionId,
        turnId,
        projectSlug: 'project-alpha',
        message: {
          id: 'answer-1',
          role: 'assistant' as const,
          parts: [{ type: 'text', text: 'Exact assistant answer' }],
          metadata: { turnId },
        },
      };
    });
    const app = createTaskRoutes(service, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: () => authority,
      readAssistantTurn,
      answerSupportModule: unassessedSupport as never,
    });
    const created = await readJson(
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'project-alpha', title: 'Basis' }),
      }),
    );
    const taskId = created.data.id as string;

    const attached = await app.request(`/${taskId}/references`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'turn',
        sessionId: 'session-1',
        turnId: 'turn-1',
        sourceSurface: 'chat',
      }),
    });
    expect(attached.status).toBe(201);
    expect(await readJson(attached)).toMatchObject({
      success: true,
      data: {
        targetType: 'turn',
        relationType: 'references_turn',
        targetId: 'turn/session-1/turn-1',
      },
    });
    expect(readAssistantTurn).toHaveBeenCalledWith({
      sessionId: 'session-1',
      turnId: 'turn-1',
      authority,
    });

    const opened = await app.request(`/${taskId}/turn-references`);
    expect(await readJson(opened)).toEqual({
      success: true,
      data: [
        expect.objectContaining({
          state: 'available',
          sessionId: 'session-1',
          turnId: 'turn-1',
          answer: expect.objectContaining({
            parts: [{ type: 'text', text: 'Exact assistant answer' }],
          }),
        }),
      ],
    });

    available = false;
    const unavailable = await app.request(`/${taskId}/turn-references`);
    expect(await readJson(unavailable)).toEqual({
      success: true,
      data: [expect.objectContaining({ state: 'unavailable' })],
    });
    const unavailableData = (
      await readJson(await app.request(`/${taskId}/turn-references`))
    ).data[0] as Record<string, unknown>;
    expect(unavailableData).not.toHaveProperty('sessionId');
    expect(unavailableData).not.toHaveProperty('turnId');
    expect(unavailableData).not.toHaveProperty('answer');
  });

  test('does not create a turn relation when the exact answer is missing or unauthorized', async () => {
    const service = createRouteService();
    const app = createTaskRoutes(service, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      readAssistantTurn: async () => ({ status: 'not-found' }),
    });
    const created = await readJson(
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'project-alpha', title: 'Basis' }),
      }),
    );

    const response = await app.request(`/${created.data.id}/references`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'turn',
        sessionId: 'other-session',
        turnId: 'turn-1',
      }),
    });
    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({
      success: false,
      error: 'Assistant answer not found',
    });
    expect(await service.readTaskTurnReferenceLinks(created.data.id)).toEqual(
      [],
    );
  });

  test.each([
    'principal',
    'session',
    'workspace',
    'narrative-revision',
  ] as const)(
    'hides a turn Keep when its %s commit witness changes inside the final Task lock',
    async (changed) => {
      let lockCount = 0;
      let principalCurrent = true;
      let sessionCurrent = true;
      let workspace = '';
      let narrativeCurrent = true;
      const service = createRouteService({
        acquireMutationLock: () => {
          lockCount += 1;
          // Task creation holds the first lock. Change the witness only when
          // the Keep reaches TaskGraph's freshly-reloaded commit boundary.
          if (lockCount === 2) {
            if (changed === 'principal') principalCurrent = false;
            if (changed === 'session') sessionCurrent = false;
            if (changed === 'workspace') workspace = '/workspace-rebound';
            if (changed === 'narrative-revision') narrativeCurrent = false;
          }
          return () => {};
        },
      });
      const task = await service.createTask({
        projectId: 'project-alpha',
        title: 'Commit witness',
      });
      workspace = task.workspaceBinding!.workingDirectory!;
      const answerNarrativeBindingModule = {
        withTaskReferencePin: async (input: {
          commit(witness: {
            associationRevision?: number;
            isCurrent(): boolean;
          }): Promise<unknown>;
        }) =>
          input.commit({
            associationRevision: 1,
            isCurrent: () => narrativeCurrent,
          }),
      };
      const app = createTaskRoutes(service, {
        taskDispatcher: inertTaskDispatcher,
        isRequestPrincipalCurrent: () => principalCurrent,
        canReadSession: () => sessionCurrent,
        resolveProjectWorkspace: () => workspace,
        readAuthorityForRequest: () =>
          sessionReadAuthorityFromRequest('owner', undefined, undefined),
        readAssistantTurn: async ({ sessionId, turnId }) => ({
          status: 'found' as const,
          sessionId,
          turnId,
          projectSlug: 'project-alpha',
          message: {
            id: 'answer-1',
            role: 'assistant' as const,
            parts: [{ type: 'text' as const, text: 'Exact answer' }],
            metadata: { turnId },
          },
        }),
        answerNarrativeBindingModule: answerNarrativeBindingModule as never,
      });

      const response = await app.request(`/${task.id}/references`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'turn',
          sessionId: 'session-1',
          turnId: 'turn-1',
        }),
      });

      expect(lockCount).toBe(2);
      expect(response.status).toBe(404);
      expect(await readJson(response)).toEqual({
        success: false,
        error: 'Assistant answer not found',
      });
      expect(await service.readTaskTurnReferenceLinks(task.id)).toEqual([]);
      expect(
        service.readTaskAnswerNarrativePin(task.id, 'turn/session-1/turn-1'),
      ).toBeUndefined();
    },
  );

  test('pins and reopens exact user-input event tuples without exposing them through the generic graph', async () => {
    const service = createRouteService();
    const authority = sessionReadAuthorityFromRequest(
      'owner',
      undefined,
      undefined,
    );
    const readUserInput = vi.fn(async ({ sessionId, eventId }) => ({
      status: 'found' as const,
      sessionId,
      eventId,
      turnId: 'turn-shared-by-steers',
      projectSlug: 'project-alpha',
      input: {
        prompt: eventId === 'steer-2' ? 'Second steer' : 'Initial prompt',
        attachments: [
          { name: 'brief.pdf', mediaType: 'application/pdf', size: 42 },
        ],
      },
    }));
    const app = createTaskRoutes(service, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: () => authority,
      readUserInput,
    });
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Pinned input',
    });
    for (const eventId of ['steer-1', 'steer-2']) {
      const response = await app.request(`/${task.id}/references`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'user-input',
          sessionId: 'historical-session',
          eventId,
        }),
      });
      expect(response.status).toBe(201);
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    }
    expect(readUserInput).toHaveBeenCalledTimes(2);
    const listed = await readJson(
      await app.request(`/${task.id}/user-input-references`),
    );
    expect(listed).toEqual({
      success: true,
      data: expect.arrayContaining([
        expect.objectContaining({
          eventId: 'steer-1',
          turnId: 'turn-shared-by-steers',
        }),
        expect.objectContaining({
          eventId: 'steer-2',
          turnId: 'turn-shared-by-steers',
        }),
      ]),
    });
    const graph = await readJson(await app.request(`/${task.id}/graph`));
    expect(graph.data.links).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relationType: 'references_user_input' }),
      ]),
    );
  });

  test('user-input route collapses protected misses, rejects before source lookup, and distinguishes only resolver outage', async () => {
    const service = createRouteService();
    const source = vi.fn(async ({ eventId }) => {
      if (eventId === 'outage') return { status: 'unavailable' as const };
      if (eventId === 'unscoped')
        return {
          status: 'found' as const,
          sessionId: 'session',
          eventId,
          turnId: 'turn',
          input: { prompt: 'explicit', attachments: [] },
        };
      if (eventId === 'mismatch')
        return {
          status: 'found' as const,
          sessionId: 'session',
          eventId,
          turnId: 'turn',
          projectSlug: 'other-project',
          input: {
            prompt: 'secret',
            attachments: [
              { name: '/private/path', mediaType: 'text/plain', size: 1 },
            ],
          },
        };
      return { status: 'not-found' as const };
    });
    const app = createTaskRoutes(service, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      readUserInput: source,
    });
    const body = { kind: 'user-input', sessionId: 'session' };
    const missing = await app.request('/missing/references', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, eventId: 'missing' }),
    });
    expect(missing.status).toBe(404);
    expect(source).not.toHaveBeenCalled();
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Matrix',
    });
    for (const eventId of ['missing', 'mismatch']) {
      const response = await app.request(`/${task.id}/references`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, eventId }),
      });
      expect(response.status).toBe(404);
      expect(await readJson(response)).toEqual({
        success: false,
        error: 'User input not found',
      });
    }
    const outage = await app.request(`/${task.id}/references`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, eventId: 'outage' }),
    });
    expect(outage.status).toBe(503);
    const unscoped = await app.request(`/${task.id}/references`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, eventId: 'unscoped' }),
    });
    expect(unscoped.status).toBe(201);
  });

  test('user-input reopen dedupes duplicate stored tuples', async () => {
    const service = createRouteService();
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Protected',
    });
    await service.createTaskReference(task.id, {
      kind: 'user-input',
      sessionId: 'session',
      eventId: 'event',
    });
    await service.createLink({
      sourceType: 'task',
      sourceId: task.id,
      targetType: 'user_input',
      targetId: 'user-input/session/event',
      relationType: 'references_user_input',
      source: 'system',
    });
    const source = vi.fn(async () => ({
      status: 'found' as const,
      sessionId: 'session',
      eventId: 'event',
      turnId: 'turn',
      projectSlug: 'project-alpha',
      input: { prompt: 'safe', attachments: [] },
    }));
    const app = createTaskRoutes(service, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      readUserInput: source,
    });
    const response = await readJson(
      await app.request(`/${task.id}/user-input-references`),
    );
    expect(source).toHaveBeenCalledOnce();
    expect(response.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ state: 'available' })]),
    );
  });

  test('user-input GET collapses missing, denied, project mismatch, and malformed stored tuples', async () => {
    const home = mkdtempSync(join(tmpdir(), 'station-input-malformed-'));
    const workspace = mkdtempSync(join(tmpdir(), 'station-input-workspace-'));
    const service = new TaskGraphService(home, {
      projectService: {
        getProject: () => ({
          id: 'project-alpha',
          slug: 'project-alpha',
          name: 'P',
          workingDirectory: workspace,
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        }),
      },
    });
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Malformed',
    });
    await service.createTaskReference(task.id, {
      kind: 'user-input',
      sessionId: 'session',
      eventId: 'event',
    });
    const persisted = JSON.parse(
      readFileSync(join(home, 'task-graph.json'), 'utf8'),
    );
    persisted.links[0].targetId = 'user-input/%/bad';
    writeFileSync(join(home, 'task-graph.json'), JSON.stringify(persisted));
    const source = vi.fn(async () => ({ status: 'not-found' as const }));
    const app = createTaskRoutes(service, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      readUserInput: source,
    });
    const malformed = await readJson(
      await app.request(`/${task.id}/user-input-references`),
    );
    expect(malformed).toEqual({
      success: true,
      data: [{ state: 'unavailable' }],
    });
    expect(source).not.toHaveBeenCalled();
    const unavailable = createTaskRoutes(service, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      readUserInput: async () => ({ status: 'unavailable' }),
    });
    // Restore a valid tuple so the resolver-outage path is independently real.
    persisted.links[0].targetId = 'user-input/session/event';
    writeFileSync(join(home, 'task-graph.json'), JSON.stringify(persisted));
    expect(
      (await unavailable.request(`/${task.id}/user-input-references`)).status,
    ).toBe(503);
  });

  test('user-input GET reauthorizes valid tuples and collapses source miss, denial, and project mismatch', async () => {
    const service = createRouteService();
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Get matrix',
    });
    await service.createTaskReference(task.id, {
      kind: 'user-input',
      sessionId: 'session',
      eventId: 'event',
    });
    let mode: 'missing' | 'denied' | 'mismatch' = 'missing';
    const source = vi.fn(async ({ eventId }) => {
      if (mode === 'mismatch')
        return {
          status: 'found' as const,
          sessionId: 'session',
          eventId,
          turnId: 'turn',
          projectSlug: 'other',
          input: { prompt: 'secret', attachments: [] },
        };
      return { status: 'not-found' as const };
    });
    const app = createTaskRoutes(service, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      readUserInput: source,
    });
    for (const next of ['missing', 'denied', 'mismatch'] as const) {
      mode = next;
      const response = await readJson(
        await app.request(`/${task.id}/user-input-references`),
      );
      expect(response).toEqual({
        success: true,
        data: [{ state: 'unavailable' }],
      });
    }
    expect(source).toHaveBeenCalledTimes(3);
  });

  test('personal user-input attachment fails retryably when resolver composition is absent', async () => {
    const service = createRouteService();
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Missing resolver',
    });
    const app = createTaskRoutes(service, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
    });
    const response = await app.request(`/${task.id}/references`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'user-input',
        sessionId: 'session',
        eventId: 'event',
      }),
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  test('maps an authorized resolver outage to retryable 503 without persisting a turn reference', async () => {
    const service = createRouteService();
    const app = createTaskRoutes(service, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      readAssistantTurn: async () => ({ status: 'unavailable' }),
    });
    const created = await readJson(
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'project-alpha', title: 'Basis' }),
      }),
    );

    const response = await app.request(`/${created.data.id}/references`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'turn',
        sessionId: 'session-1',
        turnId: 'turn-1',
      }),
    });
    expect(response.status).toBe(503);
    expect(await service.readTaskTurnReferenceLinks(created.data.id)).toEqual(
      [],
    );
  });

  test('requires the Task project to match the source Session and hides protected tuples from graph reads', async () => {
    const service = createRouteService();
    const readAssistantTurn = vi.fn(async ({ sessionId, turnId }) => ({
      status: 'found' as const,
      sessionId,
      turnId,
      projectSlug: 'project-bravo',
      message: {
        id: 'answer',
        role: 'assistant' as const,
        parts: [{ type: 'text' as const, text: 'not attachable' }],
        metadata: { turnId },
      },
    }));
    const app = createTaskRoutes(service, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      readAssistantTurn,
      answerSupportModule: unassessedSupport as never,
    });
    const created = await readJson(
      await app.request('/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'project-alpha', title: 'Basis' }),
      }),
    );
    const rejected = await app.request(`/${created.data.id}/references`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'turn',
        sessionId: 'session-1',
        turnId: 'turn-1',
      }),
    });
    expect(rejected.status).toBe(404);
    expect(await service.readTaskTurnReferenceLinks(created.data.id)).toEqual(
      [],
    );

    await service.createTaskReference(created.data.id, {
      kind: 'turn',
      sessionId: 'session-1',
      turnId: 'turn-1',
    });
    const graph = await readJson(
      await app.request(`/${created.data.id}/graph`),
    );
    expect(graph.data.links).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relationType: 'references_turn' }),
      ]),
    );
    const opened = await readJson(
      await app.request(`/${created.data.id}/turn-references`),
    );
    expect(opened).toEqual({
      success: true,
      data: [expect.objectContaining({ state: 'unavailable' })],
    });
  });

  test('allows an authorized unscoped Session answer to be explicitly pinned to a Task', async () => {
    const service = createRouteService();
    const readAssistantTurn = vi.fn(async ({ sessionId, turnId }) => ({
      status: 'found' as const,
      sessionId,
      turnId,
      message: {
        id: 'answer',
        role: 'assistant' as const,
        parts: [{ type: 'text' as const, text: 'unscoped answer' }],
        metadata: { turnId },
      },
    }));
    const app = createTaskRoutes(service, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      readAssistantTurn,
      answerSupportModule: unassessedSupport as never,
    });
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'Basis',
    });

    const attached = await app.request(`/${task.id}/references`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        kind: 'turn',
        sessionId: 'global-session',
        turnId: 'turn-1',
      }),
    });
    expect(attached.status).toBe(201);
    const reopened = await readJson(
      await app.request(`/${task.id}/turn-references`),
    );
    expect(reopened).toMatchObject({
      success: true,
      data: [
        {
          state: 'available',
          sessionId: 'global-session',
          turnId: 'turn-1',
        },
      ],
    });
  });

  test('caches duplicate protected tuple resolution within one basis read and retries resolver outages', async () => {
    const service = createRouteService();
    const created = await service.createTask({
      projectId: 'project-alpha',
      title: 'Basis',
    });
    await service.createTaskReference(created.id, {
      kind: 'turn',
      sessionId: 'session-1',
      turnId: 'turn-1',
    });
    // Seed a duplicate legacy link through the generic graph writer: the
    // read path must not turn this corruption into duplicate replays.
    await service.createLink({
      sourceType: 'task',
      sourceId: created.id,
      targetType: 'turn',
      targetId: 'turn/session-1/turn-1',
      relationType: 'references_turn',
      source: 'system',
    });
    const readAssistantTurn = vi.fn(async () => ({
      status: 'unavailable' as const,
    }));
    const app = createTaskRoutes(service, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      readAssistantTurn,
      answerSupportModule: unassessedSupport as never,
    });
    const response = await app.request(`/${created.id}/turn-references`);
    expect(response.status).toBe(503);
    expect(readAssistantTurn).toHaveBeenCalledOnce();
  });

  test('does not collide distinct NUL-containing Session/turn tuples while resolving a Task basis', async () => {
    const service = createRouteService();
    const task = await service.createTask({
      projectId: 'project-alpha',
      title: 'NUL tuples',
    });
    const first = { sessionId: 'a\u0000b', turnId: 'c' };
    const second = { sessionId: 'a', turnId: 'b\u0000c' };
    await service.createTaskReference(task.id, { kind: 'turn', ...first });
    await service.createTaskReference(task.id, { kind: 'turn', ...second });
    const readAssistantTurn = vi.fn(async ({ sessionId, turnId }) => ({
      status: 'found' as const,
      sessionId,
      turnId,
      projectSlug: 'project-alpha',
      message: {
        id: `${sessionId}/${turnId}`,
        role: 'assistant' as const,
        parts: [{ type: 'text' as const, text: `${sessionId}/${turnId}` }],
        metadata: { turnId },
      },
    }));
    const app = createTaskRoutes(service, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
      readAssistantTurn,
      answerSupportModule: unassessedSupport as never,
    });
    const response = await readJson(
      await app.request(`/${task.id}/turn-references`),
    );
    expect(response.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining(first),
        expect.objectContaining(second),
      ]),
    );
    expect(readAssistantTurn).toHaveBeenCalledTimes(2);
  });

  test('returns 400 for invalid references and 404 for unknown tasks', async () => {
    const app = createTaskRoutes(createRouteService());
    const invalid = await app.request('/missing/references', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'artifact', targetId: '' }),
    });
    expect(invalid.status).toBe(400);

    const missing = await app.request('/missing/references', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'artifact', targetId: '/tmp/plan.md' }),
    });
    expect(missing.status).toBe(404);
    expect(await readJson(missing)).toEqual({
      success: false,
      error: 'Task not found: missing',
    });

    expect((await app.request('/missing')).status).toBe(404);
    expect((await app.request('/missing/graph')).status).toBe(404);
  });

  test('does not enumerate bravo session relations to alpha', async () => {
    const authority = sessionReadAuthorityFromRequest(
      'alpha',
      undefined,
      undefined,
    );
    const readSessionRelations = vi.fn();
    const app = createTaskRoutes({ readSessionRelations } as never, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: () => authority,
      canReadSession: (sessionId) => sessionId === 'alpha-session',
    });

    const response = await app.request('/sessions/bravo-session/relations');
    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({
      success: false,
      error: 'Session not found',
    });
    expect(readSessionRelations).not.toHaveBeenCalled();
  });

  test('hosted task routes suppress every unbound store read and mutation', async () => {
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [
        { id: 'alpha', authority: 'alpha.station.test' },
        { id: 'bravo', authority: 'bravo.station.test' },
      ],
    });
    const service = {
      listTasks: vi.fn(),
      createTask: vi.fn(),
      readSessionRelations: vi.fn(),
      createTaskReference: vi.fn(),
      readTaskTurnReferenceLinks: vi.fn(),
      readTaskGraph: vi.fn(),
      readClaimStatus: vi.fn(),
      readTaskForOpen: vi.fn(),
      updateTaskStatus: vi.fn(),
      dispatchTask: vi.fn(),
    };
    const personalSupportFactory = vi.fn(() => {
      throw new Error('hosted support route touched personal composition');
    });
    const app = createTaskRoutes(service as never, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: (request) => {
        const tenant = request.headers.get('x-test-tenant');
        return sessionReadAuthorityFromRequest(
          'shared-user',
          tenant === 'alpha' || tenant === 'bravo'
            ? { tenantId: tenantId(tenant) }
            : undefined,
          registry,
        );
      },
      canReadSession: vi.fn(),
      answerSupportModuleForRequest: personalSupportFactory,
    });
    const request = (path: string, init: RequestInit = {}, tenant = 'alpha') =>
      app.request(path, {
        ...init,
        headers: {
          'content-type': 'application/json',
          ...(tenant ? { 'x-test-tenant': tenant } : {}),
          ...(init.headers ?? {}),
        },
      });

    const alphaList = await request('/');
    const bravoList = await request('/', {}, 'bravo');
    const missingList = await request('/', {}, '');
    expect(await readJson(alphaList)).toEqual({ success: true, data: [] });
    expect(await readJson(bravoList)).toEqual({ success: true, data: [] });
    expect(await readJson(missingList)).toEqual({ success: true, data: [] });

    const unavailable = await Promise.all([
      request('/task-1'),
      request('/task-1/graph'),
      request('/task-1/turn-references'),
      request('/task-1/turn-references/reference-1/support/bundles'),
      request(
        '/task-1/turn-references/reference-1/support/bundles/bundle-1/claims',
      ),
      request('/task-1/claim'),
      request('/sessions/session-1/relations'),
      request('/', {
        method: 'POST',
        body: JSON.stringify({ projectId: 'project-alpha', title: 'Probe' }),
      }),
      request('/task-1/references', {
        method: 'POST',
        body: JSON.stringify({ kind: 'receipt', targetId: 'receipt://1' }),
      }),
      request('/task-1/status', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'ready' }),
      }),
      request('/task-1/dispatch', { method: 'POST', body: JSON.stringify({}) }),
      request('/task-1/turn-references/reference-1/support', {
        method: 'POST',
        body: JSON.stringify({ bundleId: 'bundle-1', claimId: 'claim-1' }),
      }),
      request('/task-1/turn-references/reference-1/support', {
        method: 'PUT',
        body: JSON.stringify({
          bundleId: 'bundle-1',
          claimId: 'claim-1',
          expectedRevision: 1,
        }),
      }),
      request('/task-1/turn-references/reference-1/support', {
        method: 'DELETE',
        body: JSON.stringify({ expectedRevision: 1 }),
      }),
    ]);
    for (const response of unavailable) expect(response.status).toBe(404);
    expect(
      Object.values(service).every((call) => call.mock.calls.length === 0),
    ).toBe(true);
    expect(personalSupportFactory).not.toHaveBeenCalled();
  });

  test('answer-support routes are personal-only, no-store, and map unavailable without leaking choices', async () => {
    const authority = sessionReadAuthorityFromRequest(
      'owner',
      undefined,
      undefined,
    );
    const support = {
      bundles: vi.fn(async () => [{ id: 'sb1.bundle' }]),
      claims: vi.fn(async () => [{ id: 'claim-a' }]),
      create: vi.fn(async () => ({
        schemaVersion: 1 as const,
        kind: 'answer-support' as const,
        id: '11111111-1111-4111-8111-111111111111',
        taskId: 'task-1',
        answerReferenceId: 'ref-1',
        revision: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      })),
      replace: vi.fn(async () => ({
        schemaVersion: 1 as const,
        kind: 'answer-support' as const,
        id: '11111111-1111-4111-8111-111111111111',
        taskId: 'task-1',
        answerReferenceId: 'ref-1',
        revision: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:01.000Z',
      })),
      remove: vi.fn(async () => undefined),
    };
    const app = createTaskRoutes({} as never, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: () => authority,
      answerSupportModule: support as never,
    });
    const get = await app.request(
      '/task-1/turn-references/ref-1/support/bundles',
    );
    expect(get.status).toBe(200);
    expect(get.headers.get('cache-control')).toBe('private, no-store');
    expect(await readJson(get)).toEqual({
      success: true,
      data: [{ id: 'sb1.bundle' }],
    });
    const created = await app.request('/task-1/turn-references/ref-1/support', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bundleId: 'sb1.bundle', claimId: 'claim-a' }),
    });
    expect(created.status).toBe(201);
    const replaced = await app.request(
      '/task-1/turn-references/ref-1/support',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bundleId: 'sb1.bundle',
          claimId: 'claim-a',
          expectedRevision: 1,
        }),
      },
    );
    expect(replaced.status).toBe(200);
    const removed = await app.request('/task-1/turn-references/ref-1/support', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 2 }),
    });
    expect(removed.status).toBe(200);

    support.bundles.mockResolvedValueOnce('unavailable' as never);
    const unavailable = await app.request(
      '/task-1/turn-references/ref-1/support/bundles',
    );
    expect(unavailable.status).toBe(503);
    expect(await readJson(unavailable)).toEqual({
      success: false,
      error: 'Answer support temporarily unavailable',
    });

    support.claims.mockRejectedValueOnce(
      new TaskAnswerSupportUnavailableError(
        'project-a bundle-a claim-a /private/report.json count=7',
      ),
    );
    const hidden = await app.request(
      '/task-1/turn-references/ref-1/support/bundles/bundle-a/claims',
    );
    expect(hidden.status).toBe(503);
    expect(hidden.headers.get('cache-control')).toBe('private, no-store');
    const hiddenText = await hidden.text();
    for (const identity of [
      'project-a',
      'bundle-a',
      'claim-a',
      '/private/report.json',
      'count=7',
    ])
      expect(hiddenText).not.toContain(identity);
  });

  test('personal support composition is lazy, cached, and receives only exact route anchors', async () => {
    const authority = sessionReadAuthorityFromRequest(
      'owner',
      undefined,
      undefined,
    );
    const support = {
      bundles: vi.fn(async () => []),
      claims: vi.fn(async () => []),
    };
    const factory = vi.fn(() => support as never);
    const app = createTaskRoutes({} as never, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: () => authority,
      answerSupportModuleForRequest: factory,
    });
    expect(factory).not.toHaveBeenCalled();
    expect(
      (await app.request('/task-a/turn-references/reference-a/support/bundles'))
        .status,
    ).toBe(200);
    expect(
      (
        await app.request(
          '/task-a/turn-references/reference-a/support/bundles/bundle-a/claims',
        )
      ).status,
    ).toBe(200);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(support.bundles).toHaveBeenCalledWith(
      'task-a',
      'reference-a',
      authority,
    );
    expect(support.claims).toHaveBeenCalledWith(
      'task-a',
      'reference-a',
      'bundle-a',
      authority,
    );
  });

  test('personal turn-reference reads fail closed when answer-support composition is absent', async () => {
    const service = { readTaskTurnReferenceScope: vi.fn() };
    const app = createTaskRoutes(service as never, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest('owner', undefined, undefined),
    });
    const response = await app.request('/task-a/turn-references');
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await readJson(response)).toEqual({
      success: false,
      error: 'Answer support temporarily unavailable',
    });
    expect(service.readTaskTurnReferenceScope).not.toHaveBeenCalled();
  });

  test('hosted requests use an explicitly tenant-bound Task service when composition supplies one', async () => {
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [{ id: 'alpha', authority: 'alpha.station.test' }],
    });
    const globalService = {
      listTasks: vi.fn(),
      createTask: vi.fn(),
    };
    const tenantService = createRouteService();
    const app = createTaskRoutes(globalService as never, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest(
          'hosted-user',
          { tenantId: tenantId('alpha') },
          registry,
        ),
      taskGraphServiceForRequest: () => tenantService,
    });

    const created = await app.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: 'project-alpha',
        title: 'Hosted task',
      }),
    });
    expect(created.status).toBe(201);
    expect(globalService.createTask).not.toHaveBeenCalled();
    expect((await readJson(await app.request('/'))).data).toEqual([
      expect.objectContaining({ title: 'Hosted task' }),
    ]);
    expect(globalService.listTasks).not.toHaveBeenCalled();
  });

  test('hosted user-input reads and writes never touch global Task or source composition', async () => {
    const registry = parseHostedTenantRegistry({
      schemaVersion: 1,
      tenants: [{ id: 'alpha', authority: 'alpha.station.test' }],
    });
    const globalService = {
      readTaskUserInputReferenceScope: vi.fn(),
      createTaskReference: vi.fn(),
      readTaskUserInputReferenceLinks: vi.fn(),
    };
    const readUserInput = vi.fn();
    const app = createTaskRoutes(globalService as never, {
      taskDispatcher: inertTaskDispatcher,
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest(
          'hosted-user',
          { tenantId: tenantId('alpha') },
          registry,
        ),
      readUserInput,
    });
    expect((await app.request('/task-a/user-input-references')).status).toBe(
      404,
    );
    expect(
      (
        await app.request('/task-a/references', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            kind: 'user-input',
            sessionId: 'session',
            eventId: 'event',
          }),
        })
      ).status,
    ).toBe(404);
    expect(
      globalService.readTaskUserInputReferenceScope,
    ).not.toHaveBeenCalled();
    expect(readUserInput).not.toHaveBeenCalled();
  });
});
