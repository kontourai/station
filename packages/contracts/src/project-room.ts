import type { ProjectMembershipScope } from './project-membership.js';
import {
  isTaskRoomAttachments,
  type TaskRoomAttachment,
} from './project-task-room.js';

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
  /** Distinct emoji on one message. */
  reactionEmojiPerMessage: 20,
  /** Stored reactions on one message: one per person and emoji. */
  reactionsPerMessage: 100,
  /** UTF-8 bytes of one reaction emoji (a family ZWJ sequence is 25). */
  reactionEmojiBytes: 32,
  /** Superseding edits of one message; a delete is one of them. */
  revisionsPerMessage: 50,
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
 * The 409 code a message route answers when the caller may not change that
 * message: only its person author may edit or delete it, and nobody edits an
 * Agent's (#4797). Not a 403, which clients read as lost access.
 */
export const PROJECT_ROOM_FORBIDDEN_CODE = 'project_room_forbidden';
/**
 * The 503 code a Project room answers to a new attachment while its file store
 * cannot prove which stored bytes are still referenced: a file record could
 * not be read (#4852). Nothing is deleted until an operator repairs or removes
 * that record; text messages, reading and downloading existing files keep
 * working.
 */
export const PROJECT_ROOM_FILES_UNAVAILABLE_CODE =
  'project_room_files_unavailable';
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
/**
 * A file on a Project room message: the Task room's attachment shape and
 * limits (`isTaskRoomAttachments`). Bytes are stored per room; an ID grants
 * no read authority on its own.
 */
export type ProjectRoomAttachment = TaskRoomAttachment;
export interface ProjectRoomAppendInput {
  intentId: string;
  /** May be empty only when the message carries attachments. */
  text: string;
  replyTo?: string;
  attachments?: ProjectRoomAttachment[];
}
/** Who reacted with one emoji, in the order they reacted. */
export interface ProjectRoomReaction {
  emoji: string;
  actors: ProjectRoomActor[];
}
/**
 * A message as history serves it. The stored record is never rewritten:
 * `editedAt`, `deletedAt` and `reactions` are projected from separate
 * attributed records, and none of them moves the room's sequence.
 */
export interface ProjectRoomMessage extends ProjectRoomAppendInput {
  roomId: string;
  messageId: string;
  seq: number;
  actor: ProjectRoomActor;
  createdAt: string;
  /** When the latest edit was made; `text` is that edit's text. */
  editedAt?: string;
  /** A tombstone: `text` is empty, and attachments and reactions are withheld. */
  deletedAt?: string;
  /** In first-reacted order; absent when there are none. */
  reactions?: ProjectRoomReaction[];
}
/** Sets the caller's own reaction. Repeating it changes nothing. */
export interface ProjectRoomReactionInput {
  emoji: string;
  reacted: boolean;
}
/** Replaces the text of the caller's own message with a superseding edit. */
export interface ProjectRoomEditInput {
  intentId: string;
  text: string;
}
/** Replaces the caller's own message with a tombstone. */
export interface ProjectRoomDeleteInput {
  intentId: string;
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
/** `allowEmpty` admits exactly '' (a message carried by its attachments). */
function text(value: unknown, max: number, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    (!value.trim() && !(allowEmpty && value === '')) ||
    bytes(value) > max
  )
    throw new Error('Invalid Project room text');
  return value;
}
/** Bounded by the Task room's count and size limits; never empty or repeated. */
export function parseProjectRoomAttachments(
  value: unknown,
): ProjectRoomAttachment[] {
  if (
    !isTaskRoomAttachments(value) ||
    value.length === 0 ||
    new Set(value.map((attachment) => attachment.id)).size !== value.length
  )
    throw new Error('Invalid Project room attachments');
  return value.map((attachment) => ({ ...attachment }));
}
export function parseProjectRoomAppendInput(
  value: unknown,
): ProjectRoomAppendInput {
  const v = object(value);
  if (
    Object.keys(v).some(
      (k) => !['intentId', 'text', 'replyTo', 'attachments'].includes(k),
    ) ||
    !isProjectRoomUuid(v.intentId) ||
    (v.replyTo !== undefined && !isProjectRoomUuid(v.replyTo))
  )
    throw new Error('Invalid Project room input');
  const attachments =
    v.attachments === undefined
      ? undefined
      : parseProjectRoomAttachments(v.attachments);
  return {
    intentId: v.intentId,
    text: text(v.text, PROJECT_ROOM_LIMITS.textBytes, !!attachments),
    ...(v.replyTo === undefined ? {} : { replyTo: v.replyTo }),
    ...(attachments ? { attachments } : {}),
  };
}
export type ProjectRoomReactionEmojiProblem = 'empty' | 'too_long' | 'format';
/**
 * One emoji: a flag pair, a keycap, or a pictograph with optional variation
 * selector, skin tone and tag sequence, joined by ZWJ to more of the same.
 */
const singleEmoji = new RegExp(
  [
    '^(?:',
    '\\p{Regional_Indicator}{2}',
    '|[0-9#*]\\ufe0f?\\u20e3',
    '|(?:\\p{Extended_Pictographic}(?:\\ufe0f|\\p{Emoji_Modifier})?(?:[\\u{e0020}-\\u{e007e}]+\\u{e007f})?)',
    '(?:\\u200d\\p{Extended_Pictographic}(?:\\ufe0f|\\p{Emoji_Modifier})?)*',
    ')$',
  ].join(''),
  'u',
);
/** Why `value` is not one reaction emoji, or null when it is. */
export function projectRoomReactionEmojiProblem(
  value: unknown,
): ProjectRoomReactionEmojiProblem | null {
  if (typeof value !== 'string' || value.length === 0) return 'empty';
  if (bytes(value) > PROJECT_ROOM_LIMITS.reactionEmojiBytes) return 'too_long';
  return singleEmoji.test(value) ? null : 'format';
}
export function parseProjectRoomReactionEmoji(value: unknown): string {
  if (projectRoomReactionEmojiProblem(value) !== null)
    throw new Error('Invalid Project room reaction');
  return value as string;
}
export function parseProjectRoomReactionInput(
  value: unknown,
): ProjectRoomReactionInput {
  const v = object(value);
  if (
    Object.keys(v).some((k) => !['emoji', 'reacted'].includes(k)) ||
    typeof v.reacted !== 'boolean'
  )
    throw new Error('Invalid Project room reaction');
  return { emoji: parseProjectRoomReactionEmoji(v.emoji), reacted: v.reacted };
}
/** Text may be empty here; the store allows that only on a message with files. */
export function parseProjectRoomEditInput(
  value: unknown,
): ProjectRoomEditInput {
  const v = object(value);
  if (
    Object.keys(v).some((k) => !['intentId', 'text'].includes(k)) ||
    !isProjectRoomUuid(v.intentId)
  )
    throw new Error('Invalid Project room edit');
  return {
    intentId: v.intentId,
    text: text(v.text, PROJECT_ROOM_LIMITS.textBytes, true),
  };
}
export function parseProjectRoomDeleteInput(
  value: unknown,
): ProjectRoomDeleteInput {
  const v = object(value);
  if (
    Object.keys(v).some((k) => k !== 'intentId') ||
    !isProjectRoomUuid(v.intentId)
  )
    throw new Error('Invalid Project room delete');
  return { intentId: v.intentId };
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
