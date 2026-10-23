import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ProjectMembershipScope } from '@kontourai/station-contracts/project-membership';
import {
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
const decode = <T>(row: { [key: string]: unknown } | undefined): T | null =>
  row ? (JSON.parse(String(row.record)) as T) : null;
export class ProjectRoomStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS project_rooms (scope_key TEXT PRIMARY KEY, room_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS project_room_messages (room_id TEXT NOT NULL, seq INTEGER NOT NULL, message_id TEXT NOT NULL UNIQUE, author TEXT NOT NULL, intent_id TEXT NOT NULL, payload TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(room_id, seq), UNIQUE(room_id, author, intent_id)) STRICT;
      CREATE TABLE IF NOT EXISTS project_room_notes (room_id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS project_room_requests (room_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, author TEXT NOT NULL, intent_id TEXT NOT NULL, payload TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(room_id, author, intent_id)) STRICT;`);
  }
  private transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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
  private room(scope: ProjectMembershipScope): ProjectRoomIdentity {
    const room = decode<ProjectRoomIdentity>(
      this.db
        .prepare('SELECT record FROM project_rooms WHERE scope_key=?')
        .get(key(scope)),
    );
    if (!room) throw new ProjectRoomRefusal('not_found');
    return { roomId: room.roomId, scope: { ...scope } };
  }
  ensureRoom(
    scope: ProjectMembershipScope,
    assertCurrent: ProjectRoomAssertCurrent,
  ): ProjectRoomIdentity {
    if (
      Object.values(scope).some(
        (v) => typeof v !== 'string' || !v.trim() || Buffer.byteLength(v) > 512,
      )
    )
      throw new ProjectRoomRefusal('invalid');
    return this.transaction(() => {
      const existing = decode<ProjectRoomIdentity>(
        this.db
          .prepare('SELECT record FROM project_rooms WHERE scope_key=?')
          .get(key(scope)),
      );
      if (existing) {
        assertSynchronousCurrent(assertCurrent);
        return { roomId: existing.roomId, scope: { ...scope } };
      }
      const room = { scope: { ...scope }, roomId: randomUUID() };
      assertSynchronousCurrent(assertCurrent);
      this.db
        .prepare('INSERT INTO project_rooms VALUES (?, ?, ?)')
        .run(key(scope), room.roomId, JSON.stringify(room));
      return room;
    });
  }
  private message(roomId: string, messageId: string): ProjectRoomMessage {
    const value = decode<ProjectRoomMessage>(
      this.db
        .prepare(
          'SELECT record FROM project_room_messages WHERE room_id=? AND message_id=?',
        )
        .get(roomId, messageId),
    );
    if (!value) throw new ProjectRoomRefusal('not_found');
    return value;
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
          'SELECT payload, record FROM project_room_messages WHERE room_id=? AND author=? AND intent_id=?',
        )
        .get(roomId, author(actor), value.intentId);
      if (existing) {
        if (existing.payload !== payload)
          throw new ProjectRoomRefusal('conflict');
        assertSynchronousCurrent(assertCurrent);
        return decode<ProjectRoomMessage>(existing)!;
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
      return result;
    });
  }
  history(
    scope: ProjectMembershipScope,
    after = 0,
    limit = LIMITS.defaultPageSize as number,
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
          'SELECT record FROM project_room_messages WHERE room_id=? AND seq>? ORDER BY seq LIMIT ?',
        )
        .all(roomId, after, limit);
      const messages: ProjectRoomMessage[] = [];
      let bytes = 0;
      for (const row of rows) {
        const size = Buffer.byteLength(String(row.record));
        if (bytes + size > LIMITS.pageBytes) break;
        messages.push(decode<ProjectRoomMessage>(row)!);
        bytes += size;
      }
      const end = messages.at(-1)?.seq ?? after;
      return {
        ...identity,
        messages,
        checkpoint: { roomId, lastSeq },
        nextAfter: end < lastSeq ? end : null,
      };
    });
  }
  getNote(scope: ProjectMembershipScope): ProjectRoomNote | null {
    return decode(
      this.db
        .prepare('SELECT record FROM project_room_notes WHERE room_id=?')
        .get(this.room(scope).roomId),
    );
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
          'SELECT payload, record FROM project_room_requests WHERE room_id=? AND author=? AND intent_id=?',
        )
        .get(roomId, author(actor), value.intentId);
      if (existing) {
        if (existing.payload !== payload)
          throw new ProjectRoomRefusal('conflict');
        assertSynchronousCurrent(assertCurrent);
        return decode<ProjectRoomAgentRequest>(existing)!;
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
    const value = decode<ProjectRoomAgentRequest>(
      this.db
        .prepare(
          'SELECT record FROM project_room_requests WHERE room_id=? AND request_id=?',
        )
        .get(this.room(scope).roomId, requestId),
    );
    if (!value) throw new ProjectRoomRefusal('not_found');
    return value;
  }
  listPendingRequests(
    scope: ProjectMembershipScope,
  ): ProjectRoomAgentRequest[] {
    return this.db
      .prepare(
        'SELECT record FROM project_room_requests WHERE room_id=? ORDER BY rowid',
      )
      .all(this.room(scope).roomId)
      .map((row) => decode<ProjectRoomAgentRequest>(row)!)
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
