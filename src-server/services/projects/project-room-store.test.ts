import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { openPrivateSqlite } from '../../utils/private-sqlite.js';
import {
  createProjectRoomRuntime,
  ProjectRoomStore,
} from './project-room-store.js';

const makeTempDir = trackTempDirs();
const scope = {
  stationId: 'station',
  localProjectId: 'incarnation',
  portableProjectId: 'portable',
  localProjectSlug: 'project',
};
const actor = { id: 'person', kind: 'person' as const, displayName: 'Person' };
const current = () => {};
describe('ProjectRoomStore durable boundaries', () => {
  let home: string;
  let a: ReturnType<typeof createProjectRoomRuntime>;
  let b: ReturnType<typeof createProjectRoomRuntime>;
  beforeEach(() => {
    home = makeTempDir('project-room-');
    a = createProjectRoomRuntime(home);
    b = createProjectRoomRuntime(home);
    a.store.ensureRoom(scope, current);
  });
  afterEach(() => {
    a.close();
    b.close();
  });
  it('deduplicates across connections and reopen, rejects changed intent, and preserves reply identity', () => {
    const input = { intentId: randomUUID(), text: 'hello' };
    const first = a.store.append(scope, actor, input, current);
    expect(
      b.store.append(
        scope,
        { ...actor, displayName: 'Renamed' },
        input,
        current,
      ),
    ).toEqual(first);
    expect(() =>
      b.store.append(scope, actor, { ...input, text: 'changed' }, current),
    ).toThrow('conflict');
    const reply = b.store.append(
      scope,
      actor,
      { intentId: randomUUID(), text: 'reply', replyTo: first.messageId },
      current,
    );
    a.close();
    a = createProjectRoomRuntime(home);
    expect(a.store.history(scope).messages).toEqual([first, reply]);
    expect(reply.seq).toBe(2);
    expect(a.store.history(scope, 0, 1).nextAfter).toBe(1);
    expect(a.store.history(scope, 1).checkpoint.lastSeq).toBe(2);
  });
  it('isolates recreated Projects and does not treat slug as authority', () => {
    const old = a.store.append(
      scope,
      actor,
      { intentId: randomUUID(), text: 'old' },
      current,
    );
    const replacement = { ...scope, localProjectId: 'new-incarnation' };
    expect(b.store.ensureRoom(replacement, current).roomId).not.toBe(
      old.roomId,
    );
    expect(b.store.history(replacement).messages).toEqual([]);
    expect(() =>
      b.store.append(
        replacement,
        actor,
        { intentId: randomUUID(), text: 'cross', replyTo: old.messageId },
        current,
      ),
    ).toThrow('not_found');
    expect(
      a.store.history({ ...scope, localProjectSlug: 'renamed' }).messages[0],
    ).toEqual(old);
  });
  it('rolls back admission faults and serializes competing sequence and note CAS writes', () => {
    const input = { intentId: randomUUID(), text: 'refused' };
    expect(() =>
      a.store.append(scope, actor, input, () => {
        throw new Error('revoked');
      }),
    ).toThrow('revoked');
    expect(b.store.history(scope).checkpoint.lastSeq).toBe(0);
    const first = b.store.append(scope, actor, input, current);
    expect(first.seq).toBe(1);
    expect(
      a.store.append(
        scope,
        actor,
        { intentId: randomUUID(), text: 'next' },
        current,
      ).seq,
    ).toBe(2);
    const note = {
      expectedRevision: 0,
      markdown: 'Pinned decision',
      sourceMessageIds: [first.messageId],
    };
    expect(a.store.updateNote(scope, actor, note, current).revision).toBe(1);
    expect(() => b.store.updateNote(scope, actor, note, current)).toThrow(
      'conflict',
    );
    expect(() =>
      b.store.updateNote(scope, actor, { ...note, expectedRevision: 1 }, () => {
        throw new Error('revoked');
      }),
    ).toThrow('revoked');
    expect(a.store.getNote(scope)?.revision).toBe(1);
  });
  it('enforces UTF-8 input and history byte bounds without dropping messages', () => {
    expect(() =>
      a.store.append(
        scope,
        actor,
        { intentId: randomUUID(), text: '😀'.repeat(4097) },
        current,
      ),
    ).toThrow();
    expect(() =>
      a.store.updateNote(
        scope,
        actor,
        {
          expectedRevision: 0,
          markdown: '😀'.repeat(2049),
          sourceMessageIds: [],
        },
        current,
      ),
    ).toThrow();
    for (let i = 0; i < 40; i++)
      a.store.append(
        scope,
        actor,
        { intentId: randomUUID(), text: 'x'.repeat(16384) },
        current,
      );
    const page = b.store.history(scope, 0, 100);
    expect(
      Buffer.byteLength(JSON.stringify(page.messages)),
    ).toBeLessThanOrEqual(512 * 1024);
    expect(page.messages.length).toBeGreaterThan(0);
    expect(page.messages.length).toBeLessThan(40);
    expect(b.store.history(scope, page.nextAfter!).messages.at(-1)?.seq).toBe(
      40,
    );
  });
  it('refuses a competing connection during final admission and rolls back the losing admission', () => {
    const db = openPrivateSqlite(
      join(home, 'security', 'project-rooms.sqlite'),
      'Project rooms',
    );
    const competing = new ProjectRoomStore(db);
    db.exec('PRAGMA busy_timeout=0');
    const input = { intentId: randomUUID(), text: 'competing writer' };
    try {
      expect(() =>
        a.store.append(
          scope,
          actor,
          { intentId: randomUUID(), text: 'revoked writer' },
          () => {
            expect(() =>
              competing.append(scope, actor, input, current),
            ).toThrow(/locked/);
            throw new Error('revoked at admission');
          },
        ),
      ).toThrow('revoked at admission');
      expect(competing.append(scope, actor, input, current).seq).toBe(1);
      expect(
        b.store.history(scope).messages.map((message) => message.text),
      ).toEqual(['competing writer']);
    } finally {
      db.close();
    }
  });
  it('retains started effects as ambiguous across restart and never silently replays them', () => {
    const input = {
      intentId: randomUUID(),
      text: 'Please discuss',
      agentId: 'agent',
    };
    const request = a.store.reserveRequest(scope, actor, input, current);
    expect(b.store.reserveRequest(scope, actor, input, current)).toEqual(
      request,
    );
    expect(() =>
      b.store.reserveRequest(
        scope,
        actor,
        { ...input, text: 'different' },
        current,
      ),
    ).toThrow('conflict');
    a.store.markStarted(scope, request.requestId, current);
    b.store.bindSession(scope, request.requestId, 'session', current);
    a.close();
    a = createProjectRoomRuntime(home);
    expect(a.store.getRequest(scope, request.requestId).state).toBe('started');
    expect(() =>
      a.store.markStarted(scope, request.requestId, current),
    ).toThrow('conflict');
    expect(a.store.listPendingRequests(scope)).toHaveLength(1);
    a.store.markUncertain(scope, request.requestId, current);
    const reply = b.store.append(
      scope,
      { id: 'agent', displayName: 'Agent', kind: 'agent' },
      { intentId: randomUUID(), text: 'Result' },
      current,
    );
    expect(
      a.store.finishPublished(
        scope,
        request.requestId,
        reply.messageId,
        current,
      ).publishedMessageId,
    ).toBe(reply.messageId);
    expect(b.store.listPendingRequests(scope)).toEqual([]);
  });
  it('refuses corrupted persisted DTOs without leaking their contents and restores the exact original records', () => {
    const message = a.store.append(
      scope,
      actor,
      { intentId: randomUUID(), text: 'original' },
      current,
    );
    a.store.updateNote(
      scope,
      actor,
      {
        expectedRevision: 0,
        markdown: 'original note',
        sourceMessageIds: [message.messageId],
      },
      current,
    );
    const input = { intentId: randomUUID(), text: 'request', agentId: 'agent' };
    const request = a.store.reserveRequest(scope, actor, input, current);
    const db = openPrivateSqlite(
      join(home, 'security', 'project-rooms.sqlite'),
      'Project rooms',
    );
    const cases = [
      {
        table: 'project_rooms',
        patch: { roomId: randomUUID() },
        read: () => b.store.lookupRoom(scope),
      },
      {
        table: 'project_rooms',
        patch: { scope: { ...scope, localProjectId: 'foreign' } },
        read: () => b.store.lookupRoom(scope),
      },
      {
        table: 'project_rooms',
        patch: { scope: { ...scope, extra: 'foreign' } },
        read: () => b.store.lookupRoom(scope),
      },
      {
        table: 'project_room_messages',
        patch: { roomId: randomUUID() },
        read: () => b.store.history(scope),
      },
      {
        table: 'project_room_messages',
        patch: { seq: 2 },
        read: () => b.store.history(scope),
      },
      {
        table: 'project_room_messages',
        patch: { messageId: randomUUID() },
        read: () => b.store.history(scope),
      },
      {
        table: 'project_room_messages',
        patch: { text: 'foreign-secret'.repeat(2000) },
        read: () => b.store.history(scope),
      },
      {
        table: 'project_room_messages',
        patch: { text: 'x'.repeat(512 * 1024 + 1) },
        read: () => b.store.history(scope),
      },
      {
        table: 'project_room_notes',
        patch: { markdown: 'foreign-secret'.repeat(1000) },
        read: () => b.store.getNote(scope),
      },
      {
        table: 'project_room_notes',
        patch: { roomId: randomUUID() },
        read: () => b.store.getNote(scope),
      },
      {
        table: 'project_room_requests',
        patch: { roomId: randomUUID() },
        read: () => b.store.getRequest(scope, request.requestId),
      },
      {
        table: 'project_room_requests',
        patch: { state: 'foreign-secret' },
        read: () => b.store.listPendingRequests(scope),
      },
      {
        table: 'project_room_requests',
        patch: { text: 'foreign-secret'.repeat(2000) },
        read: () => b.store.reserveRequest(scope, actor, input, current),
      },
    ];
    try {
      for (const test of cases) {
        const original = String(
          db.prepare(`SELECT record FROM ${test.table}`).get()!.record,
        );
        db.prepare(`UPDATE ${test.table} SET record=?`).run(
          JSON.stringify({ ...JSON.parse(original), ...test.patch }),
        );
        try {
          expect(test.read).toThrow(/^Project room invalid$/);
        } finally {
          db.prepare(`UPDATE ${test.table} SET record=?`).run(original);
        }
        expect(
          db.prepare(`SELECT record FROM ${test.table}`).get()!.record,
        ).toBe(original);
        expect(b.store.history(scope).messages).toEqual([message]);
        expect(b.store.getRequest(scope, request.requestId)).toEqual(request);
        expect(b.store.getNote(scope)?.markdown).toBe('original note');
      }
    } finally {
      db.close();
    }
  });
  it('reads existing rooms and history while another connection holds writer admission', () => {
    const message = a.store.append(
      scope,
      actor,
      { intentId: randomUUID(), text: 'committed' },
      current,
    );
    const db = openPrivateSqlite(
      join(home, 'security', 'project-rooms.sqlite'),
      'Project rooms',
    );
    db.exec('BEGIN IMMEDIATE');
    const wal = join(home, 'security', 'project-rooms.sqlite-wal');
    const originalWal = readFileSync(wal);
    try {
      expect(b.store.lookupRoom(scope)?.roomId).toBe(message.roomId);
      expect(b.store.history(scope).messages).toEqual([message]);
      expect(
        b.store.lookupRoom({ ...scope, localProjectId: 'missing' }),
      ).toBeNull();
      expect(readFileSync(wal)).toEqual(originalWal);
    } finally {
      db.exec('ROLLBACK');
      db.close();
    }
  });
});
