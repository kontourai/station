import {
  type GateEvaluationReadResult,
  type GateEvaluationRef,
  parseGateEvaluationRef,
} from '@kontourai/flow/gate-evaluation-contract';
import {
  encodeTaskGateEvaluationReference,
  encodeTaskToolResultReference,
  encodeTaskTurnReference,
  encodeTaskUserInputReference,
  isCanonicalTaskReferenceId,
  MAX_TASK_REFERENCE_ID_LENGTH,
  MAX_TASK_REFERENCE_TARGET_LENGTH,
  parseTaskToolResultReference,
  parseTaskTurnReference,
  parseTaskUserInputReference,
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskGraph,
  type TaskRecord,
  type TaskStatus,
  type TaskWorkspaceBinding,
} from '@kontourai/station-contracts';
import {
  SESSION_INVENTORY_GROUP_IDS,
  type SessionInventoryRow,
} from '@kontourai/station-contracts/session-inventory';
import {
  parseStationBasisProjection,
  parseStationTaskBasisCollection,
  type StationBasisProjection,
  type StationTaskBasisCollection,
} from '@kontourai/station-contracts/task-basis';
import {
  isHostedSessionReadAuthority,
  type SessionReadAuthority,
} from '@kontourai/station-contracts/tenancy';
import { type Context, Hono } from 'hono';
import { z } from 'zod/v3';
import { resolveClientOriginForRequest } from '../../security/runtime-request-security.js';
import {
  AnswerNarrativeBindingModule,
  AnswerNarrativeNotFoundError,
  AnswerNarrativeUnavailableError,
} from '../../services/evidence/answer-narrative-binding-module.js';
import {
  TaskAnswerSupportConflictError,
  TaskAnswerSupportModule,
  TaskAnswerSupportUnavailableError,
} from '../../services/evidence/task-answer-support-module.js';
import type { SessionInventoryModule } from '../../services/orchestration/session-inventory-module.js';
import type {
  SessionAssistantTurnQueryOutcome,
  SessionToolResultQueryOutcome,
  SessionUserInputQueryOutcome,
} from '../../services/orchestration/session-query-module.js';
import type { TaskBasisAppReadModule } from '../../services/projects/task-basis-app-read-module.js';
import type { TaskDispatcher } from '../../services/projects/task-dispatcher.js';
import {
  type TaskGraphService,
  TaskReferenceAuthorizationError,
  type TaskReferenceCommitAuthorization,
  TaskReferenceRejectedError,
} from '../../services/projects/task-graph-service.js';
import {
  createTaskGateEvaluationReferenceReadAdapter,
  createTaskToolResultReferenceReadAdapter,
  type TaskGateEvaluationReferenceRead,
  type TaskToolResultReferenceRead,
} from '../../services/projects/task-tool-result-reference-read-adapter.js';
import { taskTurnReferenceResolutionTotal } from '../../telemetry/metrics.js';
import { errorMessage, getBody, param, validate } from '../schemas/schemas.js';

const taskCreateSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  skillName: z.string().optional(),
  agentId: z.string().optional(),
  createdBy: z.string().optional(),
  workspaceBinding: z
    .object({
      workingDirectory: z.string().optional(),
      repoRoot: z.string().optional(),
      worktreePath: z.string().optional(),
      branch: z.string().optional(),
      sourceSurface: z.string().optional(),
      capturedAt: z.string().optional(),
    })
    .optional(),
  // Roadmap archive#584, part of epic archive#580, S4, review finding #6: without these
  // two fields the public create route silently stripped a caller's
  // provider-backed identity, creating a local-only task that could never
  // enter dispatch-as-claim (TaskGraphService.createTask/TaskRecord already
  // carry both — the schema was the only place they were missing).
  sourceProvider: z.string().optional(),
  workItemRef: z.string().optional(),
});

// archive#593: an independently-versioned client may still send the pre-#581
// status vocabulary. Normalize known removed aliases at the HTTP boundary,
// before enum validation, so those clients get a clean 200 (mapped to the
// closest neutral status) instead of a 400. The coordinated Station app
// itself no longer writes these values.
const REMOVED_TASK_STATUS_VALUES: Record<string, TaskStatus> = {
  queued: 'ready',
  running: 'in_progress',
};

/** The Task owns this exact-provenance kept rowset; Session only pages it. */
function keptRowsForTaskSession(
  service: TaskGraphService,
  taskId: string,
  sessionId: string,
): Extract<SessionInventoryRow, { kind: `task-kept-${string}` }>[] {
  return [
    ...(service.readTaskTurnReferenceLinks(taskId) ?? []).flatMap((link) => {
      const reference = parseTaskTurnReference(link.targetId);
      return reference?.sessionId === sessionId
        ? [
            {
              kind: 'task-kept-answer' as const,
              key: `kept:${link.id}`,
              owner: { owner: 'station.task-graph', id: 'v1' },
              relations: ['kept-in-task'] as const,
              taskId,
              provenanceSessionId: sessionId,
              referenceId: link.targetId,
            },
          ]
        : [];
    }),
    ...(service.readTaskUserInputReferenceLinks(taskId) ?? []).flatMap(
      (link) => {
        const reference = parseTaskUserInputReference(link.targetId);
        return reference?.sessionId === sessionId
          ? [
              {
                kind: 'task-kept-input' as const,
                key: `kept:${link.id}`,
                owner: { owner: 'station.task-graph', id: 'v1' },
                relations: ['kept-in-task'] as const,
                taskId,
                provenanceSessionId: sessionId,
                referenceId: link.targetId,
              },
            ]
          : [];
      },
    ),
    ...(service.readTaskToolResultReferenceLinks(taskId) ?? []).flatMap(
      (link) => {
        const reference = parseTaskToolResultReference(link.targetId);
        return reference?.sessionId === sessionId
          ? [
              {
                kind: 'task-kept-result' as const,
                key: `kept:${link.id}`,
                owner: { owner: 'station.task-graph', id: 'v1' },
                relations: ['kept-in-task'] as const,
                taskId,
                provenanceSessionId: sessionId,
                referenceId: link.targetId,
              },
            ]
          : [];
      },
    ),
    ...service
      .listKeptDeclaredPullRequestsForSession(taskId, sessionId)
      .map((reference) => ({
        kind: 'task-kept-pull-request' as const,
        key: `kept:pr:${reference.provenance.eventId}`,
        owner: { owner: 'station.task-graph', id: 'v1' },
        relations: ['kept-in-task'] as const,
        taskId,
        provenanceSessionId: sessionId,
        referenceId: reference.provenance.eventId,
      })),
  ];
}

function sameTaskWorkspaceBinding(
  left: TaskWorkspaceBinding | undefined,
  right: TaskWorkspaceBinding | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left?.availability === right?.availability &&
    // Raw on BOTH sides on purpose (archive#4292). This is a witness check —
    // "is this the same stored binding I authorized against?" — not a path
    // read, and both sides come from `TaskRecord.workspaceBinding`, so they
    // share provenance and expansion state. Expanding would WEAKEN it: a
    // binding rewritten `~/x` -> `/home/me/x` would then compare equal and
    // slip through as unchanged, which is exactly what this must catch.
    left?.workingDirectory === right?.workingDirectory &&
    left?.repoRoot === right?.repoRoot &&
    left?.worktreePath === right?.worktreePath &&
    left?.branch === right?.branch &&
    left?.sourceSurface === right?.sourceSurface &&
    left?.capturedAt === right?.capturedAt
  );
}

