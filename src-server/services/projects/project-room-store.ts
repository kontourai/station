import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectMembershipScope } from '@kontourai/station-contracts/project-membership';
import {
  isProjectRoomUuid,
  PROJECT_ROOM_LIMITS as LIMITS,
  PROJECT_ROOM_DEFAULT_CHANNEL_NAME,
  type ProjectRoomActor,
  type ProjectRoomAgentRequest,
  type ProjectRoomAgentRequestInput,
  type ProjectRoomAppendInput,
  type ProjectRoomChannel,
  type ProjectRoomChannelCreateInput,
  type ProjectRoomChannelUpdateInput,
  type ProjectRoomDeleteInput,
  type ProjectRoomEditInput,
  type ProjectRoomHistory,
  type ProjectRoomIdentity,
  type ProjectRoomMessage,
  type ProjectRoomNote,
  type ProjectRoomNoteInput,
  type ProjectRoomReaction,
  type ProjectRoomReactionInput,
  parseProjectRoomAgentRequestInput,
  parseProjectRoomAppendInput,
  parseProjectRoomChannel,
  parseProjectRoomChannelCreateInput,
  parseProjectRoomChannelUpdateInput,
  parseProjectRoomDeleteInput,
  parseProjectRoomEditInput,
  parseProjectRoomNoteInput,
  parseProjectRoomReactionEmoji,
  parseProjectRoomReactionInput,
} from '@kontourai/station-contracts/project-room';
import {
  parseProjectRoomMessage,
  parseProjectRoomNote,
} from '@kontourai/station-contracts/project-room-browser';
import { openPrivateSqlite } from '../../utils/private-sqlite.js';

export class ProjectRoomRefusal extends Error {
  constructor(
    readonly code:
      | 'conflict'
      | 'not_found'
      | 'capacity'
      | 'invalid'
      | 'duplicate'
      | 'archived'
      /** Only a message's own person author may edit or delete it. */
      | 'forbidden'
      /** The room's file store cannot prove its references (#4852). */
      | 'files_unavailable',
  ) {
    super(`Project room ${code}`);
  }
}
/** Must synchronously reject stale membership/action authority. This store grants none. */
export type ProjectRoomAssertCurrent = () => void;
function assertSynchronousCurrent(
  assertCurrent: ProjectRoomAssertCurrent,
): void {
  const result: unknown = assertCurrent();
  if (result !== undefined) throw new ProjectRoomRefusal('invalid');
}
const key = (scope: ProjectMembershipScope) =>
  JSON.stringify([
    scope.stationId,
    scope.localProjectId,
    scope.portableProjectId,
  ]);
const author = (actor: ProjectRoomActor) =>
  JSON.stringify([actor.kind, actor.id]);
type Row = Record<string, unknown>;
function corrupt(): never {
  throw new ProjectRoomRefusal('invalid');
}
function object(value: unknown, keys: string[]): Row {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((k) => !keys.includes(k))
  )
    corrupt();
  return value as Row;
}
function assertScopeValue(
  value: unknown,
): asserts value is ProjectMembershipScope {
  const v = object(value, [
    'stationId',
    'localProjectId',
    'portableProjectId',
    'localProjectSlug',
  ]);
  for (const k of [
    'stationId',
    'localProjectId',
    'portableProjectId',
    'localProjectSlug',
  ])
    if (
      typeof v[k] !== 'string' ||
      !v[k].trim() ||
      Buffer.byteLength(v[k]) > 512
    )
      corrupt();
}
function scopeValue(value: unknown): ProjectMembershipScope {
  assertScopeValue(value);
  return value;
}
function decode<T>(row: Row, parse: (value: unknown) => T): T {
  try {
    return parse(JSON.parse(String(row.record)));
  } catch {
    return corrupt();
  }
}
function assertRequestValue(
  value: unknown,
): asserts value is ProjectRoomAgentRequest {
  const v = object(value, [
    'intentId',
    'text',
    'replyTo',
    'agentId',
    'roomId',
    'requestId',
    'executionCorrelationId',
    'actor',
    'state',
    'sessionId',
    'publishedMessageId',
    'createdAt',
    'updatedAt',
  ]);
  parseProjectRoomAgentRequestInput({
    intentId: v.intentId,
    text: v.text,
    agentId: v.agentId,
    ...(v.replyTo === undefined ? {} : { replyTo: v.replyTo }),
  });
  // The message parser owns the common persisted actor, UUID, text and date schema.
  parseProjectRoomMessage({
    roomId: v.roomId,
    messageId: v.requestId,
    seq: 1,
    actor: v.actor,
    createdAt: v.createdAt,
    intentId: v.intentId,
    text: v.text,
  });
  if (
    !isProjectRoomUuid(v.executionCorrelationId) ||
    typeof v.state !== 'string' ||
    !['reserved', 'started', 'published', 'uncertain', 'cancelled'].includes(
      v.state,
    ) ||
    typeof v.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(v.updatedAt)) ||
    (v.sessionId !== undefined &&
      (typeof v.sessionId !== 'string' ||
        !v.sessionId.trim() ||
        Buffer.byteLength(v.sessionId) > 256)) ||
    (v.publishedMessageId !== undefined &&
      !isProjectRoomUuid(v.publishedMessageId)) ||
    (v.state === 'published') !== (v.publishedMessageId !== undefined)
  )
    corrupt();
}
function requestValue(value: unknown): ProjectRoomAgentRequest {
  assertRequestValue(value);
  return value;
}
/** A `project_rooms` row, checked whole against its SQL identity columns. */
function storedRoom(row: Row): ProjectRoomIdentity {
  return decode(row, (value) => {
    const v = object(value, ['roomId', 'scope']);
    const scope = scopeValue(v.scope);
    if (
      !isProjectRoomUuid(v.roomId) ||
      v.roomId !== row.room_id ||
      key(scope) !== row.scope_key
    )
      corrupt();
    return { roomId: v.roomId, scope };
  });
}
/**
 * Schema versions: 0 is the single-room shape (`project_rooms` keyed by
 * scope). 1 adds `project_room_channels`; each Project's existing room becomes
 * its `#general` channel and keeps its room id, so its messages, note and
 * Agent requests stay where they are. 2 adds message activity (#4796, #4797,
 * #4812): reactions, superseding edit and delete records, the attachment
 * links of messages, and a per-room activity counter. No stored row changes.
 */
