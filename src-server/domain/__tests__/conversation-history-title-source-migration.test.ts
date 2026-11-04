import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import { runOrchestrationEventMigration } from '../migrations/003-orchestration-events.js';

/** The history table exactly as homes created before #4266 have it. */
const PRE_TITLE_SOURCE_HISTORY_TABLE = `
CREATE TABLE orchestration_conversation_history (
  thread_id TEXT PRIMARY KEY,
  owner_user_id TEXT,
  tenant_id TEXT,
  agent_slug TEXT,
  project_slug TEXT,
  title TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO orchestration_conversation_history
  (thread_id, owner_user_id, agent_slug, title, message_count, created_at, updated_at)
VALUES ('legacy-thread', 'owner', 'claude', 'Continue', 2,
  '2026-10-01T00:00:00.000Z', '2026-10-01T00:01:00.000Z');
`;

function titleSourceColumns(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (
      db
        .prepare('PRAGMA table_info(orchestration_conversation_history)')
        .all() as Array<{ name: string }>
    ).filter((column) => column.name === 'title_source');
  } finally {
    db.close();
  }
}

function legacyRow(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT thread_id, title, title_source, message_count
         FROM orchestration_conversation_history WHERE thread_id = 'legacy-thread'`,
      )
      .get();
  } finally {
    db.close();
  }
}

describe('conversation history title_source migration (#4266)', () => {
  const makeTempDir = trackTempDirs();

  test('boot adds a nullable title_source to an existing history table idempotently, keeping rows', () => {
    const root = makeTempDir('title-source-migration-');
    mkdirSync(join(root, 'data'));
    const path = join(root, 'data', 'orchestration.sqlite');
    const db = new DatabaseSync(path);
    db.exec(PRE_TITLE_SOURCE_HISTORY_TABLE);
    db.close();
    expect(titleSourceColumns(path)).toEqual([]);

    for (let boot = 0; boot < 2; boot++) {
      runOrchestrationEventMigration(root);
      expect(titleSourceColumns(path)).toEqual([
        expect.objectContaining({ type: 'TEXT', notnull: 0, dflt_value: null }),
      ]);
      expect(legacyRow(path)).toEqual({
        thread_id: 'legacy-thread',
        title: 'Continue',
        title_source: null,
        message_count: 2,
      });
    }
  });

  test('the event store opens a pre-#4266 database by adding the column itself', () => {
    const root = makeTempDir('title-source-store-');
    const path = join(root, 'orchestration.sqlite');
    const db = new DatabaseSync(path);
    db.exec(PRE_TITLE_SOURCE_HISTORY_TABLE);
    db.close();

    for (let open = 0; open < 2; open++) {
      const store = new EventStore(path);
      store.close();
      expect(titleSourceColumns(path)).toHaveLength(1);
    }
    // A legacy NULL source is replaceable: a generated title may land on it.
    const store = new EventStore(path);
    try {
      expect(
        store.recordGeneratedConversationTitle('legacy-thread', 'Dock fix'),
      ).toBe(true);
    } finally {
      store.close();
    }
    expect(legacyRow(path)).toMatchObject({
      title: 'Dock fix',
      title_source: 'generated',
    });
  });
});
