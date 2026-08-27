/**
 * Read side of Station's own server-log NDJSON store (station#1896, logging
 * slice 2 — the self-read path over slice 1's write side,
 * `server-log-store.ts`).
 *
 * Scans the daily `server-YYYY-MM-DD.ndjson` files `ServerLogReader` reads
 * from (same directory, same filename shape — see the exported
 * `SERVER_LOG_FILE_PATTERN` re-used from `server-log-store.ts` rather than
 * re-declared here) and answers a bounded, filtered *tail* query: the LAST
 * N matches, ordered by parsed timestamp within the returned window (not
 * simply file append order — a multi-process/multi-writer day file can
 * interleave lines out of timestamp order; this module's own scan order
 * bounds what it can prove beyond that window, see `query()`'s final sort).
 *
 * Three things this module is deliberately careful about:
 *
 * 1. **Bounded, non-blocking scan.** A tail query only needs the most
 *    recent matches, so files are scanned newest-first and each file is
 *    read backward in fixed-size chunks via `readLinesReverse` (never a
 *    whole-file `readFileSync`, which both blocks the event loop and holds
 *    the entire — up to 256 MiB retention-ceiling — file in memory). The
 *    scan stops the instant `limit` matches have been collected, and is
 *    additionally capped by a total-bytes-read budget
 *    (`DEFAULT_SERVER_LOG_SCAN_BUDGET_BYTES`) so one pathological day never
 *    turns a diagnostic query into an unbounded I/O sweep. `scannedFiles`/
 *    `oldestScannedDay`/`scanBudgetExhausted` let a caller prove the early
 *    stop actually happened rather than take it on faith.
 * 2. **Redaction on egress, applied to what `q` can see.** The durable
 *    store holds UNREDACTED bytes (UX audit D6 — a local operator has to
 *    be able to read their own logs). `query({ redact: true })` — the
 *    default, fail-closed — still runs every returned entry through
 *    `redactDeep` (secret-NAMED fields, e.g. nested `config.apiKey`) and
 *    `redactSecrets` on every string leaf (secret-SHAPED text inside
 *    free-form fields like `msg`/`err.message`/`err.stack`). Filed as
 *    station#1922: this is the only path that ever serves those lines
 *    back out over an API boundary, so this redaction is load-bearing,
 *    not decorative, for every remote/paired caller. `query({ redact:
 *    false })` is reserved for a caller that has already been classified
 *    local by the bound `isLocalRuntimeCaller` flag; it is never a query-string
 *    flag a client can set. Critically, `q` is matched against the
 *    rendering the caller will actually receive, never the other one
 *    (station#1896 review round 2, HIGH #1): a remote caller can only
 *    search what a remote caller could see, otherwise `q` is a
 *    character-by-character oracle over content the response claims to
 *    have hidden. Redaction only runs on entries that already passed the
 *    cheap level/time filters, to keep the hot path lean.
 * 3. **Honest about what it did not read.** A day file the scan could not
 *    even open (permission error, disappeared mid-scan) is counted in
 *    `unreadableFiles`, not silently skipped — and forces `truncated: true`
 *    (station#1896 review round 2, HIGH #2), because the scan cannot claim
 *    completeness for a day it never verified. A line that isn't valid
 *    JSON, or is valid JSON missing a recognizable `level`/`timestamp`, is
 *    skipped and counted in `skippedMalformedLines` rather than silently
 *    dropped. A missing fact renders as an explicit named gap, never
 *    silence.
 */

import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  redactDeep,
  sanitizeFreeText,
} from '@kontourai/station-shared/redaction';
import {
  isLogLevel,
  isLogLevelAtLeast,
  type LogLevel,
} from '../../utils/logger.js';
import { SERVER_LOG_FILE_PATTERN } from './server-log-store.js';

export const DEFAULT_SERVER_LOG_QUERY_LIMIT = 200;
export const MAX_SERVER_LOG_QUERY_LIMIT = 1000;

/**
 * Per-query cap on total bytes read off disk (station#1896 review round 2,
 * HIGH #4). A single day file can legitimately reach the write side's
 * retention ceiling (256 MiB — `DEFAULT_SERVER_LOG_RETENTION.maxBytes` in
 * `server-log-store.ts`); reading one that large — even in chunks — is
 * real, measurable I/O and CPU work (~326ms/~455MB RSS measured against a
 * synchronous whole-file read at that size before this fix). 32 MiB bounds
 * a single diagnostic query to a small, sub-second amount of reverse-chunk
 * I/O while comfortably covering the actual "give me the last N lines" use
 * case — a day needs unusually dense/verbose logging before its last
 * `MAX_SERVER_LOG_QUERY_LIMIT` (1000) matching lines fall outside the most
 * recent 32 MiB written. When the budget is spent before a query is
 * otherwise satisfied, the result says so explicitly
 * (`scanBudgetExhausted: true`, alongside `truncated: true`) rather than
 * silently returning a partial answer that looks complete.
 */
