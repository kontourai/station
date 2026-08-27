import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  orchestrationStorePath,
  STORE_INTEGRITY_EXIT_CODE,
  schedulerStorePath,
  stationHomeStorePaths,
  storeIntegrityExitCode,
  verifySqliteStore,
} from '../sqlite-store-integrity.js';

/**
 * station#3218. Every verdict here is reached against REAL bytes on a real
 * store, never a thrown fixture: the claim is that Station notices what SQLite
 * actually does to a damaged file, and a hand-authored error object cannot
 * prove that. The store is opened in WAL because that is what the runtime's
 * writer sets (`event-store.ts`), and a corpus that only ever ran against a
 * `delete`-journal store would not have exercised the mode this runs in.
 */

let dir: string;

function seed(path: string, rows: number): InstanceType<typeof DatabaseSync> {
  const database = new DatabaseSync(path);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT, b TEXT)');
  database.exec('CREATE INDEX ia ON t(a)');
  const insert = database.prepare('INSERT INTO t(a, b) VALUES (?, ?)');
  database.exec('BEGIN');
  for (let index = 0; index < rows; index += 1)
    insert.run(`a${index}${'x'.repeat(60)}`, `b${index}${'y'.repeat(60)}`);
  database.exec('COMMIT');
  return database;
}

/**
 * Overwrites the back half of the file, leaving the 100-byte header and the
 * schema pages intact. That is the damage this feature exists for: the store
 * still OPENS, so nothing on the boot path or in an ordinary query notices,
 * and only a deliberate `quick_check` reaches the pages.
 */
