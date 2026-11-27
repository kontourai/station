/**
 * #3075 owner design: the content-version backfill for an existing home runs
 * in bounded batches of threads, each committed with its progress, so an
 * interrupted start resumes where it stopped instead of from zero. Completion
 * records the upgrade fence (the store's contiguous sequence prefix) in the
 * same write. Each thread's version is found by walking its own index, never
 * by rescanning the whole history per batch.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { beforeEach, expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ReadMarkerService } from '../../read-markers/read-marker-service.js';
import { FileReadMarkerStore } from '../../read-markers/read-marker-store.js';
import { upgradeReadMarkerStore } from '../../read-markers/read-marker-upgrade.js';
import { FileConversationAcknowledgementStore } from '../conversation-acknowledgement-store.js';
import {
  EventStore,
  THREAD_CONTENT_BACKFILL_BATCH,
  THREAD_CONTENT_BACKFILL_NEXT_THREAD_SQL,
  THREAD_CONTENT_BACKFILL_PROJECT_SQL,
} from '../event-store.js';

let dir: string;
// Removed after each test whether it passed or not (#2421).
const makeTempDir = trackTempDirs();
beforeEach(() => {
  dir = makeTempDir('thread-content-backfill-');
});

/** Enough threads for three batches, the last one partial. */
const THREADS = THREAD_CONTENT_BACKFILL_BATCH * 2 + 7;
const EVENTS = THREADS * 3 + 11;
const threadName = (index: number) => `t-${String(index).padStart(5, '0')}`;
const threadOf = (index: number, threads: number) =>
  threadName(index % threads);
/** Every third event is bookkeeping, which never moves a version. */
const isContent = (index: number) => index % 3 !== 0;
/** Each thread's highest content (never bookkeeping) sequence. */
function expectedVersions(
  events: number,
  threads: number,
): Record<string, number> {
  const versions: Record<string, number> = {};
  for (let index = 1; index <= events; index += 1)
    if (isContent(index)) versions[threadOf(index, threads)] = index;
  return versions;
}
/** Thread names in the backfill's (binary) order. */
const sortedThreads = (threads: number) =>
  Array.from({ length: threads }, (_, index) => threadName(index)).sort();

/** A home from before content versions: history but no projection. */
function oldHome(path: string, events: number, threads = 2): void {
  new EventStore(path).close();
  const db = new DatabaseSync(path);
  db.exec('BEGIN');
  const insert = db.prepare(
    `INSERT INTO orchestration_events
       (id, provider, thread_id, turn_id, method, request_id, session_state, payload, created_at, observed_at, sequence, global_sequence)
     VALUES (?, 'claude', ?, 't', ?, NULL, NULL, '{}', ?, ?, ?, ?)`,
  );
  for (let index = 1; index <= events; index += 1) {
    const thread = threadOf(index, threads);
    const method = isContent(index)
      ? 'content.text-delta'
      : 'session.state-changed';
    const at = new Date(Date.UTC(2026, 10, 11, 10) + index).toISOString();
    insert.run(`e-${index}`, thread, method, at, at, index, index);
  }
  db.prepare(
    'UPDATE orchestration_stream_identity SET high_water = ? WHERE singleton = 1',
  ).run(events);
  db.exec(
    'DELETE FROM orchestration_thread_content; DELETE FROM orchestration_thread_content_migration;',
  );
  db.exec('COMMIT');
  db.close();
}

function progress(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare(
        'SELECT cutoff_sequence, cursor_sequence, cursor_thread_id, completed_at FROM orchestration_thread_content_migration WHERE singleton = 1',
      )
      .get() as
      | {
          cutoff_sequence: number;
          cursor_sequence: number;
          cursor_thread_id: string | null;
          completed_at: string | null;
        }
      | undefined;
  } finally {
    db.close();
  }
}

/** Every projected thread's content version. */
function projection(path: string): Record<string, number> {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Object.fromEntries(
      (
        db
          .prepare(
            'SELECT thread_id, content_sequence FROM orchestration_thread_content ORDER BY thread_id',
          )
          .all() as { thread_id: string; content_sequence: number }[]
      ).map((row) => [row.thread_id, Number(row.content_sequence)]),
    );
  } finally {
    db.close();
  }
}

