import crypto from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import os from 'node:os';
import { join, resolve } from 'node:path';
import {
  canTransitionTaskStatus,
  createTaskSessionId,
  isTaskPriority,
  isTaskReferenceKind,
  isTaskStatus,
  isTaskWorkspaceAvailability,
  MAX_TASK_REFERENCES_PER_TASK,
  parseTaskTurnReference,
  type RelationGraphLink,
  type RelationGraphLinkInput,
  type RelationType,
  type SessionRelations,
  type TaskAssignmentClaimSummary,
  type TaskClaimStatus,
  type TaskCreateInput,
  type TaskDispatchInput,
  type TaskDispatchRecord,
  type TaskDispatchResult,
  type TaskGraph,
  type TaskKeptDeclaredPullRequest,
  type TaskKeptDeclaredPullRequestOutcome,
  type TaskRecord,
  type TaskReferenceInput,
  type TaskStatus,
  type TaskWorkspaceBinding,
  taskReferenceToRelationGraphLinkInput,
  validateRelationGraphLinkInput,
  validateTaskCreateInput,
  validateTaskReferenceInput,
} from '@kontourai/station-contracts';
import {
  type ClientOrigin,
  isClientOrigin,
} from '@kontourai/station-contracts/client-origin';
import type {
  EngineId,
  ProviderSession,
} from '@kontourai/station-contracts/provider';
import { looksLikeWorkflowTaskSlugRef } from '@kontourai/station-contracts/workflow';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { FileStorageAdapter } from '../../domain/file-storage-adapter.js';
import {
  graphLinkCreatedTotal,
  graphQueryTotal,
  taskAssignmentClaimTotal,
  taskDispatchStartLatencyMs,
  taskDispatchTotal,
  taskReferenceCreatedTotal,
  taskWorkspaceBindingTotal,
  taskWorkspaceOpenTotal,
} from '../../telemetry/metrics.js';
import { execGit } from '../../utils/git-exec.js';
import { expandTilde } from '../../utils/paths.js';
import type {
  AssignmentClaimActor,
  AssignmentClaimService,
} from '../evidence/assignment-claim-service.js';
import type { WorkflowSidecarService } from '../evidence/workflow-sidecar-service.js';
import { JsonFileStore } from '../infra/json-store.js';
import type { OrchestrationService } from '../orchestration/orchestration-service.js';
import type { SessionStartBoundaryClaim } from '../orchestration/session-turn-boundary.js';
import { createIsolatedTaskSearch } from '../search/isolated-task-search.js';
import { ProjectResourceResolver } from './project-resource-resolver.js';
import type { ProjectService } from './project-service.js';
import {
  resolveProjectWorkspaceOutcome,
  type WorkspacePathResolver,
} from './project-workspace-path.js';
import type { TaskDispatchExecutionAuthority } from './task-dispatcher.js';
import {
  type TaskDispatchReservation as DispatcherReservation,
  type TaskDispatchAssociation,
  type TaskDispatchClaims,
  type TaskDispatchGraphState,
  type TaskDispatchRemoteSessions,
  type TaskDispatchTelemetry,
} from './task-dispatcher.js';

interface TaskGraphStoreData {
  tasks: PersistedTaskRecord[];
  links: RelationGraphLink[];
  dispatches: TaskDispatchRecord[];
  /** Private, non-projected exact narrative revision retained by a Task Keep. */
  answerNarrativePins: PersistedTaskAnswerNarrativePin[];
  /** Private mutation receipts for identity-only declared PR curation. */
  declaredPullRequestKeeps: PersistedDeclaredPullRequestKeep[];
  declaredPullRequestKeepTombstones: PersistedDeclaredPullRequestKeepTombstone[];
}

type PersistedDeclaredPullRequestKeep = TaskKeptDeclaredPullRequest & {
  operationId: string;
  fingerprint: string;
  targetKey: string;
};
type PersistedDeclaredPullRequestKeepTombstone = {
  taskId: string;
  operationId: string;
  fingerprint: string;
  targetKey: string;
};

type PersistedTaskAnswerNarrativePin = {
  schemaVersion: 1;
  taskId: string;
  turnTargetId: string;
  associationRevision: number;
  capturedAt: string;
};

/** Internal only: routes obtain this from the association owner, never clients. */
export type TaskAnswerNarrativePinCapture = {
  associationRevision?: number;
  isCurrent(): boolean;
};

/**
 * A route-owned authorization witness evaluated only while the mutation lock
 * holds the freshly reloaded Task store. The graph never receives a Request,
 * credential, or Session owner; it only binds the caller's snapshot to the
 * actual Task record about to be changed.
 */
export interface TaskReferenceCommitAuthorization {
  expectedProjectId: string;
  isAuthorized(
    task: Pick<TaskRecord, 'id' | 'projectId' | 'workspaceBinding'>,
  ): boolean;
}

export class TaskReferenceAuthorizationError extends Error {
  constructor() {
    super('Task reference authorization is no longer current');
  }
}

export class TaskReferenceRejectedError extends Error {
  constructor(
    readonly reason: 'not-found' | 'invalid' | 'capacity',
    message: string,
  ) {
    super(message);
  }
}
export class TaskDeclaredOutputKeepConflictError extends Error {}
export class TaskDeclaredOutputKeepDeletedError extends Error {}

function taskReferenceAuthorizationCurrent(
  authorization: TaskReferenceCommitAuthorization,
  task: Pick<TaskRecord, 'id' | 'projectId' | 'workspaceBinding'>,
): boolean {
  if (task.projectId !== authorization.expectedProjectId) return false;
  try {
    return authorization.isAuthorized(task) === true;
  } catch {
    return false;
  }
}

/**
 * A persisted, short-lived handoff between the locked admission decision and
 * an asynchronous provider start. It is deliberately private to the graph
 * store: callers never receive a task as "started" until a dispatch record
 * exists.
 */
interface PersistedTaskDispatchReservation {
  generation: string;
  phase: 'pre_provider' | 'provider_starting' | 'indeterminate';
  sessionId: string;
  reservedAt: string;
  expiresAt: string;
  priorStatus: TaskStatus;
  priorDispatchedAt?: string;
  priorSessionId?: string;
}

type PersistedTaskRecord = TaskRecord & {
  dispatchReservation?: PersistedTaskDispatchReservation;
};

interface TaskDispatchReservation extends DispatcherReservation {
  task: PersistedTaskRecord;
  persisted: PersistedTaskDispatchReservation;
}

/** Typed admission truth stays inside the graph Adapter, never in message text. */
class TaskDispatchAdmissionError extends Error {
  constructor(
    readonly outcome: 'not-found' | 'contended' | 'terminal',
    message: string,
  ) {
    super(message);
    this.name = 'TaskDispatchAdmissionError';
  }
}

// Async-compatible seam (archive#2646): the default is the ASYNC cross-process lock
// so a contended acquisition yields the event loop; sync test fakes remain
// assignable (awaiting a non-promise is a no-op).
type TaskGraphMutationLock = (
  lockPath: string,
) => (() => void | Promise<void>) | Promise<() => void | Promise<void>>;

/**
 * The graph is an authoritative lifecycle record. A syntactically valid JSON
 * value with an invented field or a missing dispatch invariant is not an older
 * shape to repair: it is an unreadable graph and must remain untouched for
 * inspection.
 */
export class TaskGraphStoreShapeError extends Error {
  constructor(
    readonly filePath: string,
    readonly problems: readonly string[],
  ) {
    super(`Task graph store is unavailable: ${problems.join('; ')}`);
    this.name = 'TaskGraphStoreShapeError';
  }
}

interface TaskGraphServiceLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

type TaskDispatchOrchestration = Pick<
  OrchestrationService,
  'dispatch' | 'seedSessionRecord'
> &
  Partial<Pick<OrchestrationService, 'claimTaskDispatchBoundary'>>;

interface TaskGraphServiceDeps {
  orchestrationService?: TaskDispatchOrchestration;
  projectService?: Pick<ProjectService, 'getProject'>;
  execGit?: typeof execGit;
  /** AssignmentProvider claim/release/status backend (roadmap archive#584). When
   * absent (e.g. most tests), dispatch of a workItemRef-bearing task simply
   * skips claim tracking rather than throwing. */
  assignmentClaimService?: Pick<
    AssignmentClaimService,
    'claim' | 'release' | 'status'
  >;
  /** Resolve a projectId to its workspace path (the same resolver
   * `resolveWorkspacePath` in `runtime-routes.ts` already builds), used to
   * derive the AssignmentProvider `artifactRoot`
   * (`<workspace>/.kontourai/flow-agents`).
   *
   * May be async since archive#1501: production wires it to
   * `resolveProjectWorkspacePath`, which performs live filesystem/git checks
   * (`docs/design/portable-project-identity.md` §2.2.1, consumer A7). */
  resolveProjectWorkspace?: WorkspacePathResolver;
  /**
   * Read side of the workflow sidecar (archive#189 S4), used ONLY to confirm
   * that a task's bare-slug `workItemRef` names a sidecar that already exists
   * before a dispatch declares `metadata.taskSlug`. Absent (e.g. most tests)
   * means dispatch declares no task slug — the S4 join then falls back to the
   * run-correlation path exactly as it does for a session Station did not
   * start.
   */
  workflowSidecarReader?: Pick<WorkflowSidecarService, 'readState'>;
  logger?: TaskGraphServiceLogger;
  /** Injectable only to make cross-instance contention deterministic in tests. */
  acquireMutationLock?: TaskGraphMutationLock;
}

/** Concrete integrations captured at the TaskDispatcher composition Seam. */
export interface TaskDispatchAdapterDeps {
  orchestrationService?: TaskDispatchOrchestration;
  assignmentClaimService?: Pick<
    AssignmentClaimService,
    'claim' | 'release' | 'status'
  >;
  resolveProjectWorkspace?: WorkspacePathResolver;
}

/**
 * A `workItemRef` is only a safe AssignmentProvider subject id when it is
 * globally namespaced (the SAME contract invariant `ProviderWorkItem
 * .workItemRef` already documents, e.g. `github:owner/repo#123`) — a bare id
 * has no cross-provider meaning and must never be treated as a claimable
 * subject.
 */
function isNamespacedWorkItemRef(ref: string): boolean {
  return ref.includes(':');
}

function toClaimActor(actor: AssignmentClaimActor) {
  return {
    runtime: actor.runtime,
    sessionId: actor.session_id,
    host: actor.host,
    human: actor.human ?? null,
  };
}

function resultBucket(count: number): string {
  if (count === 0) return 'empty';
  if (count < 5) return '1_4';
  if (count < 20) return '5_19';
  return '20_plus';
}

function normalizeText(value: string | undefined): string {
  return value?.trim() ?? '';
}

function metricSourceSurface(value: unknown): string {
  const sourceSurface =
    typeof value === 'string' ? value.trim().toLowerCase() : '';
  switch (sourceSurface) {
    case 'api':
    case 'cli':
    case 'ui':
      return sourceSurface;
    default:
      return 'other';
  }
}

function metricReferenceKind(value: unknown): string {
  return typeof value === 'string' && isTaskReferenceKind(value)
    ? value
    : 'invalid';
}

function workspaceValuesConflict(
  supplied: TaskWorkspaceBinding | undefined,
  derived: TaskWorkspaceBinding,
): string | null {
  if (!supplied) return null;
  for (const key of [
    'availability',
    'workingDirectory',
    'repoRoot',
    'worktreePath',
    'branch',
  ] as const) {
    const actual = supplied[key];
    const expected = derived[key] ?? '';
    const equivalent =
      actual === undefined ||
      (key === 'workingDirectory' ||
      key === 'repoRoot' ||
      key === 'worktreePath'
        ? canonicalPathForComparison(actual) ===
          canonicalPathForComparison(expected)
        : actual.trim() === expected);
    if (!equivalent) {
      return `workspaceBinding.${key} conflicts with the server-derived Project workspace`;
    }
  }
  return null;
}

function canonicalPathForComparison(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return realpathSync(trimmed);
  } catch {
    return resolve(trimmed);
  }
}

function sameWorkspace(
  stored: TaskWorkspaceBinding | undefined,
  current: TaskWorkspaceBinding,
): boolean {
  return Boolean(
    stored &&
      stored.availability === 'available' &&
      current.availability === 'available' &&
      stored.workingDirectory === current.workingDirectory &&
      stored.repoRoot === current.repoRoot &&
      stored.worktreePath === current.worktreePath &&
      stored.branch === current.branch,
  );
}

type TaskReferenceMetricContext = {
  kind: string;
  sourceSurface: string;
};

function uniqueLinks(links: RelationGraphLink[]): RelationGraphLink[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = [
      link.sourceType,
      link.sourceId,
      link.targetType,
      link.targetId,
      link.relationType,
    ].join(':');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function linkIdentity(
  input: Pick<
    RelationGraphLink,
    'sourceType' | 'sourceId' | 'targetType' | 'targetId' | 'relationType'
  >,
): string {
  return [
    input.sourceType,
    input.sourceId,
    input.targetType,
    input.targetId,
    input.relationType,
  ].join(':');
}

function stripDeclaredPullRequestKeep(
  keep: PersistedDeclaredPullRequestKeep,
): TaskKeptDeclaredPullRequest {
  return {
    schemaVersion: 1,
    taskId: keep.taskId,
    provider: keep.provider,
    host: keep.host,
    repository: { owner: keep.repository.owner, name: keep.repository.name },
    ref: keep.ref,
    nativeId: keep.nativeId,
    provenance: {
      sessionId: keep.provenance.sessionId,
      turnId: keep.provenance.turnId,
      toolCallId: keep.provenance.toolCallId,
      declarationId: keep.provenance.declarationId,
      eventId: keep.provenance.eventId,
    },
    keptAt: keep.keptAt,
  };
}

const DISPATCH_RESERVATION_LEASE_MS = 5 * 60 * 1000;

const TASK_GRAPH_ROOT_KEYS = ['tasks', 'links', 'dispatches'] as const;
const TASK_GRAPH_ROOT_ALLOWED_KEYS = [
  ...TASK_GRAPH_ROOT_KEYS,
  'answerNarrativePins',
  'declaredPullRequestKeeps',
  'declaredPullRequestKeepTombstones',
] as const;
const TASK_RECORD_KEYS = [
  'id',
  'projectId',
  'title',
  'description',
  'priority',
  'status',
  'skillName',
  'agentId',
  'createdBy',
  'createdAt',
  'updatedAt',
  'createdClientOrigin',
  'updatedClientOrigin',
  'dispatchedAt',
  'sessionId',
  'workspaceBinding',
  'sourceProvider',
  'workItemRef',
  'dispatchReservation',
] as const;
const DISPATCH_RESERVATION_KEYS = [
  'generation',
  'phase',
  'sessionId',
  'reservedAt',
  'expiresAt',
  'priorStatus',
  'priorDispatchedAt',
  'priorSessionId',
] as const;
const WORKSPACE_BINDING_KEYS = [
  'availability',
  'workingDirectory',
  'repoRoot',
  'worktreePath',
  'branch',
  'sourceSurface',
  'clientOrigin',
  'capturedAt',
] as const;
const LINK_KEYS = [
  'id',
  'sourceType',
  'sourceId',
  'targetType',
  'targetId',
  'relationType',
  'confidence',
  'createdAt',
  'source',
  'metadata',
  'clientOrigin',
] as const;
const DISPATCH_KEYS = [
  'id',
  'taskId',
  'sessionId',
  'provider',
  'outcome',
  'createdAt',
  'sourceSurface',
  'clientOrigin',
  'claim',
] as const;
const CLAIM_KEYS = [
  'outcome',
  'subjectId',
  'actor',
  'kind',
  'holderActor',
  'reason',
  'claimedAt',
] as const;
const CLAIM_ACTOR_KEYS = ['runtime', 'sessionId', 'host', 'human'] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

function validateExactObject(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
  at: string,
  problems: string[],
): value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    problems.push(`${at}: must be an object`);
    return false;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) problems.push(`${at}.${key}: unknown field`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) problems.push(`${at}.${key}: required`);
  }
  return true;
}