function damageRowPages(path: string): void {
  const bytes = readFileSync(path);
  expect(bytes.byteLength).toBeGreaterThan(64 * 1024);
  bytes.fill(0x5a, Math.floor(bytes.byteLength * 0.5));
  writeFileSync(path, bytes);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sqlite-store-integrity-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('verifySqliteStore', () => {
  test('reports a healthy store as ok while its writer is still open', () => {
    // The scheduled probe runs alongside a live Station, so the case that has
    // to work is a WAL store with a writer holding it and `-wal`/`-shm` on
    // disk. A read-only connection blocks no writer there — that property is
    // the whole reason this can run off the boot path.
    const path = join(dir, 'orchestration.sqlite');
    const writer = seed(path, 3_000);
    try {
      const result = verifySqliteStore(path);
      expect(result.verdict).toBe('ok');
      expect(result.detail).toBeUndefined();
      expect(result.errcode).toBeUndefined();
      // The writer must still be usable: a probe that took a lock the runtime
      // needed would trade corruption detection for an outage.
      expect(() =>
        writer.prepare('INSERT INTO t(a, b) VALUES (?, ?)').run('z', 'z'),
      ).not.toThrow();
    } finally {
      writer.close();
    }
  });

  test('reports page damage nothing has queried as corrupt', () => {
    const path = join(dir, 'orchestration.sqlite');
    seed(path, 20_000).close();
    damageRowPages(path);

    const result = verifySqliteStore(path);
    expect(result.verdict).toBe('corrupt');
    // `quick_check` REPORTS this damage rather than raising, so there is no
    // errcode — and the report itself is the only account of what is broken.
    // A corruption verdict with nothing behind it is what this asserts against.
    expect(result.detail).toMatch(/page \d+/);
    expect(result.detail?.length).toBeLessThanOrEqual(500);
  });

  test('reports page damage under a live WAL writer as corrupt', () => {
    // The same damage with the runtime still attached. Verified separately
    // because the read path differs: a probe here reads through the `-wal`,
    // not the main file alone.
    const path = join(dir, 'orchestration.sqlite');
    const writer = seed(path, 20_000);
    try {
      writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      damageRowPages(path);
      expect(verifySqliteStore(path).verdict).toBe('corrupt');
    } finally {
      try {
        writer.close();
      } catch {
        // Closing a handle on a damaged file is allowed to fail.
      }
    }
  });

  test('reports bytes that are not a database at all as corrupt', () => {
    const path = join(dir, 'orchestration.sqlite');
    writeFileSync(path, 'not a sqlite database');
    const result = verifySqliteStore(path);
    expect(result.verdict).toBe('corrupt');
    // SQLITE_NOTADB. Raised at OPEN time, which is why an open failure cannot
    // simply be assumed to mean "could not look".
    expect(result.errcode).toBe(26);
  });

  test('a store that cannot be read is not reported as corrupt', () => {
    // The required negative control, and the reason these verdicts are
    // separate values rather than one failure: recording corruption for a
    // store Station could not READ would quarantine a database nobody has
    // any evidence against.
    const directory = verifySqliteStore(dir);
    expect(directory.verdict).toBe('unavailable');
    expect(directory.verdict).not.toBe('corrupt');
    expect(directory.detail).toBeDefined();
    expect(directory.errcode).toBeDefined();
  });

  test('a symlink to a missing store is unavailable, not absent', () => {
    // `statSync` follows links, so a pointer at a deleted target reports
    // ENOENT and would read as "this home never had a store". Something IS
    // there; what is missing is what it points at.
    const path = join(dir, 'orchestration.sqlite');
    symlinkSync(join(dir, 'gone.sqlite'), path);
    const result = verifySqliteStore(path);
    expect(result.verdict).toBe('unavailable');
    expect(result.detail).toMatch(/symbolic link/);
  });

  test('a store that was never created is reported as absent, not unavailable', () => {
    // A home that has never scheduled anything has no scheduler ledger.
    // Reporting that as a failed check makes `station home verify` fail on a
    // healthy home, which is how a check teaches its operator to ignore it.
    const missing = verifySqliteStore(join(dir, 'never-created.sqlite'));
    expect(missing.verdict).toBe('absent');
    // On its own it is still not a clean bill of health — see the exit-code
    // suite below — but beside a store that WAS verified it is not a finding.
    expect(
      storeIntegrityExitCode([
        { databasePath: '/x.sqlite', verdict: 'ok', durationMs: 1 },
        missing,
      ]),
    ).toBe(STORE_INTEGRITY_EXIT_CODE.ok);
  });

  test('a stat failure that is not ENOENT stays unavailable', () => {
    // The discriminating case for the `absent` guard, and the reason it keys
    // on ENOENT rather than on "stat threw". Here `real.sqlite` EXISTS as a
    // file, so treating it as a directory fails ENOTDIR — Station could not
    // read a store, which is not the same as there being no store.
    //
    // Without this the previous fixture named a parent that did not exist
    // either, so it stat'd ENOENT and returned `absent` without ever reaching
    // the guard's fall-through: the rejection path had never executed.
    writeFileSync(join(dir, 'real.sqlite'), 'not a directory');
    const result = verifySqliteStore(join(dir, 'real.sqlite', 'inner.sqlite'));
    expect(result.verdict).toBe('unavailable');
    expect(result.errcode).toBe(14);
  });

  test('an empty file is not reported as corrupt', () => {
    // SQLite treats a zero-length file as a brand-new database, so this must
    // come back ok rather than damaged — a truncated-to-nothing store is
    // indistinguishable from an unused one and must not condemn a home.
    const path = join(dir, 'orchestration.sqlite');
    writeFileSync(path, '');
    // `toBe('ok')`, not `not.toBe('corrupt')`: the weaker form is also
    // satisfied by `unavailable` and `absent`, so it could not tell the three
    // apart — which is the whole distinction this file exists to defend.
    expect(verifySqliteStore(path).verdict).toBe('ok');
  });
});

describe('storeIntegrityExitCode', () => {
  test('corrupt outranks unavailable, and nothing checked is a usage error', () => {
    const at = (verdict: 'ok' | 'corrupt' | 'unavailable' | 'absent') => ({
      databasePath: '/x.sqlite',
      verdict,
      durationMs: 1,
    });
    expect(storeIntegrityExitCode([])).toBe(STORE_INTEGRITY_EXIT_CODE.usage);
    expect(storeIntegrityExitCode([at('ok'), at('ok')])).toBe(
      STORE_INTEGRITY_EXIT_CODE.ok,
    );
    expect(storeIntegrityExitCode([at('ok'), at('unavailable')])).toBe(
      STORE_INTEGRITY_EXIT_CODE.unavailable,
    );
    expect(storeIntegrityExitCode([at('unavailable'), at('corrupt')])).toBe(
      STORE_INTEGRITY_EXIT_CODE.corrupt,
    );
    // A store that does not exist is not a failure of anything — provided
    // something else was actually verified.
    expect(storeIntegrityExitCode([at('ok'), at('absent')])).toBe(
      STORE_INTEGRITY_EXIT_CODE.ok,
    );
    // But a report in which NOTHING was verified is not a report of no
    // problems. This is what a mistyped `--base` produces, and answering
    // "is my data OK?" with exit 0 about a home that does not exist is the
    // worst available answer.
    expect(storeIntegrityExitCode([at('absent'), at('absent')])).toBe(
      STORE_INTEGRITY_EXIT_CODE.usage,
    );
    expect(storeIntegrityExitCode([at('absent')])).not.toBe(
      STORE_INTEGRITY_EXIT_CODE.ok,
    );
    // The codes must stay distinct; collapsing them is the defect the
    // separation exists to prevent.
    expect(STORE_INTEGRITY_EXIT_CODE.corrupt).not.toBe(
      STORE_INTEGRITY_EXIT_CODE.unavailable,
    );
  });
});

describe('station home store layout', () => {
  test('names the stores Station writes, and only those', () => {
    const home = join('/tmp', 'home');
    expect(orchestrationStorePath(home)).toBe(
      join(home, 'data', 'orchestration.sqlite'),
    );
    expect(schedulerStorePath(home)).toBe(
      join(home, 'scheduler', 'scheduler.sqlite'),
    );
    expect(stationHomeStorePaths(home)).toEqual([
      orchestrationStorePath(home),
      schedulerStorePath(home),
    ]);
  });
});
