import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { ensurePositiveTurnStartIndex } from '../migrations/019-positive-turn-start-index.js';
import { ensureUsageExportInvalidations } from '../migrations/023-usage-export-invalidations.js';

const makeTempDir = trackTempDirs();

test.each([
  [
    'positive-start index',
    ensurePositiveTurnStartIndex,
    'idx_events_positive_turn_start',
  ],
  [
    'usage export journal',
    ensureUsageExportInvalidations,
    'orchestration_usage_export_state',
  ],
] as const)(
  '%s reserves the writer before reading migration state',
  (_name, migrate, schemaName) => {
    const path = join(makeTempDir('migration-writer-'), 'events.sqlite');
    const primary = new DatabaseSync(path);
    primary.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE migration_writer_probe (id INTEGER PRIMARY KEY);
    CREATE TABLE orchestration_events (
      thread_id TEXT, sequence INTEGER, method TEXT, payload TEXT, turn_id TEXT
    );
    CREATE TABLE orchestration_conversation_history (
      thread_id TEXT PRIMARY KEY, owner_user_id TEXT, tenant_id TEXT
    );
    CREATE TABLE orchestration_event_store_backfills (
      name TEXT PRIMARY KEY, completed_at TEXT
    );
  `);
    const peer = new DatabaseSync(path);
    peer.exec('PRAGMA busy_timeout=0');
    let attempted = false;
    let peerError: unknown;
    const prepare = primary.prepare.bind(primary);
    const intercepted = vi
      .spyOn(primary, 'prepare')
      .mockImplementation((sql) => {
        const statement = prepare(sql);
        const get = statement.get.bind(statement);
        vi.spyOn(statement, 'get').mockImplementation((...args) => {
          const row = get(...args);
          if (!attempted) {
            attempted = true;
            // In WAL, a peer can commit after a deferred reader's snapshot; that
            // reader then cannot upgrade to a writer, even with busy_timeout.
            try {
              peer.exec('INSERT INTO migration_writer_probe VALUES(1)');
            } catch (error) {
              peerError = error;
            }
          }
          return row;
        });
        return statement;
      });
    try {
      expect(() => migrate(primary)).not.toThrow();
      expect(attempted).toBe(true);
      expect(peerError).toMatchObject({ errcode: 5 });
      expect(
        peer.prepare('SELECT * FROM migration_writer_probe').all(),
      ).toEqual([]);
      expect(primary.isTransaction).toBe(false);
      expect(
        peer
          .prepare('SELECT name FROM sqlite_master WHERE name=?')
          .get(schemaName),
      ).toEqual({ name: schemaName });
      peer.exec('INSERT INTO migration_writer_probe VALUES(1)');
      migrate(peer);
      expect(
        peer.prepare('SELECT * FROM migration_writer_probe').all(),
      ).toEqual([{ id: 1 }]);

      // A caller that already owns the writer keeps its transaction on both
      // success and strict validation failure; the migration owns a savepoint.
      primary.exec(
        'BEGIN IMMEDIATE; INSERT INTO migration_writer_probe VALUES(2)',
      );
      migrate(primary);
      expect(primary.isTransaction).toBe(true);
      const corruptSchema = () => {
        if (schemaName === 'idx_events_positive_turn_start') {
          primary.exec(`DROP INDEX idx_events_positive_turn_start;
            CREATE INDEX idx_events_positive_turn_start ON migration_writer_probe(id)`);
        } else {
          primary.exec('DELETE FROM orchestration_event_store_backfills');
        }
      };
      corruptSchema();
      expect(() => migrate(primary)).toThrow(
        /positive-start index is unavailable or changed|initialization evidence is missing/,
      );
      expect(primary.isTransaction).toBe(true);
      expect(
        primary
          .prepare('SELECT * FROM migration_writer_probe ORDER BY id')
          .all(),
      ).toEqual([{ id: 1 }, { id: 2 }]);
      primary.exec('ROLLBACK');
      migrate(primary);
      expect(
        peer.prepare('SELECT * FROM migration_writer_probe').all(),
      ).toEqual([{ id: 1 }]);

      corruptSchema();
      expect(() => migrate(primary)).toThrow(
        /positive-start index is unavailable or changed|initialization evidence is missing/,
      );
      expect(primary.isTransaction).toBe(false);
      peer.exec('INSERT INTO migration_writer_probe VALUES(3)');
      expect(
        peer.prepare('SELECT * FROM migration_writer_probe ORDER BY id').all(),
      ).toEqual([{ id: 1 }, { id: 3 }]);
    } finally {
      intercepted.mockRestore();
      peer.close();
      primary.close();
    }
  },
);
