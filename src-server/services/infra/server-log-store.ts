/**
 * Durable NDJSON sink for Station's server logger (station#1895, logging
 * slice 1). Mirrors the daily-file + retention pattern already proven by
 * `runtime/conversation/runtime-event-log.ts`, but for structured log lines
 * rather than monitoring events.
 *
 * Security trade (UX audit D6): the logger seam writes UNREDACTED lines
 * here so a local operator can read their own logs through the Developer
 * surface / `read_logs`. Stdout is still redacted at write. Redaction for
 * remote/paired callers happens at read (`ServerLogReader.query`, default
 * `redact: true`). Because this directory can hold secrets, files are
 * created 0600 and the directory 0700 (re-asserted on every open, so a
 * pre-existing 0644/0755 file cannot keep leaking). If that hardening
 * throws or the resulting modes are not 0700/0600, the fd is closed and
 * this store writes nothing — logger callers degrade to redacted stdout.
 * Same POSIX floor as the local-grant secret and operator credential
 * files. A process running as this OS user can still read the files;
 * that is the same trust boundary as `~/.station` itself, not a new one.
 *
 * Durability choice: writes go through `fs.writeSync` on a fd opened once
 * per day, rather than pino's own `SonicBoom`/worker-thread transports.
 * SonicBoom's async destination surfaces open/write failures through an
 * `'error'` event on its own tick, which makes "never throw into the caller"
 * and "a fatal line survives a hard crash" both dependent on event-loop
 * timing the caller cannot control. A synchronous `fs.writeSync` call is
 * durable by construction (the write has completed, or thrown, before the
 * call returns) and every failure is caught at the call site — the
 * degrade-to-stdout-only contract falls out of a plain `try/catch` instead
 * of an async listener race. The tradeoff is a blocking write per log line;
 * that is acceptable for a debug/audit sink that is not a high-throughput
 * data path. `flushSync()` is therefore a no-op — every write is already
 * flushed by the time it returns.
 */

