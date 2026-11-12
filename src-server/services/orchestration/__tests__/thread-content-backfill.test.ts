/**
 * #3075 owner design: the content-version backfill for an existing home runs
 * in bounded batches, each committed with its progress, so an interrupted
 * start resumes where it stopped instead of from zero. Completion records the
 * upgrade fence (the store's contiguous sequence prefix) in the same write.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { EventStore, THREAD_CONTENT_BACKFILL_BATCH } from '../event-store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'thread-content-backfill-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A home from before content versions: history but no projection. */
function oldHome(path: string, events: number): void {
  new EventStore(path).close();
  const db = new DatabaseSync(path);
  db.exec('BEGIN');
  const insert = db.prepare(
    `INSERT INTO orchestration_events
       (id, provider, thread_id, turn_id, method, request_id, session_state, payload, created_at, observed_at, sequence, global_sequence)
     VALUES (?, 'claude', ?, 't', ?, NULL, NULL, '{}', ?, ?, ?, ?)`,
  );
  for (let index = 1; index <= events; index += 1) {
    const thread = index % 2 === 0 ? 'even' : 'odd';
    // Every third event is bookkeeping, which never moves a version.
    const method =
      index % 3 === 0 ? 'session.state-changed' : 'content.text-delta';
    const at = new Date(Date.UTC(2026, 10, 11, 10) + index).toISOString();
    insert.run(`e-${index}`, thread, method, at, at, index, index);
  }
  db.prepare(
    'UPDATE orchestration_stream_identity SET high_water = ? WHERE singleton = 1',
  ).run(events);
  db.exec(
    'DELETE FROM orchestration_thread_content; DELETE FROM orchestration_thread_content_progress;',
  );
  db.exec('COMMIT');
  db.close();
}

function progress(path: string) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare(
        'SELECT cursor_sequence, fence_sequence, completed_at FROM orchestration_thread_content_progress WHERE singleton = 1',
      )
      .get() as
      | {
          cursor_sequence: number;
          fence_sequence: number | null;
          completed_at: string | null;
        }
      | undefined;
  } finally {
    db.close();
  }
}

test('the backfill commits bounded batches and resumes an interrupted run where it stopped', () => {
  const path = join(dir, 'orchestration.sqlite');
  const events = THREAD_CONTENT_BACKFILL_BATCH * 2 + 123;
  oldHome(path, events);

  // A start interrupted after its first batch committed.
  expect(
    () =>
      new EventStore(path, undefined, undefined, {
        threadContentBackfillBatch: () => {
          throw new Error('interrupted');
        },
      }),
  ).toThrow('interrupted');
  const interrupted = progress(path);
  expect(interrupted).toMatchObject({
    cursor_sequence: THREAD_CONTENT_BACKFILL_BATCH,
    fence_sequence: null,
    completed_at: null,
  });

  // The next start continues from that point, never from zero.
  const cursors: number[] = [];
  const store = new EventStore(path, undefined, undefined, {
    threadContentBackfillBatch: (cursor) => {
      cursors.push(cursor);
    },
  });
  try {
    expect(cursors[0]).toBe(THREAD_CONTENT_BACKFILL_BATCH * 2);
    let previous = THREAD_CONTENT_BACKFILL_BATCH;
    for (const cursor of cursors) {
      expect(cursor - previous).toBeLessThanOrEqual(
        THREAD_CONTENT_BACKFILL_BATCH,
      );
      previous = cursor;
    }
    const done = progress(path);
    expect(done?.completed_at).not.toBeNull();
    // The fence is the contiguous prefix the backfill covered.
    expect(done?.fence_sequence).toBe(events);
    expect(store.contentUpgradeFence()).toBe(events);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      const versions = Object.fromEntries(
        (
          db
            .prepare(
              'SELECT thread_id, content_sequence FROM orchestration_thread_content ORDER BY thread_id',
            )
            .all() as { thread_id: string; content_sequence: number }[]
        ).map((row) => [row.thread_id, row.content_sequence]),
      );
      // The highest content (never bookkeeping) sequence of each thread.
      const last = (parity: number) => {
        for (let index = events; index > 0; index -= 1)
          if (index % 2 === parity && index % 3 !== 0) return index;
        return 0;
      };
      expect(versions).toEqual({ even: last(0), odd: last(1) });
    } finally {
      db.close();
    }
  } finally {
    store.close();
  }
}, 60_000);