export const DEFAULT_SERVER_LOG_SCAN_BUDGET_BYTES = 32 * 1024 * 1024;

/** Chunk size for `readLinesReverse`'s backward file reads. Small enough to
 * keep peak memory per read bounded and independent of file size, large
 * enough that a multi-megabyte scan doesn't spend most of its time on
 * syscall overhead. */
const REVERSE_READ_CHUNK_BYTES = 64 * 1024;

export interface ServerLogQueryOptions {
  /** Minimum severity floor (inclusive) — entries below this level are excluded. */
  level?: LogLevel;
  /** ISO timestamp lower bound (inclusive). */
  since?: string;
  /** ISO timestamp upper bound (inclusive). */
  until?: string;
  /** Case-insensitive substring match over the JSON rendering of the
   * entry the caller will actually receive (redacted when `redact` is
   * true — the default — never a cross-rendering oracle; see this
   * module's docblock, point 2). Matching `[REDACTED]` itself is
   * well-defined on a redacted query: it matches any entry that had at
   * least one field redacted, the same as matching any other literal
   * substring of what the response actually contains. */
  q?: string;
  /** Max entries to return. Default `DEFAULT_SERVER_LOG_QUERY_LIMIT`, clamped to `MAX_SERVER_LOG_QUERY_LIMIT`. */
  limit?: number;
  /**
   * Whether to redact each returned entry (and to match `q` against that
   * redacted rendering). Default `true` — fail-closed. Only a caller
   * already classified local by the bound `isLocalRuntimeCaller` flag may pass `false`.
   */
  redact?: boolean;
}

/** A parsed log line, redacted on egress unless `query({ redact: false })`.
 * Shape mirrors whatever `src-server/utils/logger.ts` wrote (`level`,
 * `timestamp`, `msg`, and caller-supplied context fields including
 * `err`), so this stays a `Record` rather than a fixed interface — the
 * seam owns the write shape. */
export type ServerLogEntry = Record<string, unknown>;

export interface ServerLogQueryResult {
  /** The last `limit` matches, ordered by parsed `timestamp` ascending
   * (oldest of the returned set first). */
  entries: ServerLogEntry[];
  /** True when the scan stopped before it could prove there are no further
   * matching entries beyond what's returned — the match cap was hit, a
   * `since` boundary was reached with the cap already met on an earlier
   * iteration, a file could not be opened (`unreadableFiles > 0`), or the
   * scan budget ran out (`scanBudgetExhausted`). Conservative: never claims
   * completeness it did not verify. */
  truncated: boolean;
  /** Number of daily files actually opened and (at least partially) read
   * (files pruned out by `since`/`until` before being opened do not
   * count). A successfully-opened but EMPTY (0-byte) day file yields no
   * lines, so it is not counted here either — content coverage is
   * unaffected (an empty file has nothing to miss). */
  scannedFiles: number;
  /** Files that were listed but could not be opened/read at all (e.g. a
   * permission error or a retention-sweep race). Forces `truncated: true`
   * whenever non-zero — a day the scan could not verify is not the same as
   * a day with nothing matching in it. */
  unreadableFiles: number;
  /** The oldest day (`YYYY-MM-DD`) from which at least one line was read,
   * or `null` if none was (e.g. an empty/missing log directory). A 0-byte
   * day file — possible if the store opened a day and crashed before its
   * first write — is not reflected here (same carve-out as
   * `scannedFiles`). */
  oldestScannedDay: string | null;
  /** Lines that were skipped because they were not parseable JSON, or were
   * JSON missing a recognizable `level`/`timestamp`. */
  skippedMalformedLines: number;
  /** True when `DEFAULT_SERVER_LOG_SCAN_BUDGET_BYTES` (or the reader's
   * configured override) was exhausted before the scan would otherwise
   * have stopped. Always accompanies `truncated: true`. */
  scanBudgetExhausted: boolean;
}

export interface ServerLogReader {
  readonly directory: string;
  query(options?: ServerLogQueryOptions): Promise<ServerLogQueryResult>;
}

export interface CreateServerLogReaderOptions {
  directory: string;
  /** Override for `DEFAULT_SERVER_LOG_SCAN_BUDGET_BYTES`. Primarily a
   * test-only escape hatch to exercise the budget-exhaustion path without
   * a multi-megabyte fixture. */
  scanBudgetBytes?: number;
}

