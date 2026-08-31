import type { ClientOrigin } from './client-origin.js';
import type { EngineId, ProviderSession } from './provider.js';

/**
 * Station's task status vocabulary (roadmap #581, part of epic #580).
 *
 * The Flow-compatible values (`todo`, `ready`, `in_progress`, `blocked`,
 * `review`, `verification`, and `done`) are the neutral work-item vocabulary
 * exported as `@kontourai/flow-agents`' `workItemStatuses`. Station's Task
 * board maps onto that vocabulary so a task's status stays meaningful if a
 * work item crosses into a Flow Agents-aware surface.
 *
 * `triage` is a Station-local intake state and `canceled` is a Station-local
 * terminal state for tasks a user abandons before completion. Neither belongs
 * to the Flow Agents work-item contract. Keep `canceled` last and keep this
 * comment in sync with `docs/glossary.md`'s Task entry; see
 * `packages/contracts/src/__tests__/flow-agents-vocabulary-drift.test.ts` for
 * the direct package-export tripwire.
 */
export const TASK_STATUSES = [
  'todo',
  'ready',
  'triage',
  'in_progress',
  'blocked',
  'review',
  'verification',
  'done',
  'canceled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;

export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const RELATION_ENTITY_TYPES = [
  'task',
  'session',
  'turn',
  'user_input',
  'tool_result',
  'gate_evaluation',
  'file',
  'agent',
  'skill',
  'project',
  'artifact',
  'receipt',
  'external',
] as const;

export type RelationEntityType = (typeof RELATION_ENTITY_TYPES)[number];

export const RELATION_TYPES = [
  'spawned_session',
  'touches_file',
  'uses_skill',
  'owned_by_agent',
  'references_turn',
  'references_user_input',
  'references_tool_result',
  'references_gate_evaluation',
  'references_artifact',
  'references_receipt',
  'references_external',
] as const;

export type RelationType = (typeof RELATION_TYPES)[number];

export type RelationLinkSource = 'dispatch' | 'system' | 'user' | 'inferred';

export const TASK_WORKSPACE_AVAILABILITY = [
  'available',
  'ambiguous',
  'unavailable',
] as const;

export type TaskWorkspaceAvailability =
  (typeof TASK_WORKSPACE_AVAILABILITY)[number];

export const MAX_TASK_TITLE_LENGTH = 240;
export const MAX_TASK_DESCRIPTION_LENGTH = 12_000;
export const MAX_TASK_REFERENCE_TARGET_LENGTH = 4_096;
/** Bound every producer-owned identity before it can reach a resolver. */
export const MAX_TASK_REFERENCE_ID_LENGTH = MAX_TASK_REFERENCE_TARGET_LENGTH;
export const MAX_TASK_REFERENCE_METADATA_BYTES = 16_384;
export const MAX_TASK_REFERENCES_PER_TASK = 100;
const MAX_TASK_WORKSPACE_STRING_LENGTH = 4_096;

/**
 * A point-in-time workspace snapshot captured while creating a Task. All fields
 * are optional because Station never infers an unavailable repository/worktree
 * value from a project or neighboring session.
 */
export interface TaskWorkspaceBinding {
  /** Server-derived current reopen state; raw paths are not authority to open. */
  availability?: TaskWorkspaceAvailability;
  workingDirectory?: string;
  repoRoot?: string;
  worktreePath?: string;
  branch?: string;
  sourceSurface?: string;
  capturedAt?: string;
}

/** One immutable workspace-file snapshot explicitly promoted from a Task. */
export interface TaskOutputRecord {
  schemaVersion: 1;
  id: string;
  taskId: string;
  projectId: string;
  title: string;
  source: { kind: 'workspace-file'; relativePath: string };
  materialization: {
    kind: 'snapshot';
    fileName: string;
    mediaType: string;
    byteLength: number;
    digest: `sha256:${string}`;
    contentAvailable: boolean;
  };
  createdAt: string;
  createdClientOrigin?: ClientOrigin;
}

export interface TaskOutputCreateInput {
  operationId: string;
  relativePath: string;
  title: string;
  declaredMediaType?: string;
}

/**
 * One Task-curated reference to live external pull-request state. It is an
 * identity/provenance record only: protected provider title, body, URL, and
 * any mutable preview never enter TaskGraph.
 */
export interface TaskKeptDeclaredPullRequest {
  schemaVersion: 1;
  taskId: string;
  provider: string;
  host: string;
  repository: { owner: string; name: string };
  ref: string;
  nativeId: string;
  provenance: {
    sessionId: string;
    turnId: string;
    toolCallId: string;
    declarationId: string;
    eventId: string;
  };
  keptAt: string;
}

export type TaskKeptDeclaredPullRequestOutcome = {
  outcome: 'kept' | 'already-kept';
  reference: TaskKeptDeclaredPullRequest;
};

/** Closed transport result for one explicit declared-output curation action. */
export const TASK_DECLARED_OUTPUT_KEEP_V1 =
  'task-declared-output-keep/v1' as const;
export type TaskDeclaredOutputKeepResult =
  | {
      version: typeof TASK_DECLARED_OUTPUT_KEEP_V1;
      status: 'kept';
      kind: 'workspace-file';
      outcome: 'kept' | 'already-kept';
      output: TaskOutputRecord;
    }
  | {
      version: typeof TASK_DECLARED_OUTPUT_KEEP_V1;
      status: 'kept';
      kind: 'pull-request';
      outcome: 'kept' | 'already-kept';
      reference: TaskKeptDeclaredPullRequest;
    };

export const TASK_REFERENCE_KINDS = [
  'turn',
  'user-input',
  'tool-result',
  'gate-evaluation',
  'artifact',
  'receipt',
  'external',
] as const;

export type TaskReferenceKind = (typeof TASK_REFERENCE_KINDS)[number];

export type OpaqueTaskReferenceKind = Exclude<
  TaskReferenceKind,
  'turn' | 'user-input' | 'tool-result' | 'gate-evaluation'
>;

/**
 * The durable identity of one assistant answer. A turn id is scoped to its
 * Session: callers must retain both values and must never use a transcript
 * offset, message position, or copied answer text as an identity substitute.
 */
export interface TaskTurnReference {
  kind: 'turn';
  sessionId: string;
  turnId: string;
}

/**
 * A user-supplied turn reference. `sourceSurface` describes the initiating
 * Station surface only; it is not part of the answer identity.
 */
export interface TaskTurnReferenceInput extends TaskTurnReference {
  sourceSurface?: string;
}

/**
 * Exact authored prompt identity. Event ids are globally unique in the durable
 * EventStore; Session remains part of this reference for source authorization
 * and historical Conversation lineage, never as a collision workaround.
 */
export interface TaskUserInputReference {
  kind: 'user-input';
  sessionId: string;
  eventId: string;
}

export interface TaskUserInputReferenceInput extends TaskUserInputReference {
  sourceSurface?: string;
}

/**
 * A terminal tool result is globally identified by its owner-issued event id.
 * The Session stays in the tuple for authorization and historical lineage.
 */
export interface TaskToolResultReference {
  kind: 'tool-result';
  sessionId: string;
  eventId: string;
}

export interface TaskToolResultReferenceInput extends TaskToolResultReference {
  sourceSurface?: string;
}

/** Exact owner-issued Flow gate appraisal; it is not an answer association. */
export interface TaskGateEvaluationReferenceInput {
  kind: 'gate-evaluation';
  ref: { runId: string; gateId: string; evaluationId: string };
  sourceSurface?: string;
}

/** Metadata-only attachment projection; bytes, paths, and handles never cross this wire boundary. */
export interface TaskUserInputAttachmentProjection {
  name: string;
  mediaType: string;
  size: number;
}

/** The exact authored-input payload a Task reference may expose after authorization. */
export interface TaskUserInputProjection {
  /** Canonical turn-start classification; legacy descriptors honestly report unknown. */
  inputKind?: 'initial' | 'steer' | 'unknown';
  prompt: string;
  attachments: readonly TaskUserInputAttachmentProjection[];
}

/** A Task-owned input link reauthorized at read time, or one opaque unavailable sentinel. */
export type TaskUserInputReferenceProjection =
  | {
      id: string;
      state: 'available';
      sessionId: string;
      eventId: string;
      turnId: string;
      input: TaskUserInputProjection;
    }
  | { state: 'unavailable' };

/** A durable, explicit association between one exact answer and one Surface claim. */
export interface TaskAnswerSupportAssociation {
  schemaVersion: 1;
  kind: 'answer-support';
  id: string;
  taskId: string;
  answerReferenceId: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Deliberately contains no Project, Session, turn, path, or report metadata. */
export interface TaskAnswerSupportMutationInput {
  bundleId: string;
  claimId: string;
}

export interface TaskAnswerSupportReplaceInput
  extends TaskAnswerSupportMutationInput {
  expectedRevision: number;
}

export interface TaskAnswerSupportRemoveInput {
  expectedRevision: number;
}

export type TaskAnswerSupportStanding =
  | { state: 'unassessed' }
  | {
      state: 'available';
      associationId: string;
      revision: number;
    }
  | { state: 'claim-missing' }
  | { state: 'corrupt' }
  | { state: 'unsupported-version' }
  | { state: 'unavailable' };

export const MAX_TASK_ANSWER_SUPPORT_ID_LENGTH = 512;

/** Canonical opaque IDs are intentionally not paths or display labels. */
export function isCanonicalTaskAnswerSupportId(
  value: unknown,
): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TASK_ANSWER_SUPPORT_ID_LENGTH &&
    value.trim() === value &&
    !value.includes('\\') &&
    !value.includes('/') &&
    !value.includes('\0') &&
    !value.includes('\r') &&
    !value.includes('\n')
  );
}

