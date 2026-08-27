import { readFileSync, realpathSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { writeJsonDurably } from './durable-json-file.js';
import { corruptVirtualTableName } from './sqlite-integrity.js';

/**
 * A note the session that SAW corruption leaves for the session that has to
 * deal with it.
 *
 * Station's boot check answers "is this database corrupt?" every single time,
 * at O(size), and then throws an error nothing catches. Firefox's shape is
 * better and is what this follows: the session that observes real corruption
 * records it, so that a later start CAN act on that record — quarantine,
 * replace, tell the user — instead of every start paying to re-ask a question
 * whose answer is almost always no (station#3215).
 *
 * Deliberately a separate file, not a field in an existing store: it must be
 * readable before the EventStore opens, and writable at the moment a database
 * is proving unreliable. Anything living inside the database it describes
 * cannot do either job.
 *
 * THE CONSUMER IS THE QUARANTINE (station#3217,
 * `orchestration-store-quarantine.ts`): the next boot reads the marker before
 * the EventStore opens — `readCorruptionMarker` is its authorization
 * predicate — archives the store aside by rename, and calls
 * `clearCorruptionMarker` at the point the store is replaced (and on the
 * declining paths that resolve the marker without replacing), so one
 * observation cannot condemn a home forever. If you add a second consumer,
 * clear-at-resolution is part of the contract, not an optimisation.
 */
export interface SqliteCorruptionMarker {
  /**
   * The database this describes, CANONICALIZED — absolute, with its directory
   * resolved through any symlinks. It is deliberately not the string the
   * observer was handed: two runtimes sharing one home spell that string
   * differently, and the point of storing it is that either can recognise it.
   */
  databasePath: string;
  /** When the observation happened, ISO 8601. */
  observedAt: string;
  /** SQLite's own result code, when it gave one — 11 CORRUPT, 26 NOTADB. */
  errcode?: number;
  /**
   * SQLite's message.
   *
   * Content-free in practice for SQLITE_CORRUPT/NOTADB — observed shapes are
   * a fixed phrase or `vtable constructor failed: <name>` — but nothing here
   * ENFORCES that, so treat it as untrusted text if this file is ever shipped
   * in a diagnostic bundle. It holds by what SQLite emits, not by
   * construction.
   */
  detail?: string;
  /**
   * The virtual table the failure named, when it named one — a diagnostic,
   * NOT a routing key. There is no in-place fts5 repair to route to; see
   * `corruptVirtualTableName`. Absent means only that nothing named one.
   */
  table?: string;
}

/** The marker's filename, so consumers can recognise it without a path. */
export const SQLITE_CORRUPTION_MARKER_FILE = '.corruption-observed.json';

/**
 * One spelling of a database path, so two runtimes sharing a home agree.
 *
 * `resolveHomeDir()` returns `STATION_HOME` verbatim — no `resolve`, no tilde
 * expansion, no `realpath` — and that string reaches the store path through a
 * plain `join`. So a launchd service on `/Users/x/.station` and a desktop
 * bundle on `~/.station` name the SAME file with different strings. Comparing
 * those raw would make one runtime's observation invisible to the other,
 * which reads as "no corruption was ever observed" rather than as a mismatch
 * (station#3215 delta review).
 */
function canonicalDatabasePath(databasePath: string): string {
  const absolute = resolve(databasePath);
  try {
    // The database itself may be missing or unreadable; its DIRECTORY is what
    // decides identity here, and resolving it also collapses a symlinked home.
    return join(realpathSync(dirname(absolute)), basename(absolute));
  } catch {
    return absolute;
  }
}

/**
 * ONE MARKER PER DIRECTORY, NOT PER DATABASE — a known hole, named here.
 *
 * `canonicalDatabasePath` fixed the direction that mattered (two spellings of
 * one database now agree). This is the other direction: the filename is a
 * constant, so two stores in ONE directory share a marker. The failure is
 * quiet in both roles — `recordCorruptionObserved` would read the first
 * store's marker, treat the second store's damage as already recorded, and
 * return `false`; `readCorruptionMarker` would then answer for a
 * `databasePath` that is not the one the marker describes.
 *
 * Not reachable today: Station's stores sit in separate directories and the
 * scheduler's is its own. Named rather than fixed because the shape is
 * acquiring its first reader in station#3217, and renaming this file
 * underneath a lane that is mid-flight is worse than a documented hole.
 * Keying the filename off `basename(canonicalDatabasePath(...))` is the fix
 * when someone wants it (station#3220 delta review, LOW-9).
 */
export function corruptionMarkerPath(databasePath: string): string {
  return join(
    dirname(canonicalDatabasePath(databasePath)),
    SQLITE_CORRUPTION_MARKER_FILE,
  );
}

/**
 * Builds the marker a SQLite error deserves.
 *
 * One function rather than one per store: every seam that adopts the watch has
 * to answer the same three questions about the same error object, and two
 * copies of that mapping are two chances to record a different truth about the
 * same failure (station#3220 adopted this after station#3215's EventStore).
 *
 * `table` is diagnostic, not a routing key. It is captured here because the
 * name exists only in the message text at the moment of observation and is
 * unrecoverable afterwards — but station#3217's probes found that only
 * `_config` damage names a table at all, and that both `DROP TABLE` and
 * `INSERT INTO t(t) VALUES('rebuild')` fail with errcode 11 on a corrupt fts5
 * table anyway. Do not build a repair path on its presence.
 */
export function corruptionMarkerFromError(
  databasePath: string,
  error: unknown,
  observedAt: string = new Date().toISOString(),
): SqliteCorruptionMarker {
  const errcode = (error as { errcode?: unknown } | null | undefined)?.errcode;
  const table = corruptVirtualTableName(error);
  return {
    databasePath,
    observedAt,
    ...(typeof errcode === 'number' ? { errcode } : {}),
    ...(error instanceof Error ? { detail: error.message } : {}),
    ...(table === undefined ? {} : { table }),
  };
}

/**
 * Records the observation, best-effort and idempotent.
 *
 * Best-effort because the caller is mid-failure: a marker that cannot be
 * written is a lost diagnosis, never a reason to fail differently.
 *
 * Idempotent WITHIN a process, so a corrupt page hit in a loop does not
 * rewrite the timestamp away from when the database actually went bad. Across
 * processes it is not: a STATION_HOME can legitimately be open by a desktop
 * bundle and a managed service at once, and both can pass the read before
 * either writes. The rename is atomic, so the file is never torn — but one of
 * the concurrent observations wins, not provably the first. The returned
 * `true` means "this call wrote it", not "this call was first".
 */
export function recordCorruptionObserved(
  marker: SqliteCorruptionMarker,
): boolean {
  const path = corruptionMarkerPath(marker.databasePath);
  if (readCorruptionMarker(marker.databasePath)) return false;
  const record = {
    ...marker,
    databasePath: canonicalDatabasePath(marker.databasePath),
  };

  try {
    writeJsonDurably(path, record);
    return true;
  } catch {
    // Best-effort by contract: see the docblock above.
    return false;
  }
}

/** Returns the marker if a previous session observed corruption here. */
export function readCorruptionMarker(
  databasePath: string,
): SqliteCorruptionMarker | null {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(corruptionMarkerPath(databasePath), 'utf8'),
    );
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Partial<SqliteCorruptionMarker>;
    // A marker that does not name a database and a time is not a marker.
    // Treating a malformed one as absent is right: it would otherwise
    // quarantine a database on the strength of an unreadable file.
    if (
      typeof record.databasePath !== 'string' ||
      typeof record.observedAt !== 'string'
    ) {
      return null;
    }
    // The marker is one per DIRECTORY, not one per database, so a directory
    // holding two stores would otherwise let one database's damage condemn
    // the other. Checking makes `databasePath` load-bearing; without this it
    // is a field the type documents and nothing derives.
    if (record.databasePath !== canonicalDatabasePath(databasePath))
      return null;
    return record as SqliteCorruptionMarker;
  } catch {
    return null;
  }
}

/** Clears the marker once the database it describes has been dealt with. */
export function clearCorruptionMarker(databasePath: string): void {
  try {
    rmSync(corruptionMarkerPath(databasePath), { force: true });
  } catch {
    // Best-effort: a stale marker costs one extra check, not correctness.
  }
}
