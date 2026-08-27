import { lstatSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  checkSqliteIntegrity,
  explicitCorruption,
  type SqliteIntegrityDatabase,
  type SqliteIntegrityOutcome,
} from './sqlite-integrity.js';

/**
 * Deliberate verification of a SQLite store, on its own connection.
 *
 * station#3215 stopped Station running `PRAGMA quick_check` on every boot and
 * started classifying the errors SQLite raises during ordinary work. That
 * catches corruption a query TOUCHES. Page-level damage in a region nothing
 * reads can sit undetected indefinitely, which is the coverage the boot check
 * was actually buying — so it has to be bought somewhere else before the boot
 * check can go (station#3218).
 *
 * Everything here owns its connection, which is what separates it from
 * `sqlite-integrity.ts`: that module classifies a handle somebody else
 * opened, and deliberately stays free of `node:sqlite`. This one opens its
 * own READ-ONLY handle, so it blocks no writer in WAL and cannot be handed a
 * connection whose state it does not control. The verdict itself still comes
 * from `checkSqliteIntegrity`, so a deliberate check and an ordinary query
 * failure can never disagree about the same database.
 */

/** `<home>/data/orchestration.sqlite`, in path segments. */
const ORCHESTRATION_STORE_SEGMENTS = ['data', 'orchestration.sqlite'] as const;
/** `<home>/scheduler/scheduler.sqlite`, in path segments. */
const SCHEDULER_STORE_SEGMENTS = ['scheduler', 'scheduler.sqlite'] as const;

/**
 * Where the orchestration event store lives under a Station home.
 *
 * `src-server/domain/migrations/003-orchestration-events.ts` delegates to this
 * rather than repeating the join: the CLI and the scheduled probe both need
 * the path and neither can import from `src-server`, and a third hand-written
 * `join(home, 'data', 'orchestration.sqlite')` is one somebody eventually
 * spells differently.
 */
export function orchestrationStorePath(homeDir: string): string {
  return join(homeDir, ...ORCHESTRATION_STORE_SEGMENTS);
}

/** Where the scheduler ledger lives under a Station home. */
export function schedulerStorePath(homeDir: string): string {
  return join(homeDir, ...SCHEDULER_STORE_SEGMENTS);
}

/**
 * Every SQLite store a Station home owns.
 *
 * Enumerated rather than discovered by walking for `*.sqlite`: a walk would
 * pick up a stray copy, a restore staging directory, or a backup, and report
 * a verdict about a file Station does not own. What this returns is what
 * Station writes.
 */
export function stationHomeStorePaths(homeDir: string): string[] {
  return [orchestrationStorePath(homeDir), schedulerStorePath(homeDir)];
}

/**
 * What a verification of one store concluded.
 *
 * `absent` is separate from `unavailable` for the same reason `unavailable` is
 * separate from `corrupt`: they are different facts and callers act on them
 * differently. A Station home that has never scheduled anything has no
 * scheduler ledger, and reporting that as a failed check would make
 * `station home verify` fail on a perfectly healthy home — which is how a
 * check teaches its operator to ignore it.
 */
export type StoreIntegrityVerdict = 'ok' | 'corrupt' | 'unavailable' | 'absent';

/** Every verdict, for callers validating one they did not produce. */
export const STORE_INTEGRITY_VERDICTS: readonly StoreIntegrityVerdict[] =
  Object.freeze(['ok', 'corrupt', 'unavailable', 'absent']);

export interface StoreIntegrityResult {
  databasePath: string;
  /**
   * `ok` means `PRAGMA quick_check` found the b-tree structure intact at the
   * moment of the check. It is NOT a statement that no data was lost: a
   * torn-off `-wal`, a rolled-back transaction, or rows deleted by something
   * else all leave a perfectly consistent database. This detects damage, not
   * absence.
   */
  verdict: StoreIntegrityVerdict;
  /** How long the check itself took, so an operator can see what it cost. */
  durationMs: number;
  /** SQLite's own result code, when it gave one — 11 CORRUPT, 26 NOTADB. */
  errcode?: number;
  /**
   * SQLite's message, when there was one.
   *
   * Untrusted text by the same argument as `SqliteCorruptionMarker.detail`:
   * nothing here enforces its shape, it holds by what SQLite emits.
   */
  detail?: string;
}

export interface StoreIntegrityReport {
  checkedAt: string;
  results: StoreIntegrityResult[];
}