test('each backfill statement seeks one thread on its own index, never a whole-history plan', () => {
  // The real schema and indexes, planned as a home has them (no statistics),
  // then again with statistics gathered.
  const path = join(dir, 'orchestration.sqlite');
  oldHome(path, EVENTS, THREADS);
  const db = new DatabaseSync(path);
  try {
    const plan = (sql: string) =>
      (
        db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[]
      ).map((row) => row.detail);
    for (const statistics of [false, true]) {
      if (statistics) db.exec('ANALYZE');
      // A walk back from the thread's newest event at the cutoff: no table
      // scan, no per-method index over every thread, no sort.
      expect(
        plan(THREAD_CONTENT_BACKFILL_PROJECT_SQL),
        `${statistics}`,
      ).toEqual([
        'SEARCH e USING INDEX idx_events_thread_global_sequence (thread_id=? AND global_sequence<?)',
      ]);
      const next = plan(THREAD_CONTENT_BACKFILL_NEXT_THREAD_SQL);
      expect(next).toHaveLength(1);
      expect(next[0]).toMatch(
        /^SEARCH orchestration_events USING COVERING INDEX \w+ \(thread_id>\?\)$/,
      );
    }
  } finally {
    db.close();
  }
}, 60_000);

test('the backfill commits bounded batches of threads and resumes an interrupted run where it stopped', () => {
  const path = join(dir, 'orchestration.sqlite');
  oldHome(path, EVENTS, THREADS);
  const order = sortedThreads(THREADS);

  // A start interrupted after its first batch committed.
  expect(
    () =>
      new EventStore(path, undefined, undefined, {
        threadContentBackfillBatch: () => {
          throw new Error('interrupted');
        },
      }),
  ).toThrow('interrupted');
  // The cutoff was written before the first batch; the cursor is the last
  // thread of that batch, and only that batch is projected.
  expect(progress(path)).toMatchObject({
    cutoff_sequence: EVENTS,
    cursor_thread_id: order[THREAD_CONTENT_BACKFILL_BATCH - 1],
    completed_at: null,
  });
  expect(Object.keys(projection(path))).toEqual(
    order.slice(0, THREAD_CONTENT_BACKFILL_BATCH),
  );

  // The next start continues after that thread, never from the first.
  const cursors: string[] = [];
  const store = new EventStore(path, undefined, undefined, {
    threadContentBackfillBatch: (cursor) => {
      cursors.push(cursor);
    },
  });
  try {
    // Two batches remain: one full, then the partial last one.
    expect(cursors).toEqual([order[THREAD_CONTENT_BACKFILL_BATCH * 2 - 1]]);
    const done = progress(path);
    expect(done?.completed_at).not.toBeNull();
    // Completion keeps the cutoff written before the first batch.
    expect(done).toMatchObject({
      cutoff_sequence: EVENTS,
      cursor_sequence: EVENTS,
      cursor_thread_id: order.at(-1),
    });
    expect(store.contentUpgradeFence()).toBe(EVENTS);
    expect(projection(path)).toEqual(expectedVersions(EVENTS, THREADS));
  } finally {
    store.close();
  }
}, 60_000);

test('a home part-way through the earlier global-sequence pass finishes with the full projection and the same cutoff', () => {
  const path = join(dir, 'orchestration.sqlite');
  oldHome(path, EVENTS, THREADS);
  const legacyCursor = Math.floor(EVENTS / 3);
  const appended = threadName(5);
  const db = new DatabaseSync(path);
  try {
    // The migration table as the earlier pass created it (no thread
    // cursor), with that pass's progress and its partial projection.
    db.exec(`DROP TABLE orchestration_thread_content_migration;
      CREATE TABLE orchestration_thread_content_migration (
        singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
        cutoff_sequence INTEGER NOT NULL CHECK (cutoff_sequence >= 0),
        cursor_sequence INTEGER NOT NULL
          CHECK (cursor_sequence >= 0 AND cursor_sequence <= cutoff_sequence),
        completed_at TEXT
      );`);
    db.prepare(
      `INSERT INTO orchestration_thread_content_migration
         (singleton, cutoff_sequence, cursor_sequence) VALUES (1, ?, ?)`,
    ).run(EVENTS, legacyCursor);
    db.prepare(
      `INSERT INTO orchestration_thread_content (thread_id, content_sequence)
       SELECT thread_id, MAX(global_sequence) FROM orchestration_events
       WHERE global_sequence <= ? AND method = 'content.text-delta'
       GROUP BY thread_id`,
    ).run(legacyCursor);
    // Content appended after the cutoff, projected by its own append.
    db.prepare(
      `INSERT INTO orchestration_thread_content (thread_id, content_sequence)
       VALUES (?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET content_sequence = excluded.content_sequence`,
    ).run(appended, EVENTS + 1);
  } finally {
    db.close();
  }

  const store = new EventStore(path);
  try {
    expect(store.contentUpgradeFence()).toBe(EVENTS);
    expect(progress(path)).toMatchObject({
      cutoff_sequence: EVENTS,
      cursor_sequence: EVENTS,
      cursor_thread_id: sortedThreads(THREADS).at(-1),
    });
    expect(projection(path)).toEqual({
      ...expectedVersions(EVENTS, THREADS),
      // The backfill never lowers a version written after the cutoff.
      [appended]: EVENTS + 1,
    });
  } finally {
    store.close();
  }
  // A later start sees the completed migration and leaves it alone.
  const completedAt = progress(path)?.completed_at;
  new EventStore(path).close();
  expect(progress(path)?.completed_at).toBe(completedAt);
}, 60_000);

