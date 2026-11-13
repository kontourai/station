import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  PROJECT_ROOM_LIMITS,
  type ProjectRoomActor,
} from '@kontourai/station-contracts/project-room';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { openPrivateSqlite } from '../../utils/private-sqlite.js';
import { createProjectRoomRuntime } from './project-room-store.js';

/** Reactions (#4796), edits and deletes (#4797) and message files (#4812). */
const makeTempDir = trackTempDirs();
const scope = {
  stationId: 'station',
  localProjectId: 'incarnation',
  portableProjectId: 'portable',
  localProjectSlug: 'project',
};
const ada = { id: 'ada', kind: 'person' as const, displayName: 'Ada' };
const bo = { id: 'bo', kind: 'person' as const, displayName: 'Bo' };
const scout = { id: 'scout', kind: 'agent' as const, displayName: 'Scout' };
const current = () => {};
const roomsPath = (home: string) =>
  join(home, 'security', 'project-rooms.sqlite');
const image = (name = 'shot.png') => ({
  id: randomUUID(),
  kind: 'image' as const,
  name,
  mimeType: 'image/png' as const,
  size: 1024,
});

describe('Project room message activity', () => {
  let runtime: ReturnType<typeof createProjectRoomRuntime>;
  let home: string;
  beforeEach(() => {
    home = makeTempDir('project-room-activity-');
    runtime = createProjectRoomRuntime(home);
    runtime.store.ensureRoom(scope, current);
  });
  afterEach(() => runtime.close());
  const post = (actor: ProjectRoomActor = ada, text = 'hello', extra = {}) =>
    runtime.store.append(
      scope,
      actor,
      { intentId: randomUUID(), text, ...extra },
      current,
    );
  const history = () => runtime.store.history(scope).messages;

  it('keeps one attributed reaction per person and emoji, and repeating either intent changes nothing', () => {
    const message = post();
    const react = (actor: typeof ada, emoji: string, reacted: boolean) =>
      runtime.store.react(
        scope,
        actor,
        message.messageId,
        { emoji, reacted },
        current,
      );
    react(ada, '👍', true);
    react(ada, '👍', true);
    react(bo, '👍', true);
    react(bo, '🎉', true);
    expect(history()[0]!.reactions).toEqual([
      { emoji: '👍', actors: [ada, bo] },
      { emoji: '🎉', actors: [bo] },
    ]);
    react(bo, '👍', false);
    react(bo, '👍', false);
    expect(react(bo, '🎉', false).reactions).toEqual([
      { emoji: '👍', actors: [ada] },
    ]);
    expect(() => react(ada, 'thumbs', true)).toThrow();
  });

  it('refuses a new emoji past the per-message limit, and a reaction past the stored limit', () => {
    const message = post();
    const emoji = [...'😀😃😄😁😆😅😂🤣😊😇🙂🙃😉😌😍🥰😘😗😙😚'];
    expect(emoji).toHaveLength(PROJECT_ROOM_LIMITS.reactionEmojiPerMessage);
    expect(PROJECT_ROOM_LIMITS.reactionEmojiPerMessage).toBe(20);
    for (const value of emoji)
      runtime.store.react(
        scope,
        ada,
        message.messageId,
        { emoji: value, reacted: true },
        current,
      );
    expect(() =>
      runtime.store.react(
        scope,
        ada,
        message.messageId,
        { emoji: '🔥', reacted: true },
        current,
      ),
    ).toThrow('capacity');
    // An emoji already on the message still takes another person.
    runtime.store.react(
      scope,
      bo,
      message.messageId,
      { emoji: '😀', reacted: true },
      current,
    );
    const other = post();
    expect(PROJECT_ROOM_LIMITS.reactionsPerMessage).toBe(100);
    for (let index = 0; index < 100; index += 1)
      runtime.store.react(
        scope,
        { ...ada, id: `p${index}` },
        other.messageId,
        { emoji: '👍', reacted: true },
        current,
      );
    expect(() =>
      runtime.store.react(
        scope,
        bo,
        other.messageId,
        { emoji: '👍', reacted: true },
        current,
      ),
    ).toThrow('capacity');
    expect(history()[1]!.reactions?.[0]?.actors).toHaveLength(100);
  });

  it('records an edit as a superseding revision and leaves the stored message row unchanged', () => {
    const message = post(ada, 'teh draft');
    const db = openPrivateSqlite(roomsPath(home), 'Project rooms');
    const row = () =>
      db
        .prepare(
          'SELECT record, payload FROM project_room_messages WHERE message_id=?',
        )
        .get(message.messageId);
    try {
      const before = row();
      const intent = { intentId: randomUUID(), text: 'the draft' };
      const edited = runtime.store.edit(
        scope,
        ada,
        message.messageId,
        intent,
        current,
      );
      expect(edited.text).toBe('the draft');
      expect(edited.editedAt).toEqual(expect.any(String));
      // The same intent replays; a different text under it is refused.
      expect(
        runtime.store.edit(scope, ada, message.messageId, intent, current),
      ).toEqual(edited);
      expect(() =>
        runtime.store.edit(
          scope,
          ada,
          message.messageId,
          { ...intent, text: 'other' },
          current,
        ),
      ).toThrow('conflict');
      expect(row()).toEqual(before);
      expect(
        db
          .prepare(
            'SELECT revision FROM project_room_revisions WHERE message_id=?',
          )
          .all(message.messageId),
      ).toEqual([{ revision: 1 }]);
    } finally {
      db.close();
    }
    expect(history()[0]).toEqual({
      ...message,
      text: 'the draft',
      editedAt: expect.any(String),
    });
  });

  it('refuses an edit or delete by anyone but the person who wrote the message', () => {
    const message = post(ada);
    expect(() =>
      runtime.store.edit(
        scope,
        bo,
        message.messageId,
        { intentId: randomUUID(), text: 'not mine' },
        current,
      ),
    ).toThrow('forbidden');
    expect(() =>
      runtime.store.deleteMessage(
        scope,
        bo,
        message.messageId,
        { intentId: randomUUID() },
        current,
      ),
    ).toThrow('forbidden');
    expect(history()[0]).toEqual(message);
  });

  it('never edits or deletes an Agent message, even for that Agent', () => {
    const answer = post(scout, 'Two numbers differ.');
    for (const actor of [ada, scout]) {
      expect(() =>
        runtime.store.edit(
          scope,
          actor,
          answer.messageId,
          { intentId: randomUUID(), text: 'rewritten' },
          current,
        ),
      ).toThrow('forbidden');
      expect(() =>
        runtime.store.deleteMessage(
          scope,
          actor,
          answer.messageId,
          { intentId: randomUUID() },
          current,
        ),
      ).toThrow('forbidden');
    }
    expect(history()[0]).toEqual(answer);
  });

  it('bounds the revisions of one message', () => {
    const message = post();
    expect(PROJECT_ROOM_LIMITS.revisionsPerMessage).toBe(50);
    for (let index = 0; index < 50; index += 1)
      runtime.store.edit(
        scope,
        ada,
        message.messageId,
        { intentId: randomUUID(), text: `v${index}` },
        current,
      );
    expect(() =>
      runtime.store.edit(
        scope,
        ada,
        message.messageId,
        { intentId: randomUUID(), text: 'v51' },
        current,
      ),
    ).toThrow('capacity');
    expect(history()[0]!.text).toBe('v49');
  });

  it('leaves a tombstone a reply still points at, and withholds its text, files and reactions', () => {
    const root = post(ada, 'secret plan', { attachments: [image()] });
    const reply = post(bo, 'on it', { replyTo: root.messageId });
    runtime.store.react(
      scope,
      bo,
      root.messageId,
      { emoji: '👍', reacted: true },
      current,
    );
    const intent = { intentId: randomUUID() };
    const tombstone = runtime.store.deleteMessage(
      scope,
      ada,
      root.messageId,
      intent,
      current,
    );
    expect(tombstone).toEqual({
      roomId: root.roomId,
      messageId: root.messageId,
      seq: 1,
      actor: ada,
      createdAt: root.createdAt,
      intentId: root.intentId,
      text: '',
      deletedAt: expect.any(String),
    });
    // Deleting again, by the same or a new intent, is the same tombstone.
    expect(
      runtime.store.deleteMessage(scope, ada, root.messageId, intent, current),
    ).toEqual(tombstone);
    expect(
      runtime.store.deleteMessage(
        scope,
        ada,
        root.messageId,
        { intentId: randomUUID() },
        current,
      ),
    ).toEqual(tombstone);
    expect(history()).toEqual([tombstone, reply]);
    expect(JSON.stringify(history())).not.toContain('secret plan');
    expect(() =>
      runtime.store.edit(
        scope,
        ada,
        root.messageId,
        { intentId: randomUUID(), text: 'back' },
        current,
      ),
    ).toThrow('conflict');
    expect(() =>
      runtime.store.react(
        scope,
        bo,
        root.messageId,
        { emoji: '🎉', reacted: true },
        current,
      ),
    ).toThrow('conflict');
    expect(
      runtime.store.attachmentRoom(scope, root.attachments![0]!.id),
    ).toBeNull();
  });

  it('keeps the read-state version: reactions, edits and deletes wake the stream without moving lastSeq', () => {
    const message = post();
    const { roomId } = message;
    const start = runtime.store.checkpoint(roomId);
    expect(start).toMatchObject({ lastSeq: 1, activity: 0 });
    runtime.store.react(
      scope,
      bo,
      message.messageId,
      { emoji: '👀', reacted: true },
      current,
    );
    runtime.store.edit(
      scope,
      ada,
      message.messageId,
      { intentId: randomUUID(), text: 'edited' },
      current,
    );
    runtime.store.deleteMessage(
      scope,
      ada,
      message.messageId,
      { intentId: randomUUID() },
      current,
    );
    expect(runtime.store.checkpoint(roomId)).toMatchObject({
      lastSeq: 1,
      activity: 3,
    });
    expect(runtime.store.history(scope).checkpoint).toEqual({
      roomId,
      lastSeq: 1,
    });
  });

  it('links each file to one message, and refuses an empty message without files', () => {
    const file = image();
    const message = post(ada, '', { attachments: [file] });
    expect(message.attachments).toEqual([file]);
    expect(runtime.store.attachmentRoom(scope, file.id)).toEqual({
      roomId: message.roomId,
      author: ada,
    });
    expect(runtime.store.attachmentRoom(scope, randomUUID())).toBeNull();
    expect(() => post(bo, 'mine now', { attachments: [file] })).toThrow(
      'conflict',
    );
    // One file named twice is refused before it reaches storage.
    const twice = image();
    expect(() => post(ada, 'twice', { attachments: [twice, twice] })).toThrow(
      'Invalid Project room attachments',
    );
    expect(() => post(ada, '')).toThrow();
    // Six files is past the shared Task-room count limit.
    expect(() =>
      post(ada, 'too many', {
        attachments: Array.from({ length: 6 }, () => image()),
      }),
    ).toThrow();
    expect(history()).toEqual([message]);
  });
});

