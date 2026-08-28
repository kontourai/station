import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EventStore, EventStoreIntegrityError } from '../event-store.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  orchestrationEventsPersisted: { add: vi.fn() },
  orchestrationEventPersistDuration: { record: vi.fn() },
  turnDedupClaims: { add: vi.fn() },
  orchestrationStoreCorruptionObserved: { add: vi.fn() },
}));

/**
 * archive#3217 review H1, re-anchored on the reactive path after archive#3219
 * removed the per-boot integrity check. Closing the LAST read-write connection
 * to a corrupt WAL-mode store deletes the hot WAL outright — measured: wal
 * 206032 -> GONE, main byte-identical, and the checkpoint that might have
 * folded the frames in fails on the damage. Those frames are committed events
 * that exist in no other file, and the quarantine/salvage path is about to
 * try to preserve them.
 *
 * The boot failure now happens INSIDE the constructor's migration/ensure
 * sequence (a real read hitting damaged pages), not in a dedicated
 * `PRAGMA quick_check`; the constructor's corruption-classified failure path
 * is what must hold the WAL open through its own close.
 *
 * The writer has to be genuinely DEAD: an open connection anywhere in this
 * process prevents WAL cleanup and the test cannot discriminate. Hence the
 * child process that leaves the hot WAL behind, and hence this file's
 * process-heavy classification.
 */
const HOT_WRITE_SCRIPT = `
const { DatabaseSync } = require('node:sqlite');
const p = process.argv[1];
const db = new DatabaseSync(p);
for (let i = 0; i < 50; i += 1) {
  db.exec(
    "INSERT INTO orchestration_events " +
      "(id, provider, thread_id, method, payload, created_at, sequence, global_sequence) " +
      "VALUES ('hot-" + i + "', 'claude', 'hot-thread', 'turn.started', '" +
      'x'.repeat(3000) + "', '2026-08-18T00:00:00.000Z', " + (100000 + i) + ", " + (100000 + i) + ")",
  );
}
// Exit WITHOUT close(): a killed Station leaves exactly this — a hot WAL and
// no live connection.
process.exit(0);
`;

describe('a failed corrupt-store boot preserves the hot WAL', () => {
  let dir: string;
  let databasePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'event-store-wal-preserve-'));
    databasePath = join(dir, 'orchestration.sqlite');
    // A real Station store, seeded through the real constructor so the boot
    // that later fails is reading its own schema, then closed cleanly so the
    // only connection is gone before the child writes the hot WAL.
    const store = new EventStore(databasePath);
    for (let index = 0; index < 400; index += 1) {
      store.appendEvent({
        eventId: `event-${index}`,
        provider: 'claude',
        threadId: 'wal-thread',
        turnId: `turn-${index}`,
        createdAt: '2026-08-18T00:00:00.000Z',
        method: 'turn.started',
        prompt: `payload ${index} ${'x'.repeat(400)}`,
      });
    }
    store.close?.();
    execFileSync(process.execPath, ['-e', HOT_WRITE_SCRIPT, databasePath]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('the WAL survives the corruption-classified close, hot frames intact', () => {
    const walPath = `${databasePath}-wal`;
    expect(existsSync(walPath)).toBe(true);
    const walBefore = readFileSync(walPath);
    expect(walBefore.byteLength).toBeGreaterThan(100_000);

    // Damage mid-file pages (the schema tables' data btrees) so the header
    // and sqlite_schema still open, the migration's IF NOT EXISTS statements
    // no-op without writing, and the constructor's own ensure/backfill reads
    // are what hit the damage. The child's hot frames cover only the events
    // btree tail and page 1, so the damaged pages are not masked by the WAL.
    const bytes = readFileSync(databasePath);
    expect(bytes.byteLength).toBeGreaterThan(64 * 1024);
    bytes.fill(0x5a, 8192, 8192 + 32 * 1024);
    writeFileSync(databasePath, bytes);

    expect(() => new EventStore(databasePath)).toThrow(
      EventStoreIntegrityError,
    );

    // The whole claim. Without the read-only holder, this close was the last
    // read-write connection and SQLite reaped the WAL on the way out.
    //
    // Prefix-identical, not byte-identical: a reactive boot legitimately
    // commits a handful of frames (measured: ~7) before a read discovers the
    // damage, and new frames APPEND after the last valid one. What must never
    // happen is the pre-existing committed frames being reset or reaped —
    // both of which this still catches (a reaped WAL fails `existsSync`; a
    // checkpoint-reset WAL restarts at byte 0 and fails the prefix compare).
    expect(existsSync(walPath)).toBe(true);
    expect(statSync(walPath).size).toBeGreaterThanOrEqual(walBefore.byteLength);
    expect(
      readFileSync(walPath).subarray(0, walBefore.byteLength).equals(walBefore),
    ).toBe(true);
  });
});
