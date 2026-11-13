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
  /** Stored channels per Project, archived ones included. */
  channelsPerProject: 50,
  /** Channel names are lowercase ASCII, so characters equal bytes. */
  channelNameLength: 80,
  channelTopicBytes: 250,
} as const;
/** Name the migration gives a Project's existing room. */
export const PROJECT_ROOM_DEFAULT_CHANNEL_NAME = 'general';
/**
 * The 404 code a room route answers when the Project itself does not exist
 * on this Station. Distinct from `project_room_not_found` (the Project exists
 * but its room was never opened) and from a bare 404 (a host that predates
 * the route), so a client shows "no such Project" rather than offering to
 * open a room or retry an unavailable one.
 */
export const PROJECT_ROOM_PROJECT_NOT_FOUND_CODE =
  'project_room_project_not_found';
/**
 * A named channel in a Project. Each channel is one room: `channelId` is that
 * room's `roomId`, which keys its messages, shared note and Agent requests.
 */
export interface ProjectRoomChannel {
  channelId: string;
  name: string;
  topic?: string;
  archivedAt?: string;
  /** The channel the `/room` routes address. It cannot be archived. */
  isDefault: boolean;
}
export interface ProjectRoomChannelCreateInput {
  name: string;
  topic?: string;
}
/** At least one field. `topic: null` clears the topic. */
export interface ProjectRoomChannelUpdateInput {
  name?: string;
  topic?: string | null;
  archived?: boolean;
}
export type ProjectRoomChannelNameProblem = 'empty' | 'too_long' | 'format';
const channelName = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Why `value` is not a channel name, or null when it is one. */
export function projectRoomChannelNameProblem(
  value: unknown,
): ProjectRoomChannelNameProblem | null {
  if (typeof value !== 'string' || value.length === 0) return 'empty';
  if (value.length > PROJECT_ROOM_LIMITS.channelNameLength) return 'too_long';
  return channelName.test(value) ? null : 'format';
}
export function parseProjectRoomChannelName(value: unknown): string {
  if (projectRoomChannelNameProblem(value) !== null)
    throw new Error('Invalid Project room channel name');
  return value as string;
}
export type ProjectRoomChannelTopicProblem = 'empty' | 'too_long' | 'format';
/** Why `value` is not a channel topic, or null when it is one. */
export function projectRoomChannelTopicProblem(
  value: unknown,
): ProjectRoomChannelTopicProblem | null {
  if (typeof value !== 'string' || !value.trim()) return 'empty';
  if (bytes(value) > PROJECT_ROOM_LIMITS.channelTopicBytes) return 'too_long';
  // A topic is one line of header text.
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return 'format';
  }
  return null;
}
export function parseProjectRoomChannelTopic(value: unknown): string {
  if (projectRoomChannelTopicProblem(value) !== null)
    throw new Error('Invalid Project room channel topic');
  return value as string;
}
export function parseProjectRoomChannelCreateInput(
  value: unknown,
): ProjectRoomChannelCreateInput {
  const v = object(value);
  if (Object.keys(v).some((k) => !['name', 'topic'].includes(k)))
    throw new Error('Invalid Project room channel');
  return {
    name: parseProjectRoomChannelName(v.name),
    ...(v.topic === undefined
      ? {}
      : { topic: parseProjectRoomChannelTopic(v.topic) }),
  };
}
export function parseProjectRoomChannelUpdateInput(
  value: unknown,
): ProjectRoomChannelUpdateInput {
  const v = object(value);
  const keys = Object.keys(v);
  if (
    !keys.length ||
    keys.some((k) => !['name', 'topic', 'archived'].includes(k)) ||
    (v.archived !== undefined && typeof v.archived !== 'boolean')
  )
    throw new Error('Invalid Project room channel update');
  return {
    ...(v.name === undefined
      ? {}
      : { name: parseProjectRoomChannelName(v.name) }),
    ...(v.topic === undefined
      ? {}
      : {
          topic:
            v.topic === null ? null : parseProjectRoomChannelTopic(v.topic),
        }),
    ...(v.archived === undefined ? {} : { archived: v.archived as boolean }),
  };
}
export function parseProjectRoomChannel(value: unknown): ProjectRoomChannel {
  const v = object(value);
  if (
    Object.keys(v).some(
      (k) =>
        !['channelId', 'name', 'topic', 'archivedAt', 'isDefault'].includes(k),
    ) ||
    !isProjectRoomUuid(v.channelId) ||
    typeof v.isDefault !== 'boolean' ||
    (v.archivedAt !== undefined &&
      (typeof v.archivedAt !== 'string' ||
        !Number.isFinite(Date.parse(v.archivedAt)))) ||
    (v.isDefault && v.archivedAt !== undefined)
  )
    throw new Error('Invalid Project room channel');
  return {
    channelId: v.channelId,
    name: parseProjectRoomChannelName(v.name),
    ...(v.topic === undefined
      ? {}
      : { topic: parseProjectRoomChannelTopic(v.topic) }),
    ...(v.archivedAt === undefined
      ? {}
      : { archivedAt: v.archivedAt as string }),
    isDefault: v.isDefault,
  };
}
/** A Project's channels: the default first, then by name. Bounded by the limit. */
export function parseProjectRoomChannelList(
  value: unknown,
): ProjectRoomChannel[] {
  const v = object(value);
  if (
    Object.keys(v).some((k) => k !== 'channels') ||
    !Array.isArray(v.channels) ||
    v.channels.length > PROJECT_ROOM_LIMITS.channelsPerProject
  )
    throw new Error('Invalid Project room channel list');
  const channels = v.channels.map(parseProjectRoomChannel);
  if (
    new Set(channels.map((c) => c.channelId)).size !== channels.length ||
    new Set(channels.map((c) => c.name)).size !== channels.length ||
    channels.filter((c) => c.isDefault).length > 1
  )
    throw new Error('Invalid Project room channel list');
  return channels;
}
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