import {
  chmodSync,
  closeSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

// The logger seam pulls this module into nearly every server module graph, so
// a static import of telemetry/metrics.js here would force the OTel instrument
// module ahead of vi.mock factory hoisting in every mock-heavy test file (seen
// live: "Cannot access '<mock var>' before initialization"). Load the
// instruments lazily at first use instead; counting is best-effort and must
// never block or throw into the write path.
type LogStoreInstruments = {
  serverLogStoreWriteErrors: { add(value: number): void };
  serverLogStoreRetentionRemovedFiles: { add(value: number): void };
};
let instruments: LogStoreInstruments | undefined;
let instrumentsLoading: Promise<void> | undefined;
function countInstrument(name: keyof LogStoreInstruments, value: number): void {
  if (instruments) {
    instruments[name].add(value);
    return;
  }
  instrumentsLoading ??= import('../../telemetry/metrics.js')
    .then((module) => {
      instruments = {
        serverLogStoreWriteErrors: module.serverLogStoreWriteErrors,
        serverLogStoreRetentionRemovedFiles:
          module.serverLogStoreRetentionRemovedFiles,
      };
    })
    .catch(() => {
      instrumentsLoading = undefined;
    });
  void instrumentsLoading.then(() => instruments?.[name].add(value));
}

const MIB = 1024 * 1024;
/** Exported so `server-log-reader.ts` (station#1896 logging slice 2) reuses
 * the exact same filename shape rather than re-declaring a possibly-drifting
 * copy — the read side and write side must agree on what a day file looks
 * like. */
export const SERVER_LOG_FILE_PATTERN = /^server-(\d{4}-\d{2}-\d{2})\.ndjson$/;

export const DEFAULT_SERVER_LOG_RETENTION = {
  maxAgeDays: 30,
  maxBytes: 256 * MIB,
} as const;

export interface ServerLogRetentionPolicy {
  maxAgeDays: number;
  maxBytes: number;
}

export interface ServerLogStore {
  /** Directory this store writes daily NDJSON files into. */
  readonly directory: string;
  /** Append one already-serialized log line (a trailing newline is added if missing). */
  writeLine(line: string): void;
  /** Best-effort synchronous drain for the fatal-crash path. Writes are already
   * synchronous, so this is a no-op kept for interface symmetry with async sinks. */
  flushSync(): void;
  /** Closes the currently-open day fd, if any. `installServerLogSink` calls
   * this on the store it replaces so a double-install (e.g. a config
   * reload re-pointing the log directory) can't orphan the earlier
   * instance's open descriptor. Safe to call more than once. */
  close(): void;
  /** Whether a day fd is currently open — exposed for tests that need to
   * observe fd lifecycle directly rather than inferring it from writes. */
  isOpen(): boolean;
}

export interface CreateServerLogStoreOptions {
  directory: string;
  retention?: Partial<ServerLogRetentionPolicy>;
  now?: () => Date;
}

interface LogFileInfo {
  name: string;
  path: string;
  date: string;
  size: number;
}

class FsServerLogStore implements ServerLogStore {
  readonly directory: string;
  private readonly now: () => Date;
  private readonly retention: ServerLogRetentionPolicy;
  private fd: number | undefined;
  private currentDay: string | undefined;
  private lastRetentionDay: string | undefined;

  constructor(options: CreateServerLogStoreOptions) {
    this.directory = options.directory;
    this.now = options.now ?? (() => new Date());
    this.retention = {
      maxAgeDays:
        options.retention?.maxAgeDays ??
        readPositiveInteger(
          process.env.STATION_SERVER_LOG_RETENTION_DAYS,
          DEFAULT_SERVER_LOG_RETENTION.maxAgeDays,
        ),
      maxBytes:
        options.retention?.maxBytes ??
        readPositiveInteger(
          process.env.STATION_SERVER_LOG_MAX_BYTES,
          DEFAULT_SERVER_LOG_RETENTION.maxBytes,
        ),
    };
  }

  writeLine(line: string): void {
    try {
      this.ensureOpenForToday();
      if (this.fd === undefined) return;
      const payload = line.endsWith('\n') ? line : `${line}\n`;
      writeSync(this.fd, payload, null, 'utf8');
    } catch {
      countInstrument('serverLogStoreWriteErrors', 1);
      // Degrade to stdout-only: drop the fd so the next write retries a
      // fresh open rather than writing to a possibly-broken descriptor.
      if (this.fd !== undefined) {
        try {
          closeSync(this.fd);
        } catch {
          // best-effort close; nothing more we can do here
        }
      }
      this.fd = undefined;
    }
  }

  flushSync(): void {
    // No-op: fs.writeSync already durably completes each write.
  }

  close(): void {
    if (this.fd === undefined) return;
    try {
      closeSync(this.fd);
    } catch {
      // best-effort; nothing more we can do with an fd we can't close
    }
    this.fd = undefined;
    this.currentDay = undefined;
  }

  isOpen(): boolean {
    return this.fd !== undefined;
  }

  private ensureOpenForToday(): void {
    const today = this.dayStamp();
    if (this.fd !== undefined && this.currentDay === today) return;
    if (this.fd !== undefined) {
      try {
        closeSync(this.fd);
      } catch {
        // best-effort
      }
      this.fd = undefined;
    }
    this.applyRetentionForDay(today);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const path = this.pathForDay(today);
    let fd: number;
    try {
      if (process.platform !== 'win32') {
        chmodSync(this.directory, 0o700);
      }
      fd = openSync(path, 'a', 0o600);
    } catch {
      return;
    }
    if (process.platform !== 'win32') {
      try {
        fchmodSync(fd, 0o600);
        const dirMode = statSync(this.directory).mode & 0o777;
        const fileMode = fstatSync(fd).mode & 0o777;
        if (dirMode !== 0o700 || fileMode !== 0o600) {
          closeSync(fd);
          return;
        }
      } catch {
        try {
          closeSync(fd);
        } catch {
          // best-effort close of an fd we will not write unredacted bytes to
        }
        return;
      }
    }
    this.fd = fd;
    this.currentDay = today;
  }

  private dayStamp(): string {
    return this.now().toISOString().split('T')[0];
  }

  private pathForDay(day: string): string {
    return join(this.directory, `server-${day}.ndjson`);
  }

  private applyRetentionForDay(today: string): void {
    if (this.lastRetentionDay === today) return;
    this.lastRetentionDay = today;
    try {
      const files = this.listLogFiles();
      const oldestRetainedDay = new Date(`${today}T00:00:00.000Z`);
      oldestRetainedDay.setUTCDate(
        oldestRetainedDay.getUTCDate() - (this.retention.maxAgeDays - 1),
      );
      const oldestRetainedDate = oldestRetainedDay.toISOString().split('T')[0];
      const remove = new Set(
        files
          .filter(
            (file) => file.date !== today && file.date < oldestRetainedDate,
          )
          .map((file) => file.name),
      );

      let retainedBytes = files
        .filter((file) => !remove.has(file.name))
        .reduce((total, file) => total + file.size, 0);
      for (const file of files) {
        if (retainedBytes <= this.retention.maxBytes) break;
        if (file.date === today || remove.has(file.name)) continue;
        remove.add(file.name);
        retainedBytes -= file.size;
      }

      let removedCount = 0;
      for (const file of files) {
        if (!remove.has(file.name)) continue;
        try {
          unlinkSync(file.path);
          removedCount += 1;
        } catch {
          // ENOENT race or similar; nothing to remove
        }
      }
      if (removedCount > 0) {
        countInstrument('serverLogStoreRetentionRemovedFiles', removedCount);
      }
    } catch {
      // Retention is best-effort and must never block logging.
    }
  }

  private listLogFiles(): LogFileInfo[] {
    let names: string[];
    try {
      names = readdirSync(this.directory);
    } catch {
      return [];
    }
    const files: LogFileInfo[] = [];
    for (const name of names) {
      const match = SERVER_LOG_FILE_PATTERN.exec(name);
      if (!match) continue;
      const path = join(this.directory, name);
      try {
        const info = statSync(path);
        files.push({ name, path, date: match[1], size: info.size });
      } catch {
        // File disappeared between readdir and stat; skip it.
      }
    }
    return files.sort((left, right) => left.name.localeCompare(right.name));
  }
}

export function createServerLogStore(
  options: CreateServerLogStoreOptions,
): ServerLogStore {
  return new FsServerLogStore(options);
}

let installedSink: ServerLogStore | undefined;

/** Installs the process-wide server log sink. Idempotent per call — a later
 * call replaces the earlier sink (used by tests and by hot config reload).
 * Closes the replaced instance's fd first, so a double-install can't orphan
 * an open descriptor. */
export function installServerLogSink(
  options: CreateServerLogStoreOptions,
): ServerLogStore {
  const previous = installedSink;
  installedSink = createServerLogStore(options);
  if (previous) {
    try {
      previous.close();
    } catch {
      // best-effort; never let closing the old sink block installing the new one
    }
  }
  return installedSink;
}

/** The sink every `Logger` write tees into, once installed. Returns
 * `undefined` before boot has installed one — logger writes stay stdout-only. */
export function getInstalledServerLogSink(): ServerLogStore | undefined {
  return installedSink;
}

/** Test-only escape hatch to reset process-wide sink state between tests. */
export function resetServerLogSinkForTests(): void {
  installedSink?.close();
  installedSink = undefined;
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