/**
 * Opaque producer-owned references retain their existing target handle and
 * optional display metadata. Turn references deliberately do not: their
 * identity is the typed Session/turn tuple above.
 */
export interface OpaqueTaskReferenceInput {
  kind: OpaqueTaskReferenceKind;
  targetId: string;
  metadata?: Record<string, unknown>;
  sourceSurface?: string;
}

/**
 * A narrow Task-owned reference that is persisted as a RelationGraphLink.
 * External targets are opaque handles; this contract does not resolve them.
 */
export type TaskReferenceInput =
  | TaskTurnReferenceInput
  | TaskUserInputReferenceInput
  | TaskToolResultReferenceInput
  | TaskGateEvaluationReferenceInput
  | OpaqueTaskReferenceInput;

const TASK_TURN_REFERENCE_PREFIX = 'turn/';
const TASK_USER_INPUT_REFERENCE_PREFIX = 'user-input/';
const TASK_TOOL_RESULT_REFERENCE_PREFIX = 'tool-result/';
const TASK_GATE_EVALUATION_REFERENCE_PREFIX = 'gate-evaluation/';

function isWellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff)
        return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Bounded opaque identities must be valid Unicode so URI encoding is total. */
export function isCanonicalTaskReferenceId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_TASK_REFERENCE_ID_LENGTH &&
    value.trim() === value &&
    isWellFormedUnicode(value)
  );
}