/**
 * Process exit codes for the scheduled probe and for `station home verify`.
 *
 * `corrupt` and `unavailable` are deliberately DIFFERENT non-zero codes. They
 * are different claims — "I looked and the bytes are bad" versus "I could not
 * look" — and only one of them is grounds for acting on a user's history.
 * Collapsing them into a single failure code is how a probe that could not
 * start gets read as a corruption report.
 */
export const STORE_INTEGRITY_EXIT_CODE = Object.freeze({
  ok: 0,
  corrupt: 1,
  unavailable: 2,
  /**
   * Nothing was verified: no path was given, or every store named turned out
   * not to exist. Distinct from `ok` because a report with no findings in it
   * is not the same as a report of no problems.
   */
  usage: 3,
});

/**
 * Wraps a real handle so the error that produced a verdict survives it.
 *
 * `checkSqliteIntegrity` returns a content-free `{ kind: 'corrupt' }` — right
 * for its callers, which only branch on the verdict — but the marker this
 * feeds records SQLite's `errcode`, and the reactive path (station#3215)
 * already records it. Without this the two detection paths would write
 * markers of different quality for the same damage.
 */
function recordingHandle(database: SqliteIntegrityDatabase): {
  handle: SqliteIntegrityDatabase;
  lastError: () => unknown;
  lastRows: () => unknown[] | undefined;
} {
  let lastError: unknown;
  let lastRows: unknown[] | undefined;
  const remember = <T>(run: () => T): T => {
    try {
      return run();
    } catch (error) {
      lastError = error;
      throw error;
    }
  };
  return {
    handle: {
      exec: (sql) => remember(() => database.exec(sql)),
      prepare: (sql) => {
        const statement = remember(() => database.prepare(sql));
        return {
          all: () => {
            lastRows = remember(() => statement.all());
            return lastRows;
          },
        };
      },
    },
    lastError: () => lastError,
    lastRows: () => lastRows,
  };
}

/** Ceiling on `detail`, which is written to a file and read by a human. */
const MAX_DETAIL_CHARS = 500;

/**
 * What `quick_check` said, when it said something other than `ok`.
 *
 * The most common real damage — a bad page in a region a query has not
 * touched — makes `quick_check` RETURN a report rather than raise, so there is
 * no SQLite error to take an errcode from. Its report names the trees and
 * pages, and it is the only account of the damage that exists. Recording it
 * verbatim (bounded) is what keeps a corruption verdict from being a bare
 * label with nothing behind it.
 */
function quickCheckReport(rows: unknown[] | undefined): string | undefined {
  const first = rows?.[0];
  if (typeof first !== 'object' || first === null || Array.isArray(first))
    return undefined;
  const value = Object.values(first as Record<string, unknown>)[0];
  if (typeof value !== 'string' || value === 'ok') return undefined;
  return value.slice(0, MAX_DETAIL_CHARS);
}

function errcodeOf(error: unknown): number | undefined {
  const record = error as { errcode?: unknown } | null;
  return typeof record?.errcode === 'number' ? record.errcode : undefined;
}

function diagnostics(
  error: unknown,
): Pick<StoreIntegrityResult, 'errcode' | 'detail'> {
  const errcode = errcodeOf(error);
  return {
    ...(errcode === undefined ? {} : { errcode }),
    ...(error instanceof Error
      ? { detail: error.message.slice(0, MAX_DETAIL_CHARS) }
      : {}),
  };
}

/**
 * Opens `databasePath` and classifies it, keeping the error behind the
 * verdict.
 *
 * The connection is READ-ONLY unless `checkpoint` is set. Read-only is what
 * lets this run against a live Station: the runtime holds this same file open
 * in WAL, where a reader blocks no writer. `checkpoint` exists only for the
 * archive seam, which verifies a store it has already quiesced and wants
 * collapsed into the main file first — it opens the database for WRITING and
 * must never be set by a caller running alongside the runtime.
 *
 * A database that cannot be OPENED is not automatically "could not look" —
 * SQLITE_NOTADB surfaces at open time when the header is not a database at
 * all — so an open failure goes through the same classifier as a statement
 * failure rather than being assumed either way.
 */
