import type { ProjectMembershipScope } from './project-membership.js';

/** Inert declarations; current Project membership and action authority remain server-owned. */
export const PROJECT_ROOM_LIMITS = {
  textBytes: 16 * 1024,
  noteBytes: 8 * 1024,
  pageBytes: 512 * 1024,
  defaultPageSize: 50,
  maxPageSize: 100,
  messagesPerRoom: 10_000,
  requestsPerRoom: 1_000,
  sourceMessages: 100,
} as const;
export interface ProjectRoomActor {
  id: string;
  displayName: string;
  kind: 'person' | 'agent';
}
export interface ProjectRoomIdentity {
  scope: ProjectMembershipScope;
  roomId: string;
}
export interface ProjectRoomAppendInput {
  intentId: string;
  text: string;
  replyTo?: string;
}
export interface ProjectRoomMessage extends ProjectRoomAppendInput {
  roomId: string;
  messageId: string;
  seq: number;
  actor: ProjectRoomActor;
  createdAt: string;
}
export interface ProjectRoomCheckpoint {
  roomId: string;
  lastSeq: number;
}
export interface ProjectRoomHistory extends ProjectRoomIdentity {
  messages: ProjectRoomMessage[];
  checkpoint: ProjectRoomCheckpoint;
  nextAfter: number | null;
}
export interface ProjectRoomNoteInput {
  expectedRevision: number;
  markdown: string;
  sourceMessageIds: string[];
}
export interface ProjectRoomNote {
  roomId: string;
  revision: number;
  markdown: string;
  sourceMessageIds: string[];
  actor: ProjectRoomActor;
  updatedAt: string;
}
export type ProjectRoomRequestState =
  | 'reserved'
  | 'started'
  | 'published'
  | 'uncertain'
  | 'cancelled';
export interface ProjectRoomAgentRequestInput {
  intentId: string;
  agentId: string;
  text: string;
  replyTo?: string;
}
/** Started/uncertain records are never automatically replayable or proof of a completed effect. */
export interface ProjectRoomAgentRequest extends ProjectRoomAgentRequestInput {
  roomId: string;
  requestId: string;
  executionCorrelationId: string;
  actor: ProjectRoomActor;
  state: ProjectRoomRequestState;
  sessionId?: string;
  publishedMessageId?: string;
  createdAt: string;
  updatedAt: string;
}
export interface ProjectRoomView extends ProjectRoomIdentity {
  /** Presentation only: runtime independently enforces each action. */
  capabilities: {
    view: boolean;
    discuss: boolean;
    edit: boolean;
    execute: boolean;
  };
  checkpoint: ProjectRoomCheckpoint;
  note: ProjectRoomNote | null;
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isProjectRoomUuid(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}
const bytes = (s: string) => new TextEncoder().encode(s).length;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Project room input');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || bytes(value) > max)
    throw new Error('Invalid Project room text');
  return value;
}
export function parseProjectRoomAppendInput(
  value: unknown,
): ProjectRoomAppendInput {
  const v = object(value);
  if (
    Object.keys(v).some((k) => !['intentId', 'text', 'replyTo'].includes(k)) ||
    !isProjectRoomUuid(v.intentId) ||
    (v.replyTo !== undefined && !isProjectRoomUuid(v.replyTo))
  )
    throw new Error('Invalid Project room input');
  return {
    intentId: v.intentId,
    text: text(v.text, PROJECT_ROOM_LIMITS.textBytes),
    ...(v.replyTo === undefined ? {} : { replyTo: v.replyTo }),
  };
}
export function parseProjectRoomNoteInput(
  value: unknown,
): ProjectRoomNoteInput {
  const v = object(value);
  if (
    Object.keys(v).some(
      (k) => !['expectedRevision', 'markdown', 'sourceMessageIds'].includes(k),
    ) ||
    !Number.isSafeInteger(v.expectedRevision) ||
    (v.expectedRevision as number) < 0 ||
    typeof v.markdown !== 'string' ||
    bytes(v.markdown) > PROJECT_ROOM_LIMITS.noteBytes ||
    !Array.isArray(v.sourceMessageIds) ||
    v.sourceMessageIds.length > PROJECT_ROOM_LIMITS.sourceMessages ||
    !v.sourceMessageIds.every(isProjectRoomUuid) ||
    new Set(v.sourceMessageIds).size !== v.sourceMessageIds.length
  )
    throw new Error('Invalid Project room note');
  return {
    expectedRevision: v.expectedRevision as number,
    markdown: v.markdown,
    sourceMessageIds: [...v.sourceMessageIds],
  };
}
export function parseProjectRoomAgentRequestInput(
  value: unknown,
): ProjectRoomAgentRequestInput {
  const v = object(value);
  if (
    Object.keys(v).some(
      (k) => !['intentId', 'text', 'replyTo', 'agentId'].includes(k),
    )
  )
    throw new Error('Invalid Project room request');
  const { agentId, ...message } = v;
  return {
    ...parseProjectRoomAppendInput(message),
    agentId: text(agentId, 256),
  };
}