function validateNonBlankString(
  value: unknown,
  at: string,
  problems: string[],
): value is string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.trim() !== value
  ) {
    problems.push(`${at}: must be a canonical non-blank string`);
    return false;
  }
  return true;
}

function isCanonicalUuidV4(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

function validateStationGeneratedId(
  value: unknown,
  at: string,
  problems: string[],
): value is string {
  if (!isCanonicalUuidV4(value)) {
    problems.push(`${at}: must be a canonical UUIDv4`);
    return false;
  }
  return true;
}

function validateCanonicalTimestamp(
  value: unknown,
  at: string,
  problems: string[],
): value is string {
  if (!validateNonBlankString(value, at, problems)) return false;
  const parsed = new Date(value);
  const canonical = parsed.toISOString();
  // Every Station-authored timestamp is emitted through `toISOString()`.
  // Any alternate spelling is persisted corruption, not a value to rewrite.
  if (Number.isNaN(parsed.getTime()) || value !== canonical) {
    problems.push(`${at}: must be a canonical ISO timestamp`);
    return false;
  }
  return true;
}

function canonicalizeProviderTimestamp(value: string, field: string): string {
  // AssignmentProvider emits UTC RFC3339 timestamps. It may omit the
  // fractional component or include it at source precision; Station records
  // the canonical millisecond form below. Do not let Date's locale and
  // offset parsing reinterpret a provider claim before it is persisted.
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?Z$/.exec(
    value,
  );
  if (!match) {
    throw new Error(`${field} must be an RFC3339 UTC timestamp`);
  }
  const parsed = new Date(value);
  // Date accepts the grammar above but still normalizes invalid calendar
  // components in some runtimes. Preserve the complete-second component to
  // reject those values rather than silently changing a provider claim.
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 19) !== match[1]
  ) {
    throw new Error(`${field} must be an RFC3339 UTC timestamp`);
  }
  return parsed.toISOString();
}

function validateOptionalText(
  value: unknown,
  at: string,
  problems: string[],
): void {
  if (value === undefined) return;
  validateNonBlankString(value, at, problems);
}

function validateClientOrigin(
  value: unknown,
  at: string,
  problems: string[],
): void {
  if (value !== undefined && !isClientOrigin(value)) {
    problems.push(`${at}: invalid client origin`);
  }
}

function validateClaimActor(
  value: unknown,
  at: string,
  problems: string[],
): void {
  if (
    !validateExactObject(
      value,
      CLAIM_ACTOR_KEYS,
      ['runtime', 'sessionId', 'host'],
      at,
      problems,
    )
  ) {
    return;
  }
  validateNonBlankString(value.runtime, `${at}.runtime`, problems);
  validateNonBlankString(value.sessionId, `${at}.sessionId`, problems);
  validateNonBlankString(value.host, `${at}.host`, problems);
  if (
    value.human !== undefined &&
    value.human !== null &&
    !validateNonBlankString(value.human, `${at}.human`, problems)
  ) {
    return;
  }
}

function validateTaskGraphStoreData(
  value: unknown,
  filePath: string,
): TaskGraphStoreData {
  const problems: string[] = [];
  if (
    !validateExactObject(
      value,
      TASK_GRAPH_ROOT_ALLOWED_KEYS,
      TASK_GRAPH_ROOT_KEYS,
      'task graph',
      problems,
    )
  ) {
    throw new TaskGraphStoreShapeError(filePath, problems);
  }
  for (const key of TASK_GRAPH_ROOT_KEYS) {
    if (!Array.isArray(value[key]))
      problems.push(`task graph.${key}: must be an array`);
  }
  if (
    value.answerNarrativePins !== undefined &&
    !Array.isArray(value.answerNarrativePins)
  ) {
    problems.push('task graph.answerNarrativePins: must be an array');
  }
  if (
    value.declaredPullRequestKeeps !== undefined &&
    !Array.isArray(value.declaredPullRequestKeeps)
  )
    problems.push('task graph.declaredPullRequestKeeps: must be an array');
  if (
    value.declaredPullRequestKeepTombstones !== undefined &&
    !Array.isArray(value.declaredPullRequestKeepTombstones)
  )
    problems.push(
      'task graph.declaredPullRequestKeepTombstones: must be an array',
    );
  if (problems.length > 0)
    throw new TaskGraphStoreShapeError(filePath, problems);

  const taskIds = new Set<string>();
  const reservationSessionIds = new Set<string>();
  for (const [index, task] of (value.tasks as unknown[]).entries()) {
    const at = `tasks[${index}]`;
    if (
      !validateExactObject(
        task,
        TASK_RECORD_KEYS,
        [
          'id',
          'projectId',
          'title',
          'description',
          'priority',
          'status',
          'createdBy',
          'createdAt',
          'updatedAt',
        ],
        at,
        problems,
      )
    ) {
      continue;
    }
    if (validateStationGeneratedId(task.id, `${at}.id`, problems)) {
      if (taskIds.has(task.id)) problems.push(`${at}.id: duplicate task id`);
      taskIds.add(task.id);
    }
    validateNonBlankString(task.projectId, `${at}.projectId`, problems);
    validateNonBlankString(task.title, `${at}.title`, problems);
    if (typeof task.description !== 'string') {
      problems.push(`${at}.description: must be a string`);
    }
    if (typeof task.priority !== 'string' || !isTaskPriority(task.priority)) {
      problems.push(`${at}.priority: invalid task priority`);
    }
    if (typeof task.status !== 'string' || !isTaskStatus(task.status)) {
      problems.push(`${at}.status: invalid task status`);
    }
    validateNonBlankString(task.createdBy, `${at}.createdBy`, problems);
    validateCanonicalTimestamp(task.createdAt, `${at}.createdAt`, problems);
    validateCanonicalTimestamp(task.updatedAt, `${at}.updatedAt`, problems);
    validateClientOrigin(
      task.createdClientOrigin,
      `${at}.createdClientOrigin`,
      problems,
    );
    validateClientOrigin(
      task.updatedClientOrigin,
      `${at}.updatedClientOrigin`,
      problems,
    );
    validateOptionalText(task.skillName, `${at}.skillName`, problems);
    validateOptionalText(task.agentId, `${at}.agentId`, problems);
    validateOptionalText(task.dispatchedAt, `${at}.dispatchedAt`, problems);
    if (task.dispatchedAt !== undefined) {
      validateCanonicalTimestamp(
        task.dispatchedAt,
        `${at}.dispatchedAt`,
        problems,
      );
    }
    validateOptionalText(task.sessionId, `${at}.sessionId`, problems);
    validateOptionalText(task.sourceProvider, `${at}.sourceProvider`, problems);
    validateOptionalText(task.workItemRef, `${at}.workItemRef`, problems);
    if (task.workspaceBinding === undefined) {
      problems.push(`${at}.workspaceBinding: required`);
    } else if (
      validateExactObject(
        task.workspaceBinding,
        WORKSPACE_BINDING_KEYS,
        [],
        `${at}.workspaceBinding`,
        problems,
      )
    ) {
      const binding = task.workspaceBinding;
      if (
        binding.availability !== undefined &&
        (typeof binding.availability !== 'string' ||
          !isTaskWorkspaceAvailability(binding.availability))
      ) {
        problems.push(`${at}.workspaceBinding.availability: invalid value`);
      }
      for (const key of [
        'workingDirectory',
        'repoRoot',
        'worktreePath',
        'branch',
        'sourceSurface',
      ] as const) {
        validateOptionalText(
          binding[key],
          `${at}.workspaceBinding.${key}`,
          problems,
        );
      }
      if (binding.capturedAt !== undefined) {
        validateCanonicalTimestamp(
          binding.capturedAt,
          `${at}.workspaceBinding.capturedAt`,
          problems,
        );
      }
    }
    if (task.dispatchReservation !== undefined) {
      if (
        validateExactObject(
          task.dispatchReservation,
          DISPATCH_RESERVATION_KEYS,
          [
            'generation',
            'phase',
            'sessionId',
            'reservedAt',
            'expiresAt',
            'priorStatus',
          ],
          `${at}.dispatchReservation`,
          problems,
        )
      ) {
        const reservation = task.dispatchReservation;
        validateStationGeneratedId(
          reservation.generation,
          `${at}.dispatchReservation.generation`,
          problems,
        );
        if (
          reservation.phase !== 'pre_provider' &&
          reservation.phase !== 'provider_starting' &&
          reservation.phase !== 'indeterminate'
        ) {
          problems.push(`${at}.dispatchReservation.phase: invalid phase`);
        }
        if (
          validateNonBlankString(
            reservation.sessionId,
            `${at}.dispatchReservation.sessionId`,
            problems,
          )
        ) {
          if (reservationSessionIds.has(reservation.sessionId)) {
            problems.push(
              `${at}.dispatchReservation.sessionId: duplicate reservation`,
            );
          }
          reservationSessionIds.add(reservation.sessionId);
          if (task.sessionId !== reservation.sessionId) {
            problems.push(`${at}.sessionId: must match dispatch reservation`);
          }
        }
        validateCanonicalTimestamp(
          reservation.reservedAt,
          `${at}.dispatchReservation.reservedAt`,
          problems,
        );
        validateCanonicalTimestamp(
          reservation.expiresAt,
          `${at}.dispatchReservation.expiresAt`,
          problems,
        );
        if (
          typeof reservation.reservedAt === 'string' &&
          typeof reservation.expiresAt === 'string' &&
          Date.parse(reservation.expiresAt) -
            Date.parse(reservation.reservedAt) !==
            DISPATCH_RESERVATION_LEASE_MS
        ) {
          problems.push(`${at}.dispatchReservation: invalid lease duration`);
        }
        if (
          typeof reservation.priorStatus !== 'string' ||
          !isTaskStatus(reservation.priorStatus)
        ) {
          problems.push(
            `${at}.dispatchReservation.priorStatus: invalid status`,
          );
        }
        if (task.status !== 'in_progress') {
          problems.push(`${at}.status: reservation requires in_progress`);
        }
        if (task.dispatchedAt !== reservation.reservedAt) {
          problems.push(`${at}.dispatchedAt: must equal reservation time`);
        }
        if (task.updatedAt !== reservation.reservedAt) {
          problems.push(`${at}.updatedAt: must equal reservation time`);
        }
        if (reservation.priorDispatchedAt !== undefined) {
          validateCanonicalTimestamp(
            reservation.priorDispatchedAt,
            `${at}.dispatchReservation.priorDispatchedAt`,
            problems,
          );
        }
        if (reservation.priorSessionId !== undefined) {
          validateNonBlankString(
            reservation.priorSessionId,
            `${at}.dispatchReservation.priorSessionId`,
            problems,
          );
        }
      }
    }
  }

  const linkIds = new Set<string>();
  const linkIdentities = new Set<string>();
  for (const [index, link] of (value.links as unknown[]).entries()) {
    const at = `links[${index}]`;
    if (
      !validateExactObject(
        link,
        LINK_KEYS,
        [
          'id',
          'sourceType',
          'sourceId',
          'targetType',
          'targetId',
          'relationType',
          'confidence',
          'createdAt',
          'source',
        ],
        at,
        problems,
      )
    ) {
      continue;
    }
    if (validateStationGeneratedId(link.id, `${at}.id`, problems)) {
      if (linkIds.has(link.id)) problems.push(`${at}.id: duplicate link id`);
      linkIds.add(link.id);
    }
    const relationProblems = validateRelationGraphLinkInput({
      sourceType: link.sourceType as RelationGraphLink['sourceType'],
      sourceId: link.sourceId as string,
      targetType: link.targetType as RelationGraphLink['targetType'],
      targetId: link.targetId as string,
      relationType: link.relationType as RelationGraphLink['relationType'],
      confidence: link.confidence as number,
      source: link.source as RelationGraphLink['source'],
      metadata: link.metadata as Record<string, unknown> | undefined,
    });
    problems.push(...relationProblems.map((problem) => `${at}: ${problem}`));
    validateCanonicalTimestamp(link.createdAt, `${at}.createdAt`, problems);
    validateClientOrigin(link.clientOrigin, `${at}.clientOrigin`, problems);
    if (
      typeof link.sourceType === 'string' &&
      typeof link.sourceId === 'string' &&
      typeof link.targetType === 'string' &&
      typeof link.targetId === 'string' &&
      typeof link.relationType === 'string'
    ) {
      const identity = linkIdentity(link as unknown as RelationGraphLink);
      if (linkIdentities.has(identity))
        problems.push(`${at}: duplicate relation link`);
      linkIdentities.add(identity);
    }
  }

  const dispatchIds = new Set<string>();
  const sessions = new Set<string>();
  for (const [index, dispatch] of (value.dispatches as unknown[]).entries()) {
    const at = `dispatches[${index}]`;
    if (
      !validateExactObject(
        dispatch,
        DISPATCH_KEYS,
        [
          'id',
          'taskId',
          'sessionId',
          'provider',
          'outcome',
          'createdAt',
          'sourceSurface',
        ],
        at,
        problems,
      )
    ) {
      continue;
    }
    if (validateStationGeneratedId(dispatch.id, `${at}.id`, problems)) {
      if (dispatchIds.has(dispatch.id))
        problems.push(`${at}.id: duplicate dispatch id`);
      dispatchIds.add(dispatch.id);
    }
    if (
      validateNonBlankString(dispatch.taskId, `${at}.taskId`, problems) &&
      !taskIds.has(dispatch.taskId)
    ) {
      problems.push(`${at}.taskId: does not name a stored task`);
    }
    if (
      validateNonBlankString(dispatch.sessionId, `${at}.sessionId`, problems)
    ) {
      if (sessions.has(dispatch.sessionId))
        problems.push(`${at}.sessionId: duplicate dispatch session`);
      sessions.add(dispatch.sessionId);
    }
    validateNonBlankString(dispatch.provider, `${at}.provider`, problems);
    validateClientOrigin(dispatch.clientOrigin, `${at}.clientOrigin`, problems);
    if (dispatch.outcome !== 'started' && dispatch.outcome !== 'seeded') {
      problems.push(`${at}.outcome: invalid dispatch outcome`);
    }
    validateCanonicalTimestamp(dispatch.createdAt, `${at}.createdAt`, problems);
    validateNonBlankString(
      dispatch.sourceSurface,
      `${at}.sourceSurface`,
      problems,
    );
    if (dispatch.claim !== undefined) {
      if (
        validateExactObject(
          dispatch.claim,
          CLAIM_KEYS,
          ['outcome', 'subjectId'],
          `${at}.claim`,
          problems,
        )
      ) {
        const claim = dispatch.claim;
        const outcome = claim.outcome;
        if (
          outcome !== 'claimed' &&
          outcome !== 'blocked' &&
          outcome !== 'unavailable' &&
          outcome !== 'released'
        )
          problems.push(`${at}.claim.outcome: invalid claim outcome`);
        validateNonBlankString(
          claim.subjectId,
          `${at}.claim.subjectId`,
          problems,
        );
        if (outcome === 'claimed' || outcome === 'released') {
          if (claim.actor === undefined)
            problems.push(`${at}.claim.actor: required for ${outcome}`);
          else validateClaimActor(claim.actor, `${at}.claim.actor`, problems);
          if (claim.claimedAt === undefined)
            problems.push(`${at}.claim.claimedAt: required for ${outcome}`);
          else
            validateCanonicalTimestamp(
              claim.claimedAt,
              `${at}.claim.claimedAt`,
              problems,
            );
          for (const key of ['kind', 'holderActor', 'reason'] as const) {
            if (claim[key] !== undefined)
              problems.push(`${at}.claim.${key}: forbidden for ${outcome}`);
          }
        } else if (outcome === 'blocked') {
          if (claim.kind !== 'conflict' && claim.kind !== 'operational-error')
            problems.push(`${at}.claim.kind: required blocked kind`);
          if (claim.reason === undefined)
            problems.push(`${at}.claim.reason: required for blocked`);
          else
            validateNonBlankString(
              claim.reason,
              `${at}.claim.reason`,
              problems,
            );
          if (claim.actor !== undefined || claim.claimedAt !== undefined)
            problems.push(
              `${at}.claim: actor and claimedAt forbidden for blocked`,
            );
          if (claim.kind === 'conflict' && claim.holderActor !== undefined)
            validateClaimActor(
              claim.holderActor,
              `${at}.claim.holderActor`,
              problems,
            );
          if (
            claim.kind === 'operational-error' &&
            claim.holderActor !== undefined
          )
            problems.push(
              `${at}.claim.holderActor: forbidden for operational error`,
            );
        } else if (outcome === 'unavailable') {
          if (claim.reason === undefined)
            problems.push(`${at}.claim.reason: required for unavailable`);
          else
            validateNonBlankString(
              claim.reason,
              `${at}.claim.reason`,
              problems,
            );
          for (const key of [
            'actor',
            'kind',
            'holderActor',
            'claimedAt',
          ] as const) {
            if (claim[key] !== undefined)
              problems.push(`${at}.claim.${key}: forbidden for unavailable`);
          }
        }
      }
    }
  }

  for (const sessionId of reservationSessionIds) {
    if (sessions.has(sessionId)) {
      problems.push(
        `dispatches: reservation session ${sessionId} already has a dispatch`,
      );
    }
  }

  const pins = Array.isArray(value.answerNarrativePins)
    ? value.answerNarrativePins
    : [];
  const pinKeys = new Set<string>();
  for (const [index, pin] of pins.entries()) {
    const at = `answerNarrativePins[${index}]`;
    if (
      !validateExactObject(
        pin,
        [
          'schemaVersion',
          'taskId',
          'turnTargetId',
          'associationRevision',
          'capturedAt',
        ],
        [
          'schemaVersion',
          'taskId',
          'turnTargetId',
          'associationRevision',
          'capturedAt',
        ],
        at,
        problems,
      )
    )
      continue;
    if (pin.schemaVersion !== 1) problems.push(`${at}.schemaVersion: invalid`);
    validateNonBlankString(pin.taskId, `${at}.taskId`, problems);
    validateNonBlankString(pin.turnTargetId, `${at}.turnTargetId`, problems);
    if (
      typeof pin.associationRevision !== 'number' ||
      !Number.isSafeInteger(pin.associationRevision) ||
      pin.associationRevision < 1
    )
      problems.push(`${at}.associationRevision: invalid`);
    validateCanonicalTimestamp(pin.capturedAt, `${at}.capturedAt`, problems);
    const key = `${String(pin.taskId)}\0${String(pin.turnTargetId)}`;
    if (pinKeys.has(key)) problems.push(`${at}: duplicate pin`);
    pinKeys.add(key);
    if (
      !taskIds.has(String(pin.taskId)) ||
      !parseTaskTurnReference(String(pin.turnTargetId)) ||
      !(Array.isArray(value.links) ? value.links : []).some(
        (link) =>
          link.sourceType === 'task' &&
          link.sourceId === pin.taskId &&
          link.targetType === 'turn' &&
          link.relationType === 'references_turn' &&
          link.targetId === pin.turnTargetId,
      )
    )
      problems.push(`${at}: must pin an existing Task turn reference`);
  }
  const keeps = Array.isArray(value.declaredPullRequestKeeps)
    ? value.declaredPullRequestKeeps
    : [];
  const keepTargets = new Set<string>();
  for (const [index, keep] of keeps.entries()) {
    const at = `declaredPullRequestKeeps[${index}]`;
    if (
      !validateExactObject(
        keep,
        [
          'schemaVersion',
          'taskId',
          'provider',
          'host',
          'repository',
          'ref',
          'nativeId',
          'provenance',
          'keptAt',
          'operationId',
          'fingerprint',
          'targetKey',
        ],
        [
          'schemaVersion',
          'taskId',
          'provider',
          'host',
          'repository',
          'ref',
          'nativeId',
          'provenance',
          'keptAt',
          'operationId',
          'fingerprint',
          'targetKey',
        ],
        at,
        problems,
      )
    )
      continue;
    if (keep.schemaVersion !== 1) problems.push(`${at}.schemaVersion: invalid`);
    for (const key of [
      'taskId',
      'provider',
      'host',
      'ref',
      'nativeId',
      'operationId',
      'fingerprint',
      'targetKey',
    ] as const) {
      validateNonBlankString(keep[key], `${at}.${key}`, problems);
      if (typeof keep[key] === 'string' && keep[key].length > 4096)
        problems.push(`${at}.${key}: too long`);
    }
    if (typeof keep.operationId === 'string' && keep.operationId.length > 160)
      problems.push(`${at}.operationId: too long`);
    validateCanonicalTimestamp(keep.keptAt, `${at}.keptAt`, problems);
    if (
      validateExactObject(
        keep.repository,
        ['owner', 'name'],
        ['owner', 'name'],
        `${at}.repository`,
        problems,
      )
    ) {
      validateNonBlankString(
        keep.repository.owner,
        `${at}.repository.owner`,
        problems,
      );
      validateNonBlankString(
        keep.repository.name,
        `${at}.repository.name`,
        problems,
      );
      if (
        (typeof keep.repository.owner === 'string' &&
          keep.repository.owner.length > 256) ||
        (typeof keep.repository.name === 'string' &&
          keep.repository.name.length > 256)
      )
        problems.push(`${at}.repository: too long`);
    }
    if (
      validateExactObject(
        keep.provenance,
        ['sessionId', 'turnId', 'toolCallId', 'declarationId', 'eventId'],
        ['sessionId', 'turnId', 'toolCallId', 'declarationId', 'eventId'],
        `${at}.provenance`,
        problems,
      )
    )
      for (const key of [
        'sessionId',
        'turnId',
        'toolCallId',
        'declarationId',
        'eventId',
      ] as const) {
        validateNonBlankString(
          keep.provenance[key],
          `${at}.provenance.${key}`,
          problems,
        );
        if (
          typeof keep.provenance[key] === 'string' &&
          keep.provenance[key].length > 1024
        )
          problems.push(`${at}.provenance.${key}: too long`);
      }
    if (!taskIds.has(String(keep.taskId)))
      problems.push(`${at}.taskId: missing`);
    const key = `${String(keep.taskId)}\0${String(keep.targetKey)}`;
    if (keepTargets.has(key)) problems.push(`${at}: duplicate target`);
    keepTargets.add(key);
  }
  const tombstones = Array.isArray(value.declaredPullRequestKeepTombstones)
    ? value.declaredPullRequestKeepTombstones
    : [];
  for (const [index, tombstone] of tombstones.entries()) {
    const at = `declaredPullRequestKeepTombstones[${index}]`;
    if (
      !validateExactObject(
        tombstone,
        ['taskId', 'operationId', 'fingerprint', 'targetKey'],
        ['taskId', 'operationId', 'fingerprint', 'targetKey'],
        at,
        problems,
      )
    )
      continue;
    for (const key of [
      'taskId',
      'operationId',
      'fingerprint',
      'targetKey',
    ] as const)
      validateNonBlankString(tombstone[key], `${at}.${key}`, problems);
  }
  if (problems.length > 0)
    throw new TaskGraphStoreShapeError(filePath, problems);
  return {
    ...(value as unknown as Omit<
      TaskGraphStoreData,
      | 'answerNarrativePins'
      | 'declaredPullRequestKeeps'
      | 'declaredPullRequestKeepTombstones'
    >),
    answerNarrativePins: pins as PersistedTaskAnswerNarrativePin[],
    declaredPullRequestKeeps: keeps as PersistedDeclaredPullRequestKeep[],
    declaredPullRequestKeepTombstones:
      tombstones as PersistedDeclaredPullRequestKeepTombstone[],
  };
}

