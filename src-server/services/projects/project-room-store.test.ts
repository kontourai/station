import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
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
    expect(b.store.getRequest(scope, request.requestId)).toMatchObject({
      state: 'published',
      publishedMessageId: reply.messageId,
    });
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
        read: () => b.store.getRequest(scope, request.requestId),
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

/**
 * The single-room schema and records exactly as the pre-channel writer stored
 * them (#4792): DDL copied from that writer, records serialized in its key
 * order, `PRAGMA user_version` left at 0.
 */
function writeSingleRoomFixture(
  home: string,
  options: { recordRoomId?: string } = {},
) {
  const db = openPrivateSqlite(
    join(home, 'security', 'project-rooms.sqlite'),
    'Project rooms',
  );
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS project_rooms (scope_key TEXT PRIMARY KEY, room_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS project_room_messages (room_id TEXT NOT NULL, seq INTEGER NOT NULL, message_id TEXT NOT NULL UNIQUE, author TEXT NOT NULL, intent_id TEXT NOT NULL, payload TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(room_id, seq), UNIQUE(room_id, author, intent_id)) STRICT;
      CREATE TABLE IF NOT EXISTS project_room_notes (room_id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS project_room_requests (room_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, author TEXT NOT NULL, intent_id TEXT NOT NULL, payload TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(room_id, author, intent_id)) STRICT;`);
    const roomId = randomUUID();
    const scopeKey = JSON.stringify([
      scope.stationId,
      scope.localProjectId,
      scope.portableProjectId,
    ]);
    const author = JSON.stringify([actor.kind, actor.id]);
    db.prepare('INSERT INTO project_rooms VALUES (?, ?, ?)').run(
      scopeKey,
      roomId,
      JSON.stringify({
        scope: { ...scope },
        roomId: options.recordRoomId ?? roomId,
      }),
    );
    const messages = [1, 2].map((seq) => {
      const value = { intentId: randomUUID(), text: `legacy ${seq}` };
      const message = {
        ...value,
        roomId,
        messageId: randomUUID(),
        seq,
        actor: { ...actor },
        createdAt: new Date(Date.UTC(2026, 9, seq)).toISOString(),
      };
      db.prepare(
        'INSERT INTO project_room_messages VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        roomId,
        seq,
        message.messageId,
        author,
        value.intentId,
        JSON.stringify(value),
        JSON.stringify(message),
      );
      return message;
    });
    const note = {
      roomId,
      revision: 1,
      markdown: 'Legacy decision',
      sourceMessageIds: [messages[0].messageId],
      actor: { ...actor },
      updatedAt: new Date(Date.UTC(2026, 9, 3)).toISOString(),
    };
    db.prepare('INSERT INTO project_room_notes VALUES (?, ?)').run(
      roomId,
      JSON.stringify(note),
    );
    const requestValue = {
      intentId: randomUUID(),
      text: 'Summarize',
      agentId: 'helper',
    };
    const request = {
      ...requestValue,
      roomId,
      requestId: randomUUID(),
      executionCorrelationId: randomUUID(),
      actor: { ...actor },
      state: 'reserved',
      createdAt: note.updatedAt,
      updatedAt: note.updatedAt,
    };
    db.prepare(
      'INSERT INTO project_room_requests VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      roomId,
      request.requestId,
      author,
      requestValue.intentId,
      JSON.stringify(requestValue),
      JSON.stringify(request),
    );
    return { roomId, messages, note, request };
  } finally {
    db.close();
  }
}
function userVersion(home: string) {
  const db = openPrivateSqlite(
    join(home, 'security', 'project-rooms.sqlite'),
    'Project rooms',
  );
  try {
    return Number(db.prepare('PRAGMA user_version').get()?.user_version);
  } finally {
    db.close();
  }
}
describe('ProjectRoomStore channels (#4792)', () => {
  it('migrates the single stored room to #general with its room id, history, note and Agent requests', () => {
    const home = makeTempDir('project-room-migrate-');
    const legacy = writeSingleRoomFixture(home);
    expect(userVersion(home)).toBe(0);
    let runtime = createProjectRoomRuntime(home);
    try {
      expect(userVersion(home)).toBe(2);
      expect(runtime.store.listChannels(scope)).toEqual([
        { channelId: legacy.roomId, name: 'general', isDefault: true },
      ]);
      expect(runtime.store.lookupRoom(scope)?.roomId).toBe(legacy.roomId);
      // The default room and its channel address are the same room.
      for (const channelId of [undefined, legacy.roomId]) {
        expect(runtime.store.history(scope, 0, 50, channelId).messages).toEqual(
          legacy.messages,
        );
        expect(runtime.store.getNote(scope, channelId)).toEqual(legacy.note);
        expect(
          runtime.store.getRequest(scope, legacy.request.requestId, channelId),
        ).toEqual(legacy.request);
      }
      // Posting after the upgrade continues the same sequence.
      expect(
        runtime.store.append(
          scope,
          actor,
          { intentId: randomUUID(), text: 'after upgrade' },
          current,
        ).seq,
      ).toBe(3);
    } finally {
      runtime.close();
    }
    // Reopening is idempotent.
    runtime = createProjectRoomRuntime(home);
    try {
      expect(runtime.store.listChannels(scope)).toHaveLength(1);
    } finally {
      runtime.close();
    }
  });
  it('adopts a room an older Station created after the upgrade, and refuses a newer schema', () => {
    const home = makeTempDir('project-room-downgrade-');
    createProjectRoomRuntime(home).close();
    expect(userVersion(home)).toBe(2);
    // A downgraded Station writes only `project_rooms`.
    const legacy = writeSingleRoomFixture(home);
    const runtime = createProjectRoomRuntime(home);
    try {
      expect(runtime.store.listChannels(scope)).toEqual([
        { channelId: legacy.roomId, name: 'general', isDefault: true },
      ]);
    } finally {
      runtime.close();
    }
    const db = openPrivateSqlite(
      join(home, 'security', 'project-rooms.sqlite'),
      'Project rooms',
    );
    db.exec('PRAGMA user_version=3');
    db.close();
    expect(() => createProjectRoomRuntime(home)).toThrow(
      'Project rooms database version is not supported',
    );
  });
  it('keeps messages, notes and Agent requests per channel and refuses writes to an archived channel', () => {
    const home = makeTempDir('project-room-channels-');
    const runtime = createProjectRoomRuntime(home);
    try {
      const { store } = runtime;
      const general = store.ensureRoom(scope, current).roomId;
      const design = store.createChannel(
        scope,
        { name: 'design', topic: 'Screens' },
        current,
      );
      expect(design).toMatchObject({
        name: 'design',
        topic: 'Screens',
        isDefault: false,
      });
      const posted = store.append(
        scope,
        actor,
        { intentId: randomUUID(), text: 'in design' },
        current,
        design.channelId,
      );
      expect(posted.roomId).toBe(design.channelId);
      expect(store.history(scope).messages).toEqual([]);
      expect(store.history(scope, 0, 50, design.channelId).messages).toEqual([
        posted,
      ]);
      store.updateNote(
        scope,
        actor,
        { expectedRevision: 0, markdown: 'design note', sourceMessageIds: [] },
        current,
        design.channelId,
      );
      expect(store.getNote(scope)).toBeNull();
      const request = store.reserveRequest(
        scope,
        actor,
        { intentId: randomUUID(), text: 'help', agentId: 'helper' },
        current,
        design.channelId,
      );
      expect(() => store.getRequest(scope, request.requestId)).toThrow(
        'not_found',
      );
      expect(() =>
        store.append(
          scope,
          actor,
          {
            intentId: randomUUID(),
            text: 'cross-room reply',
            replyTo: posted.messageId,
          },
          current,
        ),
      ).toThrow('not_found');
      store.updateChannel(scope, design.channelId, { archived: true }, current);
      for (const write of [
        () =>
          store.append(
            scope,
            actor,
            { intentId: randomUUID(), text: 'late' },
            current,
            design.channelId,
          ),
        () =>
          store.updateNote(
            scope,
            actor,
            { expectedRevision: 1, markdown: 'late', sourceMessageIds: [] },
            current,
            design.channelId,
          ),
        () =>
          store.reserveRequest(
            scope,
            actor,
            { intentId: randomUUID(), text: 'late', agentId: 'helper' },
            current,
            design.channelId,
          ),
      ])
        expect(write).toThrow('archived');
      expect(store.history(scope, 0, 50, design.channelId).messages).toEqual([
        posted,
      ]);
      expect(() =>
        store.updateChannel(scope, general, { archived: true }, current),
      ).toThrow('invalid');
    } finally {
      runtime.close();
    }
  });
});

describe('ProjectRoomStore migration review fixes (#4792)', () => {
  const roomsPath = (home: string) =>
    join(home, 'security', 'project-rooms.sqlite');
  const tables = (db: DatabaseSync) =>
    (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        )
        .all() as { name: string }[]
    ).map((row) => row.name);
  it('re-checks the version under the migration lock and never downgrades a newer schema', () => {
    const home = makeTempDir('project-room-race-');
    writeSingleRoomFixture(home);
    const db = openPrivateSqlite(roomsPath(home), 'Project rooms');
    const other = openPrivateSqlite(roomsPath(home), 'Project rooms');
    let interleaved = false;
    // Another Station commits a newer schema after this opener read version
    // 0 but before it holds the migration write lock.
    const racing = new Proxy(db, {
      get(target, property) {
        if (property === 'exec')
          return (sql: string) => {
            if (!interleaved && sql === 'BEGIN IMMEDIATE') {
              interleaved = true;
              other.exec('PRAGMA user_version=3');
            }
            return target.exec(sql);
          };
        const value = Reflect.get(target, property);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      expect(() => new ProjectRoomStore(racing)).toThrow(
        'Project rooms database version is not supported',
      );
      expect(interleaved).toBe(true);
      expect(
        Number(other.prepare('PRAGMA user_version').get()?.user_version),
      ).toBe(3);
      expect(tables(other)).not.toContain('project_room_channels');
    } finally {
      db.close();
      other.close();
    }
  });
  it('refuses a newer schema before creating any table', () => {
    const home = makeTempDir('project-room-newer-');
    const db = openPrivateSqlite(roomsPath(home), 'Project rooms');
    db.exec('PRAGMA user_version=3');
    db.close();
    expect(() => createProjectRoomRuntime(home)).toThrow(
      'Project rooms database version is not supported',
    );
    const check = openPrivateSqlite(roomsPath(home), 'Project rooms');
    try {
      expect(tables(check)).toEqual([]);
    } finally {
      check.close();
    }
  });
  it('does not adopt a legacy room whose record names a different room, and keeps it refused', () => {
    const home = makeTempDir('project-room-corrupt-');
    const legacy = writeSingleRoomFixture(home, {
      recordRoomId: randomUUID(),
    });
    const runtime = createProjectRoomRuntime(home);
    try {
      const { store } = runtime;
      expect(() => store.listChannels(scope)).toThrow('invalid');
      expect(() => store.lookupRoom(scope, legacy.roomId)).toThrow('invalid');
      expect(() =>
        store.append(
          scope,
          actor,
          { intentId: randomUUID(), text: 'through the channel' },
          current,
          legacy.roomId,
        ),
      ).toThrow('invalid');
    } finally {
      runtime.close();
    }
    const check = openPrivateSqlite(roomsPath(home), 'Project rooms');
    try {
      expect(
        check.prepare('SELECT COUNT(*) AS n FROM project_room_channels').get()
          ?.n,
      ).toBe(0);
    } finally {
      check.close();
    }
  });
});