/** #4809's version-1 schema, pinned: the shape a v1 Station writes. */
const VERSION_1_SCHEMA = `CREATE TABLE project_rooms (scope_key TEXT PRIMARY KEY, room_id TEXT NOT NULL UNIQUE, record TEXT NOT NULL) STRICT;
CREATE TABLE project_room_messages (room_id TEXT NOT NULL, seq INTEGER NOT NULL, message_id TEXT NOT NULL UNIQUE, author TEXT NOT NULL, intent_id TEXT NOT NULL, payload TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(room_id, seq), UNIQUE(room_id, author, intent_id)) STRICT;
CREATE TABLE project_room_notes (room_id TEXT PRIMARY KEY, record TEXT NOT NULL) STRICT;
CREATE TABLE project_room_requests (room_id TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, author TEXT NOT NULL, intent_id TEXT NOT NULL, payload TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(room_id, author, intent_id)) STRICT;
CREATE TABLE project_room_channels (room_id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, name TEXT NOT NULL, record TEXT NOT NULL, UNIQUE(scope_key, name)) STRICT;
PRAGMA user_version=1;`;

function writeVersion1Fixture(home: string) {
  const db = openPrivateSqlite(roomsPath(home), 'Project rooms');
  try {
    db.exec(VERSION_1_SCHEMA);
    const roomId = randomUUID();
    const scopeKey = JSON.stringify([
      scope.stationId,
      scope.localProjectId,
      scope.portableProjectId,
    ]);
    db.prepare('INSERT INTO project_rooms VALUES (?, ?, ?)').run(
      scopeKey,
      roomId,
      JSON.stringify({ roomId, scope }),
    );
    db.prepare('INSERT INTO project_room_channels VALUES (?, ?, ?, ?)').run(
      roomId,
      scopeKey,
      'general',
      JSON.stringify({ channelId: roomId, scope, name: 'general' }),
    );
    const author = JSON.stringify(['person', ada.id]);
    const messages = [1, 2].map((seq) => {
      const payload = { intentId: randomUUID(), text: `v1 message ${seq}` };
      const message = {
        ...payload,
        roomId,
        messageId: randomUUID(),
        seq,
        actor: { ...ada },
        createdAt: new Date(Date.UTC(2026, 10, seq)).toISOString(),
      };
      db.prepare(
        'INSERT INTO project_room_messages VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        roomId,
        seq,
        message.messageId,
        author,
        payload.intentId,
        JSON.stringify(payload),
        JSON.stringify(message),
      );
      return message;
    });
    return { roomId, messages };
  } finally {
    db.close();
  }
}
const tables = (db: DatabaseSync) =>
  (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
      )
      .all() as { name: string }[]
  ).map((row) => row.name);
