import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  type Stats,
  statSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { writeJsonDurably } from './durable-json-file.js';
import { fsyncDirectorySync } from './fs-windows-compat.js';
import {
  clearCorruptionMarker,
  readCorruptionMarker,
  type SqliteCorruptionMarker,
} from './sqlite-corruption-marker.js';
import { checkSqliteIntegrity } from './sqlite-integrity.js';
import {
  acquireStationHomeMaintenanceLease,
  StationHomeActiveError,
  type StationHomeLifecycleHooks,
} from './station-home-lifecycle.js';

/**
 * The consumer of the corruption marker (station#3217).
 *
 * station#3215 gave a session that SEES corruption a way to record it. Nothing
 * read that record: the next start found a database SQLite had already
 * declared malformed, failed its own integrity gate, and refused to boot —
 * every time, forever, until an operator moved the file by hand. This is the
 * side that acts on the record.
 *
 * The policy is archive-by-rename, copied from `homeReset`
 * (`packages/cli/src/commands/lifecycle.ts`): the store is MOVED aside, never
 * deleted, and the path it moved to is reported so the operator can hand it to
 * a recovery tool. Losing a corrupt database is still losing the user's
 * history; the only thing Station is entitled to do unattended is stop
 * standing on it.
 *
 * What it deliberately does NOT do is repair a torn fts5 search index in
 * place. The marker's `table` field looks like it should route that, and it
 * cannot: `DROP TABLE`, `ALTER TABLE … RENAME`, and `INSERT INTO t(t)
 * VALUES('rebuild')` all raise SQLITE_CORRUPT on a damaged fts5 index, and
 * `PRAGMA writable_schema` is inert because `node:sqlite` runs with
 * SQLITE_DBCONFIG_DEFENSIVE. The one damage shape that names a table in the
 * error text (a corrupt `%_config` shadow table) is also the only one where
 * even the rename fails — the routing key is populated exactly and only where
 * no in-place remedy exists. Preserving history for that case needs a logical
 * rebuild into a fresh database, which is station#3251, not this file.
 */

// The store's location is defined ONCE, in `sqlite-store-integrity.ts` —
// the quarantine, the boot check, the CLI, and the migration all have to find
// the same file, and a second spelling of `data/orchestration.sqlite` is a
// quarantine that silently stops matching the store the day either side moves
// (this merge resolved exactly that: two branches each extracted their own
// copy). Re-exported so existing importers of this module keep working.
import { orchestrationStorePath } from './sqlite-store-integrity.js';

export { orchestrationStorePath };

/**
 * Deliberately `<home>/quarantine/`, not `<home>/data/quarantine/`.
 *
 * `isTransient` in `station-home-archive.ts` only inspects `segments[0]`, so a
 * quarantine nested under `data/` would be copied into every future backup —
 * an archived corpse riding along in each one. `TRANSIENT_ROOTS` carries
 * `'quarantine'` for exactly this reason; the two must stay in step.
 */
export const STATION_HOME_QUARANTINE_DIRECTORY = 'quarantine';

/**
 * And deliberately a DIRECTORY per disposition rather than a suffixed flat
 * file.
 *
 * `collectFiles` refuses to back up any `*.sqlite` that fails its health
 * check, but that test is `entry.name.endsWith('.sqlite')`. A file named
 * `orchestration.sqlite.corrupt-<stamp>` does not end in `.sqlite`, so it
 * would slip past the check and be copied into the backup silently.
 */
export const STATION_QUARANTINE_RECORD_FILE = 'quarantine.json';
export const STATION_QUARANTINE_RECORD_SCHEMA =
  'station.orchestration-store-quarantine/v1' as const;

/**
 * `-journal` is included even though Station runs WAL: a home written by an
 * older build, or one whose `PRAGMA journal_mode = WAL` lost the race at open,
 * can still have one, and leaving a rollback journal behind next to a
 * newly-created database is how a fresh store inherits someone else's bytes.
 */
const SQLITE_SIBLING_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

