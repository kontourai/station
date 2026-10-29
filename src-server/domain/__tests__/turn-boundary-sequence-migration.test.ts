import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, test } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import {
  ORCHESTRATION_EVENT_STORE_MIGRATION,
  runOrchestrationEventMigration,
} from '../migrations/003-orchestration-events.js';

describe('turn-boundary sequence migration', () => {
  const makeTempDir = trackTempDirs();
  test.each(['fresh', 'legacy'] as const)(
    'startup adds a nullable fence idempotently without rewriting rows (%s)',
    (home) => {
      const root = makeTempDir('boundary-migration-');
      mkdirSync(join(root, 'data'));
      const path = join(root, 'data', 'orchestration.sqlite');
      let before: unknown[] = [];
      if (home === 'legacy') {
        const db = new DatabaseSync(path);
        db.exec(ORCHESTRATION_EVENT_STORE_MIGRATION);
        db.exec(`INSERT INTO orchestration_turn_boundaries
        (boundary_id, thread_id, state, owner_id, owner_pid, owner_identity_kind, created_at, updated_at)
        VALUES ('legacy', 'thread', 'indeterminate', 'owner', 123, 'unverified', '2026-10-13T02:00:00Z', '2026-10-13T02:00:00Z')`);
        before = db
          .prepare(
            'SELECT boundary_id, thread_id, state, owner_id, owner_pid, owner_identity_kind, created_at, updated_at FROM orchestration_turn_boundaries',
          )
          .all();
        db.close();
      }
      for (let boot = 0; boot < 2; boot++) {
        runOrchestrationEventMigration(root);
        const db = new DatabaseSync(path);
        try {
          const columns = db
            .prepare('PRAGMA table_info(orchestration_turn_boundaries)')
            .all();
          expect(
            columns.filter((column) => column.name === 'created_sequence'),
          ).toEqual([
            expect.objectContaining({
              type: 'INTEGER',
              notnull: 0,
              dflt_value: null,
            }),
          ]);
          expect(
            db
              .prepare(
                'SELECT boundary_id, thread_id, state, owner_id, owner_pid, owner_identity_kind, created_at, updated_at FROM orchestration_turn_boundaries',
              )
              .all(),
          ).toEqual(before);
          expect(
            db
              .prepare(
                'SELECT created_sequence FROM orchestration_turn_boundaries',
              )
              .all(),
          ).toEqual(home === 'legacy' ? [{ created_sequence: null }] : []);
        } finally {
          db.close();
        }
      }
    },
  );
});