const taskStatusSchema = z.object({
  status: z.preprocess((value) => {
    if (typeof value === 'string' && value in REMOVED_TASK_STATUS_VALUES) {
      return REMOVED_TASK_STATUS_VALUES[value];
    }
    return value;
  }, z.enum(TASK_STATUSES)),
});

const taskDispatchSchema = z.object({
  agentId: z.string().optional(),
  skillName: z.string().optional(),
  provider: z.string().min(1).optional(),
  runtimeConfig: z
    .object({
      provider: z.string().min(1).optional(),
      modelId: z.string().optional(),
      modelOptions: z.record(z.unknown()).optional(),
      cwd: z.string().optional(),
    })
    .optional(),
  relatedFiles: z.array(z.string()).optional(),
  sourceSurface: z.string().optional(),
});

const taskReferenceIdSchema = z
  .string()
  .min(1)
  .max(MAX_TASK_REFERENCE_ID_LENGTH)
  .refine(
    isCanonicalTaskReferenceId,
    'must be a bounded well-formed opaque id',
  );

const taskReferenceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('gate-evaluation'),
      ref: z
        .object({
          runId: taskReferenceIdSchema,
          gateId: taskReferenceIdSchema,
          evaluationId: taskReferenceIdSchema,
        })
        .strict(),
      sourceSurface: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('turn'),
      sessionId: z.string().min(1),
      turnId: z.string().min(1),
      sourceSurface: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('user-input'),
      sessionId: taskReferenceIdSchema,
      eventId: taskReferenceIdSchema,
      sourceSurface: z.string().min(1).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('tool-result'),
      sessionId: taskReferenceIdSchema,
      eventId: taskReferenceIdSchema,
      sourceSurface: z.string().min(1).optional(),
    })
    .strict(),
  z.object({
    kind: z.literal('artifact'),
    targetId: z.string().min(1),
    metadata: z.record(z.unknown()).optional(),
    sourceSurface: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('receipt'),
    targetId: z.string().min(1),
    metadata: z.record(z.unknown()).optional(),
    sourceSurface: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal('external'),
    targetId: z.string().min(1),
    metadata: z.record(z.unknown()).optional(),
    sourceSurface: z.string().min(1).optional(),
  }),
]);

const answerSupportMutationSchema = z
  .object({
    bundleId: z.string().min(1).max(512),
    claimId: z.string().min(1).max(512),
  })
  .strict();
const answerSupportReplaceSchema = answerSupportMutationSchema.extend({
  expectedRevision: z.number().int().positive(),
});
const answerSupportRemoveSchema = z
  .object({ expectedRevision: z.number().int().positive() })
  .strict();
const taskBasisAppOpenSchema = z.object({}).strict();
const taskBasisAppContinueSchema = z
  .object({
    continuationToken: z.string().regex(/^[A-Za-z0-9_-]{24,128}$/),
    occurrenceId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{24,128}$/)
      .optional(),
  })
  .strict();
const taskBasisAppRevokeSchema = z
  .object({ occurrenceId: z.string().regex(/^[A-Za-z0-9_-]{24,128}$/) })
  .strict();