function safeEncodeTaskReferenceComponent(value: string): string {
  if (!isWellFormedUnicode(value)) return '%';
  return encodeURIComponent(value);
}

/**
 * Canonical storage identity for a turn reference. URI component encoding
 * makes the tuple unambiguous even when either identifier contains a path or
 * delimiter character; the Session stays in the key so equal turn ids in two
 * Sessions cannot collide.
 */
export function encodeTaskTurnReference(
  sessionId: string,
  turnId: string,
): string {
  return `${TASK_TURN_REFERENCE_PREFIX}${encodeURIComponent(sessionId)}/${encodeURIComponent(turnId)}`;
}

/**
 * Parse only the exact canonical tuple emitted by
 * {@link encodeTaskTurnReference}. Non-canonical or malformed stored values
 * are rejected rather than being normalized into a different answer identity.
 */
export function parseTaskTurnReference(
  targetId: string,
): TaskTurnReference | null {
  if (!targetId.startsWith(TASK_TURN_REFERENCE_PREFIX)) return null;
  const encoded = targetId.slice(TASK_TURN_REFERENCE_PREFIX.length).split('/');
  if (encoded.length !== 2 || !encoded[0] || !encoded[1]) return null;
  try {
    const sessionId = decodeURIComponent(encoded[0]);
    const turnId = decodeURIComponent(encoded[1]);
    if (!isNonBlankString(sessionId) || !isNonBlankString(turnId)) return null;
    if (encodeTaskTurnReference(sessionId, turnId) !== targetId) return null;
    return { kind: 'turn', sessionId, turnId };
  } catch {
    return null;
  }
}

/** Canonical storage identity for an exact authored-input Session/event tuple. */
export function encodeTaskUserInputReference(
  sessionId: string,
  eventId: string,
): string {
  return `${TASK_USER_INPUT_REFERENCE_PREFIX}${safeEncodeTaskReferenceComponent(sessionId)}/${safeEncodeTaskReferenceComponent(eventId)}`;
}

/** Reject malformed and normalizable protected identity tuples. */
export function parseTaskUserInputReference(
  targetId: string,
): TaskUserInputReference | null {
  if (!targetId.startsWith(TASK_USER_INPUT_REFERENCE_PREFIX)) return null;
  const encoded = targetId
    .slice(TASK_USER_INPUT_REFERENCE_PREFIX.length)
    .split('/');
  if (encoded.length !== 2 || !encoded[0] || !encoded[1]) return null;
  try {
    const sessionId = decodeURIComponent(encoded[0]);
    const eventId = decodeURIComponent(encoded[1]);
    if (!isNonBlankString(sessionId) || !isNonBlankString(eventId)) return null;
    if (encodeTaskUserInputReference(sessionId, eventId) !== targetId)
      return null;
    return { kind: 'user-input', sessionId, eventId };
  } catch {
    return null;
  }
}