/** Back to a pre-upgrade home after a writer's own start migrated it. */
function forgetMigration(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(
    'DELETE FROM orchestration_thread_content; DELETE FROM orchestration_thread_content_migration;',
  );
  db.close();
}

/** The thread content written during the migration lands on. */
const WRITTEN = threadName(1);

/** Content written by a peer that was already running against the home. */
function appendContent(store: EventStore, eventId: string): void {
  store.appendEvent({
    eventId,
    provider: 'claude',
    threadId: WRITTEN,
    createdAt: '2026-11-11T10:00:00.000Z',
    method: 'content.text-delta',
    turnId: 't',
    itemId: eventId,
    delta: 'written during the migration',
  } as never);
}

function projected(path: string, thread: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return Number(
      (
        db
          .prepare(
            'SELECT content_sequence FROM orchestration_thread_content WHERE thread_id = ?',
          )
          .get(thread) as { content_sequence: number }
      ).content_sequence,
    );
  } finally {
    db.close();
  }
}

test('content appended between batches is projected but stays outside the cutoff', () => {
  const path = join(dir, 'orchestration.sqlite');
  oldHome(path, EVENTS, THREADS);
  const writer = new EventStore(path);
  forgetMigration(path);
  let appended = false;
  const store = new EventStore(path, undefined, undefined, {
    threadContentBackfillBatch: () => {
      if (appended) return;
      appended = true;
      appendContent(writer, 'between-batches');
    },
  });
  try {
    writer.close();
    expect(appended).toBe(true);
    // The cutoff is the sequence when the migration began, never later.
    expect(store.contentUpgradeFence()).toBe(EVENTS);
    expect(projected(path, WRITTEN)).toBe(EVENTS + 1);
  } finally {
    store.close();
  }
}, 60_000);

test('an append during an interrupted run is projected and stays outside the cutoff after the resume', () => {
  const path = join(dir, 'orchestration.sqlite');
  oldHome(path, EVENTS, THREADS);
  // A writer already open on the pre-upgrade home.
  const writer = new EventStore(path);
  forgetMigration(path);
  expect(
    () =>
      new EventStore(path, undefined, undefined, {
        threadContentBackfillBatch: () => {
          appendContent(writer, 'during-backfill');
          throw new Error('interrupted');
        },
      }),
  ).toThrow('interrupted');
  writer.close();
  const resumed = new EventStore(path);
  try {
    // Projected (no cursor skipped it) and never inside the cutoff.
    expect(projected(path, WRITTEN)).toBe(EVENTS + 1);
    expect(resumed.contentUpgradeFence()).toBe(EVENTS);
  } finally {
    resumed.close();
  }
}, 60_000);

test('overlapping initializers: one completes, the other resumes and never moves the fence', () => {
  const path = join(dir, 'orchestration.sqlite');
  oldHome(path, EVENTS, THREADS);
  let peerFence: number | undefined;
  const store = new EventStore(path, undefined, undefined, {
    threadContentBackfillBatch: () => {
      if (peerFence !== undefined) return;
      // A second initializer runs to completion between A's batches, then
      // new content arrives.
      const peer = new EventStore(path);
      peerFence = peer.contentUpgradeFence();
      appendContent(peer, 'after-peer-completed');
      peer.close();
    },
  });
  try {
    expect(peerFence).toBe(EVENTS);
    expect(store.contentUpgradeFence()).toBe(peerFence);
    expect(projected(path, WRITTEN)).toBe(EVENTS + 1);
  } finally {
    store.close();
  }
}, 60_000);

