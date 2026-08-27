import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fsWindowsCompat from '../fs-windows-compat.js';
import {
  orchestrationStorePath,
  orchestrationStoreQuarantineNotice,
  quarantineOrchestrationStore,
  STATION_QUARANTINE_RECORD_FILE,
  type StationQuarantineRecord,
} from '../orchestration-store-quarantine.js';
import {
  corruptionMarkerPath,
  readCorruptionMarker,
  recordCorruptionObserved,
} from '../sqlite-corruption-marker.js';
import { createStationHomeBackup } from '../station-home-archive.js';
import { acquireStationHomeRuntimeLease } from '../station-home-lifecycle.js';
import { ensureStationHomeSchemaSync } from '../station-home-schema.js';

/**
 * station#3217. Every corruption case here is REAL damaged bytes on a real
 * SQLite file, driven through the real classifier — never a thrown fixture.
 * The one previous corruption fixture in this tree was a hand-mangled `errstr`
 * that a classifier keying on the wrong field passed anyway, and this decides
 * whether to move the user's whole history.
 *
 * The stores are opened in WAL, because that is what `EventStore` does at
 * `event-store.ts`'s `PRAGMA journal_mode = WAL`. A fixture in the default
 * journal mode cannot exercise the sibling handling at all: SQLite ignores a
 * stray `-wal` file outside WAL mode, so a hand-written one proves nothing
 * about the shape production actually leaves behind.
 */

const roots: string[] = [];
const SIBLINGS = ['-wal', '-shm'] as const;
const fsyncOriginal = fsWindowsCompat.fsyncDirectorySync;

afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});

function home(): string {
  const parent = mkdtempSync(join(tmpdir(), 'orchestration-quarantine-'));
  roots.push(parent);
  const homeDir = join(parent, 'home');
  ensureStationHomeSchemaSync(homeDir);
  mkdirSync(join(homeDir, 'data'), { recursive: true });
  return homeDir;
}

/** A store large enough that damage past the header lands in real b-tree pages. */
function seedStore(path: string): void {
  const database = new DatabaseSync(path);
  database.exec('PRAGMA journal_mode = WAL');
  database.exec(
    'CREATE TABLE IF NOT EXISTS orchestration_events (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)',
  );
  const insert = database.prepare(
    'INSERT INTO orchestration_events(payload) VALUES (?)',
  );
  for (let index = 0; index < 600; index += 1)
    insert.run(`payload ${index} ${'x'.repeat(400)}`);
  database.close();
}

/**
 * Leaves the three files a crashed Station leaves: a main database plus a WAL
 * holding committed frames that are in no other file.
 *
 * A second connection keeps the writer's close from checkpointing; the files
 * are snapshotted while the WAL is still hot and restored afterwards, so the
 * fixture has genuine hot-WAL bytes and no open handles.
 */
function seedStoreWithHotWal(path: string): number {
  seedStore(path);
  const holder = new DatabaseSync(path);
  holder.prepare('SELECT count(*) AS total FROM orchestration_events').get();
  const writer = new DatabaseSync(path);
  writer.exec('PRAGMA wal_autocheckpoint = 0');
  const insert = writer.prepare(
    'INSERT INTO orchestration_events(payload) VALUES (?)',
  );
  for (let index = 0; index < 50; index += 1) insert.run(`hot ${index}`);
  writer.close();

  const snapshots = new Map<string, string>();
  for (const suffix of ['', ...SIBLINGS]) {
    const source = `${path}${suffix}`;
    if (!existsSync(source)) continue;
    const snapshot = `${source}.fixture-snapshot`;
    copyFileSync(source, snapshot);
    snapshots.set(source, snapshot);
  }
  holder.close();
  for (const [source, snapshot] of snapshots) {
    copyFileSync(snapshot, source);
    rmSync(snapshot);
  }
  expect(statSync(`${path}-wal`).size).toBeGreaterThan(4096);
  return 650;
}

/** A throwaway copy of the damaged main file, outside the home so nothing
 * else in the fixture can see it. */
