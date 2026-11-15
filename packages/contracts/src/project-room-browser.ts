import type {
  ProjectRoomActor,
  ProjectRoomHistory,
  ProjectRoomMessage,
  ProjectRoomNote,
  ProjectRoomReaction,
  ProjectRoomView,
} from './project-room.js';
import {
  isProjectRoomUuid,
  PROJECT_ROOM_LIMITS,
  parseProjectRoomAttachments,
  parseProjectRoomReactionEmoji,
} from './project-room.js';
export interface ProjectRoomPresence {
  clientId: string;
  actor: ProjectRoomActor;
  expiresAt: string;
}
export interface ProjectRoomBrowserView extends ProjectRoomView {
  actor: ProjectRoomActor;
  presence: ProjectRoomPresence[];
}
function record(v: unknown, keys: string[]): Record<string, unknown> {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    throw new Error('Invalid Room view');
  return v as Record<string, unknown>;
}
function string(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 2048)
    throw new Error('Invalid Room string');
  return v;
}
function integer(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
    throw new Error('Invalid Room number');
  return v;
}
function uuid(v: unknown): string {
  if (!isProjectRoomUuid(v)) throw new Error('Invalid Room UUID');
  return v;
}
function date(v: unknown): string {
  const s = string(v);
  if (!Number.isFinite(Date.parse(s))) throw new Error('Invalid Room date');
  return s;
}
function actor(v: unknown): ProjectRoomActor {
  const a = record(v, ['id', 'displayName', 'kind']);
  if (a.kind !== 'person' && a.kind !== 'agent')
    throw new Error('Invalid Room actor');
  return { id: string(a.id), displayName: string(a.displayName), kind: a.kind };
}
export function parseProjectRoomPresence(
  value: unknown,
): ProjectRoomPresence[] {
  if (!Array.isArray(value) || value.length > 100)
    throw new Error('Invalid Room presence');
  return value.map((v) => {
    const p = record(v, ['clientId', 'actor', 'expiresAt']);
    return {
      clientId: uuid(p.clientId),
      actor: actor(p.actor),
      expiresAt: date(p.expiresAt),
    };
  });
}
export function parseProjectRoomBrowserView(
  value: unknown,
): ProjectRoomBrowserView {
  const v = record(value, [
    'scope',
    'roomId',
    'capabilities',
    'checkpoint',
    'note',
    'actor',
    'presence',
  ]);
  const s = record(v.scope, [
    'stationId',
    'localProjectId',
    'localProjectSlug',
    'portableProjectId',
  ]);
  const c = record(v.capabilities, ['view', 'discuss', 'edit', 'execute']);
  const b = (v: unknown): boolean => {
    if (typeof v !== 'boolean') throw new Error('Invalid Room capability');
    return v;
  };
  const checkpoint = record(v.checkpoint, ['roomId', 'lastSeq']);
  const roomId = uuid(v.roomId);
  if (checkpoint.roomId !== roomId) throw new Error('Invalid Room checkpoint');
  const note = v.note === null ? null : parseProjectRoomNote(v.note);
  if (note && note.roomId !== roomId)
    throw new Error('Invalid Room note identity');
  return {
    scope: {
      stationId: string(s.stationId),
      localProjectId: string(s.localProjectId),
      localProjectSlug: string(s.localProjectSlug),
      portableProjectId: string(s.portableProjectId),
    },
    roomId,
    capabilities: {
      view: b(c.view),
      discuss: b(c.discuss),
      edit: b(c.edit),
      execute: b(c.execute),
    },
    checkpoint: { roomId, lastSeq: integer(checkpoint.lastSeq) },
    note,
    actor: actor(v.actor),
    presence: parseProjectRoomPresence(v.presence),
  };
}

