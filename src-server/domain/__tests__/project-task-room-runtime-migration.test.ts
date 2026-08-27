import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, test } from 'vitest';
import { EventStore } from '../../services/orchestration/event-store.js';

describe('project task room runtime migration', () => {
  let directory = '';
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  test('creates the additive working, recovery, and revision-publication tables', () => {
    directory = mkdtempSync(join(tmpdir(), 'station-room-runtime-'));
    const path = join(directory, 'orchestration.sqlite');
    const store = new EventStore(path);
    store.close();
    const db = new DatabaseSync(path);
    const names = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'project_task_room_%'",
      )
      .all() as { name: string }[];
    db.close();
    expect(names.map(({ name }) => name).sort()).toEqual(
      expect.arrayContaining([
        'project_task_room_working_batches',
        'project_task_room_working_states',
        'project_task_room_live_recovery',
        'project_task_room_revision_publication_outbox',
        'project_task_room_revision_evidence_heads',
      ]),
    );
  });
});