/**
 * A `ProjectResourceResolver` whose PROJECT source is the injected
 * `projectService` and whose manifest/binding stores live under
 * `projectHomeDir` (archive#1501, seam S4).
 *
 * Not the resolver's default (`new FileStorageAdapter(homeDir)`) deliberately.
 * In production the two are the same object graph — `runtime-routes.ts` wires
 * `context.projectService`, which reads `context.configLoader
 * .getProjectHomeDir()`, the same directory this service was constructed over.
 * But `projectService` is an injection point, and letting the resolver read a
 * DIFFERENT project store than the one this service was handed would be a
 * silent second source of truth about where a project lives — the exact defect
 * class this seam migration exists to remove. `listLayouts` is delegated
 * rather than stubbed: `composeManifest` reads it for real once a manifest
 * exists, and a `() => []` stub would quietly report a manifest with no
 * layouts.
 */
function buildProjectResourceResolver(
  projectHomeDir: string,
  projectService: Pick<ProjectService, 'getProject'>,
): ProjectResourceResolver {
  const storage = new FileStorageAdapter(projectHomeDir);
  return new ProjectResourceResolver({
    homeDir: projectHomeDir,
    source: {
      getProject: (slug) => projectService.getProject(slug),
      listLayouts: (slug) => storage.listLayouts(slug),
    },
  });
}

function createTaskGraphStore(storePath: string, maxReadBytes?: number) {
  return new JsonFileStore<TaskGraphStoreData>(
    storePath,
    {
      tasks: [],
      links: [],
      dispatches: [],
      answerNarrativePins: [],
      declaredPullRequestKeeps: [],
      declaredPullRequestKeepTombstones: [],
    },
    { onCorruption: 'throw', durableAtomicWrite: true, maxReadBytes },
  );
}