/** Bounded by distinct emoji and by stored reactions; never empty. */
function reactions(value: unknown): ProjectRoomReaction[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > PROJECT_ROOM_LIMITS.reactionEmojiPerMessage
  )
    throw new Error('Invalid Room reactions');
  let total = 0;
  const result = value.map((item) => {
    const r = record(item, ['emoji', 'actors']);
    if (!Array.isArray(r.actors) || r.actors.length === 0)
      throw new Error('Invalid Room reactions');
    total += r.actors.length;
    if (total > PROJECT_ROOM_LIMITS.reactionsPerMessage)
      throw new Error('Invalid Room reactions');
    const actors = r.actors.map(actor);
    if (
      new Set(actors.map((a) => JSON.stringify([a.kind, a.id]))).size !==
      actors.length
    )
      throw new Error('Invalid Room reactions');
    return { emoji: parseProjectRoomReactionEmoji(r.emoji), actors };
  });
  if (new Set(result.map((r) => r.emoji)).size !== result.length)
    throw new Error('Invalid Room reactions');
  return result;
}
export function parseProjectRoomMessage(value: unknown): ProjectRoomMessage {
  const v = record(value, [
    'roomId',
    'messageId',
    'seq',
    'actor',
    'createdAt',
    'intentId',
    'text',
    'replyTo',
    'attachments',
    'editedAt',
    'deletedAt',
    'reactions',
  ]);
  const attachments =
    v.attachments === undefined
      ? undefined
      : parseProjectRoomAttachments(v.attachments);
  const deleted = v.deletedAt !== undefined;
  if (
    typeof v.text !== 'string' ||
    new TextEncoder().encode(v.text).length > PROJECT_ROOM_LIMITS.textBytes ||
    v.seq === 0 ||
    // A tombstone keeps no content; anything else says something.
    (deleted
      ? v.text !== '' ||
        attachments ||
        v.reactions !== undefined ||
        v.editedAt !== undefined
      : !v.text.trim() && !(v.text === '' && attachments))
  )
    throw new Error('Invalid Room message');
  return {
    roomId: uuid(v.roomId),
    messageId: uuid(v.messageId),
    seq: integer(v.seq),
    actor: actor(v.actor),
    createdAt: date(v.createdAt),
    intentId: uuid(v.intentId),
    text: v.text,
    ...(v.replyTo === undefined ? {} : { replyTo: uuid(v.replyTo) }),
    ...(attachments ? { attachments } : {}),
    ...(v.editedAt === undefined ? {} : { editedAt: date(v.editedAt) }),
    ...(deleted ? { deletedAt: date(v.deletedAt) } : {}),
    ...(v.reactions === undefined ? {} : { reactions: reactions(v.reactions) }),
  };
}
export function parseProjectRoomHistory(value: unknown): ProjectRoomHistory {
  const v = record(value, [
    'scope',
    'roomId',
    'messages',
    'checkpoint',
    'nextAfter',
  ]);
  const s = record(v.scope, [
    'stationId',
    'localProjectId',
    'localProjectSlug',
    'portableProjectId',
  ]);
  const c = record(v.checkpoint, ['roomId', 'lastSeq']);
  const roomId = uuid(v.roomId);
  const lastSeq = integer(c.lastSeq);
  if (
    c.roomId !== roomId ||
    !Array.isArray(v.messages) ||
    v.messages.length > PROJECT_ROOM_LIMITS.maxPageSize
  )
    throw new Error('Invalid Room history');
  const messages = v.messages.map(parseProjectRoomMessage);
  for (let i = 0; i < messages.length; i++)
    if (
      messages[i].roomId !== roomId ||
      messages[i].seq > lastSeq ||
      (i > 0 && messages[i].seq <= messages[i - 1].seq)
    )
      throw new Error('Invalid Room order');
  return {
    scope: {
      stationId: string(s.stationId),
      localProjectId: string(s.localProjectId),
      localProjectSlug: string(s.localProjectSlug),
      portableProjectId: string(s.portableProjectId),
    },
    roomId,
    messages,
    checkpoint: { roomId, lastSeq },
    nextAfter: v.nextAfter === null ? null : integer(v.nextAfter),
  };
}
export function parseProjectRoomNote(value: unknown): ProjectRoomNote {
  const n = record(value, [
    'roomId',
    'revision',
    'markdown',
    'sourceMessageIds',
    'actor',
    'updatedAt',
  ]);
  if (
    typeof n.markdown !== 'string' ||
    new TextEncoder().encode(n.markdown).length >
      PROJECT_ROOM_LIMITS.noteBytes ||
    !Array.isArray(n.sourceMessageIds) ||
    n.sourceMessageIds.length > PROJECT_ROOM_LIMITS.sourceMessages ||
    new Set(n.sourceMessageIds).size !== n.sourceMessageIds.length ||
    n.revision === 0
  )
    throw new Error('Invalid Room note');
  return {
    roomId: uuid(n.roomId),
    revision: integer(n.revision),
    markdown: n.markdown,
    sourceMessageIds: n.sourceMessageIds.map(uuid),
    actor: actor(n.actor),
    updatedAt: date(n.updatedAt),
  };
}