const SCHEMA_VERSION = 2;
/** Version 2's tables. Each is new, so the step has no data to transform. */
const MESSAGE_ACTIVITY_TABLES = `CREATE TABLE IF NOT EXISTS project_room_revisions (room_id TEXT NOT NULL, message_id TEXT NOT NULL, revision INTEGER NOT NULL, author TEXT NOT NULL, intent_id TEXT NOT NULL, payload TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(message_id, revision), UNIQUE(room_id, author, intent_id)) STRICT;
      CREATE TABLE IF NOT EXISTS project_room_reactions (room_id TEXT NOT NULL, message_id TEXT NOT NULL, emoji TEXT NOT NULL, author TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(message_id, emoji, author)) STRICT;
      CREATE TABLE IF NOT EXISTS project_room_attachments (attachment_id TEXT PRIMARY KEY, room_id TEXT NOT NULL, message_id TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS project_room_activity (room_id TEXT PRIMARY KEY, revision INTEGER NOT NULL) STRICT;`;
/** An edit or a delete of one message; the original row is never rewritten. */
interface StoredRevision {
  roomId: string;
  messageId: string;
  revision: number;
  kind: 'edit' | 'delete';
  text?: string;
  actor: ProjectRoomActor;
  intentId: string;
  createdAt: string;
}
interface StoredReaction {
  roomId: string;
  messageId: string;
  emoji: string;
  actor: ProjectRoomActor;
  createdAt: string;
}
const date = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));
/** A channel as stored: the contract shape without the derived `isDefault`. */
type StoredChannel = Omit<ProjectRoomChannel, 'isDefault'> & {
  scope: ProjectMembershipScope;
};
export class ProjectRoomStore {
  private listeners = new Map<string, Set<() => void>>();
  subscribe(roomId: string, callback: () => void) {
    let listeners = this.listeners.get(roomId);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(roomId, listeners);
    }
    listeners.add(callback);
    return () => {
      listeners.delete(callback);
      if (!listeners.size) this.listeners.delete(roomId);
    };
  }
  /**
   * What the live stream watches. `activity` counts reactions, edits and
   * deletes so they wake readers, while `lastSeq` (the room's content version
   * for read state) moves only with new messages.
   */
  checkpoint(roomId: string) {
    const row = this.db
      .prepare(`SELECT
      (SELECT COALESCE(MAX(seq),0) FROM project_room_messages WHERE room_id=?) AS seq,
      (SELECT record FROM project_room_notes WHERE room_id=?) AS note,
      (SELECT revision FROM project_room_activity WHERE room_id=?) AS activity`)
      .get(roomId, roomId, roomId)!;
    return {
      roomId,
      lastSeq: Number(row.seq),
      noteRevision: row.note
        ? parseProjectRoomNote(JSON.parse(String(row.note))).revision
        : 0,
      activity: Number(row.activity ?? 0),
    };
  }
  private pendingRoom: string | undefined;
  constructor(private readonly db: DatabaseSync) {
    this.migrate();
  }
  private schemaVersion() {
    const version = Number(
      this.db.prepare('PRAGMA user_version').get()?.user_version ?? 0,
    );
    if (
      !Number.isSafeInteger(version) ||
      version < 0 ||
      version > SCHEMA_VERSION
    )
      throw new Error('Project rooms database version is not supported');
    return version;
  }
  /**
   * Refuses a newer schema before touching it, then creates tables and
   * adopts channel-less rooms under the writer lock, re-reading the version
   * there: another Station may have upgraded the file since the first read.
   */
  private migrate() {
    // Before any DDL: a newer Station's file is refused, not modified.
    if (this.schemaVersion() === SCHEMA_VERSION && this.current()) return;
    this.transaction(() => {
      // Re-read under the lock: a newer Station may have upgraded the file
      // since the first read, and writing our version would downgrade it.
      this.schemaVersion();
      this.db.exec(`CREATE TABLE IF NOT EXISTS project_rooms (scope_key TEXT PRIMARY KEY, room_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS project_room_messages (room_id TEXT NOT NULL, seq INTEGER NOT NULL, message_id TEXT NOT NULL UNIQUE, author TEXT NOT NULL, intent_id TEXT NOT NULL, payload TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(room_id, seq), UNIQUE(room_id, author, intent_id)) STRICT;
      CREATE TABLE IF NOT EXISTS project_room_notes (room_id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS project_room_requests (room_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, author TEXT NOT NULL, intent_id TEXT NOT NULL, payload TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(room_id, author, intent_id)) STRICT;
      CREATE TABLE IF NOT EXISTS project_room_channels (room_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, name TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(scope_key, name)) STRICT;`);
      // Version 2.
      this.db.exec(MESSAGE_ACTIVITY_TABLES);
      // Every open, not only from version 0: a room an older Station created
      // after a downgrade is adopted on the next upgrade.
      for (const row of this.pending()) {
        let room: ProjectRoomIdentity;
        try {
          room = storedRoom(row);
        } catch {
          // A corrupt room stays unadopted and keeps being refused for its
          // Project; other Projects still open.
          continue;
        }
        if (
          this.db
            .prepare(
              'SELECT 1 FROM project_room_channels WHERE scope_key=? AND name=?',
            )
            .get(key(room.scope), PROJECT_ROOM_DEFAULT_CHANNEL_NAME)
        )
          continue;
        this.insertChannel({
          channelId: room.roomId,
          scope: room.scope,
          name: PROJECT_ROOM_DEFAULT_CHANNEL_NAME,
        });
      }
      this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    });
  }
  /** Rooms without a channel row. */
  private pending(): Row[] {
    return this.db
      .prepare(
        'SELECT * FROM project_rooms WHERE room_id NOT IN (SELECT room_id FROM project_room_channels)',
      )
      .all();
  }
  /** At the current version with nothing to adopt, opening only reads. */
  private current() {
    try {
      return this.pending().length === 0;
    } catch {
      return false; // A missing table is repaired under the writer lock.
    }
  }
  private insertChannel(channel: StoredChannel) {
    this.db
      .prepare('INSERT INTO project_room_channels VALUES (?, ?, ?, ?)')
      .run(
        channel.channelId,
        key(channel.scope),
        channel.name,
        JSON.stringify(channel),
      );
  }
  private transaction<T>(run: () => T, readOnly = false): T {
    this.db.exec(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
    let result: T;
    try {
      result = run();
      this.db.exec('COMMIT');
    } catch (error) {
      this.pendingRoom = undefined;
      this.db.exec('ROLLBACK');
      throw error;
    }
    const roomId = this.pendingRoom;
    this.pendingRoom = undefined;
    if (roomId)
      for (const callback of this.listeners.get(roomId) ?? []) callback();
    return result;
  }

  private assertActor(actor: ProjectRoomActor) {
    if (
      !actor ||
      !['person', 'agent'].includes(actor.kind) ||
      !actor.id?.trim() ||
      !actor.displayName?.trim() ||
      Buffer.byteLength(actor.id) > 256 ||
      Buffer.byteLength(actor.displayName) > 256
    )
      throw new ProjectRoomRefusal('invalid');
  }
  /** The default room without `channelId`; otherwise that channel's room. */
  lookupRoom(
    scope: ProjectMembershipScope,
    channelId?: string,
  ): ProjectRoomIdentity | null {
    scopeValue(scope);
    if (channelId !== undefined) {
      // A channel belongs to the Project's room: a corrupt room record
      // refuses every channel with it, and no room means no channels.
      if (!this.lookupRoom(scope)) return null;
      const channel = this.lookupChannel(scope, channelId);
      return channel
        ? { roomId: channel.channelId, scope: { ...scope } }
        : null;
    }
    const row = this.db
      .prepare('SELECT * FROM project_rooms WHERE scope_key=?')
      .get(key(scope));
    if (!row) return null;
    const room = storedRoom(row);
    if (key(room.scope) !== key(scope)) corrupt();
    return { roomId: room.roomId, scope: { ...scope } };
  }
  private room(
    scope: ProjectMembershipScope,
    channelId?: string,
  ): ProjectRoomIdentity {
    const room = this.lookupRoom(scope, channelId);
    if (!room) throw new ProjectRoomRefusal('not_found');
    return room;
  }
  /** A room that accepts new content: an archived channel serves history only. */
  private writableRoom(
    scope: ProjectMembershipScope,
    channelId?: string,
  ): ProjectRoomIdentity {
    const room = this.room(scope, channelId);
    if (this.lookupChannel(scope, room.roomId)?.archivedAt)
      throw new ProjectRoomRefusal('archived');
    return room;
  }
  /** The room id new content goes to; refuses an archived channel. */
  writableRoomId(scope: ProjectMembershipScope, channelId?: string): string {
    return this.writableRoom(scope, channelId).roomId;
  }
  private storedChannel(row: Row): StoredChannel {
    return decode(row, (value) => {
      const v = object(value, [
        'channelId',
        'scope',
        'name',
        'topic',
        'archivedAt',
      ]);
      const { scope: storedScope, ...fields } = v;
      const scope = scopeValue(storedScope);
      const { isDefault: _, ...channel } = parseProjectRoomChannel({
        ...fields,
        isDefault: false,
      });
      if (
        channel.channelId !== row.room_id ||
        channel.name !== row.name ||
        key(scope) !== row.scope_key
      )
        corrupt();
      return { ...channel, scope };
    });
  }
  private lookupChannel(
    scope: ProjectMembershipScope,
    channelId: string,
  ): StoredChannel | null {
    if (!isProjectRoomUuid(channelId)) return null;
    const row = this.db
      .prepare(
        'SELECT * FROM project_room_channels WHERE room_id=? AND scope_key=?',
      )
      .get(channelId, key(scope));
    return row ? this.storedChannel(row) : null;
  }
  private publicChannel(
    channel: StoredChannel,
    defaultRoomId: string | undefined,
  ): ProjectRoomChannel {
    const { scope: _, ...value } = channel;
    return { ...value, isDefault: value.channelId === defaultRoomId };
  }
  /** The Project's channels, default first, then by name; empty before the room opens. */
  listChannels(scope: ProjectMembershipScope): ProjectRoomChannel[] {
    scopeValue(scope);
    return this.transaction(() => {
      const defaultRoomId = this.lookupRoom(scope)?.roomId;
      if (!defaultRoomId) return [];
      const rows = this.db
        .prepare(
          'SELECT * FROM project_room_channels WHERE scope_key=? ORDER BY name LIMIT ?',
        )
        .all(key(scope), LIMITS.channelsPerProject + 1);
      if (rows.length > LIMITS.channelsPerProject) corrupt();
      const channels = rows.map((row) =>
        this.publicChannel(this.storedChannel(row), defaultRoomId),
      );
      if (!channels.some((channel) => channel.isDefault)) corrupt();
      return [
        ...channels.filter((channel) => channel.isDefault),
        ...channels.filter((channel) => !channel.isDefault),
      ];
    }, true);
  }
  private assertNameFree(
    scope: ProjectMembershipScope,
    name: string,
    except?: string,
  ) {
    const row = this.db
      .prepare(
        'SELECT room_id FROM project_room_channels WHERE scope_key=? AND name=?',
      )
      .get(key(scope), name);
    if (row && row.room_id !== except)
      throw new ProjectRoomRefusal('duplicate');
  }
  createChannel(
    scope: ProjectMembershipScope,
    input: ProjectRoomChannelCreateInput,
    assertCurrent: ProjectRoomAssertCurrent,
  ): ProjectRoomChannel {
    scopeValue(scope);
    const value = parseProjectRoomChannelCreateInput(input);
    return this.transaction(() => {
      // Channels hang off the Project's opened room.
      const defaultRoomId = this.room(scope).roomId;
      const count = Number(
        this.db
          .prepare(
            'SELECT COUNT(*) AS count FROM project_room_channels WHERE scope_key=?',
          )
          .get(key(scope))?.count,
      );
      if (count >= LIMITS.channelsPerProject)
        throw new ProjectRoomRefusal('capacity');
      this.assertNameFree(scope, value.name);
      const channel: StoredChannel = {
        channelId: randomUUID(),
        scope: { ...scope },
        ...value,
      };
      assertSynchronousCurrent(assertCurrent);
      this.insertChannel(channel);
      return this.publicChannel(channel, defaultRoomId);
    });
  }
  updateChannel(
    scope: ProjectMembershipScope,
    channelId: string,
    input: ProjectRoomChannelUpdateInput,
    assertCurrent: ProjectRoomAssertCurrent,
  ): ProjectRoomChannel {
    scopeValue(scope);
    const value = parseProjectRoomChannelUpdateInput(input);
    return this.transaction(() => {
      const defaultRoomId = this.room(scope).roomId;
      const current = this.lookupChannel(scope, channelId);
      if (!current) throw new ProjectRoomRefusal('not_found');
      if (value.archived && current.channelId === defaultRoomId)
        throw new ProjectRoomRefusal('invalid');
      if (value.name !== undefined)
        this.assertNameFree(scope, value.name, current.channelId);
      const { topic, archivedAt, ...rest } = current;
      const nextTopic = value.topic === undefined ? topic : value.topic;
      const nextArchivedAt =
        value.archived === undefined
          ? archivedAt
          : value.archived
            ? (archivedAt ?? new Date().toISOString())
            : undefined;
      const next: StoredChannel = {
        ...rest,
        ...(value.name === undefined ? {} : { name: value.name }),
        ...(nextTopic == null ? {} : { topic: nextTopic }),
        ...(nextArchivedAt === undefined ? {} : { archivedAt: nextArchivedAt }),
      };
      assertSynchronousCurrent(assertCurrent);
      this.db
        .prepare(
          'UPDATE project_room_channels SET name=?, record=? WHERE room_id=? AND scope_key=?',
        )
        .run(next.name, JSON.stringify(next), next.channelId, key(scope));
      return this.publicChannel(next, defaultRoomId);
    });
  }
  ensureRoom(
    scope: ProjectMembershipScope,
    assertCurrent: ProjectRoomAssertCurrent,
  ): ProjectRoomIdentity {
    scopeValue(scope);
    return this.transaction(() => {
      const existing = this.lookupRoom(scope);
      if (existing) {
        assertSynchronousCurrent(assertCurrent);
        return existing;
      }
      const room = { scope: { ...scope }, roomId: randomUUID() };
      assertSynchronousCurrent(assertCurrent);
      this.db
        .prepare('INSERT INTO project_rooms VALUES (?, ?, ?)')
        .run(key(scope), room.roomId, JSON.stringify(room));
      this.insertChannel({
        channelId: room.roomId,
        scope: { ...scope },
        name: PROJECT_ROOM_DEFAULT_CHANNEL_NAME,
      });
      return room;
    });
  }
  private storedMessage(row: Row): ProjectRoomMessage {
    const value = decode(row, parseProjectRoomMessage);
    this.assertActor(value.actor);
    // Edits, deletes and reactions are projected, never stored in the row.
    if (
      value.editedAt !== undefined ||
      value.deletedAt !== undefined ||
      value.reactions !== undefined
    )
      corrupt();
    const payload = parseProjectRoomAppendInput({
      intentId: value.intentId,
      text: value.text,
      ...(value.replyTo === undefined ? {} : { replyTo: value.replyTo }),
      ...(value.attachments === undefined
        ? {}
        : { attachments: value.attachments }),
    });
    if (
      value.roomId !== row.room_id ||
      value.seq !== row.seq ||
      value.seq > LIMITS.messagesPerRoom ||
      value.messageId !== row.message_id ||
      author(value.actor) !== row.author ||
      value.intentId !== row.intent_id ||
      JSON.stringify(payload) !== row.payload
    )
      corrupt();
    return value;
  }
  private storedRequest(row: Row): ProjectRoomAgentRequest {
    const value = decode(row, requestValue);
    this.assertActor(value.actor);
    const payload = parseProjectRoomAgentRequestInput({
      intentId: value.intentId,
      text: value.text,
      agentId: value.agentId,
      ...(value.replyTo === undefined ? {} : { replyTo: value.replyTo }),
    });
    if (
      value.roomId !== row.room_id ||
      value.requestId !== row.request_id ||
      author(value.actor) !== row.author ||
      value.intentId !== row.intent_id ||
      JSON.stringify(payload) !== row.payload
    )
      corrupt();
    return value;
  }
  private messageRow(roomId: string, messageId: string): Row {
    const row = this.db
      .prepare(
        'SELECT * FROM project_room_messages WHERE room_id=? AND message_id=?',
      )
      .get(roomId, messageId);
    if (!row) throw new ProjectRoomRefusal('not_found');
    return row;
  }
  private message(roomId: string, messageId: string): ProjectRoomMessage {
    return this.storedMessage(this.messageRow(roomId, messageId));
  }
  private storedRevision(row: Row): StoredRevision {
    return decode(row, (value) => {
      const v = object(value, [
        'roomId',
        'messageId',
        'revision',
        'kind',
        'text',
        'actor',
        'intentId',
        'createdAt',
      ]);
      const edit = v.kind === 'edit';
      if (
        (!edit && v.kind !== 'delete') ||
        v.roomId !== row.room_id ||
        v.messageId !== row.message_id ||
        v.revision !== row.revision ||
        !Number.isSafeInteger(v.revision) ||
        (v.revision as number) < 1 ||
        (v.revision as number) > LIMITS.revisionsPerMessage ||
        !isProjectRoomUuid(v.intentId) ||
        v.intentId !== row.intent_id ||
        !date(v.createdAt) ||
        edit !== (v.text !== undefined)
      )
        corrupt();
      this.assertActor(v.actor as ProjectRoomActor);
      if (author(v.actor as ProjectRoomActor) !== row.author) corrupt();
      const edited = edit
        ? parseProjectRoomEditInput({ intentId: v.intentId, text: v.text })
        : undefined;
      const input =
        edited ?? parseProjectRoomDeleteInput({ intentId: v.intentId });
      if (
        JSON.stringify({ kind: v.kind, messageId: v.messageId, ...input }) !==
        row.payload
      )
        corrupt();
      const actor = v.actor as ProjectRoomActor;
      return {
        roomId: String(v.roomId),
        messageId: String(v.messageId),
        revision: Number(v.revision),
        kind: edited ? 'edit' : 'delete',
        ...(edited ? { text: edited.text } : {}),
        actor: {
          id: actor.id,
          displayName: actor.displayName,
          kind: actor.kind,
        },
        intentId: input.intentId,
        createdAt: String(v.createdAt),
      };
    });
  }
  /** The message's newest edit or delete, if any. */
  private latestRevision(
    roomId: string,
    messageId: string,
  ): StoredRevision | undefined {
    const row = this.db
      .prepare(
        'SELECT * FROM project_room_revisions WHERE room_id=? AND message_id=? ORDER BY revision DESC LIMIT 1',
      )
      .get(roomId, messageId);
    return row ? this.storedRevision(row) : undefined;
  }
  /** Reaction rows in the order they were added, read one past the bound. */
  private reactionRows(roomId: string, messageId: string): Row[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM project_room_reactions WHERE room_id=? AND message_id=? ORDER BY rowid LIMIT ?',
      )
      .all(roomId, messageId, LIMITS.reactionsPerMessage + 1);
    if (rows.length > LIMITS.reactionsPerMessage) corrupt();
    return rows;
  }
  private storedReaction(row: Row): StoredReaction {
    return decode(row, (value) => {
      const v = object(value, [
        'roomId',
        'messageId',
        'emoji',
        'actor',
        'createdAt',
      ]);
      this.assertActor(v.actor as ProjectRoomActor);
      if (
        v.roomId !== row.room_id ||
        v.messageId !== row.message_id ||
        v.emoji !== row.emoji ||
        parseProjectRoomReactionEmoji(v.emoji) !== row.emoji ||
        author(v.actor as ProjectRoomActor) !== row.author ||
        !date(v.createdAt)
      )
        corrupt();
      const actor = v.actor as ProjectRoomActor;
      return {
        roomId: String(v.roomId),
        messageId: String(v.messageId),
        emoji: String(v.emoji),
        actor: {
          id: actor.id,
          displayName: actor.displayName,
          kind: actor.kind,
        },
        createdAt: String(v.createdAt),
      };
    });
  }
  private reactions(roomId: string, messageId: string): ProjectRoomReaction[] {
    const byEmoji = new Map<string, ProjectRoomActor[]>();
    for (const row of this.reactionRows(roomId, messageId)) {
      const reaction = this.storedReaction(row);
      const actors = byEmoji.get(reaction.emoji) ?? [];
      actors.push({ ...reaction.actor });
      byEmoji.set(reaction.emoji, actors);
    }
    if (byEmoji.size > LIMITS.reactionEmojiPerMessage) corrupt();
    return [...byEmoji].map(([emoji, actors]) => ({ emoji, actors }));
  }
  /**
   * A message as history serves it: the stored row with its latest edit or
   * tombstone and its reactions. A tombstone keeps who and when, and the reply
   * it was, so replies to it still read; its text and files are withheld.
   */
  private project(row: Row): ProjectRoomMessage {
    const message = this.storedMessage(row);
    const latest = this.latestRevision(message.roomId, message.messageId);
    if (latest?.kind === 'delete') {
      const { attachments: _, text: __, ...rest } = message;
      return { ...rest, text: '', deletedAt: latest.createdAt };
    }
    const reactions = this.reactions(message.roomId, message.messageId);
    return {
      ...message,
      ...(latest ? { text: latest.text!, editedAt: latest.createdAt } : {}),
      ...(reactions.length ? { reactions } : {}),
    };
  }
  /** Counts a reaction, edit or delete for the stream; `seq` stays put. */
  private touch(roomId: string) {
    this.db
      .prepare(
        'INSERT INTO project_room_activity VALUES (?, 1) ON CONFLICT(room_id) DO UPDATE SET revision=revision+1',
      )
      .run(roomId);
    this.pendingRoom = roomId;
  }
  /** People edit and delete only their own messages; nobody edits an Agent's. */
  private assertOwnMessage(actor: ProjectRoomActor, row: Row) {
    const message = this.storedMessage(row);
    if (message.actor.kind === 'agent' || actor.kind !== 'person')
      throw new ProjectRoomRefusal('forbidden');
    if (row.author !== author(actor)) throw new ProjectRoomRefusal('forbidden');
    return message;
  }

  append(
    scope: ProjectMembershipScope,
    actor: ProjectRoomActor,
    input: ProjectRoomAppendInput,
    assertCurrent: ProjectRoomAssertCurrent,
    channelId?: string,
  ): ProjectRoomMessage {
    this.assertActor(actor);
    const value = parseProjectRoomAppendInput(input);
    return this.transaction(() => {
      const { roomId } = this.writableRoom(scope, channelId);
      const payload = JSON.stringify(value);
      const existing = this.db
        .prepare(
          'SELECT * FROM project_room_messages WHERE room_id=? AND author=? AND intent_id=?',
        )
        .get(roomId, author(actor), value.intentId);
      if (existing) {
        if (existing.payload !== payload)
          throw new ProjectRoomRefusal('conflict');
        assertSynchronousCurrent(assertCurrent);
        return this.storedMessage(existing);
      }
      if (value.replyTo) this.message(roomId, value.replyTo);
      // Each uploaded file belongs to one message.
      for (const attachment of value.attachments ?? [])
        if (
          this.db
            .prepare(
              'SELECT 1 FROM project_room_attachments WHERE attachment_id=?',
            )
            .get(attachment.id)
        )
          throw new ProjectRoomRefusal('conflict');
      const last = Number(
        this.db
          .prepare(
            'SELECT COALESCE(MAX(seq),0) AS seq FROM project_room_messages WHERE room_id=?',
          )
          .get(roomId)?.seq,
      );
      if (last >= LIMITS.messagesPerRoom)
        throw new ProjectRoomRefusal('capacity');
      const result: ProjectRoomMessage = {
        ...value,
        roomId,
        messageId: randomUUID(),
        seq: last + 1,
        actor: { ...actor },
        createdAt: new Date().toISOString(),
      };
      assertSynchronousCurrent(assertCurrent);
      this.db
        .prepare(
          'INSERT INTO project_room_messages VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          roomId,
          result.seq,
          result.messageId,
          author(actor),
          value.intentId,
          payload,
          JSON.stringify(result),
        );
      for (const attachment of value.attachments ?? [])
        this.db
          .prepare('INSERT INTO project_room_attachments VALUES (?, ?, ?)')
          .run(attachment.id, roomId, result.messageId);
      this.pendingRoom = roomId;
      return result;
    });
  }
  /** Adds or removes the caller's reaction; repeating either changes nothing. */
  react(
    scope: ProjectMembershipScope,
    actor: ProjectRoomActor,
    messageId: string,
    input: ProjectRoomReactionInput,
    assertCurrent: ProjectRoomAssertCurrent,
    channelId?: string,
  ): ProjectRoomMessage {
    this.assertActor(actor);
    const value = parseProjectRoomReactionInput(input);
    return this.transaction(() => {
      const { roomId } = this.writableRoom(scope, channelId);
      const row = this.messageRow(roomId, messageId);
      this.storedMessage(row);
      if (this.latestRevision(roomId, messageId)?.kind === 'delete')
        throw new ProjectRoomRefusal('conflict');
      const rows = this.reactionRows(roomId, messageId);
      const mine = rows.some(
        (r) => r.emoji === value.emoji && r.author === author(actor),
      );
      if (mine === value.reacted) {
        assertSynchronousCurrent(assertCurrent);
        return this.project(row);
      }
      if (value.reacted) {
        // Read one past each bound above, refuse at it here.
        const emoji = new Set(rows.map((r) => r.emoji));
        if (
          rows.length >= LIMITS.reactionsPerMessage ||
          (!emoji.has(value.emoji) &&
            emoji.size >= LIMITS.reactionEmojiPerMessage)
        )
          throw new ProjectRoomRefusal('capacity');
        const reaction: StoredReaction = {
          roomId,
          messageId,
          emoji: value.emoji,
          actor: { ...actor },
          createdAt: new Date().toISOString(),
        };
        assertSynchronousCurrent(assertCurrent);
        this.db
          .prepare('INSERT INTO project_room_reactions VALUES (?, ?, ?, ?, ?)')
          .run(
            roomId,
            messageId,
            value.emoji,
            author(actor),
            JSON.stringify(reaction),
          );
      } else {
        assertSynchronousCurrent(assertCurrent);
        this.db
          .prepare(
            'DELETE FROM project_room_reactions WHERE room_id=? AND message_id=? AND emoji=? AND author=?',
          )
          .run(roomId, messageId, value.emoji, author(actor));
      }
      this.touch(roomId);
      return this.project(row);
    });
  }
  /** Records an edit or a delete as a new revision of the caller's message. */
  private revise(
    scope: ProjectMembershipScope,
    actor: ProjectRoomActor,
    messageId: string,
    input:
      | ({ kind: 'edit' } & ProjectRoomEditInput)
      | ({ kind: 'delete' } & ProjectRoomDeleteInput),
    assertCurrent: ProjectRoomAssertCurrent,
    channelId?: string,
  ): ProjectRoomMessage {
    return this.transaction(() => {
      const { roomId } = this.writableRoom(scope, channelId);
      const { kind, ...value } = input;
      const payload = JSON.stringify({ kind, messageId, ...value });
      const existing = this.db
        .prepare(
          'SELECT * FROM project_room_revisions WHERE room_id=? AND author=? AND intent_id=?',
        )
        .get(roomId, author(actor), value.intentId);
      if (existing) {
        if (existing.payload !== payload)
          throw new ProjectRoomRefusal('conflict');
        this.storedRevision(existing);
        assertSynchronousCurrent(assertCurrent);
        return this.project(this.messageRow(roomId, messageId));
      }
      const row = this.messageRow(roomId, messageId);
      const message = this.assertOwnMessage(actor, row);
      const count = this.db
        .prepare(
          'SELECT revision FROM project_room_revisions WHERE room_id=? AND message_id=? LIMIT ?',
        )
        .all(roomId, messageId, LIMITS.revisionsPerMessage + 1).length;
      if (count > LIMITS.revisionsPerMessage) corrupt();
      const latest = this.latestRevision(roomId, messageId);
      if (latest?.kind === 'delete') {
        // Deleting twice is the same delete; editing a tombstone is refused.
        if (kind === 'delete') {
          assertSynchronousCurrent(assertCurrent);
          return this.project(row);
        }
        throw new ProjectRoomRefusal('conflict');
      }
      if (count >= LIMITS.revisionsPerMessage)
        throw new ProjectRoomRefusal('capacity');
      if (kind === 'edit' && !input.text && !message.attachments?.length)
        throw new ProjectRoomRefusal('invalid');
      const revision: StoredRevision = {
        roomId,
        messageId,
        revision: (latest?.revision ?? 0) + 1,
        kind,
        ...(kind === 'edit' ? { text: input.text } : {}),
        actor: { ...actor },
        intentId: value.intentId,
        createdAt: new Date().toISOString(),
      };
      assertSynchronousCurrent(assertCurrent);
      this.db
        .prepare(
          'INSERT INTO project_room_revisions VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          roomId,
          messageId,
          revision.revision,
          author(actor),
          value.intentId,
          payload,
          JSON.stringify(revision),
        );
      if (kind === 'delete')
        this.db
          .prepare(
            'DELETE FROM project_room_reactions WHERE room_id=? AND message_id=?',
          )
          .run(roomId, messageId);
      this.touch(roomId);
      return this.project(row);
    });
  }
  edit(
    scope: ProjectMembershipScope,
    actor: ProjectRoomActor,
    messageId: string,
    input: ProjectRoomEditInput,
    assertCurrent: ProjectRoomAssertCurrent,
    channelId?: string,
  ): ProjectRoomMessage {
    this.assertActor(actor);
    const value = parseProjectRoomEditInput(input);
    return this.revise(
      scope,
      actor,
      messageId,
      { kind: 'edit', ...value },
      assertCurrent,
      channelId,
    );
  }
  deleteMessage(
    scope: ProjectMembershipScope,
    actor: ProjectRoomActor,
    messageId: string,
    input: ProjectRoomDeleteInput,
    assertCurrent: ProjectRoomAssertCurrent,
    channelId?: string,
  ): ProjectRoomMessage {
    this.assertActor(actor);
    const value = parseProjectRoomDeleteInput(input);
    return this.revise(
      scope,
      actor,
      messageId,
      { kind: 'delete', ...value },
      assertCurrent,
      channelId,
    );
  }
  /**
   * The files a stored message names, with its room and author, read from
   * its original row: a deleted message's projection withholds them, but
   * its files still have to be released (#4812).
   */
  messageFiles(
    scope: ProjectMembershipScope,
    messageId: string,
    channelId?: string,
  ): { roomId: string; author: ProjectRoomActor; ids: string[] } {
    const { roomId } = this.room(scope, channelId);
    const message = this.message(roomId, messageId);
    return {
      roomId,
      author: { ...message.actor },
      ids: (message.attachments ?? []).map((attachment) => attachment.id),
    };
  }
  /**
   * Of `ids` in `roomId`: those linked to any message, and those whose
   * message still stands (not deleted).
   */
  attachmentLinks(
    roomId: string,
    ids: readonly string[],
  ): { linked: Set<string>; standing: Set<string> } {
    const linked = new Set<string>();
    const standing = new Set<string>();
    const query = this.db.prepare(
      'SELECT message_id FROM project_room_attachments WHERE attachment_id=? AND room_id=?',
    );
    for (const id of ids) {
      const row = query.get(id, roomId);
      if (!row) continue;
      linked.add(id);
      if (
        this.latestRevision(roomId, String(row.message_id))?.kind !== 'delete'
      )
        standing.add(id);
    }
    return { linked, standing };
  }
  /**
   * The room and author of the message that carries `attachmentId`, when that
   * message is readable: a deleted message's files are withheld with its text.
   */
  attachmentRoom(
    scope: ProjectMembershipScope,
    attachmentId: string,
    channelId?: string,
  ): { roomId: string; author: ProjectRoomActor } | null {
    const { roomId } = this.room(scope, channelId);
    const row = this.db
      .prepare(
        'SELECT message_id FROM project_room_attachments WHERE attachment_id=? AND room_id=?',
      )
      .get(attachmentId, roomId);
    if (!row) return null;
    const message = this.message(roomId, String(row.message_id));
    if (!message.attachments?.some((a) => a.id === attachmentId)) corrupt();
    return this.latestRevision(roomId, message.messageId)?.kind === 'delete'
      ? null
      : { roomId, author: { ...message.actor } };
  }
  history(
    scope: ProjectMembershipScope,
    after = 0,
    limit: number = LIMITS.defaultPageSize,
    channelId?: string,
  ): ProjectRoomHistory {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > LIMITS.maxPageSize
    )
      throw new ProjectRoomRefusal('invalid');
    // One read transaction keeps the page and its checkpoint on the same snapshot.
    return this.transaction(() => {
      const identity = this.room(scope, channelId);
      const { roomId } = identity;
      const lastSeq = Number(
        this.db
          .prepare(
            'SELECT COALESCE(MAX(seq),0) AS seq FROM project_room_messages WHERE room_id=?',
          )
          .get(roomId)?.seq,
      );
      const rows = this.db
        .prepare(
          'SELECT * FROM project_room_messages WHERE room_id=? AND seq>? ORDER BY seq LIMIT ?',
        )
        .all(roomId, after, limit);
      if (
        !Number.isSafeInteger(lastSeq) ||
        lastSeq < 0 ||
        lastSeq > LIMITS.messagesPerRoom
      )
        corrupt();
      const messages: ProjectRoomMessage[] = [];
      let bytes = 0;
      for (const row of rows) {
        const message = this.project(row);
        const size = Buffer.byteLength(JSON.stringify(message));
        if (size > LIMITS.pageBytes) corrupt();
        if (bytes + size + 2 + messages.length > LIMITS.pageBytes) break;
        messages.push(message);
        bytes += size;
      }
      const end = messages.at(-1)?.seq ?? after;
      if (end < lastSeq && messages.length === 0) corrupt();
      return {
        ...identity,
        messages,
        checkpoint: { roomId, lastSeq },
        nextAfter: end < lastSeq ? end : null,
      };
    }, true);
  }
  getNote(
    scope: ProjectMembershipScope,
    channelId?: string,
  ): ProjectRoomNote | null {
    const roomId = this.room(scope, channelId).roomId;
    const row = this.db
      .prepare('SELECT * FROM project_room_notes WHERE room_id=?')
      .get(roomId);
    if (!row) return null;
    const note = decode(row, parseProjectRoomNote);
    this.assertActor(note.actor);
    if (note.roomId !== roomId) corrupt();
    for (const id of note.sourceMessageIds) this.message(roomId, id);
    return note;
  }

  updateNote(
    scope: ProjectMembershipScope,
    actor: ProjectRoomActor,
    input: ProjectRoomNoteInput,
    assertCurrent: ProjectRoomAssertCurrent,
    channelId?: string,
  ): ProjectRoomNote {
    this.assertActor(actor);
    const value = parseProjectRoomNoteInput(input);
    return this.transaction(() => {
      const { roomId } = this.writableRoom(scope, channelId);
      const current = this.getNote(scope, channelId);
      if ((current?.revision ?? 0) !== value.expectedRevision)
        throw new ProjectRoomRefusal('conflict');
      for (const id of value.sourceMessageIds) this.message(roomId, id);
      const note: ProjectRoomNote = {
        roomId,
        revision: value.expectedRevision + 1,
        markdown: value.markdown,
        sourceMessageIds: value.sourceMessageIds,
        actor: { ...actor },
        updatedAt: new Date().toISOString(),
      };
      assertSynchronousCurrent(assertCurrent);
      this.db
        .prepare(
          'INSERT INTO project_room_notes VALUES (?, ?) ON CONFLICT(room_id) DO UPDATE SET record=excluded.record',
        )
        .run(roomId, JSON.stringify(note));
      this.pendingRoom = roomId;
      return note;
    });
  }
  reserveRequest(
    scope: ProjectMembershipScope,
    actor: ProjectRoomActor,
    input: ProjectRoomAgentRequestInput,
    assertCurrent: ProjectRoomAssertCurrent,
    channelId?: string,
  ): ProjectRoomAgentRequest {
    this.assertActor(actor);
    const value = parseProjectRoomAgentRequestInput(input);
    return this.transaction(() => {
      const { roomId } = this.writableRoom(scope, channelId);
      const payload = JSON.stringify(value);
      const existing = this.db
        .prepare(
          'SELECT * FROM project_room_requests WHERE room_id=? AND author=? AND intent_id=?',
        )
        .get(roomId, author(actor), value.intentId);
      if (existing) {
        if (existing.payload !== payload)
          throw new ProjectRoomRefusal('conflict');
        assertSynchronousCurrent(assertCurrent);
        return this.storedRequest(existing);
      }
      if (value.replyTo) this.message(roomId, value.replyTo);
      if (
        Number(
          this.db
            .prepare(
              'SELECT COUNT(*) AS count FROM project_room_requests WHERE room_id=?',
            )
            .get(roomId)?.count,
        ) >= LIMITS.requestsPerRoom
      )
        throw new ProjectRoomRefusal('capacity');
      const now = new Date().toISOString();
      const request: ProjectRoomAgentRequest = {
        ...value,
        roomId,
        requestId: randomUUID(),
        executionCorrelationId: randomUUID(),
        actor: { ...actor },
        state: 'reserved',
        createdAt: now,
        updatedAt: now,
      };
      assertSynchronousCurrent(assertCurrent);
      this.db
        .prepare('INSERT INTO project_room_requests VALUES (?, ?, ?, ?, ?, ?)')
        .run(
          roomId,
          request.requestId,
          author(actor),
          value.intentId,
          payload,
          JSON.stringify(request),
        );
      return request;
    });
  }
  getRequest(
    scope: ProjectMembershipScope,
    requestId: string,
    channelId?: string,
  ): ProjectRoomAgentRequest {
    const row = this.db
      .prepare(
        'SELECT * FROM project_room_requests WHERE room_id=? AND request_id=?',
      )
      .get(this.room(scope, channelId).roomId, requestId);
    if (!row) throw new ProjectRoomRefusal('not_found');
    return this.storedRequest(row);
  }
  private transition(
    scope: ProjectMembershipScope,
    id: string,
    allowed: ProjectRoomAgentRequest['state'][],
    update: Partial<ProjectRoomAgentRequest>,
    assertCurrent: ProjectRoomAssertCurrent,
    channelId?: string,
  ): ProjectRoomAgentRequest {
    return this.transaction(() => {
      const current = this.getRequest(scope, id, channelId);
      if (
        !allowed.includes(current.state) ||
        (update.sessionId &&
          current.sessionId &&
          update.sessionId !== current.sessionId)
      )
        throw new ProjectRoomRefusal('conflict');
      if (update.publishedMessageId) {
        const message = this.message(current.roomId, update.publishedMessageId);
        if (
          message.actor.kind !== 'agent' ||
          message.actor.id !== current.agentId
        )
          throw new ProjectRoomRefusal('conflict');
      }
      const next = {
        ...current,
        ...update,
        updatedAt: new Date().toISOString(),
      };
      assertSynchronousCurrent(assertCurrent);
      this.db
        .prepare(
          'UPDATE project_room_requests SET record=? WHERE request_id=? AND room_id=?',
        )
        .run(JSON.stringify(next), id, current.roomId);
      return next;
    });
  }
  markStarted(
    scope: ProjectMembershipScope,
    id: string,
    assertCurrent: ProjectRoomAssertCurrent,
    channelId?: string,
  ) {
    return this.transition(
      scope,
      id,
      ['reserved'],
      { state: 'started' },
      assertCurrent,
      channelId,
    );
  }
  bindSession(
    scope: ProjectMembershipScope,
    id: string,
    sessionId: string,
    assertCurrent: ProjectRoomAssertCurrent,
    channelId?: string,
  ) {
    if (!sessionId.trim() || Buffer.byteLength(sessionId) > 256)
      throw new ProjectRoomRefusal('invalid');
    const current = this.getRequest(scope, id, channelId);
    if (current.sessionId && current.sessionId !== sessionId)
      throw new ProjectRoomRefusal('conflict');
    return this.transition(
      scope,
      id,
      ['started'],
      { sessionId },
      assertCurrent,
      channelId,
    );
  }
  finishPublished(
    scope: ProjectMembershipScope,
    id: string,
    messageId: string,
    assertCurrent: ProjectRoomAssertCurrent,
    channelId?: string,
  ) {
    this.message(this.room(scope, channelId).roomId, messageId);
    return this.transition(
      scope,
      id,
      ['started', 'uncertain'],
      { state: 'published', publishedMessageId: messageId },
      assertCurrent,
      channelId,
    );
  }
  markUncertain(
    scope: ProjectMembershipScope,
    id: string,
    assertCurrent: ProjectRoomAssertCurrent,
    channelId?: string,
  ) {
    return this.transition(
      scope,
      id,
      ['started'],
      { state: 'uncertain' },
      assertCurrent,
      channelId,
    );
  }
  cancelRequest(
    scope: ProjectMembershipScope,
    id: string,
    assertCurrent: ProjectRoomAssertCurrent,
    channelId?: string,
  ) {
    return this.transition(
      scope,
      id,
      ['reserved', 'started', 'uncertain'],
      { state: 'cancelled' },
      assertCurrent,
      channelId,
    );
  }
}
export function createProjectRoomRuntime(home: string) {
  const db = openPrivateSqlite(
    join(home, 'security', 'project-rooms.sqlite'),
    'Project rooms',
  );
  try {
    const store = new ProjectRoomStore(db);
    let closed = false;
    return {
      store,
      close() {
        if (!closed) {
          closed = true;
          db.close();
        }
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