/** Owner-private worker read: the same canonical parser and recovery as TaskGraph. */
export function readTaskGraphForIsolatedSearch(
  storePath: string,
  maxReadBytes: number,
): TaskRecord[] {
  const data = validateTaskGraphStoreData(
    createTaskGraphStore(storePath, maxReadBytes).read(),
    storePath,
  );
  return data.tasks.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export class TaskGraphService {
  private readonly storePath: string;
  private readonly store: JsonFileStore<TaskGraphStoreData>;
  private readonly acquireMutationLock: TaskGraphMutationLock;
  private readonly projectService?: Pick<ProjectService, 'getProject'>;
  /**
   * archive#1501, seam S4. Captured with `projectService` at this
   * Module's construction seam, so the two can never answer differently about
   * the same project during this graph's lifetime.
   */
  private readonly projectResourceResolver?: ProjectResourceResolver;
  private readonly runGit: typeof execGit;
  private readonly orchestrationService: TaskDispatchOrchestration | undefined;
  private readonly assignmentClaimService:
    | Pick<AssignmentClaimService, 'claim' | 'release' | 'status'>
    | undefined;
  private readonly resolveProjectWorkspace?: WorkspacePathResolver;
  private readonly workflowSidecarReader?: Pick<
    WorkflowSidecarService,
    'readState'
  >;
  private readonly logger?: TaskGraphServiceLogger;

  constructor(projectHomeDir: string, deps: TaskGraphServiceDeps = {}) {
    this.orchestrationService = deps.orchestrationService;
    this.projectService = deps.projectService;
    this.projectResourceResolver = deps.projectService
      ? buildProjectResourceResolver(projectHomeDir, deps.projectService)
      : undefined;
    this.runGit = deps.execGit ?? execGit;
    this.assignmentClaimService = deps.assignmentClaimService;
    this.resolveProjectWorkspace = deps.resolveProjectWorkspace;
    this.workflowSidecarReader = deps.workflowSidecarReader;
    this.logger = deps.logger;
    this.storePath = join(projectHomeDir, 'task-graph.json');
    this.store = createTaskGraphStore(this.storePath);
    this.acquireMutationLock =
      deps.acquireMutationLock ?? acquireFileMutationLockAsync;
  }

  /**
   * The flow-agents task slug a dispatch of `task` should declare as
   * `metadata.taskSlug`, or undefined when there is none to declare
   * (archive#189 S4 — "populate `metadata.taskSlug` when Station starts a
   * builder session").
   *
   * Two conditions, both required, neither of them a heuristic:
   *
   *  1. `workItemRef` is a BARE flow-agents slug — the identity-grade join
   *     archive#594/#582 already established. A namespaced ref (`github:owner/repo#1`)
   *     names a work item, not a sidecar directory, and the slugified-title
   *     fallback is explicitly not used here: this value binds a session to a
   *     durable artifact, and archive#582 settled that a heuristic must never be
   *     presented as identity.
   *  2. That sidecar ALREADY EXISTS in the workspace THIS SESSION WILL RUN
   *     IN. `metadata.taskSlug` is create-or-resume downstream (`ensureTask`),
   *     so declaring an unverified slug would have Station manufacture
   *     `.kontourai/flow-agents/<slug>/` directories in the user's repo as a
   *     side effect of a read-side join. Station joins Builder runs; it does
   *     not invent them.
   *
   * The workspace checked is deliberately the dispatch's own
   * `runtimeConfig.cwd` and nothing else — the project's `workingDirectory` is
   * NOT a substitute, because a dispatch that supplies no cwd carries no
   * `projectSlug` either and its session resolves to `$HOME` rather than the
   * project directory. Checking one workspace and binding in another is how a
   * verified-existence check turns back into an unverified one. The tilde
   * expansion and `resolve` mirror `resolveStartSessionCwd` so a `~/…` cwd is
   * not a false negative.
   *
   * That mirroring is close, not identical, and the gap is worth naming: a
   * fresh dispatch runs through `resolveStartSessionCwd`, but the
   * already-exists branch of `startSession` binds the RAW input instead, so
   * for that branch the value attached is the unresolved one. A dispatch
   * always allocates a new `sessionId`, so it takes the fresh path; the caveat
   * matters only if that ever stops being true.
   *
   * Never throws: an unreadable or malformed sidecar means no slug, which
   * degrades to the correlation path rather than failing the dispatch.
   */
  private resolveDispatchTaskSlug(
    task: TaskRecord,
    cwd: string | undefined,
  ): string | undefined {
    const reader = this.workflowSidecarReader;
    const ref = normalizeText(task.workItemRef);
    if (!reader || !ref || !cwd || isNamespacedWorkItemRef(ref)) {
      return undefined;
    }
    if (!looksLikeWorkflowTaskSlugRef(ref)) return undefined;
    try {
      return reader.readState(resolve(expandTilde(cwd)), ref) ? ref : undefined;
    } catch (error) {
      this.logger?.warn('Could not read workflow sidecar for dispatch', {
        taskId: task.id,
        taskSlug: ref,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private loadStore(): TaskGraphStoreData {
    return validateTaskGraphStoreData(this.store.read(), this.storePath);
  }

  /**
   * A reservation has no durable provider session until its matching dispatch
   * record is published. If the process dies in that interval, its lease is
   * the explicit authority for a later mutation to restore the task's prior
   * state. A record that somehow contains both is rejected by schema
   * validation rather than guessing which side is authoritative.
   */
  private reconcileExpiredDispatchReservations(
    data: TaskGraphStoreData,
  ): TaskGraphStoreData {
    const now = Date.now();
    let changed = false;
    const tasks = data.tasks.map((task) => {
      const reservation = task.dispatchReservation;
      if (!reservation) return task;
      if (reservation.phase !== 'pre_provider') return task;
      if (Date.parse(reservation.expiresAt) > now) return task;
      changed = true;
      const { dispatchReservation: _reservation, ...unreserved } = task;
      return {
        ...unreserved,
        status: reservation.priorStatus,
        dispatchedAt: reservation.priorDispatchedAt,
        sessionId: reservation.priorSessionId,
        updatedAt: new Date(now).toISOString(),
      };
    });
    return changed ? { ...data, tasks } : data;
  }

  /**
   * Runs an authoritative transition against a newly read document while the
   * cross-process lock is held. The lock surrounds the read as well as the
   * durable write: an atomic rename alone prevents torn JSON but does not
   * prevent a stale instance from discarding another instance's task/link.
   */
  private async mutateStore<T>(
    transition: (data: TaskGraphStoreData) => {
      data: TaskGraphStoreData;
      result: T;
    },
  ): Promise<T> {
    const release = await this.acquireMutationLock(
      `${this.storePath}.mutation`,
    );
    try {
      const data = this.reconcileExpiredDispatchReservations(this.loadStore());
      const next = transition(structuredClone(data));
      validateTaskGraphStoreData(next.data, this.storePath);
      this.store.write(next.data);
      return next.result;
    } finally {
      await release();
    }
  }

  private readStore(): TaskGraphStoreData {
    return this.loadStore();
  }

  /** Read-only task lookup used by capability descriptors. */
  private readStoreView(): TaskGraphStoreData {
    return this.loadStore();
  }

  listTasks(projectId?: string): TaskRecord[] {
    const tasks = this.readStore().tasks;
    return tasks
      .filter((task) => !projectId || task.projectId === projectId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  /**
   * Personal-only, explicit lifecycle. Composition owns one reader per runtime
   * and must close it; this does not authorize a hosted or external caller.
   * No route/runtime caller is installed by the Task search tracer (#1413).
   */
  createPersonalSearchReader(stationId: string) {
    return createIsolatedTaskSearch({ storePath: this.storePath, stationId });
  }

  readTask(taskId: string): TaskRecord | null {
    return this.readStore().tasks.find((task) => task.id === taskId) ?? null;
  }

  /**
   * Minimal read authority for protected turn references. A malformed legacy
   * tuple must degrade only that answer to the opaque unavailable state; it
   * must not make every Task unreadable or weaken the strict generic store
   * validator used by all normal graph reads and mutations.
   */
  readTaskTurnReferenceScope(taskId: string): { projectId: string } | null {
    try {
      const task = this.readStore().tasks.find((item) => item.id === taskId);
      return task ? { projectId: task.projectId } : null;
    } catch (error) {
      if (!(error instanceof TaskGraphStoreShapeError)) throw error;
      const raw = this.store.read() as unknown;
      if (!isPlainObject(raw) || !Array.isArray(raw.tasks)) return null;
      const task = raw.tasks.find(
        (item): item is Record<string, unknown> =>
          isPlainObject(item) && item.id === taskId,
      );
      return task && typeof task.projectId === 'string' && task.projectId.trim()
        ? { projectId: task.projectId }
        : null;
    }
  }

  /** Minimal read authority for protected authored-input references. */
  readTaskUserInputReferenceScope(
    taskId: string,
  ): { projectId: string } | null {
    return this.readTaskTurnReferenceScope(taskId);
  }

  /** Non-persisting counterpart to `readTask` for capability intent binding. */
  readTaskView(taskId: string): TaskRecord | null {
    return (
      this.readStoreView().tasks.find((task) => task.id === taskId) ?? null
    );
  }

  async readTaskForOpen(taskId: string): Promise<TaskRecord | null> {
    const task = this.readTask(taskId);
    if (!task) return null;
    return {
      ...task,
      workspaceBinding: await this.resolveWorkspaceForOpen(task),
    };
  }

  async createTask(
    input: TaskCreateInput,
    clientOrigin?: ClientOrigin,
    taskId: string = crypto.randomUUID(),
  ): Promise<TaskRecord> {
    const sourceSurface = metricSourceSurface(
      input.workspaceBinding?.sourceSurface,
    );
    const errors = validateTaskCreateInput(input);
    if (errors.length > 0) {
      taskWorkspaceBindingTotal.add(1, {
        outcome: 'unavailable',
        source_surface: sourceSurface,
      });
      throw new Error(errors.join('; '));
    }

    const now = new Date().toISOString();
    const workspaceBinding = await this.captureWorkspaceBinding(
      input,
      now,
      sourceSurface,
    );
    const task: TaskRecord = {
      id: taskId,
      projectId: input.projectId.trim(),
      title: input.title.trim(),
      description: normalizeText(input.description),
      priority: input.priority ?? 'normal',
      status: 'todo',
      skillName: normalizeText(input.skillName) || undefined,
      agentId: normalizeText(input.agentId) || undefined,
      createdBy: normalizeText(input.createdBy) || 'user',
      createdAt: now,
      updatedAt: now,
      ...(clientOrigin
        ? {
            createdClientOrigin: clientOrigin,
            updatedClientOrigin: clientOrigin,
          }
        : {}),
      workspaceBinding,
      sourceProvider: normalizeText(input.sourceProvider) || undefined,
      workItemRef: normalizeText(input.workItemRef) || undefined,
    };

    await this.mutateStore((data) => {
      if (data.tasks.some((existing) => existing.id === task.id)) {
        throw new Error(`Task '${task.id}' already exists`);
      }
      return {
        data: { ...data, tasks: [...data.tasks, task] },
        result: undefined,
      };
    });
    taskWorkspaceBindingTotal.add(1, {
      outcome: workspaceBinding.availability,
      source_surface: sourceSurface,
    });
    return task;
  }

  /** Owner-local idempotent creation for a bounded caller intent. */
  async createTaskIdempotent(
    input: TaskCreateInput,
    namespace: string,
    operationId: string,
    clientOrigin?: ClientOrigin,
  ): Promise<TaskRecord> {
    const digest = crypto
      .createHash('sha256')
      .update(`${namespace}:${operationId}`)
      .digest();
    // RFC 4122 variant + v5-shaped deterministic UUID; it remains a normal
    // Task id while being reproducible by the owning Task graph only.
    digest[6] = (digest[6] & 0x0f) | 0x50;
    digest[8] = (digest[8] & 0x3f) | 0x80;
    const hex = digest.subarray(0, 16).toString('hex');
    const taskId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const existing = this.readTask(taskId);
    if (existing) return this.assertIdempotentTask(existing, input, taskId);
    try {
      return await this.createTask(input, clientOrigin, taskId);
    } catch (error) {
      const replay = this.readTask(taskId);
      if (replay) return this.assertIdempotentTask(replay, input, taskId);
      throw error;
    }
  }

  private assertIdempotentTask(
    existing: TaskRecord,
    input: TaskCreateInput,
    taskId: string,
  ): TaskRecord {
    if (
      existing.projectId !== input.projectId.trim() ||
      existing.title !== input.title.trim() ||
      (existing.description ?? undefined) !==
        (normalizeText(input.description) || undefined) ||
      existing.priority !== (input.priority ?? 'normal') ||
      existing.agentId !== (normalizeText(input.agentId) || undefined)
    )
      throw new Error(
        `Task create operation '${taskId}' conflicts with its original input`,
      );
    return existing;
  }

  private async captureWorkspaceBinding(
    input: TaskCreateInput,
    capturedAt: string,
    sourceSurface: string,
  ): Promise<TaskWorkspaceBinding> {
    try {
      return await this.deriveWorkspaceBinding(
        input.projectId.trim(),
        input.workspaceBinding,
        capturedAt,
      );
    } catch (error) {
      taskWorkspaceBindingTotal.add(1, {
        outcome:
          error instanceof Error &&
          error.message.startsWith('workspaceBinding.')
            ? 'ambiguous'
            : 'unavailable',
        source_surface: sourceSurface,
      });
      throw error;
    }
  }

  /**
   * Task-lifecycle boundary release (review finding #2, following the S4
   * ship): `session.exited` (`releaseClaimForSession`) only ever fires for
   * a REAL orchestrated session — the default `'task-dispatch'` seeded
   * path (`OrchestrationService.seedSessionRecord`, verified against
   * `orchestration-service.ts`) is a pure record write that emits NO
   * session-level event at all, so a task dispatched through the default
   * UI path would otherwise never release its claim until Station restarts
   * into a reconciliation sweep, and its own next dispatch would self-block
   * on the leaked claim. A task reaching `done`/`canceled` is a real,
   * always-reachable terminus for BOTH dispatch shapes, so every transition
   * into a terminal status releases the task's active claim here.
   */
  async updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    clientOrigin?: ClientOrigin,
  ): Promise<TaskRecord> {
    const updated = await this.mutateStore((data) => {
      const task = data.tasks.find((item) => item.id === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      if (task.dispatchReservation) {
        throw new Error('Task dispatch is being established; status is locked');
      }
      if (!canTransitionTaskStatus(task.status, status)) {
        throw new Error(
          `Cannot transition task from ${task.status} to ${status}`,
        );
      }
      const nextTask: TaskRecord = {
        ...task,
        status,
        updatedAt: new Date().toISOString(),
        ...(clientOrigin ? { updatedClientOrigin: clientOrigin } : {}),
      };
      return {
        data: {
          ...data,
          tasks: data.tasks.map((item) =>
            item.id === taskId ? nextTask : item,
          ),
        },
        result: nextTask,
      };
    });
    if (status === 'done' || status === 'canceled') {
      await this.releaseClaimForTask(taskId, `task status -> ${status}`);
    }
    return updated;
  }

  async createLink(input: RelationGraphLinkInput): Promise<RelationGraphLink> {
    const errors = validateRelationGraphLinkInput(input);
    if (errors.length > 0) {
      graphLinkCreatedTotal.add(1, {
        relation_type: input.relationType,
        source: input.source ?? 'system',
        outcome: 'rejected',
      });
      throw new Error(errors.join('; '));
    }

    const link: RelationGraphLink = {
      id: crypto.randomUUID(),
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      targetType: input.targetType,
      targetId: input.targetId,
      relationType: input.relationType,
      confidence: input.confidence ?? 1,
      createdAt: new Date().toISOString(),
      source: input.source ?? 'system',
      metadata: input.metadata,
    };

    const persisted = await this.mutateStore((data) => {
      const existing = data.links.find(
        (item) => linkIdentity(item) === linkIdentity(link),
      );
      if (existing) return { data, result: existing };
      return {
        data: { ...data, links: [...data.links, link] },
        result: link,
      };
    });
    graphLinkCreatedTotal.add(1, {
      relation_type: link.relationType,
      source: link.source,
      outcome: 'created',
    });
    return persisted;
  }

  async createTaskReference(
    taskId: string,
    input: TaskReferenceInput,
    clientOrigin?: ClientOrigin,
    authorization?: TaskReferenceCommitAuthorization,
    narrativePin?: TaskAnswerNarrativePinCapture,
  ): Promise<RelationGraphLink> {
    const metricContext = {
      sourceSurface: metricSourceSurface(input.sourceSurface),
      kind: metricReferenceKind(input.kind),
    };
    const link = await this.mutateStore<{
      link: RelationGraphLink;
      outcome: 'existing' | 'created';
    }>((data) => {
      const task = data.tasks.find((item) => item.id === taskId);
      if (!task)
        this.rejectTaskReference(
          metricContext,
          'not-found',
          `Task not found: ${taskId}`,
        );
      // Recheck inside mutateStore, after its lock has reloaded the actual
      // Task. A route-side preflight cannot authorize a write queued behind a
      // competing mutation or a credential/session revocation.
      if (
        authorization &&
        !taskReferenceAuthorizationCurrent(authorization, task)
      ) {
        this.recordTaskReferenceOutcome(metricContext, 'rejected');
        throw new TaskReferenceAuthorizationError();
      }
      if (narrativePin && !narrativePin.isCurrent()) {
        this.recordTaskReferenceOutcome(metricContext, 'rejected');
        throw new TaskReferenceAuthorizationError();
      }
      const errors = validateTaskReferenceInput(input);
      if (errors.length > 0)
        this.rejectTaskReference(metricContext, 'invalid', errors.join('; '));
      const relationInput = taskReferenceToRelationGraphLinkInput(
        taskId,
        input,
      );
      const existing = data.links.find(
        (candidate) => linkIdentity(candidate) === linkIdentity(relationInput),
      );
      if (existing)
        return {
          data,
          result: { link: existing, outcome: 'existing' as const },
        };
      const references = data.links.filter(
        (candidate) =>
          candidate.sourceType === 'task' &&
          candidate.sourceId === taskId &&
          candidate.source === 'user',
      );
      if (references.length >= MAX_TASK_REFERENCES_PER_TASK) {
        this.rejectTaskReference(
          metricContext,
          'capacity',
          `Task may have at most ${MAX_TASK_REFERENCES_PER_TASK} references`,
        );
      }
      const created: RelationGraphLink = {
        id: crypto.randomUUID(),
        ...relationInput,
        confidence: relationInput.confidence ?? 1,
        createdAt: new Date().toISOString(),
        source: relationInput.source ?? 'system',
        ...(clientOrigin ? { clientOrigin } : {}),
      };
      const turnTargetId = input.kind === 'turn' ? created.targetId : undefined;
      const pin =
        turnTargetId && narrativePin?.associationRevision !== undefined
          ? {
              schemaVersion: 1 as const,
              taskId,
              turnTargetId,
              associationRevision: narrativePin.associationRevision,
              capturedAt: new Date().toISOString(),
            }
          : undefined;
      return {
        data: {
          ...data,
          links: [...data.links, created],
          ...(pin
            ? { answerNarrativePins: [...data.answerNarrativePins, pin] }
            : {}),
        },
        result: { link: created, outcome: 'created' as const },
      };
    });
    this.recordTaskReferenceOutcome(metricContext, link.outcome);
    return link.link;
  }

  /**
   * Atomically retain one exact declared PR identity.  This is intentionally
   * separate from generic external references: its receipt/tombstone and
   * curation provenance are TaskGraph-owned, while current provider access is
   * established by the route-owned authorization witness.
   */
  async keepDeclaredPullRequest(
    input: {
      taskId: string;
      operationId: string;
      provider: string;
      host: string;
      repository: { owner: string; name: string };
      ref: string;
      nativeId: string;
      provenance: TaskKeptDeclaredPullRequest['provenance'];
    },
    authorization: TaskReferenceCommitAuthorization,
  ): Promise<TaskKeptDeclaredPullRequestOutcome> {
    const fields = [
      input.taskId,
      input.operationId,
      input.provider,
      input.host,
      input.repository?.owner,
      input.repository?.name,
      input.ref,
      input.nativeId,
      input.provenance?.sessionId,
      input.provenance?.turnId,
      input.provenance?.toolCallId,
      input.provenance?.declarationId,
      input.provenance?.eventId,
    ];
    if (
      fields.some(
        (value) =>
          typeof value !== 'string' || value.length < 1 || value.length > 4096,
      )
    )
      throw new TaskDeclaredOutputKeepConflictError();
    const targetKey = JSON.stringify({
      provider: input.provider,
      host: input.host,
      repository: input.repository,
      ref: input.ref,
      nativeId: input.nativeId,
    });
    const fingerprint = crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          targetKey,
          provenance: input.provenance,
        }),
      )
      .digest('hex');
    return this.mutateStore<TaskKeptDeclaredPullRequestOutcome>((data) => {
      const task = data.tasks.find(
        (candidate) => candidate.id === input.taskId,
      );
      if (!task || !taskReferenceAuthorizationCurrent(authorization, task))
        throw new TaskReferenceAuthorizationError();
      const existingOperation = data.declaredPullRequestKeeps.find(
        (keep) =>
          keep.taskId === input.taskId &&
          keep.operationId === input.operationId,
      );
      if (existingOperation) {
        if (existingOperation.fingerprint !== fingerprint)
          throw new TaskDeclaredOutputKeepConflictError();
        return {
          data,
          result: {
            outcome: 'already-kept' as const,
            reference: stripDeclaredPullRequestKeep(existingOperation),
          },
        };
      }
      const deletedOperation = data.declaredPullRequestKeepTombstones.find(
        (entry) =>
          entry.taskId === input.taskId &&
          entry.operationId === input.operationId,
      );
      if (deletedOperation) {
        if (deletedOperation.fingerprint !== fingerprint)
          throw new TaskDeclaredOutputKeepConflictError();
        throw new TaskDeclaredOutputKeepDeletedError();
      }
      const exactTarget = data.declaredPullRequestKeeps.find(
        (keep) => keep.taskId === input.taskId && keep.targetKey === targetKey,
      );
      if (exactTarget)
        return {
          data,
          result: {
            outcome: 'already-kept' as const,
            reference: stripDeclaredPullRequestKeep(exactTarget),
          },
        };
      if (
        data.declaredPullRequestKeepTombstones.some(
          (entry) =>
            entry.taskId === input.taskId && entry.targetKey === targetKey,
        )
      )
        throw new TaskDeclaredOutputKeepDeletedError();
      if (
        data.declaredPullRequestKeeps.length >= 512 ||
        data.declaredPullRequestKeepTombstones.length >= 512
      )
        throw new TaskDeclaredOutputKeepConflictError();
      const keep: PersistedDeclaredPullRequestKeep = {
        schemaVersion: 1,
        taskId: input.taskId,
        provider: input.provider,
        host: input.host,
        repository: { ...input.repository },
        ref: input.ref,
        nativeId: input.nativeId,
        provenance: { ...input.provenance },
        keptAt: new Date().toISOString(),
        operationId: input.operationId,
        fingerprint,
        targetKey,
      };
      return {
        data: {
          ...data,
          declaredPullRequestKeeps: [...data.declaredPullRequestKeeps, keep],
        },
        result: {
          outcome: 'kept' as const,
          reference: stripDeclaredPullRequestKeep(keep),
        },
      };
    });
  }

  /** Metadata-only exact lookup for a Task-scoped inventory projection. */
  readKeptDeclaredPullRequest(
    taskId: string,
    sessionId: string,
    eventId: string,
  ): TaskKeptDeclaredPullRequest | undefined {
    const keep = this.readStore().declaredPullRequestKeeps.find(
      (keep) =>
        keep.taskId === taskId &&
        keep.provenance.sessionId === sessionId &&
        keep.provenance.eventId === eventId,
    );
    return keep
      ? structuredClone(stripDeclaredPullRequestKeep(keep))
      : undefined;
  }

  /**
   * Metadata-only retained PR identities for one exact Session. This is the
   * only list form exposed to the Session-inventory seam; it cannot widen a
   * Session view to another Task's live external references.
   */
  listKeptDeclaredPullRequestsForSession(
    taskId: string,
    sessionId: string,
  ): TaskKeptDeclaredPullRequest[] {
    return this.readStore()
      .declaredPullRequestKeeps.filter(
        (keep) =>
          keep.taskId === taskId && keep.provenance.sessionId === sessionId,
      )
      .map((keep) => structuredClone(stripDeclaredPullRequestKeep(keep)));
  }

  /** Task-owned removal keeps a bounded tombstone so replay cannot resurrect it. */
  async deleteKeptDeclaredPullRequest(
    taskId: string,
    sessionId: string,
    eventId: string,
    authorization: TaskReferenceCommitAuthorization,
  ): Promise<boolean> {
    return this.mutateStore((data) => {
      const task = data.tasks.find((candidate) => candidate.id === taskId);
      if (!task || !taskReferenceAuthorizationCurrent(authorization, task))
        throw new TaskReferenceAuthorizationError();
      const index = data.declaredPullRequestKeeps.findIndex(
        (keep) =>
          keep.taskId === taskId &&
          keep.provenance.sessionId === sessionId &&
          keep.provenance.eventId === eventId,
      );
      if (index < 0) return { data, result: false };
      if (data.declaredPullRequestKeepTombstones.length >= 512)
        throw new TaskDeclaredOutputKeepConflictError();
      const keep = data.declaredPullRequestKeeps[index]!;
      const tombstone: PersistedDeclaredPullRequestKeepTombstone = {
        taskId: keep.taskId,
        operationId: keep.operationId,
        fingerprint: keep.fingerprint,
        targetKey: keep.targetKey,
      };
      return {
        data: {
          ...data,
          declaredPullRequestKeeps: data.declaredPullRequestKeeps.filter(
            (_keep, candidateIndex) => candidateIndex !== index,
          ),
          declaredPullRequestKeepTombstones: [
            ...data.declaredPullRequestKeepTombstones,
            tombstone,
          ],
        },
        result: true,
      };
    });
  }

  private rejectTaskReference(
    metricContext: TaskReferenceMetricContext,
    reason: 'not-found' | 'invalid' | 'capacity',
    message: string,
  ): never {
    this.recordTaskReferenceOutcome(metricContext, 'rejected');
    throw new TaskReferenceRejectedError(reason, message);
  }

  private recordTaskReferenceOutcome(
    { kind, sourceSurface }: TaskReferenceMetricContext,
    outcome: 'created' | 'existing' | 'rejected',
  ): void {
    taskReferenceCreatedTotal.add(1, {
      kind,
      source_surface: sourceSurface,
      outcome,
    });
  }

  /** Read-only proof of a completed association, never a reservation or retry. */
  readCompletedDispatchForRecovery(sessionId: string):
    | {
        task: TaskRecord;
        dispatch: TaskDispatchRecord;
        links: RelationGraphLink[];
      }
    | undefined {
    const data = this.readStoreView();
    const matches = data.dispatches.filter(
      (dispatch) => dispatch.sessionId === sessionId,
    );
    if (matches.length !== 1) return undefined;
    const dispatch = matches[0];
    const task = data.tasks.find((task) => task.id === dispatch.taskId);
    if (!task || task.dispatchReservation || task.sessionId !== sessionId)
      return undefined;
    return structuredClone({
      task,
      dispatch,
      links: data.links.filter(
        (link) =>
          (link.sourceType === 'task' && link.sourceId === task.id) ||
          (link.targetType === 'task' && link.targetId === task.id),
      ),
    });
  }

  async readTaskGraph(taskId: string): Promise<TaskGraph | null> {
    const data = this.readStore();
    const task = data.tasks.find((item) => item.id === taskId);
    if (!task) return null;
    const links = data.links.filter(
      (link) =>
        (link.sourceType === 'task' && link.sourceId === taskId) ||
        (link.targetType === 'task' && link.targetId === taskId),
    );
    graphQueryTotal.add(1, {
      query_type: 'task_graph',
      result_bucket: resultBucket(links.length),
    });
    const workspaceBinding = await this.resolveWorkspaceForOpen(task);
    const projectedTask = { ...task, workspaceBinding };
    taskWorkspaceOpenTotal.add(1, {
      availability_bucket: workspaceBinding.availability,
      source_surface: metricSourceSurface(task.workspaceBinding?.sourceSurface),
    });
    return { task: projectedTask, links };
  }

  /**
   * Return only the Task's stored turn-reference links. This is intentionally
   * a graph read, not an answer resolver: the orchestration query Module owns
   * Session authorization and exact assistant-answer projection at the
   * runtime-route composition seam.
   */
  readTaskTurnReferenceLinks(taskId: string): RelationGraphLink[] | null {
    let links: RelationGraphLink[];
    try {
      const data = this.readStore();
      if (!data.tasks.some((task) => task.id === taskId)) return null;
      links = data.links.filter(
        (link) =>
          link.sourceType === 'task' &&
          link.sourceId === taskId &&
          link.targetType === 'turn' &&
          link.relationType === 'references_turn',
      );
    } catch (error) {
      if (!(error instanceof TaskGraphStoreShapeError)) throw error;
      const raw = this.store.read() as unknown;
      if (
        !isPlainObject(raw) ||
        !Array.isArray(raw.tasks) ||
        !Array.isArray(raw.links) ||
        !raw.tasks.some((item) => isPlainObject(item) && item.id === taskId)
      ) {
        return null;
      }
      // The route uses only `id` and `targetId`, and collapses every invalid
      // target to one sentinel. Do not reinterpret any other unvalidated
      // graph field here.
      links = raw.links.flatMap((item, index): RelationGraphLink[] => {
        if (
          !isPlainObject(item) ||
          item.sourceType !== 'task' ||
          item.sourceId !== taskId ||
          item.targetType !== 'turn' ||
          item.relationType !== 'references_turn'
        ) {
          return [];
        }
        return [
          {
            id: typeof item.id === 'string' ? item.id : `legacy-turn-${index}`,
            sourceType: 'task',
            sourceId: taskId,
            targetType: 'turn',
            targetId: typeof item.targetId === 'string' ? item.targetId : '',
            relationType: 'references_turn',
            confidence: 1,
            createdAt: '',
            source: 'system',
          },
        ];
      });
    }
    graphQueryTotal.add(1, {
      query_type: 'task_turn_references',
      result_bucket: resultBucket(links.length),
    });
    return links;
  }

  /**
   * Private Task-owned association revision. Its absence is intentional: it
   * represents a legacy/unbound Keep and is never backfilled from a producer
   * head. This is deliberately not part of any Task graph projection.
   */
  readTaskAnswerNarrativePin(
    taskId: string,
    turnTargetId: string,
  ): number | undefined {
    try {
      const data = this.readStore();
      if (!data.tasks.some((task) => task.id === taskId)) return undefined;
      return data.answerNarrativePins.find(
        (pin) => pin.taskId === taskId && pin.turnTargetId === turnTargetId,
      )?.associationRevision;
    } catch (error) {
      if (error instanceof TaskGraphStoreShapeError) return undefined;
      throw error;
    }
  }

  /**
   * Return only protected user-input tuple links. Resolution remains at the
   * orchestration composition seam; TaskGraph never receives prompt content.
   */
  readTaskUserInputReferenceLinks(taskId: string): RelationGraphLink[] | null {
    let links: RelationGraphLink[];
    try {
      const data = this.readStore();
      if (!data.tasks.some((task) => task.id === taskId)) return null;
      links = data.links.filter(
        (link) =>
          link.sourceType === 'task' &&
          link.sourceId === taskId &&
          link.targetType === 'user_input' &&
          link.relationType === 'references_user_input',
      );
    } catch (error) {
      if (!(error instanceof TaskGraphStoreShapeError)) throw error;
      const raw = this.store.read() as unknown;
      if (
        !isPlainObject(raw) ||
        !Array.isArray(raw.tasks) ||
        !Array.isArray(raw.links) ||
        !raw.tasks.some((item) => isPlainObject(item) && item.id === taskId)
      ) {
        return null;
      }
      links = raw.links.flatMap((item, index): RelationGraphLink[] => {
        if (
          !isPlainObject(item) ||
          item.sourceType !== 'task' ||
          item.sourceId !== taskId ||
          item.targetType !== 'user_input' ||
          item.relationType !== 'references_user_input'
        ) {
          return [];
        }
        return [
          {
            id: typeof item.id === 'string' ? item.id : `legacy-input-${index}`,
            sourceType: 'task',
            sourceId: taskId,
            targetType: 'user_input',
            targetId: typeof item.targetId === 'string' ? item.targetId : '',
            relationType: 'references_user_input',
            confidence: 1,
            createdAt: '',
            source: 'system',
          },
        ];
      });
    }
    graphQueryTotal.add(1, {
      query_type: 'task_user_input_references',
      result_bucket: resultBucket(links.length),
    });
    return links;
  }

  /**
   * Return only protected tool-result tuples. The Task graph remains content
   * free; SessionQuery owns exact EventStore lookup and authorization.
   */
  readTaskToolResultReferenceLinks(taskId: string): RelationGraphLink[] | null {
    let links: RelationGraphLink[];
    try {
      const data = this.readStore();
      if (!data.tasks.some((task) => task.id === taskId)) return null;
      links = data.links.filter(
        (link) =>
          link.sourceType === 'task' &&
          link.sourceId === taskId &&
          link.targetType === 'tool_result' &&
          link.relationType === 'references_tool_result',
      );
    } catch (error) {
      if (!(error instanceof TaskGraphStoreShapeError)) throw error;
      const raw = this.store.read() as unknown;
      if (
        !isPlainObject(raw) ||
        !Array.isArray(raw.tasks) ||
        !Array.isArray(raw.links) ||
        !raw.tasks.some((item) => isPlainObject(item) && item.id === taskId)
      ) {
        return null;
      }
      links = raw.links.flatMap((item, index): RelationGraphLink[] => {
        if (
          !isPlainObject(item) ||
          item.sourceType !== 'task' ||
          item.sourceId !== taskId ||
          item.targetType !== 'tool_result' ||
          item.relationType !== 'references_tool_result'
        ) {
          return [];
        }
        return [
          {
            id:
              typeof item.id === 'string'
                ? item.id
                : `legacy-tool-result-${index}`,
            sourceType: 'task',
            sourceId: taskId,
            targetType: 'tool_result',
            targetId: typeof item.targetId === 'string' ? item.targetId : '',
            relationType: 'references_tool_result',
            confidence: 1,
            createdAt: '',
            source: 'system',
          },
        ];
      });
    }
    graphQueryTotal.add(1, {
      query_type: 'task_tool_result_references',
      result_bucket: resultBucket(links.length),
    });
    return links;
  }

  /** Protected retained Flow receipt identities; never part of the generic graph. */
  readTaskGateEvaluationReferenceLinks(
    taskId: string,
  ): RelationGraphLink[] | null {
    try {
      const data = this.readStore();
      if (!data.tasks.some((task) => task.id === taskId)) return null;
      return data.links.filter(
        (link) =>
          link.sourceType === 'task' &&
          link.sourceId === taskId &&
          link.targetType === 'gate_evaluation' &&
          link.relationType === 'references_gate_evaluation',
      );
    } catch {
      return null;
    }
  }

  /**
   * Where does this Project live on disk?
   *
   * Two independently-added dependencies answer the same question: the full
   * `projectService` (used by the Task workspace binding) and the lighter
   * `resolveProjectWorkspace` (added for the AssignmentProvider artifact root).
   * Either is sufficient, so this asks whichever is wired rather than making
   * callers configure both. With neither, binding stays fail-closed: a Task is
   * never created carrying a workspace nobody could verify.
   *
   * archive#1501, seam S4 (`docs/design/portable-project-identity.md`
   * §2.2.1). Both branches now route through `resolveProjectResource`.
   *
   * **The `Project not found: ${projectId}` throw is PRESERVED** — same
   * trigger, same source, same sentence: `projectService.getProject` throwing.
   * It is load-bearing; `deriveWorkspaceBinding` lets it escape so a Task is
   * never created against a project that does not exist.
   *
   * That existence check is deliberately kept SEPARATE from the resolution,
   * rather than folded into the adapter's `error` outcome, because `error`
   * cannot distinguish "this project does not exist" from "the resolver blew
   * up" (an unreadable manifest — resolver decision 7 — or a genuine bug).
   * Relabelling every one of those `Project not found` would be a claim with
   * no source, and it hid a real fault during this slice's own development:
   * a test's module mock left a telemetry instrument undefined, the resulting
   * `TypeError` was caught by the adapter, and eighteen tests reported that a
   * project that plainly existed did not. So: `getProject` answers existence,
   * and any OTHER resolver failure is re-thrown with its own message. Both
   * still fail closed.
   *
   * **What that costs, stated accurately (slice 3b review, FIX 6).** It is a
   * second, uncached read: `FileStorageAdapter.getProject` is `existsSync` +
   * `readFileSync` + `JSON.parse` on every call, and `ProjectService
   * .getProject` is a pass-through to it. There is no cache anywhere on that
   * path. So one binding derivation reads and parses `project.json` TWICE —
   * once here for existence, once inside `resolveProjectResource` — on top of
   * the manifest and binding-store reads the resolver does. The decision
   * stands: a binding derivation is a per-Task-create/per-Task-open
   * operation, not a hot loop, and two small JSON reads are the price of not
   * relabelling an unreadable manifest as a missing project. It is a real
   * cost, not a free one.
   *
   * **Behavior delta for a project without a manifest.** The old code
   * returned `project.workingDirectory` verbatim and `deriveWorkspaceBinding`
   * then `existsSync`'d that UNEXPANDED string — so a project stored as
   * `~/dev/repo` failed the check and its Tasks bound `availability:
   * 'unavailable'`, blocking dispatch. The resolver's compat branch returns
   * `resolve(expandTilde(...))`, so those projects now bind `available`. That
   * is the same latent tilde bug seam S3 carried, and the same fix.
   *
   * **That fix reaches NEWLY DERIVED bindings only (slice 3b review, FIX 5).**
   * A Task created while its `~`-stored project did not resolve persisted
   * `availability: 'unavailable'` with no `workingDirectory`. Reopening it now
   * derives an `available` current binding, and `resolveWorkspaceForOpen`
   * reports `ambiguous` — not `available` — because `sameWorkspace` requires
   * BOTH sides to be `available`. See that method's docblock for why the
   * transition is deliberately not an auto-re-bind.
   */
  private async readProjectWorkingDirectory(
    projectId: string,
  ): Promise<string | undefined> {
    if (this.projectService && this.projectResourceResolver) {
      try {
        this.projectService.getProject(projectId);
      } catch {
        throw new Error(`Project not found: ${projectId}`);
      }
      const outcome = await resolveProjectWorkspaceOutcome(projectId, {
        resolver: this.projectResourceResolver,
      });
      if (outcome.available) return outcome.path;
      if (outcome.state === 'error') throw new Error(outcome.reason);
      // Every other state — `unbound` (nothing is recorded), `missing` (a
      // recorded realization, binding or declared workingDirectory, whose path
      // is gone — archive#1594 moved the second half of the old `unbound`
      // here), `drifted`, `stale`, `ambiguous` — is a real answer: this
      // Project has no workspace we can vouch for right now. The binding
      // models that as `unavailable`, exactly as it modelled an absent
      // `workingDirectory` before.
      return undefined;
    }
    if (this.resolveProjectWorkspace) {
      // A wired resolver answering `undefined` is a real answer — "this
      // Project has no resolvable workspace" — which the binding models as
      // `unavailable`, not as a failure to look it up.
      return await this.resolveProjectWorkspace(projectId);
    }
    throw new Error('Project workspace resolver is unavailable');
  }

  private async deriveWorkspaceBinding(
    projectId: string,
    supplied: TaskWorkspaceBinding | undefined,
    capturedAt: string,
  ): Promise<TaskWorkspaceBinding> {
    const sourceSurface = normalizeText(supplied?.sourceSurface) || undefined;
    const workingDirectory = normalizeText(
      await this.readProjectWorkingDirectory(projectId),
    );
    if (!workingDirectory || !existsSync(workingDirectory)) {
      const unavailable: TaskWorkspaceBinding = {
        availability: 'unavailable',
        sourceSurface,
        capturedAt,
      };
      const conflict = workspaceValuesConflict(supplied, unavailable);
      if (conflict) throw new Error(conflict);
      return unavailable;
    }

    const canonicalWorkingDirectory = realpathSync(workingDirectory);
    const binding: TaskWorkspaceBinding = {
      availability: 'available',
      workingDirectory: canonicalWorkingDirectory,
      sourceSurface,
      capturedAt,
    };
    try {
      const opts = {
        cwd: canonicalWorkingDirectory,
        encoding: 'utf-8' as const,
      };
      const [root, branch] = await Promise.all([
        this.runGit(['rev-parse', '--show-toplevel'], opts),
        this.runGit(['rev-parse', '--abbrev-ref', 'HEAD'], opts),
      ]);
      const repoRoot = realpathSync(
        resolve(canonicalWorkingDirectory, root.stdout.trim()),
      );
      binding.repoRoot = repoRoot;
      binding.worktreePath = repoRoot;
      binding.branch = branch.stdout.trim() || undefined;
    } catch {
      // A Project need not be Git-backed. Its canonical working directory is
      // still a useful, available local Task workspace.
    }
    const conflict = workspaceValuesConflict(supplied, binding);
    if (conflict) throw new Error(conflict);
    return binding;
  }

  /**
   * Projects a Task's PERSISTED workspace binding against the project's
   * workspace as it is right now, for the read paths (`readTaskForOpen`,
   * `readTaskGraph`). It never writes.
   *
   * **archive#1501 review, FIX 5 — the pre-existing-Task
   * consequence of the tilde fix.** Seam S4 made a `~`-stored project resolve
   * to a real directory. A Task created BEFORE that, against such a project,
   * persisted `availability: 'unavailable'` and no `workingDirectory`.
   * Reopening it now derives an `available` `current`, and `sameWorkspace`
   * returns false (it requires the STORED side to be `available` too), so
   * this reports `ambiguous`. That population is exactly the one the tilde fix
   * was for, so it is worth being explicit: those Tasks do NOT silently become
   * `available` — only newly derived bindings do.
   *
   * **Decision: an `unavailable` → `available` transition is deliberately NOT
   * an auto-re-bind.** Returning `available` here was considered and rejected:
   *
   * - This is a read path. Adopting a workspace the Task never bound would
   *   report a binding that is nowhere on disk — the projection and the stored
   *   record would disagree, and the next writer would have to decide which
   *   one was real.
   * - `unavailable` has more than one cause. "The project's directory string
   *   was unexpandable and a later Station fixed that" and "the project has
   *   since been pointed at a directory it did not have" are indistinguishable
   *   from the stored binding, and they are not the same event. `ambiguous` is
   *   the honest label for "the recorded workspace and the current one do not
   *   agree, and I cannot tell you why" — it is the repair prompt, not a
   *   failure.
   * - `ambiguous` is a read-side projection here; it does not tighten
   *   anything. `claimForDispatch` gates on the freshly derived binding, not
   *   on this, so a re-created Task or a new dispatch already gets the fixed
   *   `available` answer.
   */
  private async resolveWorkspaceForOpen(
    task: TaskRecord,
  ): Promise<TaskWorkspaceBinding> {
    if (!task.workspaceBinding) {
      return { availability: 'unavailable' };
    }
    let current: TaskWorkspaceBinding;
    try {
      current = await this.deriveWorkspaceBinding(
        task.projectId,
        undefined,
        task.workspaceBinding.capturedAt ?? task.updatedAt,
      );
    } catch {
      return { ...task.workspaceBinding, availability: 'unavailable' };
    }
    if (current.availability !== 'available') return current;
    if (!sameWorkspace(task.workspaceBinding, current)) {
      return { ...task.workspaceBinding, availability: 'ambiguous' };
    }
    return {
      ...current,
      sourceSurface: task.workspaceBinding.sourceSurface,
      capturedAt: task.workspaceBinding.capturedAt,
    };
  }

  readSessionRelations(sessionId: string): SessionRelations {
    const links = this.readStore().links.filter(
      (link) =>
        (link.sourceType === 'session' && link.sourceId === sessionId) ||
        (link.targetType === 'session' && link.targetId === sessionId),
    );
    graphQueryTotal.add(1, {
      query_type: 'session_relations',
      result_bucket: resultBucket(links.length),
    });
    return { sessionId, links };
  }

  /**
   * Composition Seam for the deep TaskDispatcher Module. The adapters expose
   * durable graph transitions and concrete Station integrations, while the
   * dispatch algorithm and compensation ordering live in task-dispatcher.ts.
   */
  createTaskDispatchAdapters(deps: TaskDispatchAdapterDeps = {}): {
    graph: TaskDispatchGraphState;
    claims: TaskDispatchClaims;
    remoteSessions: TaskDispatchRemoteSessions;
    telemetry: TaskDispatchTelemetry;
    execution?: TaskDispatchExecutionAuthority;
  } {
    const orchestrationService =
      deps.orchestrationService ?? this.orchestrationService;
    const assignmentClaimService =
      deps.assignmentClaimService ?? this.assignmentClaimService;
    const resolveProjectWorkspace =
      deps.resolveProjectWorkspace ?? this.resolveProjectWorkspace;
    const graph: TaskDispatchGraphState = {
      reserve: async (taskId, input) => {
        try {
          return {
            kind: 'reserved',
            reservation: await this.reserveTaskDispatch(taskId, input),
          };
        } catch (error) {
          if (error instanceof TaskDispatchAdmissionError) {
            return { kind: error.outcome, reason: error.message };
          }
          throw error;
        }
      },
      markProviderStarting: (reservation) =>
        this.markDispatchReservationProviderStarting(
          reservation as TaskDispatchReservation,
        ),
      associate: (reservation, input, association) =>
        this.associateTaskDispatch(
          reservation as TaskDispatchReservation,
          input,
          association,
        ),
      markIndeterminate: (reservation) =>
        this.markDispatchReservationIndeterminate(
          reservation as TaskDispatchReservation,
        ),
      releaseReservation: (reservation) =>
        this.releaseTaskDispatchReservation(
          reservation as TaskDispatchReservation,
        ),
    };
    const claims = {
      claim: (
        reservation: DispatcherReservation,
        signal: AbortSignal | undefined,
      ) =>
        this.claimForDispatch(
          reservation.task,
          reservation.sessionId,
          signal,
          assignmentClaimService,
          resolveProjectWorkspace,
        ),
      compensate: (reservation: DispatcherReservation, cause: unknown) =>
        this.compensateFailedDispatchClaim(
          reservation.task,
          reservation.sessionId,
          cause,
          assignmentClaimService,
          resolveProjectWorkspace,
        ),
    };
    const remoteSessions = {
      readiness: (reservation: DispatcherReservation) =>
        reservation.provider !== 'task-dispatch' && !orchestrationService
          ? {
              kind: 'unavailable' as const,
              reason: 'orchestration service is not ready',
              retryable: true,
            }
          : { kind: 'ready' as const },
      mayHaveStarted: (reservation: DispatcherReservation) =>
        reservation.provider !== 'task-dispatch' &&
        orchestrationService !== undefined,
      startOrSeed: async (
        reservation: DispatcherReservation,
        input: TaskDispatchInput,
        admission?: SessionStartBoundaryClaim,
      ) => {
        if (reservation.provider !== 'task-dispatch' && orchestrationService) {
          const taskSlug = this.resolveDispatchTaskSlug(
            reservation.task,
            input.runtimeConfig?.cwd,
          );
          await this.assertDispatchReservationProviderStarting(
            reservation as TaskDispatchReservation,
          );
          const session = (await orchestrationService.dispatch(
            {
              type: 'startSession',
              input: {
                threadId: reservation.sessionId,
                provider: reservation.provider,
                cwd: input.runtimeConfig?.cwd,
                modelId: reservation.modelId,
                modelOptions: input.runtimeConfig?.modelOptions,
                ...(taskSlug ? { metadata: { taskSlug } } : {}),
              },
            },
            undefined,
            {
              roomExecutionBinding: {
                projectId: reservation.task.projectId,
                taskId: reservation.task.id,
              },
              ...(admission ? { sessionStartAdmission: admission } : {}),
              ...(taskSlug
                ? { workflowSidecarAttachMode: 'read-only-join' as const }
                : {}),
            },
          )) as ProviderSession;
          return { session, outcome: 'started' as const };
        }
        return {
          session: this.seedSession(
            reservation.sessionId,
            reservation.provider,
            reservation.modelId,
            orchestrationService,
          ),
          outcome: 'seeded' as const,
        };
      },
    };
    const telemetry: TaskDispatchTelemetry = {
      succeeded: (reservation, result, startedAt) => {
        for (const link of result.links) {
          graphLinkCreatedTotal.add(1, {
            relation_type: link.relationType,
            source: link.source,
            outcome: 'created',
          });
        }
        taskDispatchTotal.add(1, {
          outcome: result.dispatch.outcome,
          runtime_kind: reservation.provider,
          source_surface: reservation.sourceSurface,
        });
        taskDispatchStartLatencyMs.record(performance.now() - startedAt, {
          runtime_kind: reservation.provider,
        });
      },
      failed: (reservation, startedAt, blocked) => {
        taskDispatchTotal.add(1, {
          outcome: blocked ? 'blocked' : 'failed',
          runtime_kind: reservation.provider,
          source_surface: reservation.sourceSurface,
        });
        taskDispatchStartLatencyMs.record(performance.now() - startedAt, {
          runtime_kind: reservation.provider,
        });
      },
    };
    const execution: TaskDispatchExecutionAuthority | undefined =
      orchestrationService?.claimTaskDispatchBoundary
        ? {
            claim: async (reservation) =>
              orchestrationService.claimTaskDispatchBoundary!({
                projectId: reservation.task.projectId,
                taskId: reservation.task.id,
                sessionId: reservation.sessionId,
              }),
          }
        : undefined;
    return {
      graph,
      claims,
      remoteSessions,
      telemetry,
      ...(execution ? { execution } : {}),
    };
  }

  /**
   * Persist a short-lived `in_progress` reservation before any provider or
   * assignment-provider await. The lock is never held ACROSS that provider
   * await — the reservation, not the lock, is what gives other processes an
   * authoritative reason to refuse a duplicate start. Since archive#2646 the
   * acquisition itself is awaited rather than busy-waited, so a contended
   * reservation yields the event loop instead of freezing the listener; the
   * critical section it guards is still only the read-modify-write.
   */
  private async reserveTaskDispatch(
    taskId: string,
    input: TaskDispatchInput,
  ): Promise<TaskDispatchReservation> {
    return await this.mutateStore((data) => {
      const task = data.tasks.find((item) => item.id === taskId);
      if (!task) {
        throw new TaskDispatchAdmissionError(
          'not-found',
          `Task not found: ${taskId}`,
        );
      }
      if (task.dispatchReservation) {
        throw new TaskDispatchAdmissionError(
          task.dispatchReservation.phase === 'pre_provider'
            ? 'contended'
            : 'terminal',
          task.dispatchReservation.phase === 'pre_provider'
            ? 'Task dispatch reservation is active'
            : 'Task dispatch start is indeterminate; explicit reconciliation is required',
        );
      }
      if (!canTransitionTaskStatus(task.status, 'ready')) {
        throw new TaskDispatchAdmissionError(
          'terminal',
          `Task cannot be dispatched from ${task.status}`,
        );
      }
      const dispatchIndex =
        data.dispatches.filter((dispatch) => dispatch.taskId === taskId)
          .length + 1;
      const sessionId = createTaskSessionId(taskId, dispatchIndex);
      const provider =
        input.runtimeConfig?.provider ?? input.provider ?? 'task-dispatch';
      const sourceSurface = normalizeText(input.sourceSurface) || 'api';
      const modelId = input.runtimeConfig?.modelId;
      const reservedAt = new Date().toISOString();
      const reservation: PersistedTaskDispatchReservation = {
        generation: crypto.randomUUID(),
        phase: 'pre_provider',
        sessionId,
        reservedAt,
        expiresAt: new Date(
          Date.parse(reservedAt) + DISPATCH_RESERVATION_LEASE_MS,
        ).toISOString(),
        priorStatus: task.status,
        priorDispatchedAt: task.dispatchedAt,
        priorSessionId: task.sessionId,
      };
      const reserved: PersistedTaskRecord = {
        ...task,
        status: 'in_progress',
        dispatchedAt: reservedAt,
        sessionId,
        updatedAt: reservedAt,
        dispatchReservation: reservation,
      };
      return {
        data: {
          ...data,
          tasks: data.tasks.map((item) =>
            item.id === taskId ? reserved : item,
          ),
        },
        result: {
          task: reserved,
          persisted: reservation,
          sessionId,
          provider,
          sourceSurface,
          modelId,
        },
      };
    });
  }

  /** Atomic durable publication after the Dispatcher has acquired a session. */
  private async associateTaskDispatch(
    reservation: TaskDispatchReservation,
    input: TaskDispatchInput,
    association: TaskDispatchAssociation,
  ): Promise<TaskDispatchResult> {
    const { task, sessionId, provider, sourceSurface } = reservation;
    return await this.mutateStore((data) => {
      const currentTask = data.tasks.find((item) => item.id === task.id);
      if (
        !currentTask ||
        currentTask.sessionId !== sessionId ||
        currentTask.status !== 'in_progress' ||
        currentTask.updatedAt !== reservation.task.updatedAt ||
        currentTask.dispatchReservation?.sessionId !== sessionId ||
        currentTask.dispatchReservation.reservedAt !==
          reservation.persisted.reservedAt ||
        currentTask.dispatchReservation.generation !==
          reservation.persisted.generation ||
        currentTask.dispatchReservation.phase !== 'provider_starting'
      ) {
        throw new Error('Task dispatch reservation was superseded');
      }
      const now = new Date().toISOString();
      const { dispatchReservation: _persistedReservation, ...unreserved } =
        currentTask;
      const updatedTask: TaskRecord = {
        ...unreserved,
        agentId: normalizeText(input.agentId) || unreserved.agentId,
        skillName: normalizeText(input.skillName) || unreserved.skillName,
        status: association.outcome === 'started' ? 'in_progress' : 'ready',
        dispatchedAt: now,
        sessionId,
        updatedAt: now,
        ...(input.clientOrigin
          ? { updatedClientOrigin: input.clientOrigin }
          : {}),
      };
      const dispatch: TaskDispatchRecord = {
        id: crypto.randomUUID(),
        taskId: task.id,
        sessionId,
        provider,
        outcome: association.outcome,
        createdAt: now,
        sourceSurface,
        ...(input.clientOrigin ? { clientOrigin: input.clientOrigin } : {}),
        claim: association.claim,
      };
      const links = this.buildDispatchLinks(updatedTask, input, sessionId);
      return {
        data: {
          ...data,
          tasks: data.tasks.map((item) =>
            item.id === task.id ? updatedTask : item,
          ),
          dispatches: [...data.dispatches, dispatch],
          links: uniqueLinks([...data.links, ...links]),
        },
        result: {
          task: updatedTask,
          dispatch,
          session: association.session,
          links,
        },
      };
    });
  }

  private async releaseTaskDispatchReservation(
    reservation: TaskDispatchReservation,
  ): Promise<{ kind: 'released' } | { kind: 'indeterminate'; reason: string }> {
    return await this.mutateStore<
      { kind: 'released' } | { kind: 'indeterminate'; reason: string }
    >((data) => {
      const current = data.tasks.find(
        (item) => item.id === reservation.task.id,
      );
      if (
        !current ||
        current.sessionId !== reservation.sessionId ||
        current.status !== 'in_progress' ||
        current.updatedAt !== reservation.task.updatedAt ||
        current.dispatchReservation?.sessionId !== reservation.sessionId ||
        current.dispatchReservation.reservedAt !==
          reservation.persisted.reservedAt ||
        current.dispatchReservation.generation !==
          reservation.persisted.generation
      ) {
        return {
          data,
          result: {
            kind: 'indeterminate' as const,
            reason: 'Task dispatch reservation was superseded during cleanup',
          },
        };
      }
      const { dispatchReservation: persistedReservation, ...unreserved } =
        current;
      const restored: TaskRecord = {
        ...unreserved,
        status: persistedReservation.priorStatus,
        dispatchedAt: persistedReservation.priorDispatchedAt,
        sessionId: persistedReservation.priorSessionId,
        updatedAt: new Date().toISOString(),
      };
      return {
        data: {
          ...data,
          tasks: data.tasks.map((item) =>
            item.id === restored.id ? restored : item,
          ),
        },
        result: { kind: 'released' as const },
      };
    });
  }

  private async markDispatchReservationProviderStarting(
    reservation: TaskDispatchReservation,
  ): Promise<void> {
    await this.mutateStore((data) => {
      const current = data.tasks.find(
        (item) => item.id === reservation.task.id,
      );
      if (!current?.dispatchReservation) {
        throw new Error('Task dispatch reservation was superseded');
      }
      const currentReservation = current.dispatchReservation;
      if (
        currentReservation.phase !== 'pre_provider' ||
        currentReservation.generation !== reservation.persisted.generation ||
        currentReservation.sessionId !== reservation.sessionId ||
        current?.updatedAt !== reservation.persisted.reservedAt
      ) {
        throw new Error('Task dispatch reservation was superseded');
      }
      const nextReservation: PersistedTaskDispatchReservation = {
        ...current.dispatchReservation,
        phase: 'provider_starting',
      };
      const nextTask: PersistedTaskRecord = {
        ...current,
        dispatchReservation: nextReservation,
      };
      return {
        data: {
          ...data,
          tasks: data.tasks.map((item) =>
            item.id === nextTask.id ? nextTask : item,
          ),
        },
        result: undefined,
      };
    });
  }

  private async assertDispatchReservationProviderStarting(
    reservation: TaskDispatchReservation,
  ): Promise<void> {
    const release = await this.acquireMutationLock(
      `${this.storePath}.mutation`,
    );
    try {
      const current = this.loadStore().tasks.find(
        (item) => item.id === reservation.task.id,
      );
      if (!current?.dispatchReservation) {
        throw new Error('Task dispatch reservation was superseded');
      }
      const currentReservation = current.dispatchReservation;
      if (
        currentReservation.phase !== 'provider_starting' ||
        currentReservation.generation !== reservation.persisted.generation ||
        currentReservation.sessionId !== reservation.sessionId ||
        current?.updatedAt !== reservation.persisted.reservedAt
      ) {
        throw new Error('Task dispatch reservation was superseded');
      }
    } finally {
      await release();
    }
  }

  private async markDispatchReservationIndeterminate(
    reservation: TaskDispatchReservation,
  ): Promise<void> {
    await this.mutateStore((data) => {
      const current = data.tasks.find(
        (item) => item.id === reservation.task.id,
      );
      if (
        !current ||
        current.dispatchReservation?.generation !==
          reservation.persisted.generation ||
        current.dispatchReservation.sessionId !== reservation.sessionId
      ) {
        return { data, result: undefined };
      }
      const nextTask: PersistedTaskRecord = {
        ...current,
        dispatchReservation: {
          ...current.dispatchReservation,
          phase: 'indeterminate',
        },
      };
      return {
        data: {
          ...data,
          tasks: data.tasks.map((item) =>
            item.id === nextTask.id ? nextTask : item,
          ),
        },
        result: undefined,
      };
    });
  }

  /** AssignmentProvider artifact root for a project workspace — the SAME
   * `<workspace>/.kontourai/flow-agents` root the pinned package's own
   * `ensure-session`/`assignment-provider` CLI resolve (verified against
   * `workflow-sidecar.js`'s `artifactRoot = path.dirname(path.resolve(dir))`
   * for a `.kontourai/flow-agents/<slug>` artifact dir). */
  private assignmentArtifactRoot(workspace: string): string {
    return join(workspace, '.kontourai', 'flow-agents');
  }

  /** Resolves the (subjectId, artifactRoot, actor) triple a claim/release
   * call needs for this task+session, or null when claim tracking doesn't
   * apply (no/unnamespaced workItemRef, or no resolvable project
   * workspace). Shared by `claimForDispatch` and the compensating-release
   * path so both derive the SAME actor/artifactRoot, never a second,
   * drifting computation.
   *
   * It performs no I/O of its OWN; since archive#1501 the injected
   * `resolveProjectWorkspace` does (a live filesystem/git check through
   * `resolveProjectResource`), which is why this is async. It is still a pure
   * function of the task, the session and that resolver — it reads no store
   * and writes nothing. */
  private async buildClaimContext(
    task: TaskRecord,
    sessionId: string,
    resolveProjectWorkspace = this.resolveProjectWorkspace,
  ): Promise<{
    subjectId: string;
    artifactRoot: string;
    actor: AssignmentClaimActor;
  } | null> {
    const subjectId = task.workItemRef;
    if (!subjectId || !isNamespacedWorkItemRef(subjectId)) return null;
    const workspace = await resolveProjectWorkspace?.(task.projectId);
    if (!workspace) return null;
    return {
      subjectId,
      artifactRoot: this.assignmentArtifactRoot(workspace),
      actor: { runtime: 'station', session_id: sessionId, host: os.hostname() },
    };
  }

  /**
   * Attempts an AssignmentProvider claim for a dispatch of a provider-backed
   * task (namespaced `workItemRef`). Returns undefined for a local task (no
   * workItemRef) — unchanged dispatch behavior. Never throws.
   *
   * Fail-open is reserved for EXACTLY ONE condition (review findings #4 and
   * its confirmation-pass follow-up): the assignment-provider CLI package is
   * CONFIRMED not installed (`AssignmentClaimService` itself resolved no
   * package root) — `'unavailable'`, dispatch proceeds unclaimed. Every
   * other degraded path — no `assignmentClaimService` wired at all, an
   * unresolvable project workspace (`resolveProjectWorkspace` returning
   * undefined is production-reachable whenever a project's
   * `workingDirectory` is unset), a genuine actor conflict, or an
   * operational claim failure that leaves ownership indeterminate (lock
   * timeout, corrupt record, malformed output) — resolves to `'blocked'`
   * and the caller refuses dispatch. None of those are "no claim system
   * exists"; they are all "the claim system could not be consulted", which
   * must never be silently treated the same as package-absence.
   */
  private async claimForDispatch(
    task: TaskRecord,
    sessionId: string,
    signal?: AbortSignal,
    assignmentClaimService = this.assignmentClaimService,
    resolveProjectWorkspace = this.resolveProjectWorkspace,
  ): Promise<TaskAssignmentClaimSummary | undefined> {
    signal?.throwIfAborted();
    const subjectId = task.workItemRef;
    if (!subjectId || !isNamespacedWorkItemRef(subjectId)) return undefined;
    if (!assignmentClaimService) {
      // No claim service wired at all is an operational gap, not a
      // confirmed "no claim system installed" — fail CLOSED (confirmation
      // pass on finding #4).
      taskAssignmentClaimTotal.add(1, {
        operation: 'claim',
        outcome: 'blocked',
      });
      return {
        outcome: 'blocked',
        subjectId,
        kind: 'operational-error',
        reason: 'assignment claim service not configured',
      };
    }
    const context = await this.buildClaimContext(
      task,
      sessionId,
      resolveProjectWorkspace,
    );
    if (!context) {
      // An unresolvable project workspace is production-reachable
      // (`workingDirectory` is optional) and is NOT proof the package is
      // absent — fail CLOSED here too, rather than silently proceeding
      // claimless (confirmation pass on finding #4).
      taskAssignmentClaimTotal.add(1, {
        operation: 'claim',
        outcome: 'blocked',
      });
      return {
        outcome: 'blocked',
        subjectId,
        kind: 'operational-error',
        reason: 'project workspace not resolvable',
      };
    }
    const { artifactRoot, actor } = context;

    // Redispatch self-handoff (review finding #2 follow-through): if THIS
    // task's own prior dispatch still holds an active claim on the same
    // subject (the task-lifecycle-boundary / session.exited release
    // triggers haven't fired yet — e.g. the task is still 'ready' and the
    // user dispatched it again), release it first. This is Station
    // releasing its OWN previously-recorded claim using data it already
    // persisted — never a stale-lease/liveness reclaim of a claim some
    // OTHER actor holds, which still goes through claim()'s normal
    // conflict path below and can legitimately come back 'blocked'.
    const priorDispatch = this.readStore().dispatches.find(
      (item) =>
        item.taskId === task.id &&
        item.sessionId !== sessionId &&
        item.claim?.outcome === 'claimed' &&
        item.claim.subjectId === subjectId,
    );
    if (priorDispatch) {
      await this.releaseDispatchClaim(
        priorDispatch,
        task.id,
        `superseded by redispatch (session ${sessionId})`,
      );
    }

    const result = await assignmentClaimService.claim({
      artifactRoot,
      subjectId,
      actor,
      branch: `station/${sessionId}`,
      artifactDir: join(artifactRoot, subjectId),
      reason: `Station dispatch: task ${task.id}`,
    });
    const summary: TaskAssignmentClaimSummary =
      result.outcome === 'claimed'
        ? {
            outcome: 'claimed',
            subjectId,
            actor: toClaimActor(actor),
            claimedAt: canonicalizeProviderTimestamp(
              result.record.claimed_at,
              'Assignment-provider claimed_at',
            ),
          }
        : result.outcome === 'blocked'
          ? {
              outcome: 'blocked',
              subjectId,
              kind: result.kind,
              reason: result.reason,
              holderActor: result.holderActor
                ? toClaimActor(result.holderActor)
                : undefined,
            }
          : { outcome: 'unavailable', subjectId, reason: result.reason };
    taskAssignmentClaimTotal.add(1, {
      operation: 'claim',
      outcome: summary.outcome,
    });
    return summary;
  }

  /**
   * Compensates a claim acquired before durable dispatch association. Its
   * result is deliberately total: a caller must never restore a reservation
   * as retryable while the external claim may still be held.
   */
  private async compensateFailedDispatchClaim(
    task: TaskRecord,
    sessionId: string,
    originalError: unknown,
    assignmentClaimService = this.assignmentClaimService,
    resolveProjectWorkspace = this.resolveProjectWorkspace,
  ): Promise<{ kind: 'released' } | { kind: 'indeterminate'; reason: string }> {
    try {
      if (!assignmentClaimService) {
        return {
          kind: 'indeterminate',
          reason: 'assignment claim service is not configured for compensation',
        };
      }
      const context = await this.buildClaimContext(
        task,
        sessionId,
        resolveProjectWorkspace,
      );
      if (!context) {
        return {
          kind: 'indeterminate',
          reason: 'project workspace is not resolvable for compensation',
        };
      }
      const result = await assignmentClaimService.release({
        artifactRoot: context.artifactRoot,
        subjectId: context.subjectId,
        actor: context.actor,
        reason: `dispatch failed after claim: ${
          originalError instanceof Error
            ? originalError.message
            : String(originalError)
        }`,
      });
      taskAssignmentClaimTotal.add(1, {
        operation: 'release',
        outcome: result.outcome,
      });
      if (result.outcome === 'released' || result.outcome === 'skipped') {
        return { kind: 'released' };
      }
      this.logger?.warn(
        'Failed to release assignment claim after a failed dispatch — claim may be orphaned until the next startup reconciliation sweep',
        {
          taskId: task.id,
          sessionId,
          subjectId: context.subjectId,
          reason: result.reason,
        },
      );
      return { kind: 'indeterminate', reason: result.reason };
    } catch (releaseError) {
      const reason =
        releaseError instanceof Error
          ? releaseError.message
          : String(releaseError);
      this.logger?.warn('compensateFailedDispatchClaim threw unexpectedly', {
        taskId: task.id,
        sessionId,
        error: reason,
      });
      return { kind: 'indeterminate', reason };
    }
  }

  /**
   * Releases the AssignmentProvider claim recorded on a specific dispatch
   * record, if it is still marked `'claimed'`. Only ever marks the dispatch
   * record `'released'` in the store when the CLI confirmed the claim is
   * actually gone (`'released'`, or the CLI's own idempotent `'skipped'`
   * no-op) — a release that itself failed (`'failed'`/`'unavailable'`)
   * leaves the record `'claimed'` so it is found and retried again later
   * (review finding #3: a failed release must never read as success).
   * Never throws — every internal failure is logged and reported through
   * the return value.
   */
  private async releaseDispatchClaim(
    dispatch: TaskDispatchRecord,
    taskId: string,
    reason: string,
  ): Promise<
    'released' | 'skipped' | 'failed' | 'unavailable' | 'not-claimed'
  > {
    if (!this.assignmentClaimService) return 'unavailable';
    const claim = dispatch.claim;
    if (!claim?.actor || claim.outcome !== 'claimed') return 'not-claimed';
    const task = this.readTask(taskId);
    if (!task) return 'not-claimed';
    const workspace = await this.resolveProjectWorkspace?.(task.projectId);
    if (!workspace) {
      this.logger?.warn(
        'Cannot release assignment claim: project workspace not resolvable',
        { taskId, sessionId: dispatch.sessionId },
      );
      return 'unavailable';
    }
    const artifactRoot = this.assignmentArtifactRoot(workspace);
    const result = await this.assignmentClaimService.release({
      artifactRoot,
      subjectId: claim.subjectId,
      actor: {
        runtime: claim.actor.runtime,
        session_id: claim.actor.sessionId,
        host: claim.actor.host,
        human: claim.actor.human ?? null,
      },
      reason,
    });
    taskAssignmentClaimTotal.add(1, {
      operation: 'release',
      outcome: result.outcome,
    });
    if (result.outcome === 'unavailable' || result.outcome === 'failed') {
      this.logger?.warn(
        'Failed to release assignment claim; leaving it active for retry',
        {
          taskId,
          sessionId: dispatch.sessionId,
          outcome: result.outcome,
          reason: result.reason,
        },
      );
      return result.outcome;
    }
    // 'released' and 'skipped' (the CLI's own idempotent no-op) both mean
    // nothing is left to release — safe to mark this dispatch record so.
    await this.markDispatchClaimReleased(dispatch.id);
    return result.outcome;
  }

  /** Flips a dispatch record's `claim.outcome` to `'released'` in the
   * store — the ONLY place that ever does so; every release call site
   * (session-exited, task-terminal, redispatch self-handoff, startup
   * reconciliation) routes through `releaseDispatchClaim` above, which only
   * calls this after the CLI confirmed the claim is actually gone. */
  private async markDispatchClaimReleased(dispatchId: string): Promise<void> {
    await this.mutateStore((data) => {
      const index = data.dispatches.findIndex((item) => item.id === dispatchId);
      if (index === -1) return { data, result: undefined };
      const existingClaim = data.dispatches[index].claim;
      if (existingClaim?.outcome !== 'claimed') {
        return { data, result: undefined };
      }
      const updated: TaskDispatchRecord = {
        ...data.dispatches[index],
        claim: { ...existingClaim, outcome: 'released' },
      };
      return {
        data: {
          ...data,
          dispatches: data.dispatches.map((item, at) =>
            at === index ? updated : item,
          ),
        },
        result: undefined,
      };
    });
  }

  /**
   * Releases a task's AssignmentProvider claim on orchestration session end
   * or cancel (roadmap archive#584) — fires only for a REAL orchestrated session
   * (`session.exited`); the default `'task-dispatch'` seeded path never
   * reaches this trigger at all (see `updateTaskStatus`'s doc comment) and
   * relies on `releaseClaimForTask` instead. Never throws; idempotent since
   * `session.exited` can fire more than once for the same thread.
   */
  async releaseClaimForSession(
    sessionId: string,
    reason: string,
  ): Promise<void> {
    try {
      if (!this.assignmentClaimService) return;
      const data = this.readStore();
      const task = data.tasks.find((item) => item.sessionId === sessionId);
      if (!task?.workItemRef) return;
      const dispatch = data.dispatches.find(
        (item) =>
          item.sessionId === sessionId && item.claim?.outcome === 'claimed',
      );
      if (!dispatch) return;
      await this.releaseDispatchClaim(dispatch, task.id, reason);
    } catch (error) {
      this.logger?.warn('releaseClaimForSession failed unexpectedly', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Releases a task's active AssignmentProvider claim keyed by task id
   * rather than session id — the task-lifecycle-boundary release trigger
   * (review finding #2). Called by `updateTaskStatus` on every transition
   * into `done`/`canceled`, and by `claimForDispatch`'s redispatch
   * self-handoff. Never throws; idempotent (a task with no active claim is
   * a no-op).
   */
  async releaseClaimForTask(taskId: string, reason: string): Promise<void> {
    try {
      if (!this.assignmentClaimService) return;
      const data = this.readStore();
      const dispatch = data.dispatches.find(
        (item) => item.taskId === taskId && item.claim?.outcome === 'claimed',
      );
      if (!dispatch) return;
      await this.releaseDispatchClaim(dispatch, taskId, reason);
    } catch (error) {
      this.logger?.warn('releaseClaimForTask failed unexpectedly', {
        taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Startup reconciliation sweep (review finding #5, hardened against a
   * confirmation-pass follow-up finding). a crash between `claim()`
   * succeeding and its compensating release (or a `session.exited`/
   * task-completion release that never landed because Station itself was
   * down) leaves a durable claim with no live owner. Never throws.
   *
   * SUBJECT-centric, not task-centric (the confirmation-pass fix): a
   * `workItemRef` can be shared by more than one local task, and the SAME
   * artifact root/subject can be shared across two different Station
   * homes. Evaluating "is this still MY current session" per task
   * independently let one task's own terminal status release ANOTHER
   * task's — or another Station instance's — genuinely live claim, because
   * `runtime === 'station'` on its own is not ownership proof (any Station
   * instance's dispatch writes that runtime string). The fix requires a
   * claim to clear ALL of:
   *
   *   1. Every LOCAL task referencing the subject is terminal
   *      (`done`/`canceled`) — if even one is still active, the claim is
   *      left alone entirely, no matter which session the CLI reports
   *      holding it.
   *   2. The claim is held by `runtime: 'station'` (never touches another
   *      runtime's claim, e.g. a live flow-agents CLI session).
   *   3. A dispatch record THIS instance itself persisted proves it: same
   *      subject, `claim.outcome === 'claimed'`, and an EXACT
   *      `sessionId` match against the CLI's reported holder session. This
   *      is the actual ownership proof — without it, a `'station'`-owned
   *      claim on a terminal-locally task's subject could just as easily
   *      be another Station instance's own live dispatch, and is left
   *      alone.
   *
   * Ambiguous cases (no proving dispatch record found, or any sibling task
   * still active) are NEVER released — "looks superseded relative to a
   * sibling task" is not a release condition. Re-checks the local
   * terminal/non-terminal set immediately before releasing to narrow the
   * race against a new task being dispatched onto the subject while the
   * sweep is still running.
   *
   * Residual gap (accepted limitation, ties to kontourai/archive#592's
   * `@kontourai/flow-agents` bump): a crash between `claim()` succeeding
   * and the dispatch's task-store write landing leaves NO dispatch record
   * at all for that attempt, so this sweep cannot prove ownership of it —
   * by design (never guess), that claim is left alone rather than reclaimed
   * on weaker evidence. The pinned 3.4.3 bare `assignment-provider claim`
   * has no TTL/liveness of its own to fall back on here; closing this fully
   * needs the typed, liveness-aware provider (archive#592).
   */
  async reconcileStaleAssignmentClaims(): Promise<{
    releasedSubjects: string[];
  }> {
    const released: string[] = [];
    try {
      if (!this.assignmentClaimService) return { releasedSubjects: released };
      const data = this.readStore();
      const tasksBySubject = new Map<string, TaskRecord[]>();
      for (const task of data.tasks) {
        const subjectId = task.workItemRef;
        if (!subjectId || !isNamespacedWorkItemRef(subjectId)) continue;
        const list = tasksBySubject.get(subjectId) ?? [];
        list.push(task);
        tasksBySubject.set(subjectId, list);
      }

      for (const [subjectId, tasksForSubject] of tasksBySubject) {
        const isTerminal = (task: TaskRecord) =>
          task.status === 'done' || task.status === 'canceled';
        if (tasksForSubject.some((task) => !isTerminal(task))) continue;

        let artifactRoot: string | undefined;
        for (const task of tasksForSubject) {
          const workspace = await this.resolveProjectWorkspace?.(
            task.projectId,
          );
          if (workspace) {
            artifactRoot = this.assignmentArtifactRoot(workspace);
            break;
          }
        }
        if (!artifactRoot) continue;

        const status = await this.assignmentClaimService.status({
          artifactRoot,
          subjectId,
        });
        if (status.outcome !== 'claimed') continue;
        if (status.actor.runtime !== 'station') continue;

        // Ownership proof: a dispatch record THIS instance persisted for a
        // task sharing this subject, whose session_id matches the CLI's
        // reported holder EXACTLY. `runtime === 'station'` alone proves
        // nothing about WHICH Station instance/task made the claim.
        const provingDispatch = data.dispatches.find(
          (dispatch) =>
            dispatch.claim?.outcome === 'claimed' &&
            dispatch.claim.subjectId === subjectId &&
            dispatch.sessionId === status.actor.session_id &&
            tasksForSubject.some((task) => task.id === dispatch.taskId),
        );
        if (!provingDispatch) continue; // ambiguous — never guess

        // Narrow the race against a new task being created and dispatched
        // onto this subject while the sweep is still running.
        const stillAllTerminal = this.readStore()
          .tasks.filter((task) => task.workItemRef === subjectId)
          .every(isTerminal);
        if (!stillAllTerminal) continue;

        const result = await this.releaseDispatchClaim(
          provingDispatch,
          provingDispatch.taskId,
          'startup reconciliation: task reached a terminal status without a claim release',
        );
        taskAssignmentClaimTotal.add(1, {
          operation: 'reconcile',
          outcome: result,
        });
        if (result === 'released' || result === 'skipped') {
          released.push(subjectId);
        } else if (result === 'failed' || result === 'unavailable') {
          this.logger?.warn(
            'Startup reconciliation failed to release a stale assignment claim',
            { taskId: provingDispatch.taskId, subjectId, outcome: result },
          );
        }
      }
    } catch (error) {
      this.logger?.warn('reconcileStaleAssignmentClaims failed unexpectedly', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { releasedSubjects: released };
  }

  /**
   * Read-time AssignmentProvider claim status for a task's `workItemRef`
   * (roadmap archive#584) — independent of dispatch history, so the Tasks board
   * can show claim state and guard dispatch BEFORE the user attempts it.
   */
  async readClaimStatus(taskId: string): Promise<TaskClaimStatus> {
    const task = this.readStore().tasks.find((item) => item.id === taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const subjectId = task.workItemRef;
    if (!subjectId || !isNamespacedWorkItemRef(subjectId)) {
      return { state: 'none' };
    }
    if (!this.assignmentClaimService) {
      return {
        state: 'unavailable',
        subjectId,
        reason: 'assignment claim service not configured',
      };
    }
    const workspace = await this.resolveProjectWorkspace?.(task.projectId);
    if (!workspace) {
      return {
        state: 'unavailable',
        subjectId,
        reason: 'project workspace not resolvable',
      };
    }
    const artifactRoot = this.assignmentArtifactRoot(workspace);
    const result = await this.assignmentClaimService.status({
      artifactRoot,
      subjectId,
    });
    if (result.outcome === 'unavailable') {
      return { state: 'unavailable', subjectId, reason: result.reason };
    }
    if (result.outcome === 'free') {
      return { state: 'free', subjectId };
    }
    const actor = toClaimActor(result.actor);
    const mine =
      actor.runtime === 'station' && actor.sessionId === task.sessionId;
    return {
      state: mine ? 'claimed-by-me' : 'claimed-by-other',
      subjectId,
      actor,
    };
  }

  private seedSession(
    sessionId: string,
    provider: EngineId,
    model?: string,
    orchestrationService = this.orchestrationService,
  ): ProviderSession {
    if (orchestrationService) {
      return orchestrationService.seedSessionRecord({
        threadId: sessionId,
        provider,
        model,
        status: 'ready',
      });
    }
    const now = new Date().toISOString();
    return {
      provider,
      threadId: sessionId,
      status: 'ready',
      model,
      createdAt: now,
      updatedAt: now,
    };
  }

  private buildDispatchLinks(
    task: TaskRecord,
    input: TaskDispatchInput,
    sessionId: string,
  ): RelationGraphLink[] {
    const now = new Date().toISOString();
    const links: Array<Omit<RelationGraphLink, 'id' | 'createdAt'>> = [
      {
        sourceType: 'task',
        sourceId: task.id,
        targetType: 'session',
        targetId: sessionId,
        relationType: 'spawned_session',
        confidence: 1,
        source: 'dispatch',
      },
    ];

    const agentId = normalizeText(input.agentId) || task.agentId;
    if (agentId) {
      links.push({
        sourceType: 'task',
        sourceId: task.id,
        targetType: 'agent',
        targetId: agentId,
        relationType: 'owned_by_agent',
        confidence: 1,
        source: 'dispatch',
      });
    }

    const skillName = normalizeText(input.skillName) || task.skillName;
    if (skillName) {
      links.push({
        sourceType: 'task',
        sourceId: task.id,
        targetType: 'skill',
        targetId: skillName,
        relationType: 'uses_skill',
        confidence: 1,
        source: 'dispatch',
      });
    }

    for (const file of input.relatedFiles ?? []) {
      const targetId = normalizeText(file);
      if (!targetId) continue;
      links.push({
        sourceType: 'task',
        sourceId: task.id,
        targetType: 'file',
        targetId,
        relationType: 'touches_file' as RelationType,
        confidence: 0.8,
        source: 'dispatch',
      });
    }

    return links.map((link) => ({
      ...link,
      id: crypto.randomUUID(),
      createdAt: now,
    }));
  }
}
