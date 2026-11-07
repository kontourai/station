import {
  boundaryText,
  boundedText,
  closedRecord,
  sha256,
  timestamp,
} from './contract-validation.js';
import type { ExecutionModelRequest } from './execution-target.js';
import type { TaskRoomAttachment } from './project-task-room.js';

export const TASK_ROOM_WORK_VERSION = 'station.task-room-work/v1' as const;

export const TASK_ROOM_CONTEXT_VERSION =
  'station.task-room-context/v1' as const;
export interface TaskRoomContextReference {
  version: typeof TASK_ROOM_CONTEXT_VERSION;
  digest: string;
}
export interface TaskRoomContextSnapshot extends TaskRoomContextReference {
  title: string;
  description: string;
  documentRevision: string;
  text: string;
}

export interface TaskRoomWorkInput {
  operationId: string;
  agentId: string;
  /** Receiver-owned default engine Agent; profile identity remains agentId. */
  executionAgentId?: string;
  expectedDefinitionFingerprint?: string;
  model?: ExecutionModelRequest;
  prompt: string;
  attachments?: TaskRoomAttachment[];
  context?: TaskRoomContextReference;
}

export interface TaskRoomWorkRecord {
  version: typeof TASK_ROOM_WORK_VERSION;
  taskId: string;
  projectId: string;
  taskCreatedAt: string;
  operationId: string;
  // A server-issued Task-scoped display identity, not an account or grant.
  requesterId: string;
  agentId: string;
  /** Receiver-owned default engine Agent; profile identity remains agentId. */
  executionAgentId?: string;
  expectedDefinitionFingerprint?: string;
  modelId?: string;
  /** SHA-256 of canonical JSON options; option values are never retained. */
  modelOptionsDigest?: string;
  prompt: string;
  attachments?: TaskRoomAttachment[];
  sessionId: string;
  createdAt: string;
  state: 'starting' | 'dispatched' | 'indeterminate' | 'refused';
  context?: TaskRoomContextSnapshot;
}

export type TaskRoomWorkList =
  | {
      kind: 'available';
      records: TaskRoomWorkRecord[];
      context?: TaskRoomContextSnapshot | null;
      contextVersion?: typeof TASK_ROOM_CONTEXT_VERSION;
    }
  | { kind: 'refused' };

export type TaskRoomWorkOutcome =
  | { kind: 'recorded'; record: TaskRoomWorkRecord; replayed: boolean }
  | {
      kind: 'refused';
      reason: 'access' | 'conflict' | 'capacity' | 'input' | 'context';
    };

// UNWIRED(#4659): negotiation only; no shared runtime is mounted yet.
export const TASK_ROOM_SHARED_WORK_VERSION =
  'station.task-room-shared-work/v1' as const;
export const TASK_ROOM_SHARED_CONTEXT_VERSION =
  'station.task-room-shared-context/v1' as const;
export const TASK_ROOM_SHARED_RESULT_VERSION =
  'station.task-room-shared-result/v1' as const;

export interface SharedTaskIdentity {
  projectId: string;
  taskId: string;
  taskCreatedAt: string;
}
export interface SharedThreadRef extends SharedTaskIdentity {
  conversationId: string;
  originSessionId: string;
}
export interface SharedResultRef extends SharedThreadRef {
  version: typeof TASK_ROOM_SHARED_RESULT_VERSION;
  sessionId: string;
  turnId: string;
  sequence: number;
  proposalDigest: string;
  /** SHA-256 of the published UTF-8 markdown, including any truncation notice. */
  contentDigest: string;
}
export interface SharedContextSelection {
  version: typeof TASK_ROOM_SHARED_CONTEXT_VERSION;
  brief: { documentRevision: string; digest: string };
  results: readonly SharedResultRef[];
}
export interface SharedContextSnapshot {
  version: typeof TASK_ROOM_SHARED_CONTEXT_VERSION;
  digest: string;
  brief: TaskRoomContextSnapshot;
  results: readonly { reference: SharedResultRef; markdown: string }[];
}
export interface SharedAgentRequest {
  version: typeof TASK_ROOM_SHARED_WORK_VERSION;
  expectedActorId: string;
  taskCreatedAt: string;
  operationId: string;
  agentId: string;
  modelId: string;
  context: SharedContextSelection;
  prompt: string;
  target: { kind: 'new-thread' } | { kind: 'thread'; thread: SharedThreadRef };
}
export type SharedWorkCapability =
  | {
      version: typeof TASK_ROOM_SHARED_WORK_VERSION;
      kind: 'available';
      contextVersion: typeof TASK_ROOM_SHARED_CONTEXT_VERSION;
      resultVersion: typeof TASK_ROOM_SHARED_RESULT_VERSION;
      mode: 'model-only';
      nextTurn: 'durable';
      agents: readonly {
        agentId: string;
        definitionFingerprint: string;
        modelIds: readonly string[];
      }[];
      context: TaskRoomContextSnapshot | null;
    }
  | {
      version: typeof TASK_ROOM_SHARED_WORK_VERSION;
      kind: 'unavailable';
      reason:
        | 'unsupported'
        | 'access'
        | 'host'
        | 'agent'
        | 'model'
        | 'compute'
        | 'confinement';
    };