function probeStore(
  databasePath: string,
  checkpoint: boolean,
): {
  outcome: SqliteIntegrityOutcome;
  lastError: unknown;
  report?: string;
} {
  let database: InstanceType<typeof DatabaseSync> | undefined;
  try {
    database = new DatabaseSync(databasePath, {
      timeout: 5_000,
      readOnly: !checkpoint,
    });
    const recording = recordingHandle(database);
    const outcome = checkSqliteIntegrity(recording.handle, { checkpoint });
    const report = quickCheckReport(recording.lastRows());
    return {
      outcome,
      lastError: recording.lastError(),
      ...(report === undefined ? {} : { report }),
    };
  } catch (error) {
    return {
      outcome: explicitCorruption(error)
        ? { kind: 'corrupt' }
        : { kind: 'unavailable', cause: error },
      lastError: error,
    };
  } finally {
    try {
      database?.close();
    } catch {
      // The verdict above is already the answer; a failing close cannot
      // improve it and must not replace it.
    }
  }
}

/**
 * Opens `databasePath` on its own connection and returns the verdict.
 *
 * The archive seam's health gate is this function with `checkpoint` set, so
 * a store that Station archives and a store that Station verifies on a
 * schedule are judged by one implementation rather than two that agree today.
 */
export function openAndCheckSqliteIntegrity(
  databasePath: string,
  options: { checkpoint?: boolean } = {},
): SqliteIntegrityOutcome {
  return probeStore(databasePath, options.checkpoint === true).outcome;
}

/** Verifies one store read-only and shapes the verdict for a report. */
export function verifySqliteStore(databasePath: string): StoreIntegrityResult {
  const startedAt = performance.now();
  try {
    statSync(databasePath);
  } catch (error) {
    // ENOENT specifically, not "stat failed": a directory this process cannot
    // traverse also fails here, and that is a store Station could not READ,
    // which is a different claim. Anything else falls through to the open,
    // which classifies it properly.
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') {
      // ...unless something IS at that path. `statSync` follows symlinks, so
      // a link pointing at a deleted target reports ENOENT — and calling that
      // `absent` would tell an operator their home never had a store, when
      // what it has is a broken pointer to one.
      let dangling = false;
      try {
        dangling = lstatSync(databasePath).isSymbolicLink();
      } catch {
        // Nothing at the path at all, which is the plain absent case.
      }
      return dangling
        ? {
            databasePath,
            verdict: 'unavailable',
            durationMs: 0,
            detail: 'store path is a symbolic link to a missing target',
          }
        : { databasePath, verdict: 'absent', durationMs: 0 };
    }
  }
  const { outcome, lastError, report } = probeStore(databasePath, false);
  const durationMs = Math.round(performance.now() - startedAt);
  if (outcome.kind === 'ok') return { databasePath, verdict: 'ok', durationMs };
  if (outcome.kind === 'corrupt')
    return {
      databasePath,
      verdict: 'corrupt',
      durationMs,
      // `errcode` is absent when `quick_check` REPORTED damage instead of
      // raising — the rows are the finding and there is no SQLite error
      // behind them — so its own report becomes the detail in that case.
      ...diagnostics(lastError),
      ...(report === undefined ? {} : { detail: report }),
    };
  return {
    databasePath,
    verdict: 'unavailable',
    durationMs,
    ...diagnostics(outcome.cause),
  };
}

/**
 * The worst verdict in a report, as a process exit code.
 *
 * `corrupt` outranks `unavailable`: a run that proved one store bad and could
 * not read another has still proved a store bad, and that is what an operator
 * has to act on. `absent` is not a failure at all.
 */
export function storeIntegrityExitCode(
  results: readonly StoreIntegrityResult[],
): number {
  // Nothing verified is never a clean bill of health. An empty report, or one
  // where every store turned out `absent`, is what a mistyped `--base` looks
  // like — and answering "is my data OK?" with exit 0 about a home that does
  // not exist is the worst answer available (station#3218 review MED-1).
  if (
    results.length === 0 ||
    results.every((result) => result.verdict === 'absent')
  )
    return STORE_INTEGRITY_EXIT_CODE.usage;
  // Past that, `absent` contributes nothing: a store that was never created
  // is the normal state of a home that has not used that subsystem yet.
  if (results.some((result) => result.verdict === 'corrupt'))
    return STORE_INTEGRITY_EXIT_CODE.corrupt;
  if (results.some((result) => result.verdict === 'unavailable'))
    return STORE_INTEGRITY_EXIT_CODE.unavailable;
  return STORE_INTEGRITY_EXIT_CODE.ok;
}