function probeCopy(path: string): string {
  const probe = mkdtempSync(join(tmpdir(), 'orchestration-quarantine-probe-'));
  roots.push(probe);
  const target = join(probe, 'orchestration.sqlite');
  copyFileSync(path, target);
  return target;
}

function damage(path: string): Buffer {
  const bytes = readFileSync(path);
  expect(bytes.byteLength).toBeGreaterThan(64 * 1024);
  bytes.fill(0x5a, 8192, Math.min(bytes.byteLength, 8192 + 32 * 1024));
  writeFileSync(path, bytes);
  return bytes;
}

/**
 * Written by the real recorder, from the error SQLite actually raises. A
 * hand-authored marker would prove only that this code reads its own JSON.
 */
function observeCorruption(path: string, probePath = path): void {
  // `probePath` exists because opening a damaged store READ-WRITE deletes a
  // hot WAL beside it (measured: 206,032 bytes to nothing). A fixture that
  // needs those bytes still standing when the quarantine runs takes its real
  // SQLite error from a copy, so the error is genuine and the fixture is
  // untouched — the alternative is hand-authoring the errcode, which is the
  // thrown-fixture habit these tests exist to avoid.
  const database = new DatabaseSync(probePath);
  let observed: unknown;
  try {
    database
      .prepare('SELECT count(*) AS total FROM orchestration_events')
      .get();
  } catch (error) {
    observed = error;
  }
  try {
    database.close();
  } catch {
    // A corrupt handle is allowed to fail on close.
  }
  expect(observed).toBeDefined();
  expect(
    recordCorruptionObserved({
      databasePath: path,
      observedAt: '2026-08-18T00:00:00.000Z',
      errcode: (observed as { errcode?: number }).errcode,
    }),
  ).toBe(true);
}

function corruptHome(): { homeDir: string; store: string; bytes: Buffer } {
  const homeDir = home();
  const store = orchestrationStorePath(homeDir);
  seedStore(store);
  const bytes = damage(store);
  observeCorruption(store);
  return { homeDir, store, bytes };
}