test('a writer holding the lock fails the open before the cutoff is written; the next open migrates in full', () => {
  const path = join(dir, 'orchestration.sqlite');
  oldHome(path, 50);
  const peer = new DatabaseSync(path);
  try {
    expect(
      () =>
        new EventStore(path, undefined, undefined, {
          threadContentMigrationStart: () => peer.exec('BEGIN IMMEDIATE'),
        }),
    ).toThrow(/locked|busy/i);
    // Nothing was written: no cutoff to inherit, nothing half-done.
    expect(progress(path)).toBeUndefined();
  } finally {
    peer.exec('ROLLBACK');
    peer.close();
  }
  const retried = new EventStore(path);
  try {
    expect(retried.contentUpgradeFence()).toBe(50);
    expect(projection(path)).toEqual(expectedVersions(50, 2));
  } finally {
    retried.close();
  }
}, 60_000);

test('a writer holding the lock between batches fails the open mid-backfill; the next open resumes at the cursor with the same cutoff', () => {
  const path = join(dir, 'orchestration.sqlite');
  oldHome(path, EVENTS, THREADS);
  const order = sortedThreads(THREADS);
  const peer = new DatabaseSync(path);
  try {
    expect(
      () =>
        new EventStore(path, undefined, undefined, {
          threadContentBackfillBatch: () => peer.exec('BEGIN IMMEDIATE'),
        }),
    ).toThrow(/locked|busy/i);
    expect(progress(path)).toMatchObject({
      cutoff_sequence: EVENTS,
      cursor_thread_id: order[THREAD_CONTENT_BACKFILL_BATCH - 1],
      completed_at: null,
    });
  } finally {
    peer.exec('ROLLBACK');
    peer.close();
  }
  const cursors: string[] = [];
  const retried = new EventStore(path, undefined, undefined, {
    threadContentBackfillBatch: (cursor) => {
      cursors.push(cursor);
    },
  });
  try {
    // Resumed after the committed thread cursor, never from the first.
    expect(cursors).toEqual([order[THREAD_CONTENT_BACKFILL_BATCH * 2 - 1]]);
    expect(retried.contentUpgradeFence()).toBe(EVENTS);
    expect(progress(path)?.completed_at).not.toBeNull();
    expect(projection(path)).toEqual(expectedVersions(EVENTS, THREADS));
  } finally {
    retried.close();
  }
}, 60_000);

test('a person whose first acknowledgement another process records after the store opens starts unread; only the owner keeps the baseline', () => {
  const path = join(dir, 'orchestration.sqlite');
  oldHome(path, 50);
  const acknowledgements = new FileConversationAcknowledgementStore(dir);
  // Ada had a record before the upgrade; it earns her nothing.
  acknowledgements.acknowledge({
    userId: 'human:test:ada',
    conversationId: 'history',
    updatedAt: '2026-11-11T10:00:00.000Z',
  });
  const events = new EventStore(path);
  try {
    // Bob's first view, recorded by another process after the store opened.
    const moduleUrl = pathToFileURL(
      join(
        process.cwd(),
        'src-server/services/orchestration/conversation-acknowledgement-store.ts',
      ),
    ).href;
    const peer = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `import { FileConversationAcknowledgementStore } from ${JSON.stringify(moduleUrl)};
new FileConversationAcknowledgementStore(${JSON.stringify(dir)}).acknowledge({ userId: 'human:test:bob', conversationId: 'other', updatedAt: '2026-11-12T00:00:00.000Z' });`,
      ],
      { encoding: 'utf8', timeout: 20_000, windowsHide: true },
    );
    expect(peer.error, peer.stderr).toBeUndefined();
    expect(peer.status, peer.stderr).toBe(0);
    expect(
      acknowledgements.getMany('human:test:bob', ['other']).get('other'),
    ).toBe('2026-11-12T00:00:00.000Z');
    const markers = new FileReadMarkerStore(dir);
    expect(
      upgradeReadMarkerStore({
        store: markers,
        events,
        hosted: false,
        now: new Date('2026-11-12T00:00:00.000Z'),
      }),
    ).toBe(true);
    const odd = projected(path, threadName(1));
    const stateFor = (person: string) =>
      new ReadMarkerService({
        store: markers,
        conversations: acknowledgements,
        personKeyFor: () => person,
        agentConversations: {
          latestVersions: async () => new Map(),
          versionsOf: () =>
            new Map([
              [
                'history',
                { version: odd, space: 'content', acknowledgeableUntil: 0 },
              ],
            ]),
        },
      })
        .conversationReadStates({} as never, [])
        ?.get('history');
    expect(stateFor('personal:owner')).toMatchObject({ unread: false });
    expect(stateFor('human:test:ada')).toMatchObject({ unread: true });
    expect(stateFor('human:test:bob')).toMatchObject({ unread: true });
  } finally {
    events.close();
  }
}, 60_000);
