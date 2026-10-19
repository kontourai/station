import { writeSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';

const makeTempDir = trackTempDirs();
const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0).reverse()) store.close();
  vi.restoreAllMocks();
});

function open(path: string): EventStore {
  const store = new EventStore(path);
  stores.push(store);
  return store;
}

function captureCompilations(store: EventStore) {
  const db = store['db'];
  const prepare = db.prepare.bind(db);
  const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => prepare(sql));
  return () => ({
    ordinary: spy.mock.calls.filter(([sql]) =>
      /^INSERT INTO orchestration_events\s/.test(sql),
    ).length,
    orIgnore: spy.mock.calls.filter(([sql]) =>
      /^INSERT OR IGNORE INTO orchestration_events\s/.test(sql),
    ).length,
    highWater: spy.mock.calls.filter(
      ([sql]) =>
        sql ===
        'UPDATE orchestration_stream_identity SET high_water = ? WHERE singleton = 1',
    ).length,
  });
}

function started(id: string, threadId: string): CanonicalRuntimeEvent {
  return {
    eventId: id,
    provider: 'claude',
    threadId,
    turnId: `turn-${id}`,
    method: 'turn.started',
    prompt: `prompt-${id}`,
    createdAt: '2026-10-19T00:00:00.000Z',
  };
}

function tool(id: string, threadId: string): CanonicalRuntimeEvent {
  return {
    eventId: id,
    provider: 'claude',
    threadId,
    turnId: `turn-${id}`,
    method: 'tool.completed',
    itemId: `item-${id}`,
    toolCallId: `call-${id}`,
    toolName: `tool-${id}`,
    status: 'success',
    createdAt: '2026-10-19T00:00:01.000Z',
  };
}

function committedRows(path: string) {
  const reader = new DatabaseSync(path, { readOnly: true });
  try {
    return reader
      .prepare(
        `SELECT id, thread_id, method, turn_id, sequence, global_sequence,
                json_extract(payload, '$.prompt') AS prompt,
                json_extract(payload, '$.toolCallId') AS tool_call_id
         FROM orchestration_events ORDER BY global_sequence`,
      )
      .all();
  } finally {
    reader.close();
  }
}