/** Canonical storage identity for one portable Thread tool-result tuple. */
export function encodeTaskToolResultReference(
  sessionId: string,
  eventId: string,
): string {
  return `${TASK_TOOL_RESULT_REFERENCE_PREFIX}${safeEncodeTaskReferenceComponent(sessionId)}/${safeEncodeTaskReferenceComponent(eventId)}`;
}

/** Reject malformed and normalizable protected tool-result identity tuples. */
export function parseTaskToolResultReference(
  targetId: string,
): TaskToolResultReference | null {
  if (!targetId.startsWith(TASK_TOOL_RESULT_REFERENCE_PREFIX)) return null;
  const encoded = targetId
    .slice(TASK_TOOL_RESULT_REFERENCE_PREFIX.length)
    .split('/');
  if (encoded.length !== 2 || !encoded[0] || !encoded[1]) return null;
  try {
    const sessionId = decodeURIComponent(encoded[0]);
    const eventId = decodeURIComponent(encoded[1]);
    if (
      !isCanonicalTaskReferenceId(sessionId) ||
      !isCanonicalTaskReferenceId(eventId)
    )
      return null;
    if (encodeTaskToolResultReference(sessionId, eventId) !== targetId)
      return null;
    return { kind: 'tool-result', sessionId, eventId };
  } catch {
    return null;
  }
}

export function encodeTaskGateEvaluationReference(ref: {
  runId: string;
  gateId: string;
  evaluationId: string;
}): string {
  return `${TASK_GATE_EVALUATION_REFERENCE_PREFIX}${safeEncodeTaskReferenceComponent(ref.runId)}/${safeEncodeTaskReferenceComponent(ref.gateId)}/${safeEncodeTaskReferenceComponent(ref.evaluationId)}`;
}

export function parseTaskGateEvaluationReference(
  targetId: string,
): { runId: string; gateId: string; evaluationId: string } | null {
  if (!targetId.startsWith(TASK_GATE_EVALUATION_REFERENCE_PREFIX)) return null;
  const parts = targetId
    .slice(TASK_GATE_EVALUATION_REFERENCE_PREFIX.length)
    .split('/');
  if (parts.length !== 3 || parts.some((part) => !part)) return null;
  try {
    const [runId, gateId, evaluationId] = parts.map(decodeURIComponent);
    const ref = { runId, gateId, evaluationId };
    if (!Object.values(ref).every(isCanonicalTaskReferenceId)) return null;
    return encodeTaskGateEvaluationReference(ref) === targetId ? ref : null;
  } catch {
    return null;
  }
}

export interface TaskRecord {
  id: string;
  projectId: string;
  title: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  skillName?: string;
  agentId?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** Authenticated origin of creation; absent on records before #3830. */
  createdClientOrigin?: ClientOrigin;
  /** Authenticated origin of the last direct Task mutation. */
  updatedClientOrigin?: ClientOrigin;
  dispatchedAt?: string;
  sessionId?: string;
  workspaceBinding?: TaskWorkspaceBinding;
  /** Provider-neutral source of this task, when it originated from an
   * external work-item provider (e.g. `'github'`). Absent for tasks created
   * directly in Station. */
  sourceProvider?: string;
  /** Provider-neutral reference to the originating work item (e.g. a GitHub
   * issue URL or id). Absent for tasks created directly in Station. */
  workItemRef?: string;
}

export interface TaskCreateInput {
  projectId: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
  skillName?: string;
  agentId?: string;
  createdBy?: string;
  workspaceBinding?: TaskWorkspaceBinding;
  /** Provider-neutral source of this task, when it originated from an
   * external work-item provider (e.g. `'github'`). */
  sourceProvider?: string;
  /** Provider-neutral reference to the originating work item (e.g.
   * `github:owner/repo#123`). Must be globally namespaced to participate in
   * the Tasks board's cross-provider join (see `ProviderWorkItem.workItemRef`'s
   * contract invariant) and in dispatch-as-claim (roadmap #584). */
  workItemRef?: string;
}

export interface TaskStatusUpdateInput {
  status: TaskStatus;
}

export interface TaskDispatchRuntimeConfig {
  provider?: EngineId;
  modelId?: string;
  modelOptions?: Record<string, unknown>;
  cwd?: string;
}

export interface TaskDispatchInput {
  agentId?: string;
  skillName?: string;
  provider?: EngineId;
  runtimeConfig?: TaskDispatchRuntimeConfig;
  relatedFiles?: string[];
  sourceSurface?: string;
  /** Server-authenticated request origin; public route schemas strip this. */
  clientOrigin?: ClientOrigin;
}

