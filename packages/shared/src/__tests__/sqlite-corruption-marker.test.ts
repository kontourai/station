import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  clearCorruptionMarker,
  corruptionMarkerFromError,
  corruptionMarkerPath,
  readCorruptionMarker,
  recordCorruptionObserved,
} from '../sqlite-corruption-marker.js';

/**
 * station#3215. The marker is what lets Station stop re-asking "is this
 * corrupt?" on every boot: the session that OBSERVES corruption records it,
 * so a later start can act on that record instead of paying an O(size) check
 * to rediscover it. No such reader has merged yet (station#3217 is building
 * the first); today the file is operator diagnostics.
 */
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function dbPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'corruption-marker-'));
  roots.push(root);
  return join(root, 'orchestration.sqlite');
}

describe('a corruption observation survives the session that made it', () => {
  test('what is written is what the next session reads', () => {
    const path = dbPath();
    expect(
      recordCorruptionObserved({
        databasePath: path,
        observedAt: '2026-08-18T00:00:00.000Z',
        errcode: 11,
        detail: 'database disk image is malformed',
      }),
    ).toBe(true);

    const marker = readCorruptionMarker(path);
    // Canonical, not the literal string handed in — on macOS the temp root is
    // itself a symlink, which is exactly the case this is built to survive.
    expect(marker?.databasePath).toBe(
      join(realpathSync(dirname(path)), basename(path)),
    );
    expect(marker?.errcode).toBe(11);
  });

  test('the builder carries every field a SQLite error actually gave it', () => {
    // `table` had no assertion anywhere in the repo before station#3220's
    // review: deleting the spread that captures it left the whole suite green,
    // on the one field that is unrecoverable after the moment of observation
    // (the name exists only in the message text). The string below is the
    // exact wording SQLite emits, not an approximation of it.
    const error = Object.assign(new Error('vtable constructor failed: fts'), {
      errcode: 11,
      code: 'ERR_SQLITE_ERROR',
    });
    const marker = corruptionMarkerFromError(
      '/tmp/example/orchestration.sqlite',
      error,
      '2026-08-18T00:00:00.000Z',
    );
    expect(marker).toEqual({
      databasePath: '/tmp/example/orchestration.sqlite',
      observedAt: '2026-08-18T00:00:00.000Z',
      errcode: 11,
      detail: 'vtable constructor failed: fts',
      table: 'fts',
    });
  });

  test('the builder omits what the error did not name', () => {
    // station#3217 measured that four of five real fts5 corruption shapes
    // report the generic malformed message with NO table name. An ABSENT
    // `table` therefore means only that nothing named one — never that the
    // damage is outside a virtual table.
    const marker = corruptionMarkerFromError(
      '/tmp/example/orchestration.sqlite',
      Object.assign(new Error('database disk image is malformed'), {
        errcode: 11,
      }),
      '2026-08-18T00:00:00.000Z',
    );
    expect(marker.table).toBeUndefined();
    expect(marker.errcode).toBe(11);
  });

  test('the builder records a non-Error throw without inventing fields', () => {
    const marker = corruptionMarkerFromError(
      '/tmp/example/orchestration.sqlite',
      'not an error object',
      '2026-08-18T00:00:00.000Z',
    );
    expect(marker).toEqual({
      databasePath: '/tmp/example/orchestration.sqlite',
      observedAt: '2026-08-18T00:00:00.000Z',
    });
  });

  test('the FIRST observation wins', () => {
    // A later write would move the timestamp away from when the database
    // actually went bad, which is the one fact the marker exists to carry.
    const path = dbPath();
    recordCorruptionObserved({
      databasePath: path,
      observedAt: '2026-08-18T00:00:00.000Z',
      errcode: 11,
    });
    expect(
      recordCorruptionObserved({
        databasePath: path,
        observedAt: '2026-08-19T00:00:00.000Z',
        errcode: 26,
      }),
    ).toBe(false);

    expect(readCorruptionMarker(path)?.observedAt).toBe(
      '2026-08-18T00:00:00.000Z',
    );
  });

  test('no marker means no observation, not a missing file error', () => {
    expect(readCorruptionMarker(dbPath())).toBeNull();
  });

  test('a malformed marker reads as absent', () => {
    // It must NOT quarantine a database on the strength of an unreadable
    // file — that would turn a corrupt marker into a corrupt-database claim.
    const path = dbPath();
    writeFileSync(corruptionMarkerPath(path), '{ not json', 'utf8');
    expect(readCorruptionMarker(path)).toBeNull();

    // Each required field needs its own case: a marker missing BOTH is
    // rejected by whichever clause runs first, so it cannot prove the other
    // clause exists.
    writeFileSync(corruptionMarkerPath(path), '{"errcode":11}', 'utf8');
    expect(readCorruptionMarker(path)).toBeNull();

    writeFileSync(
      corruptionMarkerPath(path),
      JSON.stringify({ databasePath: path, errcode: 11 }),
      'utf8',
    );
    expect(readCorruptionMarker(path)).toBeNull();

    writeFileSync(
      corruptionMarkerPath(path),
      JSON.stringify({ observedAt: '2026-08-18T00:00:00.000Z' }),
      'utf8',
    );
    expect(readCorruptionMarker(path)).toBeNull();
  });

  test('clearing it lets a replaced database start clean', () => {
    const path = dbPath();
    recordCorruptionObserved({
      databasePath: path,
      observedAt: '2026-08-18T00:00:00.000Z',
    });
    clearCorruptionMarker(path);
    expect(readCorruptionMarker(path)).toBeNull();
  });

  test('it lands beside the database, not inside it', () => {
    // Anything living in the database it describes can be read neither before
    // that database opens nor while it is failing.
    const path = dbPath();
    recordCorruptionObserved({
      databasePath: path,
      observedAt: '2026-08-18T00:00:00.000Z',
    });
    expect(corruptionMarkerPath(path)).not.toBe(path);
    expect(readFileSync(corruptionMarkerPath(path), 'utf8')).toContain(
      'observedAt',
    );
  });

  test('an unwritable location fails quietly', () => {
    // The caller is mid-failure. A marker that cannot be written is a lost
    // diagnosis, never a reason to fail differently.
    expect(
      recordCorruptionObserved({
        databasePath: '/proc/definitely-not-writable/db.sqlite',
        observedAt: '2026-08-18T00:00:00.000Z',
      }),
    ).toBe(false);
  });

  test('a marker is not read as describing a DIFFERENT database', () => {
    // The marker is one per DIRECTORY. Without this check `databasePath` is a
    // field the type documents and nothing derives, and a second store in the
    // same directory would be condemned by its neighbour's damage.
    const root = mkdtempSync(join(tmpdir(), 'corruption-marker-'));
    roots.push(root);
    const damaged = join(root, 'orchestration.sqlite');
    const healthy = join(root, 'scheduler.sqlite');

    recordCorruptionObserved({
      databasePath: damaged,
      observedAt: '2026-08-18T00:00:00.000Z',
      errcode: 11,
    });

    expect(readCorruptionMarker(damaged)).not.toBeNull();
    expect(readCorruptionMarker(healthy)).toBeNull();
  });

  test('a different SPELLING of the same database finds the same marker', () => {
    // resolveHomeDir() returns STATION_HOME verbatim — no resolve, no tilde
    // expansion, no realpath — and that string reaches the store path through
    // a plain join. A launchd service on an absolute home and a desktop bundle
    // on a symlinked or relative one name the SAME file with different
    // strings, and the codebase explicitly supports both sharing a home.
    // Comparing raw would make one runtime's observation read as "no
    // corruption was ever observed" by the other, permanently.
    const base = mkdtempSync(join(tmpdir(), 'corruption-marker-'));
    roots.push(base);
    const real = join(base, 'home');
    mkdirSync(join(real, 'data'), { recursive: true });
    const canonical = join(real, 'data', 'orchestration.sqlite');

    const linked = join(base, 'link');
    symlinkSync(real, linked);
    const viaSymlink = join(linked, 'data', 'orchestration.sqlite');
    const viaDots = join(real, 'data', '..', 'data', 'orchestration.sqlite');

    recordCorruptionObserved({
      databasePath: canonical,
      observedAt: '2026-08-18T00:00:00.000Z',
      errcode: 11,
    });

    expect(readCorruptionMarker(viaSymlink)).not.toBeNull();
    expect(readCorruptionMarker(viaDots)).not.toBeNull();
    // And the neighbour check still holds, so this did not simply defeat it.
    expect(
      readCorruptionMarker(join(real, 'data', 'scheduler.sqlite')),
    ).toBeNull();
  });
});