interface DayFile {
  date: string;
  path: string;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_SERVER_LOG_QUERY_LIMIT;
  }
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  if (floored > MAX_SERVER_LOG_QUERY_LIMIT) return MAX_SERVER_LOG_QUERY_LIMIT;
  return floored;
}

function parseBoundTimestamp(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function dayStartMs(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`);
}

function dayEndMs(date: string): number {
  return Date.parse(`${date}T23:59:59.999Z`);
}

function isWellFormedEntry(value: unknown): value is ServerLogEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (!isLogLevel(record.level)) return false;
  return (
    typeof record.timestamp === 'string' &&
    !Number.isNaN(Date.parse(record.timestamp))
  );
}

/** Applies `sanitizeFreeText` to every string leaf of an already
 * `redactDeep`-processed value. `redactDeep` already routes most string
 * leaves through `redactSecrets` internally, but this explicit second pass
 * is the contract this module promises regardless of `redactDeep`'s own
 * internal short-circuits (e.g. its JSON-in-string recursion cap) — every
 * string leaf in a returned entry has been through `sanitizeFreeText`, full
 * stop. */
function redactStringsDeep(value: unknown): unknown {
  if (typeof value === 'string') return sanitizeFreeText(value);
  if (Array.isArray(value)) return value.map(redactStringsDeep);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      out[key] = redactStringsDeep(child);
    }
    return out;
  }
  return value;
}

function redactLogEntry(entry: ServerLogEntry): ServerLogEntry {
  return redactStringsDeep(redactDeep(entry)) as ServerLogEntry;
}

interface ScanBudget {
  remaining: number;
}

const NEWLINE_BYTE = 0x0a;

/**
 * Yields lines of `filePath` from the END of the file backward (most
 * recent line first), reading in bounded `REVERSE_READ_CHUNK_BYTES` chunks
 * rather than loading the whole file into memory at once (station#1896
 * review round 2, HIGH #4). Splitting only ever happens on a literal `\n`
 * (0x0a) byte, which is safe against UTF-8 multi-byte boundaries — 0x0a
 * never occurs as a continuation byte in valid UTF-8, only as a real
 * newline — so chunk boundaries never corrupt a decoded line.
 *
 * Consumes from `budget.remaining` as it reads; if the budget is spent
 * before the file's start is reached, the generator simply stops (no
 * error) with an in-flight line fragment discarded rather than yielded
 * corrupt/incomplete — the caller reads `budget.remaining <= 0` afterward
 * as its signal that this file was only partially scanned.
 */
async function* readLinesReverse(
  filePath: string,
  budget: ScanBudget,
): AsyncGenerator<string> {
  const handle = await open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    let position = size;
    let leftover = Buffer.alloc(0);

    while (position > 0 && budget.remaining > 0) {
      const chunkSize = Math.min(
        REVERSE_READ_CHUNK_BYTES,
        position,
        budget.remaining,
      );
      position -= chunkSize;
      const chunk = Buffer.alloc(chunkSize);
      await handle.read(chunk, 0, chunkSize, position);
      budget.remaining -= chunkSize;

      const combined = Buffer.concat([chunk, leftover]);
      let searchFrom = combined.length;
      for (let i = combined.length - 1; i >= 0; i -= 1) {
        if (combined[i] === NEWLINE_BYTE) {
          yield combined.subarray(i + 1, searchFrom).toString('utf8');
          searchFrom = i;
        }
      }
      if (position === 0) {
        // Nothing precedes this — it's the file's genuine first line, not
        // a fragment continuing into an earlier (unread) chunk.
        yield combined.subarray(0, searchFrom).toString('utf8');
        leftover = Buffer.alloc(0);
      } else {
        leftover = combined.subarray(0, searchFrom);
      }
    }
    // If the loop exited with `position > 0`, the budget ran out mid-file:
    // `leftover` (if any) is an incomplete fragment continuing into bytes
    // we never read, and is deliberately discarded, not yielded.
  } finally {
    await handle.close();
  }
}

class FsServerLogReader implements ServerLogReader {
  readonly directory: string;
  private readonly scanBudgetBytes: number;

  constructor(options: CreateServerLogReaderOptions) {
    this.directory = options.directory;
    this.scanBudgetBytes =
      options.scanBudgetBytes ?? DEFAULT_SERVER_LOG_SCAN_BUDGET_BYTES;
  }

  async query(
    options: ServerLogQueryOptions = {},
  ): Promise<ServerLogQueryResult> {
    const limit = clampLimit(options.limit);
    const sinceMs = parseBoundTimestamp(options.since);
    const untilMs = parseBoundTimestamp(options.until);
    const qLower = options.q ? options.q.toLowerCase() : undefined;
    const minLevel = options.level;
    const redact = options.redact !== false;

    const files = await this.listDayFilesDescending();

    const matches: { entry: ServerLogEntry; timeMs: number }[] = [];
    let scannedFiles = 0;
    let unreadableFiles = 0;
    let oldestScannedDay: string | null = null;
    let skippedMalformedLines = 0;
    let truncated = false;
    let scanBudgetExhausted = false;
    const budget: ScanBudget = { remaining: this.scanBudgetBytes };

    fileLoop: for (const file of files) {
      // Stop BEFORE opening the next (older) file once the cap is already
      // satisfied — checking only inside the per-line loop below would
      // still open one file too many.
      if (matches.length >= limit) {
        truncated = true;
        break;
      }
      if (budget.remaining <= 0) {
        truncated = true;
        scanBudgetExhausted = true;
        break;
      }
      // Prune whole files outside [since, until] by filename date alone —
      // no need to open a file that cannot contain a matching line.
      if (untilMs !== undefined && dayStartMs(file.date) > untilMs) continue;
      if (sinceMs !== undefined && dayEndMs(file.date) < sinceMs) {
        // Files are visited newest-first; once one is entirely before
        // `since`, every remaining (older) file is too. Stop scanning.
        break;
      }

      let fileMarkedScanned = false;
      try {
        for await (const line of readLinesReverse(file.path, budget)) {
          // Mark the file as scanned on the FIRST successfully-read line —
          // not after the loop — so a mid-file `break fileLoop` below (the
          // cap was hit partway through this file) still counts the file
          // that actually produced the match, rather than skipping the
          // bookkeeping because the loop never reached its natural end.
          if (!fileMarkedScanned) {
            fileMarkedScanned = true;
            scannedFiles += 1;
            oldestScannedDay = file.date;
          }
          if (matches.length >= limit) {
            truncated = true;
            break fileLoop;
          }
          if (line.trim() === '') continue;

          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            skippedMalformedLines += 1;
            continue;
          }
          if (!isWellFormedEntry(parsed)) {
            skippedMalformedLines += 1;
            continue;
          }

          const entryLevel = parsed.level as LogLevel;
          const entryTimeMs = Date.parse(parsed.timestamp as string);
          if (
            minLevel !== undefined &&
            !isLogLevelAtLeast(entryLevel, minLevel)
          ) {
            continue;
          }
          if (sinceMs !== undefined && entryTimeMs < sinceMs) continue;
          if (untilMs !== undefined && entryTimeMs > untilMs) continue;

          // Redact only AFTER the cheap level/time filters pass (keeps the
          // hot path lean), and apply `q` to the SAME rendering the
          // caller will receive — station#1896 review round 2, HIGH #1:
          // matching `q` against pre-redaction text while returning a
          // redacted body lets a remote caller confirm an exact secret
          // character-by-character via match/no-match. Local callers
          // (`redact: false`) search the unredacted bytes they are
          // allowed to see.
          const entry = redact ? redactLogEntry(parsed) : parsed;
          if (
            qLower !== undefined &&
            !JSON.stringify(entry).toLowerCase().includes(qLower)
          ) {
            continue;
          }

          matches.push({ entry, timeMs: entryTimeMs });
        }
      } catch {
        // Could not even open/read this file (permission error, a
        // retention-sweep race, etc.) — not a malformed line, an entire
        // day the scan never verified. Keep scanning older files; the
        // result is still honest about the gap via `unreadableFiles`.
        unreadableFiles += 1;
        continue;
      }

      if (budget.remaining <= 0) {
        truncated = true;
        scanBudgetExhausted = true;
        break;
      }
    }

    if (unreadableFiles > 0) truncated = true;

    // Stable sort by parsed timestamp — a multi-process/multi-writer day
    // file is not guaranteed to be in strict timestamp order just because
    // it's in append order (station#1896 review round 2, MEDIUM #5).
    matches.sort((left, right) => left.timeMs - right.timeMs);

    return {
      entries: matches.map((match) => match.entry),
      truncated,
      scannedFiles,
      unreadableFiles,
      oldestScannedDay,
      skippedMalformedLines,
      scanBudgetExhausted,
    };
  }

  private async listDayFilesDescending(): Promise<DayFile[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      return [];
    }
    const files: DayFile[] = [];
    for (const name of names) {
      const match = SERVER_LOG_FILE_PATTERN.exec(name);
      if (!match) continue;
      files.push({ date: match[1], path: join(this.directory, name) });
    }
    return files.sort((left, right) => right.date.localeCompare(left.date));
  }
}

export function createServerLogReader(
  options: CreateServerLogReaderOptions,
): ServerLogReader {
  return new FsServerLogReader(options);
}