const version = (db: DatabaseSync) =>
  Number(db.prepare('PRAGMA user_version').get()?.user_version);

describe('Project room schema version 2 migration', () => {
  it('upgrades a version-1 file in place: history is untouched and messages take reactions, edits and deletes', () => {
    const home = makeTempDir('project-room-v1-');
    const fixture = writeVersion1Fixture(home);
    const runtime = createProjectRoomRuntime(home);
    try {
      const { store } = runtime;
      expect(store.history(scope).messages).toEqual(fixture.messages);
      const [first, second] = fixture.messages;
      store.react(
        scope,
        bo,
        first!.messageId,
        { emoji: '👍', reacted: true },
        current,
      );
      store.edit(
        scope,
        ada,
        second!.messageId,
        { intentId: randomUUID(), text: 'edited after upgrade' },
        current,
      );
      expect(store.history(scope).messages).toEqual([
        { ...first, reactions: [{ emoji: '👍', actors: [bo] }] },
        {
          ...second,
          text: 'edited after upgrade',
          editedAt: expect.any(String),
        },
      ]);
      expect(store.checkpoint(fixture.roomId).lastSeq).toBe(2);
    } finally {
      runtime.close();
    }
    const db = openPrivateSqlite(roomsPath(home), 'Project rooms');
    try {
      expect(version(db)).toBe(2);
      expect(tables(db)).toEqual(
        expect.arrayContaining([
          'project_room_activity',
          'project_room_attachments',
          'project_room_reactions',
          'project_room_revisions',
        ]),
      );
    } finally {
      db.close();
    }
    // Reopening a version-2 file only reads.
    const again = createProjectRoomRuntime(home);
    try {
      expect(again.store.history(scope).messages[1]?.text).toBe(
        'edited after upgrade',
      );
    } finally {
      again.close();
    }
  });
});

it('a version-1 upgrade that fails part way rolls back its tables and user_version, and the file reopens', async () => {
  const { ProjectRoomStore } = await import('./project-room-store.js');
  const home = makeTempDir('project-room-v1-partial-');
  const fixture = writeVersion1Fixture(home);
  const db = openPrivateSqlite(roomsPath(home), 'Project rooms');
  const exec = db.exec.bind(db);
  const originalTables = tables(db);
  const originalExec = db.exec;
  db.exec = ((sql: string) => {
    if (sql.startsWith('CREATE TABLE IF NOT EXISTS project_room_revisions')) {
      exec(sql.slice(0, sql.indexOf(';') + 1));
      throw new Error('simulated mid-DDL failure');
    }
    return exec(sql);
  }) as typeof db.exec;
  expect(() => new ProjectRoomStore(db)).toThrow('simulated mid-DDL failure');
  db.exec = originalExec;
  expect(version(db)).toBe(1);
  expect(tables(db)).toEqual(originalTables);
  db.close();
  const runtime = createProjectRoomRuntime(home);
  try {
    expect(runtime.store.history(scope).messages).toEqual(fixture.messages);
  } finally {
    runtime.close();
  }
});