export type StationQuarantineDisposition =
  /** The store was corrupt and its files were moved here. */
  | 'store-moved'
  /** The store read clean; only the superseded observation is kept here. */
  | 'store-read-clean';

export interface StationQuarantineFile {
  name: string;
  bytes: number;
  /**
   * False for a file this quarantine's own integrity check caused SQLite to
   * create, rather than one it found.
   *
   * It exists because a bare name is a claim about the user's data that this
   * function is not always entitled to make. Corroborating a WAL-mode store
   * whose `-wal` is already gone makes SQLite create an empty one; archiving
   * that under `orchestration.sqlite-wal` tells a rebuild tool (station#3251)
   * there were no uncheckpointed frames, when the truth is that nobody here
   * knows.
   */
  preexisting: boolean;
}

export interface StationQuarantineRecord {
  schemaVersion: typeof STATION_QUARANTINE_RECORD_SCHEMA;
  disposition: StationQuarantineDisposition;
  quarantinedAt: string;
  files: StationQuarantineFile[];
  /** Set when this directory finishes a move an earlier start began. */
  continuedFrom?: string;
  observation: SqliteCorruptionMarker;
}

export type OrchestrationStoreQuarantineOutcome =
  /** No previous session recorded corruption here. The ordinary boot. */
  | { kind: 'no-marker' }
  /** A marker naming some other database; not ours to act on. */
  /** A peer runtime holds this home; nothing here may touch it. */
  | { kind: 'home-active'; marker: SqliteCorruptionMarker }
  /** Home coordination itself was unavailable (lock contention, no identity). */
  | {
      kind: 'home-lifecycle-unavailable';
      marker: SqliteCorruptionMarker;
      cause: unknown;
    }
  /** The marker outlived the file it describes. */
  | { kind: 'store-absent'; marker: SqliteCorruptionMarker }
  /** The bytes disagree with the record: the store reads clean. */
  | {
      kind: 'store-healthy';
      marker: SqliteCorruptionMarker;
      recordDir?: string;
    }
  /** The check could not be run, so no verdict was reached. */
  | { kind: 'store-unreadable'; marker: SqliteCorruptionMarker; cause: unknown }
  /**
   * The move failed part-way. The marker survives so the next start retries —
   * but files may ALREADY have moved, which the operator has to be told.
   */
  | {
      kind: 'quarantine-failed';
      marker: SqliteCorruptionMarker;
      quarantineDir?: string;
      files: StationQuarantineFile[];
      cause: unknown;
    }
  | {
      kind: 'quarantined';
      quarantineDir: string;
      files: StationQuarantineFile[];
      marker: SqliteCorruptionMarker;
    };

export interface QuarantineOrchestrationStoreOptions {
  now?: () => Date;
  lifecycleHooks?: StationHomeLifecycleHooks;
  /**
   * Private fault seam: called after each file is renamed into the quarantine,
   * so a test can stop the process mid-move and assert what `data/` looks like
   * to the next boot.
   */
  afterRename?: (name: string) => void;
}

/**
 * Ask the bytes, not the record.
 *
 * The marker says a query once raised SQLITE_CORRUPT. That is a report about a
 * moment, and this function is about to move 61MB of somebody's history on the
 * strength of it, so the record alone is not enough: a stale or mistaken
 * marker would otherwise be sufficient cause. Only a completed `corrupt`
 * verdict — SQLite looking at the file now and saying it is malformed —
 * authorises the rename. "I could not look" is not a verdict and must never
 * authorise one.
 */