export function createTaskRoutes(
  taskGraphService: TaskGraphService,
  options: {
    taskDispatcher: TaskDispatcher;
    /**
     * Central orchestration predicate. Keeping it as a per-request call is
     * essential: a route singleton must never retain one tenant's authority.
     */
    canReadSession?: (
      sessionId: string,
      authority: SessionReadAuthority,
    ) => boolean;
    /** Authorized session projection; Task route owns the Task/Project witness. */
    sessionInventory?: SessionInventoryModule;
    readAuthorityForRequest?: (request: Request) => SessionReadAuthority;
    /**
     * The orchestration-owned exact answer resolver. It is injected at the
     * runtime seam so Task storage never receives a transcript store or an
     * authorization dependency.
     */
    readAssistantTurn?: (input: {
      sessionId: string;
      turnId: string;
      authority: SessionReadAuthority;
    }) => Promise<SessionAssistantTurnQueryOutcome>;
    /** Orchestration-owned exact authored-input resolver. */
    readUserInput?: (input: {
      sessionId: string;
      eventId: string;
      authority: SessionReadAuthority;
    }) => Promise<SessionUserInputQueryOutcome>;
    /** Orchestration-owned exact terminal tool-result resolver. */
    readToolResult?: (input: {
      sessionId: string;
      eventId: string;
      authority: SessionReadAuthority;
    }) => Promise<SessionToolResultQueryOutcome>;
    /** Owner-backed Flow receipt reader; Task routes never read Flow files. */
    readFlowGateEvaluation?: (input: {
      taskId: string;
      projectId: string;
      ref: GateEvaluationRef;
      request: Request;
      authorize: () => boolean;
    }) => Promise<GateEvaluationReadResult>;
    /** Runtime-owned current Project workspace resolver for Flow-backed refs. */
    resolveProjectWorkspace?: (projectId: string) => string | undefined;
    /** Shared TaskGraph -> exact Session owner adapter for kept results. */
    readTaskToolResultReferences?: TaskToolResultReferenceRead['read'];
    readTaskGateEvaluationReferences?: TaskGateEvaluationReferenceRead['read'];
    readTaskBasis?: (input: {
      taskId: string;
      request?: Request;
      answerReferenceId?: string;
      authority: SessionReadAuthority;
    }) => Promise<
      | {
          status: 'found';
          data: StationBasisProjection | StationTaskBasisCollection;
        }
      | { status: 'not-found' }
      | { status: 'unavailable' }
    >;
    taskBasisAppRead?: TaskBasisAppReadModule;
    callerBindingForRequest?: (request: Request) => string | undefined;
    isRequestPrincipalCurrent?: (request: Request) => boolean;
    /**
     * Hosted deployments may supply a tenant-bound Task service. The shared
     * local graph is never selected for a hosted request.
     */
    taskGraphServiceForRequest?: (
      request: Request,
    ) => TaskGraphService | undefined;
    taskDispatcherForRequest?: (request: Request) => TaskDispatcher | undefined;
    /** Personal-only answer-support authority; hosted requests never select it. */
    answerSupportModule?: TaskAnswerSupportModule;
    /** Lazily composes personal-only filesystem authority after hosted rejection. */
    answerSupportModuleForRequest?: (
      request: Request,
    ) => TaskAnswerSupportModule;
    /** Personal-only association owner; it captures Task pins under its lock. */
    answerNarrativeBindingModule?: AnswerNarrativeBindingModule;
  } = {} as {
    taskDispatcher: TaskDispatcher;
    canReadSession?: (
      sessionId: string,
      authority: SessionReadAuthority,
    ) => boolean;
    sessionInventory?: SessionInventoryModule;
    readAuthorityForRequest?: (request: Request) => SessionReadAuthority;
    readAssistantTurn?: (input: {
      sessionId: string;
      turnId: string;
      authority: SessionReadAuthority;
    }) => Promise<SessionAssistantTurnQueryOutcome>;
    readUserInput?: (input: {
      sessionId: string;
      eventId: string;
      authority: SessionReadAuthority;
    }) => Promise<SessionUserInputQueryOutcome>;
    readToolResult?: (input: {
      sessionId: string;
      eventId: string;
      authority: SessionReadAuthority;
    }) => Promise<SessionToolResultQueryOutcome>;
    readFlowGateEvaluation?: (input: {
      taskId: string;
      projectId: string;
      ref: GateEvaluationRef;
      request: Request;
      authorize: () => boolean;
    }) => Promise<GateEvaluationReadResult>;
    resolveProjectWorkspace?: (projectId: string) => string | undefined;
    readTaskToolResultReferences?: TaskToolResultReferenceRead['read'];
    readTaskGateEvaluationReferences?: TaskGateEvaluationReferenceRead['read'];
    readTaskBasis?: (input: {
      taskId: string;
      answerReferenceId?: string;
      authority: SessionReadAuthority;
    }) => Promise<
      | {
          status: 'found';
          data: StationBasisProjection | StationTaskBasisCollection;
        }
      | { status: 'not-found' }
      | { status: 'unavailable' }
    >;
    taskBasisAppRead?: TaskBasisAppReadModule;
    callerBindingForRequest?: (request: Request) => string | undefined;
    isRequestPrincipalCurrent?: (request: Request) => boolean;
    taskGraphServiceForRequest?: (
      request: Request,
    ) => TaskGraphService | undefined;
    taskDispatcherForRequest?: (request: Request) => TaskDispatcher | undefined;
    answerSupportModule?: TaskAnswerSupportModule;
    answerSupportModuleForRequest?: (
      request: Request,
    ) => TaskAnswerSupportModule;
    answerNarrativeBindingModule?: AnswerNarrativeBindingModule;
  },
) {
  const app = new Hono();
  const fallbackTaskToolResultReferences =
    options.readTaskToolResultReferences === undefined
      ? createTaskToolResultReferenceReadAdapter({
          taskGraph: taskGraphService,
          sessionQueries: {
            readToolResult: async (query, authority) =>
              (await options.readToolResult?.({
                sessionId: query.threadId,
                eventId: query.eventId,
                authority,
              })) ?? { status: 'unavailable' },
          },
          canReadSession: (sessionId, authority) =>
            options.canReadSession?.(sessionId, authority) ?? true,
        })
      : undefined;
  const fallbackTaskGateEvaluationReferences =
    options.readTaskGateEvaluationReferences === undefined &&
    options.readFlowGateEvaluation &&
    options.resolveProjectWorkspace &&
    options.isRequestPrincipalCurrent
      ? createTaskGateEvaluationReferenceReadAdapter({
          taskGraph: taskGraphService,
          resolveProjectWorkspace: options.resolveProjectWorkspace,
          isRequestPrincipalCurrent: options.isRequestPrincipalCurrent,
          readFlowGateEvaluation: options.readFlowGateEvaluation,
        })
      : undefined;
  let personalAnswerSupportModule: TaskAnswerSupportModule | undefined;
  const hostedRequest = (request: Request) => {
    const authority = options.readAuthorityForRequest?.(request);
    return authority ? isHostedSessionReadAuthority(authority) : false;
  };
  const hostedNotFound = (c: Context) =>
    c.json({ success: false, error: 'Task not found' }, 404);
  const serviceForRequest = (request: Request) =>
    hostedRequest(request)
      ? options.taskGraphServiceForRequest?.(request)
      : taskGraphService;
  const dispatcherForRequest = (request: Request) =>
    hostedRequest(request)
      ? options.taskDispatcherForRequest?.(request)
      : options.taskDispatcher;
  const observeTurnResolution = (
    operation: 'attach' | 'reopen',
    outcome: 'available' | 'not-found' | 'unavailable' | 'project-mismatch',
  ) => {
    taskTurnReferenceResolutionTotal.add(1, { operation, outcome });
  };
  const readAssistantTurn = async (
    request: Request,
    sessionId: string,
    turnId: string,
  ): Promise<SessionAssistantTurnQueryOutcome> => {
    const authority = options.readAuthorityForRequest?.(request);
    // A missing composition dependency or authority must never make a stored
    // tuple readable. Return the same outcome as a missing/denied answer.
    if (!authority || !options.readAssistantTurn) {
      return { status: 'not-found' };
    }
    return options.readAssistantTurn({ sessionId, turnId, authority });
  };
  const readUserInput = async (
    request: Request,
    sessionId: string,
    eventId: string,
  ): Promise<SessionUserInputQueryOutcome> => {
    const authority = options.readAuthorityForRequest?.(request);
    if (!authority) return { status: 'not-found' };
    if (!options.readUserInput) return { status: 'unavailable' };
    return options.readUserInput({ sessionId, eventId, authority });
  };
  const readToolResult = async (
    request: Request,
    sessionId: string,
    eventId: string,
  ): Promise<SessionToolResultQueryOutcome> => {
    const authority = options.readAuthorityForRequest?.(request);
    if (!authority) return { status: 'not-found' };
    if (!options.readToolResult) return { status: 'unavailable' };
    return options.readToolResult({ sessionId, eventId, authority });
  };
  const answerSupportForRequest = (request: Request) => {
    if (hostedRequest(request)) return undefined;
    if (options.answerSupportModule) return options.answerSupportModule;
    if (!options.answerSupportModuleForRequest) return undefined;
    personalAnswerSupportModule ??=
      options.answerSupportModuleForRequest(request);
    return personalAnswerSupportModule;
  };
  const noStore = (c: Context) =>
    c.header('Cache-Control', 'private, no-store');
  const supportFailure = (c: Context, error: unknown) => {
    noStore(c);
    if (error instanceof TaskAnswerSupportUnavailableError)
      return c.json(
        { success: false, error: 'Answer support temporarily unavailable' },
        503,
      );
    if (error instanceof TaskAnswerSupportConflictError)
      return c.json({ success: false, error: 'Answer support conflicts' }, 409);
    return c.json({ success: false, error: 'Answer support unavailable' }, 404);
  };

  app.get('/', (c) => {
    // TaskGraphService is one global, unbound store. Do not partially filter
    // it: there is no per-record tenant authority to prove an emitted task or
    // relation safe. A later tenant-bound task store can replace this narrow
    // route seam without changing personal mode.
    const service = serviceForRequest(c.req.raw);
    if (!service) return c.json({ success: true, data: [] });
    const data = service.listTasks(c.req.query('projectId'));
    return c.json({ success: true, data });
  });

  app.post('/', validate(taskCreateSchema), async (c) => {
    try {
      const service = serviceForRequest(c.req.raw);
      if (!service) return hostedNotFound(c);
      const data = await service.createTask(
        getBody(c),
        resolveClientOriginForRequest(c.req.raw),
      );
      return c.json({ success: true, data }, 201);
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.get('/sessions/:sessionId/relations', (c) => {
    const service = serviceForRequest(c.req.raw);
    if (!service) {
      return c.json({ success: false, error: 'Session not found' }, 404);
    }
    const sessionId = param(c, 'sessionId');
    const authority = options.readAuthorityForRequest?.(c.req.raw);
    // Direct ids are deliberately indistinguishable from missing relations.
    // A hosted runtime wires both dependencies; partial wiring fails closed.
    if (
      (authority && !options.canReadSession?.(sessionId, authority)) ||
      (!authority && options.canReadSession)
    ) {
      return c.json({ success: false, error: 'Session not found' }, 404);
    }
    const data = service.readSessionRelations(sessionId);
    return c.json({ success: true, data });
  });

  app.get('/:taskId/sessions/:sessionId/inventory', async (c) => {
    noStore(c);
    const request = c.req.raw;
    const service = serviceForRequest(request);
    const authority = options.readAuthorityForRequest?.(request);
    const taskId = param(c, 'taskId');
    const sessionId = param(c, 'sessionId');
    const authorized = () =>
      options.isRequestPrincipalCurrent?.(request) !== false &&
      Boolean(service?.readTask(taskId)) &&
      Boolean(authority) &&
      (options.canReadSession?.(sessionId, authority!) ?? false) &&
      Boolean(
        service
          ?.readSessionRelations(sessionId)
          .links.some(
            (link) =>
              (link.sourceType === 'task' && link.sourceId === taskId) ||
              (link.targetType === 'task' && link.targetId === taskId),
          ),
      );
    // Same opaque 404 covers absent Task, Session denial, missing exact join,
    // hosted-composition omission, and principal epoch loss.
    if (!service || !authority || !options.sessionInventory || !authorized())
      return hostedNotFound(c);
    const keepRows = keptRowsForTaskSession(service, taskId, sessionId);
    const outcome = await options.sessionInventory.read({
      scope: { kind: 'kept-in-task', taskId, sessionId },
      keptRows: keepRows,
      authority,
      current: authorized,
    });
    if (!authorized() || outcome.status !== 'found') return hostedNotFound(c);
    return c.json({
      success: true,
      data: outcome.projection,
    });
  });

  app.get(
    '/:taskId/sessions/:sessionId/inventory/groups/:groupId',
    async (c) => {
      noStore(c);
      const request = c.req.raw;
      const service = serviceForRequest(request);
      const authority = options.readAuthorityForRequest?.(request);
      const taskId = param(c, 'taskId');
      const sessionId = param(c, 'sessionId');
      const groupId = param(c, 'groupId');
      const authorized = () =>
        options.isRequestPrincipalCurrent?.(request) !== false &&
        Boolean(service?.readTask(taskId)) &&
        Boolean(authority) &&
        (options.canReadSession?.(sessionId, authority!) ?? false) &&
        Boolean(
          service
            ?.readSessionRelations(sessionId)
            .links.some(
              (link) =>
                (link.sourceType === 'task' && link.sourceId === taskId) ||
                (link.targetType === 'task' && link.targetId === taskId),
            ),
        );
      if (
        !service ||
        !authority ||
        !options.sessionInventory ||
        !SESSION_INVENTORY_GROUP_IDS.includes(
          groupId as (typeof SESSION_INVENTORY_GROUP_IDS)[number],
        ) ||
        !authorized()
      )
        return hostedNotFound(c);
      const outcome = await options.sessionInventory.page({
        scope: { kind: 'kept-in-task', taskId, sessionId },
        groupId: groupId as (typeof SESSION_INVENTORY_GROUP_IDS)[number],
        continuation: c.req.query('continuation'),
        keptRows: keptRowsForTaskSession(service, taskId, sessionId),
        authority,
        current: authorized,
      });
      if (!authorized() || outcome.status !== 'found') return hostedNotFound(c);
      return c.json({ success: true, data: outcome.page });
    },
  );

  app.post('/:taskId/references', validate(taskReferenceSchema), async (c) => {
    const input = getBody(c);
    const isToolResult = input.kind === 'tool-result';
    const isGateEvaluation = input.kind === 'gate-evaluation';
    // Mark the protected request before service selection or scope reads: an
    // owner/store fault must never make this capability-shaped mutation cache.
    if (isToolResult || isGateEvaluation) noStore(c);
    try {
      const service = serviceForRequest(c.req.raw);
      if (!service) return hostedNotFound(c);
      let referenceCommitAuthorization:
        | TaskReferenceCommitAuthorization
        | undefined;
      if (isGateEvaluation) {
        // Parse the exact owner contract before any persistence. Never trust
        // decoded path pieces or a client-shaped lookalike as a Flow ref.
        const ref = parseGateEvaluationRef(input.ref);
        if (
          !ref ||
          encodeTaskGateEvaluationReference(ref) !==
            encodeTaskGateEvaluationReference(input.ref)
        ) {
          return c.json(
            { success: false, error: 'Gate evaluation not found' },
            404,
          );
        }
        const task = service.readTask(param(c, 'taskId'));
        if (!task) return hostedNotFound(c);
        const taskWorkspaceBinding = task.workspaceBinding;
        const projectWorkspace = options.resolveProjectWorkspace?.(
          task.projectId,
        );
        // A Flow receipt is bound to the Task's captured workspace and the
        // current Project workspace. Without both observations, an owner read
        // can admit one workspace and a queued graph commit can retain it on a
        // Task that has since been rebound.
        if (!taskWorkspaceBinding || !projectWorkspace) {
          return c.json(
            { success: false, error: 'Gate evaluation not found' },
            404,
          );
        }
        const request = c.req.raw;
        const authorize = (
          actualTask?: Pick<
            TaskRecord,
            'id' | 'projectId' | 'workspaceBinding'
          >,
        ) => {
          const taskAtWitness = actualTask ?? task;
          if (
            options.isRequestPrincipalCurrent &&
            options.isRequestPrincipalCurrent(request) !== true
          )
            return false;
          return (
            taskAtWitness.projectId === task.projectId &&
            sameTaskWorkspaceBinding(
              taskAtWitness.workspaceBinding,
              taskWorkspaceBinding,
            ) &&
            options.resolveProjectWorkspace?.(taskAtWitness.projectId) ===
              projectWorkspace
          );
        };
        const result = await options.readFlowGateEvaluation?.({
          taskId: param(c, 'taskId'),
          projectId: task.projectId,
          ref,
          request,
          authorize,
        });
        if (result?.status === 'unavailable') {
          return c.json(
            {
              success: false,
              error: 'Gate evaluation is temporarily unavailable',
            },
            503,
          );
        }
        if (result?.status !== 'found') {
          return c.json(
            { success: false, error: 'Gate evaluation not found' },
            404,
          );
        }
        referenceCommitAuthorization = {
          expectedProjectId: task.projectId,
          isAuthorized: (actualTask) => authorize(actualTask),
        };
      }
      if (input.kind === 'turn') {
        const task = service.readTaskTurnReferenceScope(param(c, 'taskId'));
        if (!task) return hostedNotFound(c);
        const answer = await readAssistantTurn(
          c.req.raw,
          input.sessionId,
          input.turnId,
        );
        // Creation is allowed only after the exact completed assistant answer
        // is authorized and observed. Missing and denied stay indistinguishable.
        if (answer.status === 'unavailable') {
          observeTurnResolution('attach', 'unavailable');
          return c.json(
            {
              success: false,
              error: 'Assistant answer is temporarily unavailable',
            },
            503,
          );
        }
        if (
          answer.status !== 'found' ||
          (answer.projectSlug !== undefined &&
            answer.projectSlug !== task.projectId)
        ) {
          observeTurnResolution(
            'attach',
            answer.status === 'found' ? 'project-mismatch' : 'not-found',
          );
          return c.json(
            { success: false, error: 'Assistant answer not found' },
            404,
          );
        }
        if (options.answerNarrativeBindingModule) {
          const taskRecord = service.readTask(param(c, 'taskId'));
          const taskWorkspaceBinding = taskRecord?.workspaceBinding;
          const projectWorkspace = options.resolveProjectWorkspace?.(
            task.projectId,
          );
          const request = c.req.raw;
          referenceCommitAuthorization = {
            expectedProjectId: task.projectId,
            isAuthorized: (actualTask) => {
              if (
                options.isRequestPrincipalCurrent &&
                options.isRequestPrincipalCurrent(request) !== true
              )
                return false;
              const authority = options.readAuthorityForRequest?.(request);
              if (
                !authority ||
                (options.canReadSession?.(input.sessionId, authority) ??
                  false) !== true ||
                actualTask.projectId !== task.projectId ||
                !sameTaskWorkspaceBinding(
                  actualTask.workspaceBinding,
                  taskWorkspaceBinding,
                )
              )
                return false;
              return (
                projectWorkspace === undefined ||
                options.resolveProjectWorkspace?.(actualTask.projectId) ===
                  projectWorkspace
              );
            },
          };
        }
        observeTurnResolution('attach', 'available');
      }
      if (input.kind === 'user-input') {
        noStore(c);
        const task = service.readTaskUserInputReferenceScope(
          param(c, 'taskId'),
        );
        if (!task) return hostedNotFound(c);
        if (
          encodeTaskUserInputReference(input.sessionId, input.eventId).length >
          MAX_TASK_REFERENCE_TARGET_LENGTH
        ) {
          return c.json({ success: false, error: 'User input not found' }, 404);
        }
        const userInput = await readUserInput(
          c.req.raw,
          input.sessionId,
          input.eventId,
        );
        if (userInput.status === 'unavailable') {
          return c.json(
            { success: false, error: 'User input is temporarily unavailable' },
            503,
          );
        }
        // Missing, denied, wrong event kind, malformed input, and a scoped
        // project mismatch intentionally remain one response shape.
        if (
          userInput.status !== 'found' ||
          (userInput.projectSlug !== undefined &&
            userInput.projectSlug !== task.projectId)
        ) {
          return c.json({ success: false, error: 'User input not found' }, 404);
        }
      }
      if (input.kind === 'tool-result') {
        const task = service.readTaskUserInputReferenceScope(
          param(c, 'taskId'),
        );
        if (!task) return hostedNotFound(c);
        if (
          encodeTaskToolResultReference(input.sessionId, input.eventId).length >
          MAX_TASK_REFERENCE_TARGET_LENGTH
        ) {
          return c.json(
            { success: false, error: 'Tool result not found' },
            404,
          );
        }
        const toolResult = await readToolResult(
          c.req.raw,
          input.sessionId,
          input.eventId,
        );
        if (toolResult.status === 'unavailable') {
          return c.json(
            { success: false, error: 'Tool result is temporarily unavailable' },
            503,
          );
        }
        if (
          toolResult.status !== 'found' ||
          toolResult.sessionId !== input.sessionId ||
          toolResult.eventId !== input.eventId ||
          toolResult.result.resultId !== input.eventId ||
          (toolResult.projectSlug !== undefined &&
            toolResult.projectSlug !== task.projectId)
        ) {
          return c.json(
            { success: false, error: 'Tool result not found' },
            404,
          );
        }
        const authorizedProjectId = task.projectId;
        const request = c.req.raw;
        // This witness is intentionally evaluated by TaskGraphService only
        // inside its locked, freshly-reloaded mutateStore callback. It binds
        // the owner-read admission to the actual Task that will be changed.
        referenceCommitAuthorization = {
          expectedProjectId: authorizedProjectId,
          isAuthorized: (actualTask) => {
            if (actualTask.projectId !== authorizedProjectId) return false;
            if (
              options.isRequestPrincipalCurrent &&
              options.isRequestPrincipalCurrent(request) !== true
            ) {
              return false;
            }
            const authority = options.readAuthorityForRequest?.(request);
            if (!authority) return false;
            return options.canReadSession?.(input.sessionId, authority) ?? true;
          },
        };
      }
      // Awaited inside the try: the 404/400 mapping below reads the rejection
      // message, so an unawaited promise would escape it as a 500 (archive#2646).
      const create = (narrativePin?: {
        associationRevision?: number;
        isCurrent(): boolean;
      }) =>
        service.createTaskReference(
          param(c, 'taskId'),
          input,
          resolveClientOriginForRequest(c.req.raw),
          referenceCommitAuthorization,
          narrativePin,
        );
      const data =
        input.kind === 'turn' && options.answerNarrativeBindingModule
          ? await options.answerNarrativeBindingModule.withTaskReferencePin({
              sessionId: input.sessionId,
              turnId: input.turnId,
              authority: options.readAuthorityForRequest!(c.req.raw),
              current: () =>
                (options.isRequestPrincipalCurrent?.(c.req.raw) ?? true) &&
                (options.canReadSession?.(
                  input.sessionId,
                  options.readAuthorityForRequest!(c.req.raw),
                ) ??
                  false),
              commit: create,
            })
          : await create();
      return c.json({ success: true, data }, 201);
    } catch (error) {
      if (error instanceof AnswerNarrativeUnavailableError) {
        return c.json(
          {
            success: false,
            error: 'Assistant answer is temporarily unavailable',
          },
          503,
        );
      }
      if (error instanceof AnswerNarrativeNotFoundError) {
        return c.json(
          { success: false, error: 'Assistant answer not found' },
          404,
        );
      }
      if (error instanceof TaskReferenceAuthorizationError) {
        return c.json(
          {
            success: false,
            error:
              input.kind === 'turn'
                ? 'Assistant answer not found'
                : isGateEvaluation
                  ? 'Gate evaluation not found'
                  : 'Tool result not found',
          },
          404,
        );
      }
      if (error instanceof TaskReferenceRejectedError) {
        return c.json(
          { success: false, error: errorMessage(error) },
          error.reason === 'not-found' ? 404 : 400,
        );
      }
      if (isToolResult || isGateEvaluation) {
        return c.json(
          {
            success: false,
            error: isGateEvaluation
              ? 'Gate evaluation is temporarily unavailable'
              : 'Tool result is temporarily unavailable',
          },
          503,
        );
      }
      const message = errorMessage(error);
      const status = message.startsWith('Task not found:') ? 404 : 400;
      return c.json({ success: false, error: message }, status);
    }
  });

  app.get(
    '/:taskId/turn-references/:referenceId/support/bundles',
    async (c) => {
      noStore(c);
      const support = answerSupportForRequest(c.req.raw);
      if (!support)
        return c.json(
          { success: false, error: 'Answer support unavailable' },
          404,
        );
      const authority = options.readAuthorityForRequest?.(c.req.raw);
      if (!authority)
        return c.json(
          { success: false, error: 'Answer support unavailable' },
          404,
        );
      try {
        const data = await support.bundles(
          param(c, 'taskId'),
          param(c, 'referenceId'),
          authority,
        );
        if (data === 'unavailable')
          return c.json(
            { success: false, error: 'Answer support temporarily unavailable' },
            503,
          );
        if (data === 'not-found')
          return c.json(
            { success: false, error: 'Answer support unavailable' },
            404,
          );
        return c.json({ success: true, data });
      } catch (error) {
        return supportFailure(c, error);
      }
    },
  );

  app.get(
    '/:taskId/turn-references/:referenceId/support/bundles/:bundleId/claims',
    async (c) => {
      noStore(c);
      const support = answerSupportForRequest(c.req.raw);
      if (!support)
        return c.json(
          { success: false, error: 'Answer support unavailable' },
          404,
        );
      const authority = options.readAuthorityForRequest?.(c.req.raw);
      if (!authority)
        return c.json(
          { success: false, error: 'Answer support unavailable' },
          404,
        );
      try {
        const data = await support.claims(
          param(c, 'taskId'),
          param(c, 'referenceId'),
          param(c, 'bundleId'),
          authority,
        );
        if (data === 'unavailable')
          return c.json(
            { success: false, error: 'Answer support temporarily unavailable' },
            503,
          );
        if (data === 'not-found')
          return c.json(
            { success: false, error: 'Answer support unavailable' },
            404,
          );
        return c.json({ success: true, data });
      } catch (error) {
        return supportFailure(c, error);
      }
    },
  );

  app.post(
    '/:taskId/turn-references/:referenceId/support',
    validate(answerSupportMutationSchema),
    async (c) => {
      noStore(c);
      const support = answerSupportForRequest(c.req.raw);
      const authority = options.readAuthorityForRequest?.(c.req.raw);
      if (!support || !authority)
        return c.json(
          { success: false, error: 'Answer support unavailable' },
          404,
        );
      try {
        return c.json(
          {
            success: true,
            data: await support.create(
              param(c, 'taskId'),
              param(c, 'referenceId'),
              getBody(c).bundleId,
              getBody(c).claimId,
              authority,
            ),
          },
          201,
        );
      } catch (error) {
        return supportFailure(c, error);
      }
    },
  );

  app.put(
    '/:taskId/turn-references/:referenceId/support',
    validate(answerSupportReplaceSchema),
    async (c) => {
      noStore(c);
      const support = answerSupportForRequest(c.req.raw);
      const authority = options.readAuthorityForRequest?.(c.req.raw);
      if (!support || !authority)
        return c.json(
          { success: false, error: 'Answer support unavailable' },
          404,
        );
      try {
        const body = getBody(c);
        return c.json({
          success: true,
          data: await support.replace(
            param(c, 'taskId'),
            param(c, 'referenceId'),
            body.bundleId,
            body.claimId,
            body.expectedRevision,
            authority,
          ),
        });
      } catch (error) {
        return supportFailure(c, error);
      }
    },
  );

  app.delete(
    '/:taskId/turn-references/:referenceId/support',
    validate(answerSupportRemoveSchema),
    async (c) => {
      noStore(c);
      const support = answerSupportForRequest(c.req.raw);
      const authority = options.readAuthorityForRequest?.(c.req.raw);
      if (!support || !authority)
        return c.json(
          { success: false, error: 'Answer support unavailable' },
          404,
        );
      try {
        await support.remove(
          param(c, 'taskId'),
          param(c, 'referenceId'),
          getBody(c).expectedRevision,
          authority,
        );
        return c.json({ success: true });
      } catch (error) {
        return supportFailure(c, error);
      }
    },
  );

  app.get('/:taskId/turn-references', async (c) => {
    noStore(c);
    const support = answerSupportForRequest(c.req.raw);
    // Personal Task answer reads are an authority surface once this feature is
    // mounted: absence of its composition seam is an outage, not evidence that
    // every stored answer is unassessed.
    if (!support && !hostedRequest(c.req.raw))
      return c.json(
        { success: false, error: 'Answer support temporarily unavailable' },
        503,
      );
    const service = serviceForRequest(c.req.raw);
    if (!service) return hostedNotFound(c);
    const task = service.readTaskTurnReferenceScope(param(c, 'taskId'));
    if (!task) return hostedNotFound(c);
    const links = service.readTaskTurnReferenceLinks(param(c, 'taskId'));
    if (!links) return c.json({ success: false, error: 'Task not found' }, 404);

    // An idempotent Task normally has one link per tuple, but cache at the
    // route boundary too: a legacy/corrupt store must not trigger repeated
    // exact-turn replays while this request is reauthorizing its links.
    const answers = new Map<
      string,
      Promise<SessionAssistantTurnQueryOutcome>
    >();
    const resolve = (sessionId: string, turnId: string) => {
      const key = encodeTaskTurnReference(sessionId, turnId);
      const existing = answers.get(key);
      if (existing) return existing;
      const next = readAssistantTurn(c.req.raw, sessionId, turnId);
      answers.set(key, next);
      return next;
    };
    const resolved = await Promise.all(
      links.map(async (link) => {
        const reference = parseTaskTurnReference(link.targetId);
        if (!reference) return { state: 'unavailable' as const };
        const answer = await resolve(reference.sessionId, reference.turnId);
        if (answer.status === 'unavailable') {
          observeTurnResolution('reopen', 'unavailable');
          return { state: 'resolver-unavailable' as const };
        }
        if (answer.status !== 'found') {
          observeTurnResolution('reopen', 'not-found');
          // Do not expose an unavailable Session/turn identity, excerpt, or
          // distinction between absent and unauthorized source records.
          return { state: 'unavailable' as const };
        }
        if (
          answer.projectSlug !== undefined &&
          answer.projectSlug !== task.projectId
        ) {
          observeTurnResolution('reopen', 'project-mismatch');
          return { state: 'unavailable' as const };
        }
        observeTurnResolution('reopen', 'available');
        const authority = options.readAuthorityForRequest?.(c.req.raw);
        const standing = support
          ? authority
            ? await support.standing(param(c, 'taskId'), link.id, authority)
            : { state: 'unavailable' as const }
          : { state: 'unassessed' as const };
        return {
          id: link.id,
          state: 'available' as const,
          sessionId: answer.sessionId,
          turnId: answer.turnId,
          answer: answer.message,
          support: standing,
        };
      }),
    ).catch((error: unknown) => {
      if (error instanceof TaskAnswerSupportUnavailableError) return undefined;
      throw error;
    });
    if (!resolved)
      return c.json(
        { success: false, error: 'Answer support temporarily unavailable' },
        503,
      );
    if (
      resolved.some((reference) => reference.state === 'resolver-unavailable')
    ) {
      return c.json(
        { success: false, error: 'Answer basis is temporarily unavailable' },
        503,
      );
    }
    const data: typeof resolved = resolved.filter(
      (reference) => reference.state === 'available',
    );
    // Missing, denied, malformed, and cross-project links intentionally
    // collapse to one identity-free sentinel. A count would itself disclose
    // the shape of protected stored references.
    if (resolved.some((reference) => reference.state === 'unavailable')) {
      data.push({ state: 'unavailable' as const });
    }
    return c.json({ success: true, data });
  });

  app.get('/:taskId/user-input-references', async (c) => {
    noStore(c);
    const service = serviceForRequest(c.req.raw);
    if (!service) return hostedNotFound(c);
    const task = service.readTaskUserInputReferenceScope(param(c, 'taskId'));
    if (!task) return hostedNotFound(c);
    const links = service.readTaskUserInputReferenceLinks(param(c, 'taskId'));
    if (!links) return hostedNotFound(c);

    const inputs = new Map<string, Promise<SessionUserInputQueryOutcome>>();
    const resolve = (sessionId: string, eventId: string) => {
      const key = encodeTaskUserInputReference(sessionId, eventId);
      const existing = inputs.get(key);
      if (existing) return existing;
      const next = readUserInput(c.req.raw, sessionId, eventId);
      inputs.set(key, next);
      return next;
    };
    const resolved = await Promise.all(
      links.map(async (link) => {
        const reference = parseTaskUserInputReference(link.targetId);
        if (!reference) return { state: 'unavailable' as const };
        const userInput = await resolve(reference.sessionId, reference.eventId);
        if (userInput.status === 'unavailable') {
          return { state: 'resolver-unavailable' as const };
        }
        if (
          userInput.status !== 'found' ||
          (userInput.projectSlug !== undefined &&
            userInput.projectSlug !== task.projectId)
        ) {
          return { state: 'unavailable' as const };
        }
        return {
          id: link.id,
          state: 'available' as const,
          sessionId: userInput.sessionId,
          eventId: userInput.eventId,
          turnId: userInput.turnId,
          input: userInput.input,
        };
      }),
    );
    if (
      resolved.some((reference) => reference.state === 'resolver-unavailable')
    ) {
      return c.json(
        { success: false, error: 'User input is temporarily unavailable' },
        503,
      );
    }
    const data: typeof resolved = resolved.filter(
      (reference) => reference.state === 'available',
    );
    // Never disclose protected tuple count or identity through a generic
    // graph-shaped failure; a single sentinel is the only degraded state.
    if (resolved.some((reference) => reference.state === 'unavailable')) {
      data.push({ state: 'unavailable' as const });
    }
    return c.json({ success: true, data });
  });

  app.get('/:taskId/tool-result-references', async (c) => {
    noStore(c);
    try {
      const request = c.req.raw;
      const taskId = param(c, 'taskId');
      const service = serviceForRequest(request);
      if (!service) return hostedNotFound(c);
      const authority = options.readAuthorityForRequest?.(request);
      const read =
        options.readTaskToolResultReferences ??
        fallbackTaskToolResultReferences?.read;
      if (!authority || !read) {
        return c.json(
          { success: false, error: 'Tool result is temporarily unavailable' },
          503,
        );
      }
      const outcome = await read({ taskId, authority });
      if (outcome.status !== 'found' || hasUnavailableGap(outcome.gaps)) {
        return c.json(
          { success: false, error: 'Tool result is temporarily unavailable' },
          503,
        );
      }
      if (options.isRequestPrincipalCurrent?.(request) === false)
        return c.json(
          { success: false, error: 'Tool result is temporarily unavailable' },
          503,
        );
      const data: (
        | {
            id: string;
            state: 'available';
            ref: Extract<
              import('@kontourai/surface/basis').BasisContributionRef,
              { authority: '@kontourai/thread'; kind: 'result' }
            >;
            result: unknown;
          }
        | { state: 'unavailable' }
      )[] = [
        ...outcome.references.map((reference) => ({
          id: reference.referenceId,
          state: 'available' as const,
          ref: reference.ref,
          result: reference.result,
        })),
        ...(outcome.gaps?.length ? [{ state: 'unavailable' as const }] : []),
      ];
      return c.json({ success: true, data });
    } catch {
      return c.json(
        { success: false, error: 'Tool result is temporarily unavailable' },
        503,
      );
    }
  });

  app.get('/:taskId/gate-evaluation-references', async (c) => {
    noStore(c);
    try {
      const request = c.req.raw;
      if (!serviceForRequest(request)) return hostedNotFound(c);
      const read =
        options.readTaskGateEvaluationReferences ??
        fallbackTaskGateEvaluationReferences?.read;
      // Hosted requests have no personal Flow home adapter. Do not fall back
      // to a global reader when a tenant-specific composition is absent.
      if (!read)
        return c.json(
          {
            success: false,
            error: 'Gate evaluation is temporarily unavailable',
          },
          503,
        );
      const outcome = await read({ taskId: param(c, 'taskId'), request });
      if (outcome.status === 'unavailable')
        return c.json(
          {
            success: false,
            error: 'Gate evaluation is temporarily unavailable',
          },
          503,
        );
      if (outcome.status !== 'found')
        return c.json(
          { success: false, error: 'Gate evaluation not found' },
          404,
        );
      // Failed owner reads and denied/missing retained links collapse to this
      // one identity-free sentinel. It contains no Flow tuple or file detail.
      return c.json({
        success: true,
        data: [
          ...outcome.references.map((reference) => ({
            referenceId: reference.referenceId,
            kept: true as const,
            evaluation: reference.evaluation,
          })),
          ...(outcome.gaps?.length ? [{ state: 'unavailable' as const }] : []),
        ],
      });
    } catch {
      return c.json(
        { success: false, error: 'Gate evaluation is temporarily unavailable' },
        503,
      );
    }
  });

  app.get('/:taskId/basis', async (c) => {
    noStore(c);
    try {
      const request = c.req.raw;
      const taskId = param(c, 'taskId');
      const service = serviceForRequest(request);
      if (!service) return hostedNotFound(c);
      // Capture every protected relation before owner I/O. The post-read
      // comparison below keeps a response from crossing a link/scope change.
      const scope = service.readTaskTurnReferenceScope(taskId);
      const turnLinks = service.readTaskTurnReferenceLinks(taskId);
      const resultLinks = service.readTaskToolResultReferenceLinks(taskId);
      if (!scope || !turnLinks || !resultLinks) return hostedNotFound(c);
      const authority = options.readAuthorityForRequest?.(request);
      if (!authority || !options.readTaskBasis)
        return c.json({ success: false, error: 'Basis unavailable' }, 503);
      const outcome = await options.readTaskBasis({
        taskId,
        request,
        ...(c.req.query('answerReferenceId')
          ? { answerReferenceId: c.req.query('answerReferenceId')! }
          : {}),
        authority,
      });
      if (outcome.status === 'unavailable')
        return c.json({ success: false, error: 'Basis unavailable' }, 503);
      if (outcome.status !== 'found') return hostedNotFound(c);
      const currentScope = service.readTaskTurnReferenceScope(taskId);
      const currentTurnLinks = service.readTaskTurnReferenceLinks(taskId);
      const currentResultLinks =
        service.readTaskToolResultReferenceLinks(taskId);
      const publishedSessions = publishedBasisSessionIds(outcome.data);
      const sessionsCurrent =
        publishedSessions?.every(
          (sessionId) => options.canReadSession?.(sessionId, authority) ?? true,
        ) === true;
      if (
        options.isRequestPrincipalCurrent?.(request) === false ||
        currentScope?.projectId !== scope.projectId ||
        !sameReferenceLinks(turnLinks, currentTurnLinks) ||
        !sameReferenceLinks(resultLinks, currentResultLinks) ||
        !sessionsCurrent
      )
        return c.json({ success: false, error: 'Basis unavailable' }, 503);
      return c.json({ success: true, data: outcome.data });
    } catch {
      return c.json({ success: false, error: 'Basis unavailable' }, 503);
    }
  });

  // The browser/app host never supplies authority, occurrence ownership, or
  // offsets.  It can only present an opaque continuation bound at open time.
  app.post('/:taskId/basis/app-read', async (c) => {
    noStore(c);
    let callerBinding: string | undefined;
    let openedOccurrence: string | undefined;
    try {
      const authority = options.readAuthorityForRequest?.(c.req.raw);
      callerBinding = options.callerBindingForRequest?.(c.req.raw);
      if (!authority || !callerBinding || !options.taskBasisAppRead)
        return c.json({ success: false, error: 'Basis unavailable' }, 503);
      let rawBody: unknown;
      try {
        rawBody = await c.req.json();
      } catch {
        return c.json({ success: false, error: 'Basis unavailable' }, 503);
      }
      const continuation = taskBasisAppContinueSchema.safeParse(rawBody);
      const opening = taskBasisAppOpenSchema.safeParse(rawBody);
      const beforeService = serviceForRequest(c.req.raw);
      const beforeScope = beforeService?.readTaskTurnReferenceScope(
        param(c, 'taskId'),
      );
      const beforeLinks = beforeService?.readTaskTurnReferenceLinks(
        param(c, 'taskId'),
      );
      const beforeResultLinks = beforeService?.readTaskToolResultReferenceLinks(
        param(c, 'taskId'),
      );
      if (!beforeScope || !beforeLinks || !beforeResultLinks)
        return c.json({ success: false, error: 'Basis unavailable' }, 503);
      const outcome = continuation.success
        ? await options.taskBasisAppRead.continue({
            taskId: param(c, 'taskId'),
            ...(continuation.data.occurrenceId
              ? { occurrenceId: continuation.data.occurrenceId }
              : {}),
            continuationToken: continuation.data.continuationToken,
            callerBinding,
            authority,
            request: c.req.raw,
          })
        : opening.success
          ? await options.taskBasisAppRead.open({
              taskId: param(c, 'taskId'),
              callerBinding,
              authority,
              request: c.req.raw,
            })
          : { status: 'unavailable' as const };
      if (outcome.status !== 'available')
        return c.json({ success: false, error: 'Basis unavailable' }, 503);
      openedOccurrence = outcome.occurrenceId;
      // Recheck the request's currently-bound principal and every returned
      // answer session immediately before publication. A long owner read must
      // not publish through a revoked request/mount window.
      const service = serviceForRequest(c.req.raw);
      const links =
        service?.readTaskTurnReferenceLinks(param(c, 'taskId')) ?? null;
      const resultLinks =
        service?.readTaskToolResultReferenceLinks(param(c, 'taskId')) ?? null;
      const publishAllowed =
        service !== undefined &&
        links !== null &&
        resultLinks !== null &&
        options.isRequestPrincipalCurrent?.(c.req.raw) === true &&
        JSON.stringify(
          service.readTaskTurnReferenceScope(param(c, 'taskId')),
        ) === JSON.stringify(beforeScope) &&
        JSON.stringify(links) === JSON.stringify(beforeLinks) &&
        sameReferenceLinks(beforeResultLinks, resultLinks) &&
        outcome.page.status === 'available' &&
        outcome.page.answers.every((answer) => {
          const link = links.find(
            (candidate) => candidate.id === answer.answerReferenceId,
          );
          const tuple = link
            ? parseTaskTurnReference(String(link.targetId))
            : null;
          return (
            tuple !== null &&
            answer.projection.answer.state === 'available' &&
            answer.projection.answer.value.ref.threadId === tuple.sessionId &&
            options.canReadSession?.(tuple.sessionId, authority) === true
          );
        }) &&
        outcome.page.keptToolResults.every((result) => {
          const link = resultLinks.find(
            (candidate) => candidate.id === result.referenceId,
          );
          const tuple = link
            ? parseTaskToolResultReference(String(link.targetId))
            : null;
          return (
            tuple !== null &&
            result.ref.threadId === tuple.sessionId &&
            result.ref.resultId === tuple.eventId &&
            options.canReadSession?.(tuple.sessionId, authority) === true
          );
        });
      if (!publishAllowed) {
        options.taskBasisAppRead.revoke(
          param(c, 'taskId'),
          callerBinding,
          outcome.occurrenceId,
        );
        return c.json({ success: false, error: 'Basis unavailable' }, 503);
      }
      return c.json({
        success: true,
        data: outcome.page,
        meta: {
          'station.task-basis-app/v1': {
            occurrenceId: outcome.occurrenceId,
            ...(outcome.continuationToken
              ? { continuationToken: outcome.continuationToken }
              : {}),
          },
        },
      });
    } catch {
      if (callerBinding && openedOccurrence) {
        try {
          options.taskBasisAppRead?.revoke(
            param(c, 'taskId'),
            callerBinding,
            openedOccurrence,
          );
        } catch {
          // The outward response remains generic even if bounded teardown fails.
        }
      }
      return c.json({ success: false, error: 'Basis unavailable' }, 503);
    }
  });
  app.delete('/:taskId/basis/app-read', async (c) => {
    noStore(c);
    const callerBinding = options.callerBindingForRequest?.(c.req.raw);
    if (!callerBinding || !options.taskBasisAppRead)
      return c.json({ success: false, error: 'Basis unavailable' }, 503);
    let rawBody: unknown;
    try {
      rawBody = await c.req.json();
    } catch {
      return c.json({ success: false, error: 'Basis unavailable' }, 503);
    }
    const body = taskBasisAppRevokeSchema.safeParse(rawBody);
    if (!body.success)
      return c.json({ success: false, error: 'Basis unavailable' }, 503);
    options.taskBasisAppRead.revoke(
      param(c, 'taskId'),
      callerBinding,
      body.data.occurrenceId,
    );
    return c.json({ success: true });
  });

  app.get('/:taskId/graph', async (c) => {
    const service = serviceForRequest(c.req.raw);
    if (!service) return hostedNotFound(c);
    const data = await service.readTaskGraph(param(c, 'taskId'));
    if (!data) return c.json({ success: false, error: 'Task not found' }, 404);
    // A raw tuple is a protected capability-like reference, not generic graph
    // metadata. Exact source-session authorization happens only at the
    // turn-reference endpoint, so graph consumers receive no tuple to replay.
    const safeGraph: TaskGraph = {
      ...data,
      links: data.links.filter(
        (link) =>
          !(
            link.targetType === 'turn' &&
            link.relationType === 'references_turn'
          ) &&
          !(
            link.targetType === 'user_input' &&
            link.relationType === 'references_user_input'
          ) &&
          !(
            link.targetType === 'tool_result' &&
            link.relationType === 'references_tool_result'
          ) &&
          !(
            link.targetType === 'gate_evaluation' &&
            link.relationType === 'references_gate_evaluation'
          ),
      ),
    };
    return c.json({ success: true, data: safeGraph });
  });

  app.get('/:taskId/claim', async (c) => {
    try {
      const service = serviceForRequest(c.req.raw);
      if (!service) return hostedNotFound(c);
      const data = await service.readClaimStatus(param(c, 'taskId'));
      return c.json({ success: true, data });
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.get('/:taskId', async (c) => {
    const service = serviceForRequest(c.req.raw);
    if (!service) return hostedNotFound(c);
    const data = await service.readTaskForOpen(param(c, 'taskId'));
    if (!data) return c.json({ success: false, error: 'Task not found' }, 404);
    return c.json({ success: true, data });
  });

  app.patch('/:taskId/status', validate(taskStatusSchema), async (c) => {
    try {
      const service = serviceForRequest(c.req.raw);
      if (!service) return hostedNotFound(c);
      const data = await service.updateTaskStatus(
        param(c, 'taskId'),
        getBody(c).status,
        resolveClientOriginForRequest(c.req.raw),
      );
      return c.json({ success: true, data });
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  app.post('/:taskId/dispatch', validate(taskDispatchSchema), async (c) => {
    try {
      const dispatcher = dispatcherForRequest(c.req.raw);
      if (!dispatcher) return hostedNotFound(c);
      const outcome = await dispatcher.dispatch(param(c, 'taskId'), {
        ...getBody(c),
        clientOrigin: resolveClientOriginForRequest(c.req.raw),
      });
      if (outcome.kind !== 'dispatched') throw new Error(outcome.reason);
      const data = outcome.result;
      return c.json({ success: true, data });
    } catch (error) {
      return c.json({ success: false, error: errorMessage(error) }, 400);
    }
  });

  return app;
}

function hasUnavailableGap(
  gaps:
    | readonly { state: 'restricted' | 'corrupt' | 'unavailable' }[]
    | undefined,
): boolean {
  return gaps?.some((gap) => gap.state === 'unavailable') ?? false;
}

function sameReferenceLinks(
  left: readonly { id: unknown; targetId: unknown }[],
  right: readonly { id: unknown; targetId: unknown }[] | null,
): boolean {
  return (
    right !== null &&
    left.length === right.length &&
    left.every(
      (link, index) =>
        link.id === right[index]?.id &&
        link.targetId === right[index]?.targetId,
    )
  );
}

/** Returns only the Session identities represented by data about to publish. */
function publishedBasisSessionIds(
  data: StationBasisProjection | StationTaskBasisCollection,
): readonly string[] | null {
  const collection = parseStationTaskBasisCollection(data);
  if (collection) {
    const sessionIds: string[] = [];
    for (const answer of collection.answers) {
      const projection = parseStationBasisProjection(answer.projection);
      if (projection?.answer.state !== 'available') return null;
      sessionIds.push(projection.answer.value.ref.threadId);
    }
    sessionIds.push(
      ...collection.keptToolResults.map((result) => result.ref.threadId),
    );
    return [...new Set(sessionIds)];
  }
  const projection = parseStationBasisProjection(data);
  return projection && projection.answer.state === 'available'
    ? [projection.answer.value.ref.threadId]
    : null;
}