/**
 * AssignmentProvider claim/release seam (roadmap #584, part of epic #580,
 * S4). A neutral, camelCase projection of `@kontourai/flow-agents`'
 * AssignmentClaimRecord actor shape — deliberately decoupled from the CLI's
 * own snake_case wire format (`src-server/services/evidence/assignment-claim-service.ts`
 * owns that translation), the same boundary discipline `ProviderWorkItem`
 * already applies to flow-agents' work-item shapes.
 */
export interface TaskAssignmentClaimActor {
  runtime: string;
  sessionId: string;
  host: string;
  human?: string | null;
}

/**
 * `'claimed'` — this dispatch holds the claim.
 * `'blocked'` — dispatch was refused because ownership is contested or
 *   indeterminate; see `kind` (post-ship hardening, review finding #4).
 *   `'unavailable'` — the assignment-provider CLI/package is genuinely NOT
 *   INSTALLED (the only condition allowed to fail open — no claim system
 *   exists for this station install, so dispatch proceeds WITHOUT a claim).
 *   A lock timeout, corrupt record, or any other operational claim failure
 *   is `'blocked'`, never `'unavailable'` — ownership indeterminate is not
 *   the same as ownership absent.
 * `'released'` — a previously `'claimed'` dispatch's claim has since been
 *   released (session end/cancel, task completion, or startup
 *   reconciliation). Only ever reached from `'claimed'` via a release that
 *   the CLI confirmed actually happened (or confirmed nothing was left to
 *   release) — a release that itself failed leaves the summary `'claimed'`
 *   so it is retried, never silently marked released (review finding #3).
 */
export type TaskAssignmentClaimOutcome =
  | 'claimed'
  | 'blocked'
  | 'unavailable'
  | 'released';

/**
 * Only present when `outcome === 'blocked'` (review finding #4).
 * `'conflict'` — a different actor genuinely holds the claim; `holderActor`
 *   is populated when resolvable. `'operational-error'` — the claim
 *   CLI/lock/record could not be read/written reliably (timeout, corrupt
 *   record, malformed output); ownership is indeterminate, not conflicting,
 *   but the dispatch is still refused rather than risk a double-claim.
 */
export type TaskAssignmentClaimBlockKind = 'conflict' | 'operational-error';

export interface TaskAssignmentClaimSummary {
  outcome: TaskAssignmentClaimOutcome;
  /** The namespaced workItemRef the claim was recorded against. */
  subjectId: string;
  /** Present when outcome is 'claimed' or 'released' (the actor Station
   * claimed as). */
  actor?: TaskAssignmentClaimActor;
  /** Present only when outcome is 'blocked'. */
  kind?: TaskAssignmentClaimBlockKind;
  /** Present when outcome is 'blocked' with kind 'conflict' and the current
   * holder's actor was resolvable via `assignment-provider status`. */
  holderActor?: TaskAssignmentClaimActor;
  /** Present when outcome is 'blocked' or 'unavailable'. */
  reason?: string;
  claimedAt?: string;
}

export interface TaskDispatchRecord {
  id: string;
  taskId: string;
  sessionId: string;
  provider: EngineId;
  outcome: 'started' | 'seeded';
  createdAt: string;
  sourceSurface: string;
  clientOrigin?: ClientOrigin;
  /** Present only when the dispatched task carried a namespaced
   * `workItemRef` (roadmap #584); absent for local-only dispatches. */
  claim?: TaskAssignmentClaimSummary;
}

/**
 * `GET /api/tasks/:taskId/claim` response shape (roadmap #584). Read-time
 * projection of the current AssignmentProvider claim for a task's
 * `workItemRef`, independent of dispatch history — lets the Tasks board
 * show claim state (claimed-by-me / claimed-by-other) and guard dispatch
 * BEFORE the user attempts it, not just after a blocked dispatch throws.
 *
 * `'none'` — the task carries no namespaced `workItemRef` (a local task);
 *   claim tracking does not apply.
 * `'free'` — a namespaced `workItemRef`, no active claim.
 * `'claimed-by-me'` — the active claim's actor is this Station instance's
 *   own dispatch session for this task.
 * `'claimed-by-other'` — the active claim's actor is someone else.
 * `'unavailable'` — claim status could not be determined (CLI/package
 *   missing, project workspace not resolvable, malformed output).
 */
export type TaskClaimState =
  | 'none'
  | 'free'
  | 'claimed-by-me'
  | 'claimed-by-other'
  | 'unavailable';

export interface TaskClaimStatus {
  state: TaskClaimState;
  subjectId?: string;
  actor?: TaskAssignmentClaimActor;
  reason?: string;
}

export interface TaskDispatchResult {
  task: TaskRecord;
  dispatch: TaskDispatchRecord;
  session: ProviderSession;
  links: RelationGraphLink[];
}