export type SharedWorkState =
  | 'waiting'
  | 'placing'
  | 'placed'
  | 'refused'
  | 'withdrawn'
  | 'unconfirmed';
export interface SharedWorkRecord extends SharedTaskIdentity {
  version: typeof TASK_ROOM_SHARED_WORK_VERSION;
  operationId: string;
  requesterId: string;
  expectedActorId: string;
  agentId: string;
  modelId: string;
  inputDigest: string;
  context: SharedContextSnapshot;
  thread: SharedThreadRef;
  target: SharedAgentRequest['target'];
  state: SharedWorkState;
}
export type SharedWorkOutcome =
  | { kind: 'not-sent'; reason: string }
  | { kind: 'accepted'; record: SharedWorkRecord; replayed: boolean }
  | { kind: 'unconfirmed'; operationId: string; intent: SharedAgentRequest };

function sharedObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function closed(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  return closedRecord(value, keys) && Object.keys(value).length === keys.length;
}
function sharedText(value: unknown, max: number): value is string {
  return boundaryText(value, max);
}
function digest(value: unknown): value is string {
  return sha256(value);
}
const threadKeys = [
  'projectId',
  'taskId',
  'taskCreatedAt',
  'conversationId',
  'originSessionId',
] as const;
function threadFields(value: Record<string, unknown>): boolean {
  return (
    sharedText(value.projectId, 160) &&
    sharedText(value.taskId, 160) &&
    timestamp(value.taskCreatedAt) &&
    sharedText(value.conversationId, 160) &&
    sharedText(value.originSessionId, 160)
  );
}
export function isSharedThreadRef(value: unknown): value is SharedThreadRef {
  return closed(value, threadKeys) && threadFields(value);
}
export function isSharedResultRef(value: unknown): value is SharedResultRef {
  return (
    closed(value, [
      ...threadKeys,
      'version',
      'sessionId',
      'turnId',
      'sequence',
      'proposalDigest',
      'contentDigest',
    ]) &&
    threadFields(value) &&
    value.version === TASK_ROOM_SHARED_RESULT_VERSION &&
    sharedText(value.sessionId, 160) &&
    sharedText(value.turnId, 160) &&
    Number.isSafeInteger(value.sequence) &&
    typeof value.sequence === 'number' &&
    value.sequence > 0 &&
    digest(value.proposalDigest) &&
    digest(value.contentDigest)
  );
}
export function isSharedContextSelection(
  value: unknown,
): value is SharedContextSelection {
  return (
    closed(value, ['version', 'brief', 'results']) &&
    value.version === TASK_ROOM_SHARED_CONTEXT_VERSION &&
    closed(value.brief, ['documentRevision', 'digest']) &&
    sharedText(value.brief.documentRevision, 256) &&
    digest(value.brief.digest) &&
    Array.isArray(value.results) &&
    value.results.length <= 160 &&
    value.results.every(isSharedResultRef)
  );
}
export function isSharedAgentRequest(
  value: unknown,
): value is SharedAgentRequest {
  if (
    !closed(value, [
      'version',
      'expectedActorId',
      'taskCreatedAt',
      'operationId',
      'agentId',
      'modelId',
      'context',
      'prompt',
      'target',
    ]) ||
    value.version !== TASK_ROOM_SHARED_WORK_VERSION ||
    !sharedText(value.expectedActorId, 512) ||
    !timestamp(value.taskCreatedAt) ||
    !sharedText(value.operationId, 160) ||
    !sharedText(value.agentId, 160) ||
    !sharedText(value.modelId, 512) ||
    !boundedText(value.prompt, 12000) ||
    !isSharedContextSelection(value.context)
  )
    return false;
  if (!sharedObject(value.target)) return false;
  if (value.target.kind === 'new-thread') return closed(value.target, ['kind']);
  return (
    value.target.kind === 'thread' &&
    closed(value.target, ['kind', 'thread']) &&
    isSharedThreadRef(value.target.thread) &&
    value.target.thread.taskCreatedAt === value.taskCreatedAt
  );
}
