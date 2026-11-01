import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { EventStore } from '../event-store.js';
import type { SqliteDatabase } from '../sqlite-database.js';

const makeTempDir = trackTempDirs();

describe('EventStore cache-disabled diagnostics', () => {
  test('recomputes derived reads and prepares each statement while preserving durable events', () => {
    vi.stubEnv('STATION_DISABLE_EVENT_STORE_CACHES', '1');
    const store = new EventStore(
      join(makeTempDir('uncached-event-store-'), 'events.sqlite'),
    );
    try {
      const db = (store as unknown as { db: SqliteDatabase }).db;
      const prepare = vi.spyOn(db, 'prepare');
      const at = '2026-08-13T00:00:00.000Z';
      for (const [index, letter] of ['a', 'b'].entries()) {
        store.appendEvent({
          eventId: `event-${index}`,
          provider: 'codex',
          threadId: 'thread',
          turnId: `turn-${index}`,
          method: 'turn.started',
          createdAt: at,
          prompt: letter.repeat(20_000),
        });
      }
      expect(store.standingUnresolvedCompletionIds('thread', 2)).toEqual(
        new Set(),
      );
      expect(store.standingUnresolvedCompletionIds('thread', 2)).toEqual(
        new Set(),
      );
      expect(store.listEventsForTurn('thread', 'turn-0')).toHaveLength(1);
      const queries = prepare.mock.calls.map(([sql]) => sql);
      expect(
        queries.filter((sql) =>
          sql.includes('INSERT INTO orchestration_events'),
        ),
      ).toHaveLength(2);
      expect(
        queries.filter((sql) =>
          sql.includes('UPDATE orchestration_stream_identity SET high_water = ?'),
        ),
      ).toHaveLength(2);
      expect(
        queries.filter((sql) =>
          sql.includes('INSERT OR IGNORE INTO orchestration_event_content'),
        ),
      ).toHaveLength(2);
      expect(
        queries.filter(
          (sql) =>
            sql.includes('SELECT payload FROM orchestration_events') &&
            sql.includes('sequence <= ?'),
        ),
      ).toHaveLength(2);
    } finally {
      store.close();
      vi.unstubAllEnvs();
    }
  });
});