describe('quarantineOrchestrationStore', () => {
  it('moves a recorded-corrupt store into <home>/quarantine/<stamp>/ intact', () => {
    const { homeDir, store, bytes } = corruptHome();

    const renamed: string[] = [];
    const outcome = quarantineOrchestrationStore(homeDir, {
      now: () => new Date('2026-08-18T04:05:06.700Z'),
      afterRename: (name) => renamed.push(name),
    });

    expect(outcome.kind).toBe('quarantined');
    if (outcome.kind !== 'quarantined') return;
    expect(outcome.quarantineDir).toBe(
      join(homeDir, 'quarantine', '2026-08-18T04-05-06-700Z'),
    );
    // Siblings first, the store last — asserted at the rename sequence, which
    // is where the safety property lives. `files` is the archive manifest, a
    // different claim, and reading order off it proved the wrong thing.
    expect(renamed.at(-1)).toBe('orchestration.sqlite');

    // Never deleted, and never rewritten: byte-for-byte what was on disk.
    const quarantined = readFileSync(
      join(outcome.quarantineDir, 'orchestration.sqlite'),
    );
    expect(quarantined.equals(bytes)).toBe(true);

    // The path is free, so the next open creates a usable store rather than
    // reopening the malformed one.
    expect(existsSync(store)).toBe(false);
    const replacement = new DatabaseSync(store);
    replacement.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)');
    replacement.exec('INSERT INTO t(id) VALUES (1)');
    expect(replacement.prepare('SELECT count(*) AS c FROM t').get()).toEqual({
      c: 1,
    });
    replacement.close();

    // The observation is spent: it has been acted on, and leaving it would
    // quarantine the fresh replacement on the next boot.
    expect(readCorruptionMarker(store)).toBeNull();
  });

  it('records what it moved, and why, alongside the moved bytes', () => {
    const { homeDir } = corruptHome();

    const outcome = quarantineOrchestrationStore(homeDir);
    expect(outcome.kind).toBe('quarantined');
    if (outcome.kind !== 'quarantined') return;

    const record = JSON.parse(
      readFileSync(
        join(outcome.quarantineDir, STATION_QUARANTINE_RECORD_FILE),
        'utf8',
      ),
    ) as StationQuarantineRecord;
    expect(record.schemaVersion).toBe(
      'station.orchestration-store-quarantine/v1',
    );
    expect(record.disposition).toBe('store-moved');
    expect(record.files.map((file) => file.name)).toContain(
      'orchestration.sqlite',
    );
    expect(
      record.files.find((file) => file.name === 'orchestration.sqlite')
        ?.preexisting,
    ).toBe(true);
    if (outcome.kind === 'quarantined')
      expect(record.files).toEqual(outcome.files);
    expect(record.observation.observedAt).toBe('2026-08-18T00:00:00.000Z');
    expect([11, 26]).toContain(record.observation.errcode);
  });

  it('moves a hot WAL with the store, and moves it FIRST', () => {
    const homeDir = home();
    const store = orchestrationStorePath(homeDir);
    seedStoreWithHotWal(store);
    damage(store);
    observeCorruption(store, probeCopy(store));
    // Captured immediately before the call: the claim is that quarantine
    // preserves what was on disk when it ran, not what was there earlier.
    const walBytes = readFileSync(`${store}-wal`);
    expect(walBytes.byteLength).toBeGreaterThan(4096);

    const renamed: string[] = [];
    const outcome = quarantineOrchestrationStore(homeDir, {
      afterRename: (name) => renamed.push(name),
    });
    expect(outcome.kind).toBe('quarantined');
    if (outcome.kind !== 'quarantined') return;

    // The ORDER is the assertion. The main database goes last so that "the
    // store is gone" implies "its siblings are gone too" — see the
    // partial-quarantine case below for why.
    expect(renamed.at(-1)).toBe('orchestration.sqlite');
    // The set, not the sequence: only "the store goes last" is load-bearing,
    // and pinning the sibling order reds a reordering with no consequence.
    expect(new Set(renamed.slice(0, -1))).toEqual(
      new Set(['orchestration.sqlite-wal', 'orchestration.sqlite-shm']),
    );

    // Nothing is left behind to poison the store created next.
    for (const suffix of SIBLINGS)
      expect(existsSync(`${store}${suffix}`)).toBe(false);
    expect(
      readFileSync(
        join(outcome.quarantineDir, 'orchestration.sqlite-wal'),
      ).equals(walBytes),
    ).toBe(true);

    // The quarantined store cannot be QUERIED — it is corrupt, which is why it
    // is here. What matters is that the WAL's bytes survived the trip: 50
    // committed events exist in no other file, and a read-write corroboration
    // open would have deleted them outright (see `readStoreIntegrity`). They
    // are what a logical rebuild has to work from.
    expect(
      statSync(join(outcome.quarantineDir, 'orchestration.sqlite-wal')).size,
    ).toBe(walBytes.byteLength);
  });

  it('never leaves a sibling in data/ after the store it belongs to is gone', () => {
    // The crash window. Whatever is in `data/` when the process dies is what
    // the next boot sees, and an orphaned WAL beside a missing database is how
    // a brand-new store inherits somebody else's committed frames.
    const homeDir = home();
    const store = orchestrationStorePath(homeDir);
    seedStoreWithHotWal(store);
    damage(store);
    observeCorruption(store, probeCopy(store));

    const outcome = quarantineOrchestrationStore(homeDir, {
      afterRename: (name) => {
        if (name.endsWith('-wal')) throw new Error('stopped mid-quarantine');
      },
    });

    expect(outcome.kind).toBe('quarantine-failed');
    // The invariant: the store is still here, so nothing downstream can mistake
    // this for a home that has no orchestration data.
    expect(existsSync(store)).toBe(true);
    expect(existsSync(`${store}-wal`)).toBe(false);
    // And the record survived, so the next start finishes the job.
    expect(readCorruptionMarker(store)?.observedAt).toBe(
      '2026-08-18T00:00:00.000Z',
    );

    const retry = quarantineOrchestrationStore(homeDir);
    expect(retry.kind).toBe('quarantined');
    expect(existsSync(store)).toBe(false);
  });

  it('never reports a sibling it created as if it were the user\u2019s', () => {
    // The production sequence: EventStore's read-write open destroyed the WAL
    // one boot earlier, so the store carries a WAL-mode header with no `-wal`
    // beside it. Corroborating that store makes SQLite create an EMPTY one.
    // Archiving it as `orchestration.sqlite-wal` tells a rebuild tool
    // (station#3251) there were no uncheckpointed frames, when the truth is
    // that this code never saw them.
    const homeDir = home();
    const store = orchestrationStorePath(homeDir);
    seedStoreWithHotWal(store);
    damage(store);
    observeCorruption(store); // read-write, exactly as EventStore's boot is
    expect(existsSync(`${store}-wal`)).toBe(false);

    const outcome = quarantineOrchestrationStore(homeDir);
    expect(outcome.kind).toBe('quarantined');
    if (outcome.kind !== 'quarantined') return;

    // Unconditional. `if (wal) { ...assert... }` passes whether or not the
    // empty file is archived, which is no assertion at all: nothing this call
    // conjured may be sitting in the archive claiming to be the user's WAL.
    expect(
      outcome.files.filter((file) => !file.preexisting && file.bytes === 0),
    ).toEqual([]);
    expect(outcome.files.map((file) => file.name)).not.toContain(
      'orchestration.sqlite-wal',
    );
    const main = outcome.files.find((file) =>
      file.name.endsWith('orchestration.sqlite'),
    );
    expect(main?.preexisting).toBe(true);
    expect(main?.bytes).toBeGreaterThan(64 * 1024);

    const record = JSON.parse(
      readFileSync(
        join(outcome.quarantineDir, STATION_QUARANTINE_RECORD_FILE),
        'utf8',
      ),
    ) as StationQuarantineRecord;
    expect(record.files).toEqual(outcome.files);
  });

  it('finishes an interrupted move into the SAME directory', () => {
    // Otherwise the real 206KB WAL sits in an unlabelled directory while the
    // retry writes a manifest next door claiming a complete set. Neither
    // references the other, and the halves are never reunited.
    const homeDir = home();
    const store = orchestrationStorePath(homeDir);
    seedStoreWithHotWal(store);
    damage(store);
    observeCorruption(store, probeCopy(store));
    const walBytes = readFileSync(`${store}-wal`).byteLength;
    expect(walBytes).toBeGreaterThan(4096);

    const stopped = quarantineOrchestrationStore(homeDir, {
      afterRename: (name) => {
        if (name.endsWith('-wal')) throw new Error('stopped mid-quarantine');
      },
    });
    expect(stopped.kind).toBe('quarantine-failed');

    const retry = quarantineOrchestrationStore(homeDir);
    expect(retry.kind).toBe('quarantined');
    if (retry.kind !== 'quarantined') return;

    // One directory, holding both halves.
    expect(readdirSync(join(homeDir, 'quarantine'))).toHaveLength(1);
    expect(
      statSync(join(retry.quarantineDir, 'orchestration.sqlite-wal')).size,
    ).toBe(walBytes);
    expect(existsSync(join(retry.quarantineDir, 'orchestration.sqlite'))).toBe(
      true,
    );
    const record = JSON.parse(
      readFileSync(
        join(retry.quarantineDir, STATION_QUARANTINE_RECORD_FILE),
        'utf8',
      ),
    ) as StationQuarantineRecord;
    expect(record.files.map((file) => file.name).sort()).toEqual(
      readdirSync(retry.quarantineDir)
        .filter((name) => name !== STATION_QUARANTINE_RECORD_FILE)
        .sort(),
    );
  });

  it('tells the operator when a failed move had already moved something', () => {
    const homeDir = home();
    const store = orchestrationStorePath(homeDir);
    seedStoreWithHotWal(store);
    damage(store);
    observeCorruption(store, probeCopy(store));

    const stopped = quarantineOrchestrationStore(homeDir, {
      afterRename: (name) => {
        if (name.endsWith('-wal')) throw new Error('stopped mid-quarantine');
      },
    });
    expect(stopped.kind).toBe('quarantine-failed');
    if (stopped.kind !== 'quarantine-failed') return;

    expect(stopped.files.map((file) => file.name)).toEqual([
      'orchestration.sqlite-wal',
    ]);
    const notice = orchestrationStoreQuarantineNotice(stopped);
    // "could not be moved aside" alone is false here: a file already moved.
    expect(notice).toContain(stopped.quarantineDir as string);
    expect(notice).toMatch(/already moved/);
  });

  it('does not go silent when a crash moved everything before the record', () => {
    // The last rename succeeded, so `data/` has no store and the next boot
    // used to take the silent `store-absent` path — leaving 61MB in an
    // unlabelled directory that nothing ever mentioned again.
    const { homeDir, store } = corruptHome();

    const stopped = quarantineOrchestrationStore(homeDir, {
      afterRename: (name) => {
        if (name === 'orchestration.sqlite')
          throw new Error('stopped after the last rename');
      },
    });
    expect(stopped.kind).toBe('quarantine-failed');
    expect(existsSync(store)).toBe(false);

    const next = quarantineOrchestrationStore(homeDir);
    expect(next.kind).toBe('quarantined');
    if (next.kind !== 'quarantined') return;

    // Completed, recorded, and reportable — not 'store-absent' with no notice.
    expect(
      existsSync(join(next.quarantineDir, STATION_QUARANTINE_RECORD_FILE)),
    ).toBe(true);
    expect(
      next.files.some((file) => file.name === 'orchestration.sqlite'),
    ).toBe(true);
    expect(orchestrationStoreQuarantineNotice(next)).toContain(
      next.quarantineDir,
    );
    expect(readCorruptionMarker(store)).toBeNull();
  });

  it('does not overwrite an earlier quarantine taken in the same instant', () => {
    const { homeDir, store } = corruptHome();
    const now = () => new Date('2026-08-18T04:05:06.700Z');

    const first = quarantineOrchestrationStore(homeDir, { now });
    expect(first.kind).toBe('quarantined');

    seedStore(store);
    const secondBytes = damage(store);
    observeCorruption(store);
    const second = quarantineOrchestrationStore(homeDir, { now });

    expect(second.kind).toBe('quarantined');
    if (first.kind !== 'quarantined' || second.kind !== 'quarantined') return;
    expect(second.quarantineDir).not.toBe(first.quarantineDir);
    expect(second.quarantineDir).toBe(
      join(homeDir, 'quarantine', '2026-08-18T04-05-06-700Z-1'),
    );
    expect(
      readFileSync(join(second.quarantineDir, 'orchestration.sqlite')).equals(
        secondBytes,
      ),
    ).toBe(true);
  });

  it('makes the moves durable BEFORE it removes the record of why', () => {
    // Ordering, not decoration. Between the renames and their fsyncs the moves
    // exist only in page cache; unlink the marker inside that window and a
    // power loss can leave the durable unlink beside the lost renames — a
    // corrupt store back in `data/` with nothing left to say so, which is the
    // original bug restored. The barrier has to be crossed while the record
    // still exists.
    const { homeDir, store } = corruptHome();
    const barriers: Array<{ path: string; markerPresent: boolean }> = [];
    // Scoped to this test and restored immediately: a spy left installed
    // across the file would silently stop every other case from fsyncing.
    const fsync = vi
      .spyOn(fsWindowsCompat, 'fsyncDirectorySync')
      .mockImplementation((path) => {
        barriers.push({
          path,
          markerPresent: existsSync(corruptionMarkerPath(store)),
        });
        fsyncOriginal(path);
      });

    let quarantineDir: string | undefined;
    try {
      const outcome = quarantineOrchestrationStore(homeDir);
      expect(outcome.kind).toBe('quarantined');
      if (outcome.kind === 'quarantined') quarantineDir = outcome.quarantineDir;
    } finally {
      fsync.mockRestore();
    }

    // Named call SITES, not "some fsyncs happened". Counting barriers is not
    // enough: `writeJsonDurably` fsyncs the record's own directory, so a
    // version with all three barriers DELETED still produced two entries here
    // and passed — the test proved ordering relative to whatever fsyncs
    // happened to occur, not that the barrier exists.
    const before = barriers
      .filter((entry) => entry.markerPresent)
      .map((entry) => entry.path);
    expect(before).toContain(quarantineDir);
    expect(before).toContain(join(homeDir, 'quarantine'));
    expect(before).toContain(join(homeDir, 'data'));

    // And the unlink happened after all of them.
    expect(barriers.at(-1)?.markerPresent).toBe(false);
    expect(readCorruptionMarker(store)).toBeNull();
  });

  it('does not turn contended home coordination into a failed boot', () => {
    // The whole point of this branch is that a corrupt store must not brick
    // the boot. Letting a lifecycle failure out of here would brick it in a
    // new way, from the one call site that runs before anything can catch it.
    const { homeDir, store, bytes } = corruptHome();
    const peer = acquireStationHomeRuntimeLease(homeDir);

    try {
      const outcome = quarantineOrchestrationStore(homeDir, {
        lifecycleHooks: {
          processIdentity: {
            alive: () => {
              throw new Error('process identity is unavailable');
            },
            lookup: () => 'unused',
          },
        },
      });
      expect(outcome.kind).toBe('home-lifecycle-unavailable');
    } finally {
      peer.release();
    }

    expect(existsSync(join(homeDir, 'quarantine'))).toBe(false);
    expect(readFileSync(store).equals(bytes)).toBe(true);
    expect(readCorruptionMarker(store)?.observedAt).toBe(
      '2026-08-18T00:00:00.000Z',
    );
  });

  it('refuses to move the store through a symlinked quarantine root', () => {
    // `station-home-archive` fails hard on any symlink in the home; this root
    // did not exist when it made that rule, and a symlinked `quarantine/`
    // would redirect the renames out of the home entirely.
    const { homeDir, store, bytes } = corruptHome();
    const elsewhere = mkdtempSync(join(tmpdir(), 'quarantine-elsewhere-'));
    roots.push(elsewhere);
    symlinkSync(elsewhere, join(homeDir, 'quarantine'));

    const outcome = quarantineOrchestrationStore(homeDir);

    expect(outcome.kind).toBe('quarantine-failed');
    // Nothing was written through the link, and the store is untouched.
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(readFileSync(store).equals(bytes)).toBe(true);
    expect(readCorruptionMarker(store)?.observedAt).toBe(
      '2026-08-18T00:00:00.000Z',
    );
  });

  it('leaves a home with no recorded corruption completely alone', () => {
    const homeDir = home();
    const store = orchestrationStorePath(homeDir);
    seedStore(store);
    const before = readFileSync(store);

    expect(quarantineOrchestrationStore(homeDir)).toEqual({
      kind: 'no-marker',
    });

    expect(existsSync(join(homeDir, 'quarantine'))).toBe(false);
    expect(readFileSync(store).equals(before)).toBe(true);
  });

  it('refuses to quarantine a store the bytes say is healthy, and keeps the observation', () => {
    // The guard that decides this is derived, not declared: a marker is a
    // report about a moment, and moving 61MB of history has to be authorised
    // by SQLite looking at the file NOW. Without this, a stale marker razes a
    // perfectly good store.
    const homeDir = home();
    const store = orchestrationStorePath(homeDir);
    seedStore(store);
    const before = readFileSync(store);
    expect(
      recordCorruptionObserved({
        databasePath: store,
        observedAt: '2026-08-18T00:00:00.000Z',
        errcode: 11,
      }),
    ).toBe(true);

    const outcome = quarantineOrchestrationStore(homeDir);
    expect(outcome.kind).toBe('store-healthy');
    if (outcome.kind !== 'store-healthy') return;

    // The store never moved.
    expect(readFileSync(store).equals(before)).toBe(true);
    // Cleared, or every future boot re-runs a whole-file check to re-answer a
    // question the bytes already answered — but not DISCARDED. The observation
    // is filed before the marker goes.
    expect(readCorruptionMarker(store)).toBeNull();
    expect(outcome.recordDir).toBeDefined();
    const record = JSON.parse(
      readFileSync(
        join(outcome.recordDir as string, STATION_QUARANTINE_RECORD_FILE),
        'utf8',
      ),
    ) as StationQuarantineRecord;
    expect(record.disposition).toBe('store-read-clean');
    expect(record.files).toEqual([]);
    expect(record.observation.observedAt).toBe('2026-08-18T00:00:00.000Z');
  });

  it('skips the quarantine while a peer runtime holds the home, and keeps the marker', () => {
    const { homeDir, store, bytes } = corruptHome();
    const peer = acquireStationHomeRuntimeLease(homeDir);

    try {
      const blocked = quarantineOrchestrationStore(homeDir);
      expect(blocked.kind).toBe('home-active');
    } finally {
      peer.release();
    }

    expect(existsSync(join(homeDir, 'quarantine'))).toBe(false);
    expect(readFileSync(store).equals(bytes)).toBe(true);
    // The observation has to outlive this start: the peer may be mid-write,
    // and whichever start gets the home to itself still has to act on it.
    const kept = readCorruptionMarker(store);
    expect(kept?.observedAt).toBe('2026-08-18T00:00:00.000Z');

    // And once the peer is gone, the same call does the work.
    const outcome = quarantineOrchestrationStore(homeDir);
    expect(outcome.kind).toBe('quarantined');
  });

  it('will not delete another runtime’s observation just because the store reads clean', () => {
    // The lease is not only the move's precondition. Clearing the marker is a
    // mutation of a shared home too, and a peer that recorded corruption one
    // second ago must not have its record deleted by a boot whose check
    // happened to pass over the fault.
    const homeDir = home();
    const store = orchestrationStorePath(homeDir);
    seedStore(store);
    recordCorruptionObserved({
      databasePath: store,
      observedAt: '2026-08-18T00:00:00.000Z',
      errcode: 11,
    });
    const peer = acquireStationHomeRuntimeLease(homeDir);

    try {
      expect(quarantineOrchestrationStore(homeDir).kind).toBe('home-active');
    } finally {
      peer.release();
    }

    expect(readCorruptionMarker(store)?.observedAt).toBe(
      '2026-08-18T00:00:00.000Z',
    );
  });

  it('will not forget an observation for an absent store while a peer holds the home', () => {
    const { homeDir, store } = corruptHome();
    rmSync(store);
    const peer = acquireStationHomeRuntimeLease(homeDir);

    try {
      expect(quarantineOrchestrationStore(homeDir).kind).toBe('home-active');
    } finally {
      peer.release();
    }

    expect(readCorruptionMarker(store)?.observedAt).toBe(
      '2026-08-18T00:00:00.000Z',
    );
  });

  it('will not move a store it could not read a verdict from', () => {
    // "I could not look" is not a verdict, and must never authorise moving the
    // user's history. The fixture is an unopenable path standing in for any
    // store SQLite cannot get a completed answer out of — a permissions
    // failure, an I/O error, a busy device.
    const homeDir = home();
    const store = orchestrationStorePath(homeDir);
    mkdirSync(store);
    expect(
      recordCorruptionObserved({
        databasePath: store,
        observedAt: '2026-08-18T00:00:00.000Z',
        errcode: 11,
      }),
    ).toBe(true);

    const outcome = quarantineOrchestrationStore(homeDir);
    expect(outcome.kind).toBe('store-unreadable');

    expect(existsSync(join(homeDir, 'quarantine'))).toBe(false);
    expect(existsSync(store)).toBe(true);
    // Kept: the question is still open, so the record still has work to do.
    expect(readCorruptionMarker(store)?.observedAt).toBe(
      '2026-08-18T00:00:00.000Z',
    );
  });

  it('a marker describing some other database moves nothing', () => {
    const { homeDir, store, bytes } = corruptHome();
    const marker = JSON.parse(
      readFileSync(corruptionMarkerPath(store), 'utf8'),
    );
    writeFileSync(
      corruptionMarkerPath(store),
      JSON.stringify({
        ...marker,
        databasePath: join(homeDir, 'elsewhere.db'),
      }),
    );

    // A foreign marker reads as ABSENT: readCorruptionMarker is the one
    // authorization predicate, and it refuses to answer for a different
    // database. The file stays on disk (nothing here may clear an
    // observation it cannot read), and nothing is moved.
    expect(quarantineOrchestrationStore(homeDir).kind).toBe('no-marker');
    expect(existsSync(join(homeDir, 'quarantine'))).toBe(false);
    expect(readFileSync(store).equals(bytes)).toBe(true);
  });

  it('forgets a marker whose database is already gone', () => {
    const { homeDir, store } = corruptHome();
    rmSync(store);

    expect(quarantineOrchestrationStore(homeDir).kind).toBe('store-absent');
    expect(existsSync(join(homeDir, 'quarantine'))).toBe(false);
    expect(readCorruptionMarker(store)).toBeNull();
  });

  it('keeps a quarantined corpse out of every future backup', () => {
    const { homeDir } = corruptHome();
    const outcome = quarantineOrchestrationStore(homeDir);
    expect(outcome.kind).toBe('quarantined');

    const backup = createStationHomeBackup({
      homeDir,
      outputDir: join(homeDir, '..', 'backup'),
    });

    // Asserted against the MANIFEST the backup actually produced, not against
    // the transient-roots table: a set membership test would still pass if
    // `isTransient` stopped consulting it.
    const quarantineEntries = backup.manifest.files.filter((file) =>
      file.path.includes('quarantine'),
    );
    expect(quarantineEntries).toEqual([]);
    expect(existsSync(join(backup.backupDir, 'home', 'quarantine'))).toBe(
      false,
    );
    // The backup is not empty for some unrelated reason.
    expect(backup.manifest.files.length).toBeGreaterThan(0);
  });

  it('tells the operator where the bytes went and how to get history back', () => {
    const notice = orchestrationStoreQuarantineNotice({
      kind: 'quarantined',
      quarantineDir: '/home/quarantine/2026-08-18T04-05-06-700Z',
      files: [{ name: 'orchestration.sqlite', bytes: 4096, preexisting: true }],
      marker: {
        databasePath: '/home/data/orchestration.sqlite',
        observedAt: '2026-08-18T00:00:00.000Z',
      },
    });
    expect(notice).toContain('/home/quarantine/2026-08-18T04-05-06-700Z');
    expect(notice).toContain('station home restore');
    // The quarantine holds raw database files, not a manifest-bearing backup;
    // pointing `--from` at it would be an instruction that cannot work.
    expect(notice).not.toContain(
      '--from=/home/quarantine/2026-08-18T04-05-06-700Z',
    );
  });

  it('says something for every outcome that precedes a boot failure', () => {
    // `home-active` and `store-unreadable` are followed by the store failing
    // to open. Silence there leaves the operator reading the pre-branch error
    // with no way to tell whether the quarantine ran, declined, or could not
    // look.
    const marker = {
      databasePath: '/home/data/orchestration.sqlite',
      observedAt: '2026-08-18T00:00:00.000Z',
    };
    expect(
      orchestrationStoreQuarantineNotice({ kind: 'home-active', marker }),
    ).toMatch(/another Station runtime holds this home/);
    expect(
      orchestrationStoreQuarantineNotice({
        kind: 'store-unreadable',
        marker,
        cause: new Error('nope'),
      }),
    ).toMatch(/could not be read to confirm it/);
    expect(
      orchestrationStoreQuarantineNotice({
        kind: 'quarantine-failed',
        marker,
        files: [],
        cause: new Error('nope'),
      }),
    ).toMatch(/could not be fully moved aside/);
    // And nothing for the states that are not the operator's business.
    expect(
      orchestrationStoreQuarantineNotice({ kind: 'no-marker' }),
    ).toBeUndefined();
    expect(
      orchestrationStoreQuarantineNotice({ kind: 'store-healthy', marker }),
    ).toBeUndefined();
  });

  it('resolves the store under data/, which is what the runtime opens', () => {
    // Pinned to the literal rather than to another function that now returns
    // this one: comparing two spellings that are the same expression cannot
    // fail, and the point of collapsing them was that the literal is stated
    // once.
    const homeDir = home();
    expect(orchestrationStorePath(homeDir)).toBe(
      join(homeDir, 'data', 'orchestration.sqlite'),
    );
  });
});