function readStoreIntegrity(
  databasePath: string,
): ReturnType<typeof checkSqliteIntegrity> {
  let database: InstanceType<typeof DatabaseSync> | undefined;
  try {
    // Read-only, and it is worth being exact about which case that saves.
    //
    // Measured A/B on one damaged store carrying a 206,032-byte hot WAL — 50
    // events in no other file. Read-write open, failed query, close: main file
    // 282,624 bytes unchanged, `-wal` GONE, `-shm` gone. Read-only: `-wal`
    // still 206,032 bytes. The frames are not checkpointed into the main
    // database first — the checkpoint fails on the damage — so a read-write
    // open simply deletes them.
    //
    // But on the path that actually produces a marker today, they are already
    // gone before this runs: `EventStore`'s constructor opens READ-WRITE, and
    // its integrity throw closes that handle, which is the same close measured
    // above (station#3215's lane owns that). So what this buys is the
    // remaining sub-case — a store whose marker was written and whose process
    // died before any read-write close, e.g. SIGKILL — plus not adding a
    // second deletion of our own. Defence in depth, not the whole defence.
    //
    // It is also why `preexisting` exists: opening a WAL-mode store whose
    // `-wal` is gone makes SQLite create an empty one right here, and
    // archiving that as if it were the user's WAL is a lie to station#3251.
    database = new DatabaseSync(databasePath, {
      readOnly: true,
      timeout: 5_000,
    });
    return checkSqliteIntegrity(database);
  } catch (error) {
    return { kind: 'unavailable', cause: error };
  } finally {
    try {
      database?.close();
    } catch {
      // The verdict above is the product; a close failure cannot improve it.
    }
  }
}