export interface RelationGraphLink {
  id: string;
  sourceType: RelationEntityType;
  sourceId: string;
  targetType: RelationEntityType;
  targetId: string;
  relationType: RelationType;
  confidence: number;
  createdAt: string;
  source: RelationLinkSource;
  metadata?: Record<string, unknown>;
  /** Authenticated origin of this user-created relation. */
  clientOrigin?: ClientOrigin;
}

export interface RelationGraphLinkInput {
  sourceType: RelationEntityType;
  sourceId: string;
  targetType: RelationEntityType;
  targetId: string;
  relationType: RelationType;
  confidence?: number;
  source?: RelationLinkSource;
  metadata?: Record<string, unknown>;
}

export interface TaskGraph {
  task: TaskRecord;
  links: RelationGraphLink[];
}

export interface SessionRelations {
  sessionId: string;
  links: RelationGraphLink[];
}

// #593 (follow-up from #581's review, finding 2): `review`/`verification`
// can reach `blocked` directly — routing through an `in_progress` detour
// recorded a misleading intermediate status. `blocked` can resume straight
// back to `review`/`verification` for tasks that were blocked from there.
const TASK_STATUS_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  todo: ['ready', 'triage', 'in_progress', 'blocked', 'canceled'],
  ready: ['triage', 'in_progress', 'blocked', 'canceled'],
  triage: ['todo', 'ready', 'in_progress', 'blocked', 'canceled'],
  in_progress: ['blocked', 'review', 'verification', 'done', 'canceled'],
  blocked: [
    'todo',
    'ready',
    'triage',
    'in_progress',
    'review',
    'verification',
    'canceled',
  ],
  review: ['in_progress', 'blocked', 'verification', 'done', 'canceled'],
  verification: ['in_progress', 'blocked', 'review', 'done', 'canceled'],
  done: [],
  canceled: [],
};

export function isTaskStatus(value: string): value is TaskStatus {
  return TASK_STATUSES.includes(value as TaskStatus);
}

export function isTaskPriority(value: string): value is TaskPriority {
  return TASK_PRIORITIES.includes(value as TaskPriority);
}

export function isTaskReferenceKind(value: string): value is TaskReferenceKind {
  return TASK_REFERENCE_KINDS.includes(value as TaskReferenceKind);
}

export function isTaskWorkspaceAvailability(
  value: string,
): value is TaskWorkspaceAvailability {
  return TASK_WORKSPACE_AVAILABILITY.includes(
    value as TaskWorkspaceAvailability,
  );
}

export function canTransitionTaskStatus(
  from: TaskStatus,
  to: TaskStatus,
): boolean {
  return from === to || TASK_STATUS_TRANSITIONS[from].includes(to);
}

export function validateTaskCreateInput(input: TaskCreateInput): string[] {
  const errors: string[] = [];
  if (!isNonBlankString(input.projectId)) errors.push('projectId is required');
  if (!isNonBlankString(input.title)) errors.push('title is required');
  if (
    typeof input.title === 'string' &&
    input.title.trim().length > MAX_TASK_TITLE_LENGTH
  ) {
    errors.push(`title must be at most ${MAX_TASK_TITLE_LENGTH} characters`);
  }
  if (
    typeof input.description === 'string' &&
    input.description.length > MAX_TASK_DESCRIPTION_LENGTH
  ) {
    errors.push(
      `description must be at most ${MAX_TASK_DESCRIPTION_LENGTH} characters`,
    );
  }
  if (input.priority && !isTaskPriority(input.priority)) {
    errors.push(`priority must be one of: ${TASK_PRIORITIES.join(', ')}`);
  }
  errors.push(...validateTaskWorkspaceBinding(input.workspaceBinding));
  return errors;
}

export function validateTaskWorkspaceBinding(
  binding: TaskWorkspaceBinding | undefined,
): string[] {
  if (binding === undefined) return [];
  if (!isRecord(binding)) return ['workspaceBinding must be an object'];

  const errors: string[] = [];
  if (
    binding.availability !== undefined &&
    (typeof binding.availability !== 'string' ||
      !isTaskWorkspaceAvailability(binding.availability))
  ) {
    errors.push(
      `workspaceBinding.availability must be one of: ${TASK_WORKSPACE_AVAILABILITY.join(', ')}`,
    );
  }
  for (const key of [
    'workingDirectory',
    'repoRoot',
    'worktreePath',
    'branch',
    'sourceSurface',
    'capturedAt',
  ] as const) {
    if (binding[key] !== undefined && typeof binding[key] !== 'string') {
      errors.push(`workspaceBinding.${key} must be a string`);
    }
    if (
      typeof binding[key] === 'string' &&
      binding[key].length > MAX_TASK_WORKSPACE_STRING_LENGTH
    ) {
      errors.push(
        `workspaceBinding.${key} must be at most ${MAX_TASK_WORKSPACE_STRING_LENGTH} characters`,
      );
    }
  }
  if (
    typeof binding.capturedAt === 'string' &&
    binding.capturedAt.trim() &&
    Number.isNaN(Date.parse(binding.capturedAt))
  ) {
    errors.push('workspaceBinding.capturedAt must be a valid timestamp');
  }
  return errors;
}

