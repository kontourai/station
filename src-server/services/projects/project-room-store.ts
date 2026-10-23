import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectMembershipScope } from '@kontourai/station-contracts/project-membership';
import {
  isProjectRoomUuid,
  PROJECT_ROOM_LIMITS as LIMITS,
  type ProjectRoomActor,
  type ProjectRoomAgentRequest,
  type ProjectRoomAgentRequestInput,
  type ProjectRoomAppendInput,
  type ProjectRoomHistory,
  type ProjectRoomIdentity,
  type ProjectRoomMessage,
  type ProjectRoomNote,
  type ProjectRoomNoteInput,
  parseProjectRoomAgentRequestInput,
  parseProjectRoomAppendInput,
  parseProjectRoomNoteInput,
} from '@kontourai/station-contracts/project-room';
import {
  parseProjectRoomMessage,
  parseProjectRoomNote,
} from '@kontourai/station-contracts/project-room-browser';
import { openPrivateSqlite } from '../../utils/private-sqlite.js';

export class ProjectRoomRefusal extends Error {
  constructor(
    readonly code: 'conflict' | 'not_found' | 'capacity' | 'invalid',
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
  checkpoint(roomId: string) {
    const row = this.db
      .prepare(`SELECT
      (SELECT COALESCE(MAX(seq),0) FROM project_room_messages WHERE room_id=?) AS seq,
      (SELECT record FROM project_room_notes WHERE room_id=?) AS note`)
      .get(roomId, roomId)!;
    return {
      roomId,
      lastSeq: Number(row.seq),
      noteRevision: row.note
        ? parseProjectRoomNote(JSON.parse(String(row.note))).revision
        : 0,
    };
  }
  private pendingRoom: string | undefined;
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS project_rooms (scope_key TEXT PRIMARY KEY, room_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS project_room_messages (room_id TEXT NOT NULL, seq INTEGER NOT NULL, message_id TEXT NOT NULL UNIQUE, author TEXT NOT NULL, intent_id TEXT NOT NULL, payload TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(room_id, seq), UNIQUE(room_id, author, intent_id)) STRICT;
      CREATE TABLE IF NOT EXISTS project_room_notes (room_id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS project_room_requests (room_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, author TEXT NOT NULL, intent_id TEXT NOT NULL, payload TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(room_id, author, intent_id)) STRICT;`);
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
  lookupRoom(scope: ProjectMembershipScope): ProjectRoomIdentity | null {
    scopeValue(scope);
    const row = this.db
      .prepare('SELECT * FROM project_rooms WHERE scope_key=?')
      .get(key(scope));
    if (!row) return null;
    return decode(row, (value) => {
      const v = object(value, ['roomId', 'scope']);
      const stored = scopeValue(v.scope);
      if (
        !isProjectRoomUuid(v.roomId) ||
        v.roomId !== row.room_id ||
        key(stored) !== row.scope_key ||
        key(stored) !== key(scope)
      )
        corrupt();
      return { roomId: v.roomId, scope: { ...scope } };
    });
  }
  private room(scope: ProjectMembershipScope): ProjectRoomIdentity {
    const room = this.lookupRoom(scope);
    if (!room) throw new ProjectRoomRefusal('not_found');
    return room;
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
      return room;
    });
  }
  private storedMessage(row: Row): ProjectRoomMessage {
    const value = decode(row, parseProjectRoomMessage);
    this.assertActor(value.actor);
    const payload = parseProjectRoomAppendInput({
      intentId: value.intentId,
      text: value.text,
      ...(value.replyTo === undefined ? {} : { replyTo: value.replyTo }),
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
  private message(roomId: string, messageId: string): ProjectRoomMessage {
    const row = this.db
      .prepare(
        'SELECT * FROM project_room_messages WHERE room_id=? AND message_id=?',
      )
      .get(roomId, messageId);
    if (!row) throw new ProjectRoomRefusal('not_found');
    return this.storedMessage(row);
  }

  append(
    scope: ProjectMembershipScope,
    actor: ProjectRoomActor,
    input: ProjectRoomAppendInput,
    assertCurrent: ProjectRoomAssertCurrent,
  ): ProjectRoomMessage {
    this.assertActor(actor);
    const value = parseProjectRoomAppendInput(input);
    return this.transaction(() => {
      const { roomId } = this.room(scope);
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
      this.pendingRoom = roomId;
      return result;
    });
  }
  history(
    scope: ProjectMembershipScope,
    after = 0,
    limit: number = LIMITS.defaultPageSize,
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
      const identity = this.room(scope);
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
        const size = Buffer.byteLength(String(row.record));
        const message = this.storedMessage(row);
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
  getNote(scope: ProjectMembershipScope): ProjectRoomNote | null {
    const roomId = this.room(scope).roomId;
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
  ): ProjectRoomNote {
    this.assertActor(actor);
    const value = parseProjectRoomNoteInput(input);
    return this.transaction(() => {
      const { roomId } = this.room(scope);
      const current = this.getNote(scope);
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
  ): ProjectRoomAgentRequest {
    this.assertActor(actor);
    const value = parseProjectRoomAgentRequestInput(input);
    return this.transaction(() => {
      const { roomId } = this.room(scope);
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
  ): ProjectRoomAgentRequest {
    const row = this.db
      .prepare(
        'SELECT * FROM project_room_requests WHERE room_id=? AND request_id=?',
      )
      .get(this.room(scope).roomId, requestId);
    if (!row) throw new ProjectRoomRefusal('not_found');
    return this.storedRequest(row);
  }
  listPendingRequests(
    scope: ProjectMembershipScope,
  ): ProjectRoomAgentRequest[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM project_room_requests WHERE room_id=? ORDER BY rowid LIMIT ?',
      )
      .all(this.room(scope).roomId, LIMITS.requestsPerRoom + 1);
    if (rows.length > LIMITS.requestsPerRoom) corrupt();
    return rows
      .map((row) => this.storedRequest(row))
      .filter((v) => ['reserved', 'started', 'uncertain'].includes(v.state));
  }
  private transition(
    scope: ProjectMembershipScope,
    id: string,
    allowed: ProjectRoomAgentRequest['state'][],
    update: Partial<ProjectRoomAgentRequest>,
    assertCurrent: ProjectRoomAssertCurrent,
  ): ProjectRoomAgentRequest {
    return this.transaction(() => {
      const current = this.getRequest(scope, id);
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
  ) {
    return this.transition(
      scope,
      id,
      ['reserved'],
      { state: 'started' },
      assertCurrent,
    );
  }
  bindSession(
    scope: ProjectMembershipScope,
    id: string,
    sessionId: string,
    assertCurrent: ProjectRoomAssertCurrent,
  ) {
    if (!sessionId.trim() || Buffer.byteLength(sessionId) > 256)
      throw new ProjectRoomRefusal('invalid');
    const current = this.getRequest(scope, id);
    if (current.sessionId && current.sessionId !== sessionId)
      throw new ProjectRoomRefusal('conflict');
    return this.transition(
      scope,
      id,
      ['started'],
      { sessionId },
      assertCurrent,
    );
  }
  finishPublished(
    scope: ProjectMembershipScope,
    id: string,
    messageId: string,
    assertCurrent: ProjectRoomAssertCurrent,
  ) {
    this.message(this.room(scope).roomId, messageId);
    return this.transition(
      scope,
      id,
      ['started', 'uncertain'],
      { state: 'published', publishedMessageId: messageId },
      assertCurrent,
    );
  }
  markUncertain(
    scope: ProjectMembershipScope,
    id: string,
    assertCurrent: ProjectRoomAssertCurrent,
  ) {
    return this.transition(
      scope,
      id,
      ['started'],
      { state: 'uncertain' },
      assertCurrent,
    );
  }
  cancelRequest(
    scope: ProjectMembershipScope,
    id: string,
    assertCurrent: ProjectRoomAssertCurrent,
  ) {
    return this.transition(
      scope,
      id,
      ['reserved', 'started', 'uncertain'],
      { state: 'cancelled' },
      assertCurrent,
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
