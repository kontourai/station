import type {
  ProjectRoomActor,
  ProjectRoomAgentRequest,
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
  parseProjectRoomMentions,
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
    'mentions',
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
        v.mentions !== undefined ||
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
    ...(v.mentions === undefined
      ? {}
      : { mentions: parseProjectRoomMentions(v.text, v.mentions) }),
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

/**
 * One room's Agent request as a room reader sees it (#4800): the request
 * lifecycle only. The Agent's private Session and its steps never cross this
 * seam. `failure` is set only while the request is unsettled.
 */
export type ProjectRoomAgentActivity = Pick<
  ProjectRoomAgentRequest,
  | 'requestId'
  | 'agentId'
  | 'actor'
  | 'state'
  | 'replyTo'
  | 'publishedMessageId'
  | 'createdAt'
  | 'updatedAt'
> & {
  failure?:
    | 'agent_unavailable'
    | 'launch_uncertain'
    | 'execution_failed'
    | 'publication_failed';
};
/** The newest requests a live frame carries, whatever their state. */
export const PROJECT_ROOM_LIVE_AGENT_REQUESTS = 20;
/**
 * The requests still working (reserved or started, with no recorded failure)
 * a live frame also carries, newest first, however many newer requests have
 * settled or failed. With more than this working, the oldest are left out.
 */
export const PROJECT_ROOM_LIVE_WORKING_REQUESTS = 50;
/** Rooms one live connection may carry (#4798): every channel a Project lists. */
export const PROJECT_ROOM_LIVE_MAX_ROOMS =
  PROJECT_ROOM_LIMITS.channelsPerProject;
/** Messages one `update` frame carries; more is a `resync`. */
export const PROJECT_ROOM_LIVE_UPDATE_MESSAGES = 25;
/** How long a typing signal lasts unless it is renewed (#4798). */
export const PROJECT_ROOM_TYPING_TTL_MS = 6000;
/**
 * `GET /api/projects/:slug/rooms/live?channel=<channelId>&…&client=<uuid>`:
 * one stream for the Project's rooms (the sidebar shows one Project). The
 * default room is addressed by its own channel id. Answers
 * `text/event-stream` frames of {@link ProjectRoomLiveFrame}, each named by
 * its `kind`; a frame's `key` is the channel id it is about.
 */
export const PROJECT_ROOM_LIVE_SUFFIX = '/rooms/live';
/**
 * A frame of the multiplexed room stream. `key` is the subscription as the
 * client asked for it. `append.message.seq` is the room's next sequence and
 * `update` names the activity range it covers, so a client detects any frame
 * it did not see and re-reads history instead of skipping it.
 */
export type ProjectRoomLiveFrame =
  | {
      kind: 'subscribed';
      key: string;
      roomId: string;
      lastSeq: number;
      activity: number;
    }
  | { kind: 'append'; key: string; message: ProjectRoomMessage }
  | {
      kind: 'update';
      key: string;
      /** Every message whose reactions, edit or delete moved `activity`. */
      messages: ProjectRoomMessage[];
      fromActivity: number;
      activity: number;
    }
  | { kind: 'resync'; key: string; lastSeq: number; activity: number }
  | { kind: 'typing'; key: string; actors: ProjectRoomActor[] }
  | { kind: 'presence'; key: string; participants: ProjectRoomPresence[] }
  | { kind: 'agents'; key: string; requests: ProjectRoomAgentActivity[] }
  | { kind: 'revoked'; key: string }
  /** No such room, or not readable: the same answer for both. */
  | { kind: 'unavailable'; key: string };
const liveKinds = new Set<ProjectRoomLiveFrame['kind']>([
  'subscribed',
  'append',
  'update',
  'resync',
  'typing',
  'presence',
  'agents',
  'revoked',
  'unavailable',
]);
const requestStates = new Set<ProjectRoomAgentActivity['state']>([
  'reserved',
  'started',
  'published',
  'uncertain',
  'cancelled',
]);
const failures = new Set<NonNullable<ProjectRoomAgentActivity['failure']>>([
  'agent_unavailable',
  'launch_uncertain',
  'execution_failed',
  'publication_failed',
]);
function agentActivity(value: unknown): ProjectRoomAgentActivity {
  const v = record(value, [
    'requestId',
    'agentId',
    'actor',
    'state',
    'replyTo',
    'publishedMessageId',
    'createdAt',
    'updatedAt',
    'failure',
  ]);
  if (
    !requestStates.has(v.state as ProjectRoomAgentActivity['state']) ||
    (v.failure !== undefined &&
      !failures.has(
        v.failure as NonNullable<ProjectRoomAgentActivity['failure']>,
      ))
  )
    throw new Error('Invalid Room agent activity');
  return {
    requestId: uuid(v.requestId),
    agentId: string(v.agentId),
    actor: actor(v.actor),
    state: v.state as ProjectRoomAgentActivity['state'],
    ...(v.replyTo === undefined ? {} : { replyTo: uuid(v.replyTo) }),
    ...(v.publishedMessageId === undefined
      ? {}
      : { publishedMessageId: uuid(v.publishedMessageId) }),
    createdAt: date(v.createdAt),
    updatedAt: date(v.updatedAt),
    ...(v.failure === undefined
      ? {}
      : { failure: v.failure as ProjectRoomAgentActivity['failure'] }),
  };
}
/** Parses one live frame named `event`; throws on anything else. */
export function parseProjectRoomLiveFrame(
  event: string,
  value: unknown,
): ProjectRoomLiveFrame {
  if (!liveKinds.has(event as ProjectRoomLiveFrame['kind']))
    throw new Error('Invalid Room frame');
  const kind = event as ProjectRoomLiveFrame['kind'];
  const base = (keys: string[]) => {
    const v = record(value, ['key', ...keys]);
    return { v, key: uuid(v.key) };
  };
  switch (kind) {
    case 'subscribed': {
      const { v, key } = base(['roomId', 'lastSeq', 'activity']);
      return {
        kind,
        key,
        roomId: uuid(v.roomId),
        lastSeq: integer(v.lastSeq),
        activity: integer(v.activity),
      };
    }
    case 'append': {
      const { v, key } = base(['message']);
      return { kind, key, message: parseProjectRoomMessage(v.message) };
    }
    case 'update': {
      const { v, key } = base(['messages', 'fromActivity', 'activity']);
      const fromActivity = integer(v.fromActivity);
      const activity = integer(v.activity);
      if (
        activity <= fromActivity ||
        !Array.isArray(v.messages) ||
        v.messages.length === 0 ||
        v.messages.length > PROJECT_ROOM_LIVE_UPDATE_MESSAGES
      )
        throw new Error('Invalid Room frame');
      return {
        kind,
        key,
        messages: v.messages.map(parseProjectRoomMessage),
        fromActivity,
        activity,
      };
    }
    case 'resync': {
      const { v, key } = base(['lastSeq', 'activity']);
      return {
        kind,
        key,
        lastSeq: integer(v.lastSeq),
        activity: integer(v.activity),
      };
    }
    case 'typing': {
      const { v, key } = base(['actors']);
      if (!Array.isArray(v.actors) || v.actors.length > 100)
        throw new Error('Invalid Room frame');
      return { kind, key, actors: v.actors.map(actor) };
    }
    case 'presence': {
      const { v, key } = base(['participants']);
      return {
        kind,
        key,
        participants: parseProjectRoomPresence(v.participants),
      };
    }
    case 'agents': {
      const { v, key } = base(['requests']);
      if (
        !Array.isArray(v.requests) ||
        v.requests.length >
          PROJECT_ROOM_LIVE_AGENT_REQUESTS + PROJECT_ROOM_LIVE_WORKING_REQUESTS
      )
        throw new Error('Invalid Room frame');
      return { kind, key, requests: v.requests.map(agentActivity) };
    }
    case 'revoked':
    case 'unavailable':
      return { kind, key: base([]).key };
  }
}
