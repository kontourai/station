import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';

const makeTempDir = trackTempDirs();

test('a durable parent terminal records one child stop intent and fence across reopen', () => {
  const path = join(makeTempDir('cascade-intent-'), 'events.sqlite');
  const store = new EventStore(path);
  store.appendEvent({
    eventId: 'parent-terminal',
    threadId: 'parent',
    sessionId: 'parent',
    provider: 'codex',
    method: 'session.exited',
    createdAt: '2026-01-01T00:00:00.000Z',
    reason: 'stopped',
  });
  expect(
    store.recordCascadeStopIntent('parent', 'child', 'parent-terminal'),
  ).toBe(true);
  expect(
    store.recordCascadeStopIntent('parent', 'child', 'parent-terminal'),
  ).toBe(false);
  expect(() =>
    store.recordCascadeStopIntent(
      'other-parent',
      'other-child',
      'parent-terminal',
    ),
  ).toThrow('Cascade parent terminal is unavailable');
  store.close();
  const db = new DatabaseSync(path);
  try {
    expect(
      db
        .prepare(
          'SELECT thread_id, terminal_event_id FROM orchestration_cancellation_fences',
        )
        .all(),
    ).toEqual([{ thread_id: 'child', terminal_event_id: 'parent-terminal' }]);
    expect(
      db
        .prepare(
          'SELECT parent_session_id, child_session_id, terminal_event_id, state FROM orchestration_cascade_stop_intents',
        )
        .all(),
    ).toEqual([
      {
        parent_session_id: 'parent',
        child_session_id: 'child',
        terminal_event_id: 'parent-terminal',
        state: 'pending',
      },
    ]);
  } finally {
    db.close();
  }
});

test('a fence write failure rolls back the stop intent', () => {
  const path = join(makeTempDir('cascade-rollback-'), 'events.sqlite');
  const store = new EventStore(path);
  store.appendEvent({
    eventId: 'terminal',
    threadId: 'parent',
    sessionId: 'parent',
    provider: 'codex',
    method: 'session.exited',
    createdAt: '2026-01-01T00:00:00.000Z',
    reason: 'stopped',
  });
  const peer = new DatabaseSync(path);
  try {
    peer.exec(`CREATE TRIGGER fail_cascade_fence BEFORE INSERT ON orchestration_cancellation_fences
      BEGIN SELECT RAISE(ABORT, 'injected fence failure'); END`);
    expect(() =>
      store.recordCascadeStopIntent('parent', 'child', 'terminal'),
    ).toThrow('injected fence failure');
    expect(
      peer.prepare('SELECT * FROM orchestration_cascade_stop_intents').all(),
    ).toEqual([]);
    expect(
      peer.prepare('SELECT * FROM orchestration_cancellation_fences').all(),
    ).toEqual([]);
  } finally {
    peer.close();
    store.close();
  }
});