function quarantineRootPath(homeDir: string): string {
  const root = join(homeDir, STATION_HOME_QUARANTINE_DIRECTORY);
  // `station-home-archive` refuses to walk a home containing any symlink; this
  // root is the one place in the home that did not exist when it made that
  // rule, and a symlinked `quarantine/` would redirect these renames out of
  // the home entirely. Same-user threat model, one lstat.
  const existing = lstatIfPresent(root);
  if (existing?.isSymbolicLink())
    throw new Error(
      `Station home quarantine directory is a symbolic link: ${root}`,
    );
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function lstatIfPresent(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/** homeReset's collision handling: two dispositions in the same millisecond
 * must not overwrite one another, and the second one losing its bytes is the
 * failure this loop exists to prevent. */
function createDispositionDirectory(homeDir: string, stamp: string): string {
  const root = quarantineRootPath(homeDir);
  let directory = join(root, stamp);
  for (let suffix = 1; existsSync(directory); suffix += 1)
    directory = join(root, `${stamp}-${suffix}`);
  mkdirSync(directory, { mode: 0o700 });
  return directory;
}

/**
 * A disposition directory an earlier start began and never finished.
 *
 * "Unfinished" is derivable rather than remembered: the record is the last
 * thing written, so a directory without one is a move that stopped part-way.
 * Finding it is what keeps a retry from splitting one store across two
 * directories, with the real `-wal` in an unlabelled one and a manifest in the
 * other claiming a complete set.
 */
function findIncompleteDisposition(homeDir: string): string | undefined {
  const root = join(homeDir, STATION_HOME_QUARANTINE_DIRECTORY);
  if (!existsSync(root)) return undefined;
  const candidates = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => join(root, entry.name))
    .filter((path) => !existsSync(join(path, STATION_QUARANTINE_RECORD_FILE)))
    // Stamps sort chronologically, so the newest incomplete one is the one
    // this start is continuing.
    .sort();
  return candidates.at(-1);
}

function describeQuarantinedFile(
  directory: string,
  name: string,
  preexisting: boolean,
): StationQuarantineFile {
  let bytes = 0;
  try {
    bytes = statSync(join(directory, name)).size;
  } catch {
    // A size we cannot read is reported as 0 rather than failing the move.
  }
  return { name, bytes, preexisting };
}

function writeDispositionRecord(
  directory: string,
  record: StationQuarantineRecord,
): void {
  writeJsonDurably(join(directory, STATION_QUARANTINE_RECORD_FILE), record);
}

/**
 * Moves a store a previous session recorded as corrupt out of the way, so the
 * next open creates a usable one, and reports where it went.
 *
 * Call this BEFORE `acquireStationHomeRuntimeLease`. Every path that touches
 * the home — including the two that only clear the marker — runs under the
 * maintenance lease, which proves no runtime holds this home, and this
 * process's own runtime lease would be the counterexample that defeats it.
 */
export function quarantineOrchestrationStore(
  homeDir: string,
  options: QuarantineOrchestrationStoreOptions = {},
): OrchestrationStoreQuarantineOutcome {
  const databasePath = orchestrationStorePath(homeDir);
  // readCorruptionMarker IS the authorization predicate: it refuses a marker
  // describing a different database, comparing CANONICAL paths (the marker
  // stores realpath-resolved spellings so two runtimes naming one home
  // differently still recognise each other's observation). This function used
  // to re-derive that comparison with a bare resolve(), which broke the
  // moment the stored form became canonical — on macOS the temp root is a
  // symlink, so the re-check read every legitimate marker as foreign. A
  // second copy of an authorization predicate is a second chance to get it
  // wrong; consume the one that exists (station#3215/#3217 merge).
  const marker = readCorruptionMarker(databasePath);
  if (!marker) return { kind: 'no-marker' };

  let lease: { release(): void };
  try {
    lease = acquireStationHomeMaintenanceLease(homeDir, options.lifecycleHooks);
  } catch (error) {
    // A peer runtime is live, or home coordination is unavailable. Either way
    // KEEP the marker: the peer may be mid-write, and the observation must
    // survive to be acted on by whichever start finds the home to itself.
    //
    // Neither case may propagate. This exists so a corrupt store does not
    // brick the boot, and failing the constructor because a 10-second file
    // mutation lock was contended would do exactly that in a new way.
    if (error instanceof StationHomeActiveError)
      return { kind: 'home-active', marker };
    return { kind: 'home-lifecycle-unavailable', marker, cause: error };
  }

  try {
    const dataDir = dirname(databasePath);
    const now = options.now?.() ?? new Date();
    const stamp = now.toISOString().replace(/[:.]/g, '-');

    if (!existsSync(databasePath)) {
      // The store may be absent because a PREVIOUS start moved it and died
      // before writing the record. Finishing that is the difference between
      // telling the user where their 61MB went and never mentioning it again:
      // the old code cleared the marker here and returned a silent outcome
      // while the data sat in an unlabelled directory.
      const incomplete = findIncompleteDisposition(homeDir);
      if (incomplete) {
        const files = readdirSync(incomplete).map((name) =>
          describeQuarantinedFile(incomplete, name, true),
        );
        writeDispositionRecord(incomplete, {
          schemaVersion: STATION_QUARANTINE_RECORD_SCHEMA,
          disposition: 'store-moved',
          quarantinedAt: now.toISOString(),
          files,
          observation: marker,
        });
        fsyncDirectorySync(incomplete);
        clearCorruptionMarker(databasePath);
        fsyncDirectorySync(dataDir);
        return {
          kind: 'quarantined',
          quarantineDir: incomplete,
          files,
          marker,
        };
      }
      clearCorruptionMarker(databasePath);
      fsyncDirectorySync(dataDir);
      return { kind: 'store-absent', marker };
    }

    // Snapshot BEFORE the corroboration open. Opening a WAL-mode store whose
    // `-wal` has already been removed makes SQLite create an empty one, and a
    // sibling that exists only because we looked is not the user's data.
    const preexistingSiblings = new Set(
      SQLITE_SIBLING_SUFFIXES.filter((suffix) =>
        existsSync(`${databasePath}${suffix}`),
      ),
    );

    const integrity = readStoreIntegrity(databasePath);

    // Undo this check's own side effect before deciding anything.
    //
    // Opening a WAL-mode store whose `-wal` is gone makes SQLite create an
    // empty one. Left in place it does three kinds of damage: it is archived
    // as though it were the user's WAL, it collides with the REAL `-wal` when
    // a retry continues an interrupted move, and it is an orphan beside a
    // fresh store if it is not moved. Removing a zero-length file that did not
    // exist a moment ago is not deleting anybody's data — it is putting the
    // directory back the way we found it. The predicate is deliberately narrow:
    // anything with bytes in it, or anything that was already there, is left
    // alone and archived.
    for (const suffix of SQLITE_SIBLING_SUFFIXES) {
      if (preexistingSiblings.has(suffix)) continue;
      const path = `${databasePath}${suffix}`;
      try {
        if (existsSync(path) && statSync(path).size === 0) rmSync(path);
      } catch {
        // It stays and is archived with `preexisting: false`, which is still
        // truthful. This is tidiness, not correctness.
      }
    }

    if (integrity.kind === 'unavailable')
      return { kind: 'store-unreadable', marker, cause: integrity.cause };

    if (integrity.kind === 'ok') {
      // Clearing is deliberate: keeping the marker would make every future
      // boot re-run `PRAGMA quick_check` at O(database size) — the exact cost
      // station#3215 removed — to re-answer a question the bytes have already
      // answered. But clearing is not the same as discarding, so the
      // superseded observation is written out first. The watch is still
      // installed, so a real failure records itself again immediately.
      let recordDir: string | undefined;
      try {
        recordDir = createDispositionDirectory(homeDir, stamp);
        writeDispositionRecord(recordDir, {
          schemaVersion: STATION_QUARANTINE_RECORD_SCHEMA,
          disposition: 'store-read-clean',
          quarantinedAt: now.toISOString(),
          files: [],
          observation: marker,
        });
      } catch {
        // Best-effort evidence. Failing to file it is not a reason to keep
        // re-checking the store forever.
        recordDir = undefined;
      }
      clearCorruptionMarker(databasePath);
      fsyncDirectorySync(dataDir);
      return { kind: 'store-healthy', marker, recordDir };
    }

    let quarantineDir: string | undefined;
    // What THIS call moved, in rename order. The record below describes the
    // whole directory instead; the two are different claims and conflating
    // them made a continued move's manifest undercount its own archive.
    const movedNow: StationQuarantineFile[] = [];
    let files: StationQuarantineFile[] = [];
    try {
      // Continue an unfinished move rather than starting a second directory,
      // unless doing so would collide with a name already archived there.
      const incomplete = findIncompleteDisposition(homeDir);
      const collides =
        incomplete !== undefined &&
        SQLITE_SIBLING_SUFFIXES.some(
          (suffix) =>
            existsSync(`${databasePath}${suffix}`) &&
            existsSync(join(incomplete, basename(`${databasePath}${suffix}`))),
        );
      const continuedFrom =
        incomplete && collides ? basename(incomplete) : undefined;
      const directory =
        incomplete && !collides
          ? incomplete
          : createDispositionDirectory(homeDir, stamp);
      quarantineDir = directory;

      // Siblings FIRST, the main database LAST, and the order is load-bearing.
      //
      // Stop the process between two renames and whatever is left in `data/`
      // is what the next boot sees. With the main file moved first, a crash
      // leaves an orphaned `-wal`/`-shm` with no database beside it: the next
      // boot takes the `store-absent` path, clears the marker, and `EventStore`
      // creates a fresh database in a directory holding a stale WAL — the
      // precise hazard the `-journal` note above exists to prevent, reopened by
      // the code that names it. Moving the main file last makes "the store is
      // gone" imply "its siblings are gone too".
      for (const suffix of [...SQLITE_SIBLING_SUFFIXES, ''] as const) {
        const source = `${databasePath}${suffix}`;
        if (!existsSync(source)) continue;
        const name = basename(source);
        renameSync(source, join(directory, name));
        movedNow.push(
          describeQuarantinedFile(
            directory,
            name,
            suffix === '' || preexistingSiblings.has(suffix),
          ),
        );
        files = movedNow.slice();
        options.afterRename?.(name);
      }

      // The record describes the DIRECTORY, not just this call's renames.
      // Continuing an interrupted move means files an earlier start moved are
      // already sitting here; a manifest listing only what this invocation
      // touched would undercount the archive it claims to describe.
      const byName = new Map(movedNow.map((file) => [file.name, file]));
      const archived = readdirSync(directory)
        .filter((name) => name !== STATION_QUARANTINE_RECORD_FILE)
        .sort()
        .map(
          (name) =>
            byName.get(name) ??
            // Moved out of `data/` by an earlier attempt, so it was the
            // user's file, not one an integrity check conjured.
            describeQuarantinedFile(directory, name, true),
        );

      writeDispositionRecord(directory, {
        schemaVersion: STATION_QUARANTINE_RECORD_SCHEMA,
        disposition: 'store-moved',
        quarantinedAt: now.toISOString(),
        files: archived,
        ...(continuedFrom ? { continuedFrom } : {}),
        observation: marker,
      });
      files = archived;

      // Durability before the unlink, not after. The marker is the only thing
      // that will make a future boot try again; make it unreachable while the
      // renames are still only in page cache and a power loss restores the
      // original bug exactly — corrupt store back in `data/`, no marker, no
      // consumer, permanent brick.
      fsyncDirectorySync(directory);
      fsyncDirectorySync(join(homeDir, STATION_HOME_QUARANTINE_DIRECTORY));
      fsyncDirectorySync(dataDir);
    } catch (error) {
      // A partial move is survivable: the marker is untouched, so the next
      // start reaches this code again and moves whatever is left. What is NOT
      // survivable is telling the operator nothing moved — some of their data
      // may already be in `quarantineDir`, and the retry continues into that
      // same directory rather than starting a second one.
      return {
        kind: 'quarantine-failed',
        marker,
        ...(quarantineDir ? { quarantineDir } : {}),
        files,
        cause: error,
      };
    }

    clearCorruptionMarker(databasePath);
    fsyncDirectorySync(dataDir);

    return { kind: 'quarantined', quarantineDir, files, marker };
  } finally {
    lease.release();
  }
}

/**
 * What to tell the operator, for every outcome worth telling them about.
 *
 * `home-active` and `store-unreadable` matter as much as the move does: both
 * are followed by `EventStoreIntegrityError` killing the boot, and without a
 * line here the operator sees the same message as before this existed and
 * cannot tell whether the quarantine ran, declined, or could not look.
 *
 * The quarantined message names the path and `station home restore`, and is
 * careful not to conflate them: the quarantine holds raw database files, not
 * a backup, so `--from=<quarantineDir>` would fail. `station home restore`
 * reads a manifest-bearing backup directory (`station-home-archive.ts`).
 */
export function orchestrationStoreQuarantineNotice(
  outcome: OrchestrationStoreQuarantineOutcome,
): string | undefined {
  switch (outcome.kind) {
    case 'quarantined':
      return [
        `Station orchestration data was recorded as corrupt and has been moved to ${outcome.quarantineDir}.`,
        'Nothing was deleted. Station has started with an empty orchestration store;',
        'restore a validated backup with `station home restore --from=<backup-dir> --confirm`',
        'to get the previous history back. Copy the quarantine elsewhere first if you want to keep it:',
        'restore renames the whole existing home aside, and the quarantine travels with it.',
      ].join(' ');
    case 'home-active':
      return [
        'Station orchestration data was recorded as corrupt, but another Station runtime holds this home,',
        'so it was left untouched. Stop every Station using this home and start one again to have it moved aside.',
      ].join(' ');
    case 'home-lifecycle-unavailable':
      return [
        'Station orchestration data was recorded as corrupt, but home coordination was unavailable,',
        'so it was left untouched. The next start will try again.',
      ].join(' ');
    case 'store-unreadable':
      return [
        'Station orchestration data was recorded as corrupt, but the store could not be read to confirm it,',
        'so it was left untouched. Nothing is moved on an unfinished check.',
      ].join(' ');
    case 'quarantine-failed':
      return [
        'Station orchestration data was recorded as corrupt but could not be fully moved aside.',
        outcome.files.length > 0 && outcome.quarantineDir
          ? `${outcome.files.length} file(s) were already moved to ${outcome.quarantineDir}; nothing was deleted.`
          : 'Nothing was moved.',
        'The record was kept, so the next start will finish the job.',
      ].join(' ');
    case 'no-marker':
    case 'store-absent':
    case 'store-healthy':
      return undefined;
    default:
      // Exhaustive on purpose. Adding an outcome without deciding what to say
      // about it is how `store-absent` came to hide a completed quarantine
      // behind silence; the compiler asks the question now instead.
      return assertNoticeDecided(outcome);
  }
}

function assertNoticeDecided(outcome: never): undefined {
  void outcome;
  return undefined;
}