// One explicit prepare call per selected shape and connection; execution stays fresh.
// SQLite automatic recompilation after DDL is not counted by the spy.
// Projection equivalence remains owned by the unchanged high-cardinality case.
test('three append shapes use one explicit prepare call per connection with fresh bindings, schema changes, errors and reopen', () => {
  const root = makeTempDir('event-store-append-statements-');
  const path = join(root, 'first.sqlite');
  const store = open(path);
  const counts = captureCompilations(store);
  expect(counts()).toEqual({ ordinary: 0, orIgnore: 0, highWater: 0 });

  const first = started('a', 'one');
  const firstTool = tool('b', 'one');
  expect(store.appendEvent(first)).toBe(1);
  expect(store.appendEvent(firstTool)).toBe(2);
  expect(store.appendEvent(started('c', 'two'))).toBe(1);
  expect(store.appendEvent(tool('d', 'two'))).toBe(2);
  expect(store.appendEvent(firstTool)).toBe(2);
  expect(() => store.appendEvent(first)).toThrow('UNIQUE');
  expect(counts()).toEqual({ ordinary: 1, orIgnore: 1, highWater: 1 });

  store['db'].exec(`CREATE TEMP TRIGGER reject_high_water
    BEFORE UPDATE ON orchestration_stream_identity
    WHEN NEW.high_water != OLD.high_water
    BEGIN SELECT RAISE(ABORT, 'keeper high-water abort'); END`);
  expect(() => store.appendEvent(started('not-committed', 'one'))).toThrow(
    'keeper high-water abort',
  );
  expect(store.hasEventId('not-committed')).toBe(false);
  store['db'].exec('DROP TRIGGER reject_high_water');
  store['db'].exec(
    'ALTER TABLE orchestration_events ADD COLUMN keeper_only TEXT',
  );
  expect(store.appendEvent(started('e', 'one'))).toBe(3);
  expect(store.appendEvent(tool('f', 'two'))).toBe(3);
  expect(counts()).toEqual({ ordinary: 1, orIgnore: 1, highWater: 1 });
  const rows = committedRows(path);
  writeSync(
    1,
    `@@APPEND_STATEMENT_ROWS@@${JSON.stringify(rows)}@@END_APPEND_STATEMENT_ROWS@@\n`,
  );
  expect(rows).toEqual([
    {
      id: 'a',
      thread_id: 'one',
      method: 'turn.started',
      turn_id: 'turn-a',
      sequence: 1,
      global_sequence: 1,
      prompt: 'prompt-a',
      tool_call_id: null,
    },
    {
      id: 'b',
      thread_id: 'one',
      method: 'tool.completed',
      turn_id: 'turn-b',
      sequence: 2,
      global_sequence: 2,
      prompt: null,
      tool_call_id: 'call-b',
    },
    {
      id: 'c',
      thread_id: 'two',
      method: 'turn.started',
      turn_id: 'turn-c',
      sequence: 1,
      global_sequence: 3,
      prompt: 'prompt-c',
      tool_call_id: null,
    },
    {
      id: 'd',
      thread_id: 'two',
      method: 'tool.completed',
      turn_id: 'turn-d',
      sequence: 2,
      global_sequence: 4,
      prompt: null,
      tool_call_id: 'call-d',
    },
    {
      id: 'e',
      thread_id: 'one',
      method: 'turn.started',
      turn_id: 'turn-e',
      sequence: 3,
      global_sequence: 5,
      prompt: 'prompt-e',
      tool_call_id: null,
    },
    {
      id: 'f',
      thread_id: 'two',
      method: 'tool.completed',
      turn_id: 'turn-f',
      sequence: 3,
      global_sequence: 6,
      prompt: null,
      tool_call_id: 'call-f',
    },
  ]);
  store.close();
  expect(() => store.appendEvent(started('closed', 'one'))).toThrow(
    'database is not open',
  );

  const reopened = open(path);
  const reopenedCounts = captureCompilations(reopened);
  expect(reopenedCounts()).toEqual({ ordinary: 0, orIgnore: 0, highWater: 0 });
  expect(committedRows(path)).toEqual(rows);
  expect(reopened.appendEvent(started('g', 'one'))).toBe(4);
  expect(reopened.appendEvent(tool('h', 'two'))).toBe(4);
  expect(reopenedCounts()).toEqual({ ordinary: 1, orIgnore: 1, highWater: 1 });
  expect(committedRows(path).slice(-2)).toMatchObject([
    { id: 'g', thread_id: 'one', global_sequence: 7, prompt: 'prompt-g' },
    { id: 'h', thread_id: 'two', global_sequence: 8, tool_call_id: 'call-h' },
  ]);

  const otherPath = join(root, 'second.sqlite');
  const other = open(otherPath);
  const otherCounts = captureCompilations(other);
  expect(otherCounts()).toEqual({ ordinary: 0, orIgnore: 0, highWater: 0 });
  expect(other.appendEvent(started('a', 'isolated'))).toBe(1);
  expect(other.appendEvent(tool('b', 'isolated'))).toBe(2);
  const otherRows = committedRows(otherPath);
  const reopenedRows = committedRows(path);
  writeSync(
    1,
    `@@APPEND_STATEMENT_LIFETIMES@@${JSON.stringify({
      firstCounts: counts(),
      reopenedCounts: reopenedCounts(),
      otherCounts: otherCounts(),
      reopenedRows,
      otherRows,
    })}@@END_APPEND_STATEMENT_LIFETIMES@@\n`,
  );
  expect(otherCounts()).toEqual({ ordinary: 1, orIgnore: 1, highWater: 1 });
  expect(otherRows).toMatchObject([
    { id: 'a', thread_id: 'isolated', sequence: 1, global_sequence: 1 },
    { id: 'b', thread_id: 'isolated', sequence: 2, global_sequence: 2 },
  ]);
  expect(reopenedRows).toHaveLength(8);
});

test('lazy append preparation stays after co-commit refusal and transaction-loss checks', () => {
  const store = open(
    join(makeTempDir('event-store-append-lazy-'), 'events.sqlite'),
  );
  const counts = captureCompilations(store);
  const refusal = new Error('real participant refusal');
  expect(() =>
    store.appendEvent(started('refused', 'one'), [], () => {
      throw refusal;
    }),
  ).toThrow(refusal);
  expect(counts()).toEqual({ ordinary: 0, orIgnore: 0, highWater: 0 });
  expect(() =>
    store.appendEvent(started('lost', 'one'), [], () => {
      store['db'].exec('ROLLBACK');
    }),
  ).toThrow();
  expect(counts()).toEqual({ ordinary: 0, orIgnore: 0, highWater: 0 });
  expect(store.listEvents('one')).toEqual([]);
  expect(
    store.appendEvent(started('fresh', 'one'), [], () => {
      expect(counts()).toEqual({ ordinary: 0, orIgnore: 0, highWater: 0 });
      expect(store['db'].isTransaction).toBe(true);
    }),
  ).toBe(1);
  expect(counts()).toEqual({ ordinary: 1, orIgnore: 0, highWater: 1 });
});