export function validateRelationGraphLinkInput(
  input: RelationGraphLinkInput,
): string[] {
  const errors: string[] = [];
  if (!RELATION_ENTITY_TYPES.includes(input.sourceType)) {
    errors.push(
      `sourceType must be one of: ${RELATION_ENTITY_TYPES.join(', ')}`,
    );
  }
  if (!isNonBlankString(input.sourceId)) errors.push('sourceId is required');
  if (!RELATION_ENTITY_TYPES.includes(input.targetType)) {
    errors.push(
      `targetType must be one of: ${RELATION_ENTITY_TYPES.join(', ')}`,
    );
  }
  if (!isNonBlankString(input.targetId)) errors.push('targetId is required');
  if (!RELATION_TYPES.includes(input.relationType)) {
    errors.push(`relationType must be one of: ${RELATION_TYPES.join(', ')}`);
  }
  if (
    input.confidence !== undefined &&
    (input.confidence < 0 || input.confidence > 1)
  ) {
    errors.push('confidence must be between 0 and 1');
  }
  if (input.targetType === 'turn' || input.relationType === 'references_turn') {
    if (input.targetType !== 'turn') {
      errors.push('references_turn links must target a turn');
    }
    if (input.relationType !== 'references_turn') {
      errors.push('turn links must use relationType references_turn');
    }
    if (parseTaskTurnReference(input.targetId) === null) {
      errors.push('turn targetId must be a canonical Session/turn tuple');
    }
  }
  if (
    input.targetType === 'user_input' ||
    input.relationType === 'references_user_input'
  ) {
    if (input.targetType !== 'user_input') {
      errors.push('references_user_input links must target a user_input');
    }
    if (input.relationType !== 'references_user_input') {
      errors.push(
        'user_input links must use relationType references_user_input',
      );
    }
    if (parseTaskUserInputReference(input.targetId) === null) {
      errors.push(
        'user_input targetId must be a canonical Session/event tuple',
      );
    }
  }
  if (
    input.targetType === 'tool_result' ||
    input.relationType === 'references_tool_result'
  ) {
    if (input.targetType !== 'tool_result') {
      errors.push('references_tool_result links must target a tool_result');
    }
    if (input.relationType !== 'references_tool_result') {
      errors.push(
        'tool_result links must use relationType references_tool_result',
      );
    }
    if (parseTaskToolResultReference(input.targetId) === null) {
      errors.push(
        'tool_result targetId must be a canonical Session/event tuple',
      );
    }
  }
  if (
    input.targetType === 'gate_evaluation' ||
    input.relationType === 'references_gate_evaluation'
  ) {
    if (input.targetType !== 'gate_evaluation')
      errors.push(
        'references_gate_evaluation links must target a gate_evaluation',
      );
    if (input.relationType !== 'references_gate_evaluation')
      errors.push(
        'gate_evaluation links must use relationType references_gate_evaluation',
      );
    if (parseTaskGateEvaluationReference(input.targetId) === null)
      errors.push(
        'gate_evaluation targetId must be a canonical Flow evaluation tuple',
      );
  }
  errors.push(...validateReferenceMetadata(input.metadata));
  return errors;
}

export function validateTaskReferenceInput(
  input: TaskReferenceInput,
): string[] {
  const errors: string[] = [];
  if (!isTaskReferenceKind(input.kind)) {
    errors.push(`kind must be one of: ${TASK_REFERENCE_KINDS.join(', ')}`);
  }

  if (
    input.kind === 'turn' ||
    input.kind === 'user-input' ||
    input.kind === 'tool-result'
  ) {
    if (!isCanonicalTaskReferenceId(input.sessionId))
      errors.push('sessionId is required');
    const identifier = input.kind === 'turn' ? input.turnId : input.eventId;
    if (!isCanonicalTaskReferenceId(identifier))
      errors.push(
        input.kind === 'turn' ? 'turnId is required' : 'eventId is required',
      );
    if (
      isCanonicalTaskReferenceId(input.sessionId) &&
      isCanonicalTaskReferenceId(identifier) &&
      (input.kind === 'turn'
        ? encodeTaskTurnReference(input.sessionId, identifier)
        : input.kind === 'user-input'
          ? encodeTaskUserInputReference(input.sessionId, identifier)
          : encodeTaskToolResultReference(input.sessionId, identifier)
      ).length > MAX_TASK_REFERENCE_TARGET_LENGTH
    ) {
      errors.push(
        `${input.kind} reference must be at most ${MAX_TASK_REFERENCE_TARGET_LENGTH} characters`,
      );
    }
    const untyped = input as (
      | TaskTurnReferenceInput
      | TaskUserInputReferenceInput
      | TaskToolResultReferenceInput
    ) & {
      metadata?: unknown;
      targetId?: unknown;
    };
    if (untyped.metadata !== undefined) {
      errors.push(`${input.kind} references do not accept metadata`);
    }
    if (untyped.targetId !== undefined) {
      errors.push(`${input.kind} references do not accept targetId`);
    }
  } else if (input.kind === 'gate-evaluation') {
    const ref = input.ref;
    if (!ref || !Object.values(ref).every(isCanonicalTaskReferenceId)) {
      errors.push('gate-evaluation ref must contain bounded owner-issued ids');
    } else if (
      encodeTaskGateEvaluationReference(ref).length >
      MAX_TASK_REFERENCE_TARGET_LENGTH
    ) {
      errors.push(
        `gate-evaluation reference must be at most ${MAX_TASK_REFERENCE_TARGET_LENGTH} characters`,
      );
    }
  } else {
    if (!isNonBlankString(input.targetId)) errors.push('targetId is required');
    if (
      typeof input.targetId === 'string' &&
      input.targetId.trim().length > MAX_TASK_REFERENCE_TARGET_LENGTH
    ) {
      errors.push(
        `targetId must be at most ${MAX_TASK_REFERENCE_TARGET_LENGTH} characters`,
      );
    }
    errors.push(...validateReferenceMetadata(input.metadata));
  }
  if (
    input.sourceSurface !== undefined &&
    !isNonBlankString(input.sourceSurface)
  ) {
    errors.push('sourceSurface must not be blank');
  }
  return errors;
}

export function taskReferenceToRelationGraphLinkInput(
  taskId: string,
  input: TaskReferenceInput,
): RelationGraphLinkInput {
  if (input.kind === 'turn') {
    return {
      sourceType: 'task',
      sourceId: taskId,
      targetType: 'turn',
      targetId: encodeTaskTurnReference(input.sessionId, input.turnId),
      relationType: 'references_turn',
      confidence: 1,
      source: 'user',
    };
  }
  if (input.kind === 'user-input') {
    return {
      sourceType: 'task',
      sourceId: taskId,
      targetType: 'user_input',
      targetId: encodeTaskUserInputReference(input.sessionId, input.eventId),
      relationType: 'references_user_input',
      confidence: 1,
      source: 'user',
    };
  }
  if (input.kind === 'tool-result') {
    return {
      sourceType: 'task',
      sourceId: taskId,
      targetType: 'tool_result',
      targetId: encodeTaskToolResultReference(input.sessionId, input.eventId),
      relationType: 'references_tool_result',
      confidence: 1,
      source: 'user',
    };
  }
  if (input.kind === 'gate-evaluation') {
    return {
      sourceType: 'task',
      sourceId: taskId,
      targetType: 'gate_evaluation',
      targetId: encodeTaskGateEvaluationReference(input.ref),
      relationType: 'references_gate_evaluation',
      confidence: 1,
      source: 'user',
      metadata: { ref: structuredClone(input.ref) },
    };
  }
  const relationByKind: Record<
    OpaqueTaskReferenceKind,
    Pick<RelationGraphLinkInput, 'targetType' | 'relationType'>
  > = {
    artifact: {
      targetType: 'artifact',
      relationType: 'references_artifact',
    },
    receipt: {
      targetType: 'receipt',
      relationType: 'references_receipt',
    },
    external: {
      targetType: 'external',
      relationType: 'references_external',
    },
  };
  const relation = relationByKind[input.kind];
  return {
    sourceType: 'task',
    sourceId: taskId,
    targetType: relation.targetType,
    targetId: input.targetId.trim(),
    relationType: relation.relationType,
    confidence: 1,
    source: 'user',
    metadata: input.metadata,
  };
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return true;
  }
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function validateReferenceMetadata(
  metadata: Record<string, unknown> | undefined,
): string[] {
  if (metadata === undefined) return [];
  if (!isRecord(metadata) || !isJsonValue(metadata)) {
    return ['metadata must be a JSON object'];
  }
  const metadataBytes = new TextEncoder().encode(JSON.stringify(metadata));
  if (metadataBytes.byteLength > MAX_TASK_REFERENCE_METADATA_BYTES) {
    return [
      `metadata must be at most ${MAX_TASK_REFERENCE_METADATA_BYTES} bytes`,
    ];
  }
  return [];
}

export function createTaskSessionId(
  taskId: string,
  dispatchIndex: number,
): string {
  return `task-${taskId}-${dispatchIndex}`;
}
