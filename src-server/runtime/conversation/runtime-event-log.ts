import { createReadStream, existsSync } from 'node:fs';
import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

interface RuntimeLogger {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
}

const EVENT_FILE_PATTERN = /^events-(\d{4}-\d{2}-\d{2})\.ndjson$/;
const MIB = 1024 * 1024;

export const DEFAULT_EVENT_LOG_RETENTION = {
  maxAgeDays: 30,
  maxBytes: 256 * MIB,
} as const;

interface EventLogRetentionPolicy {
  maxAgeDays: number;
  maxBytes: number;
}

interface RuntimeEventLogOptions {
  retention?: Partial<EventLogRetentionPolicy>;
  now?: () => Date;
}

interface EventLogFile {
  name: string;
  path: string;
  date: string;
  size: number;
}

export class RuntimeEventLog {
  private readonly retention: EventLogRetentionPolicy;
  private readonly now: () => Date;
  // Only file identity and timestamp bounds are retained, never event payloads.
  // Bounds come from contents: a file named for today may contain OTLP backfill.
  private readonly timeBounds = new Map<
    string,
    {
      signature: string;
      min: number;
      max: number;
    }
  >();
  private lastRetentionDay?: string;
  private retentionInFlight?: Promise<RetentionResult>;

  constructor(
    private readonly eventLogPath: string,
    private readonly logger: RuntimeLogger,
    options: RuntimeEventLogOptions = {},
  ) {
    this.retention = {
      maxAgeDays:
        options.retention?.maxAgeDays ??
        readPositiveInteger(
          process.env.STATION_EVENT_LOG_RETENTION_DAYS,
          DEFAULT_EVENT_LOG_RETENTION.maxAgeDays,
        ),
      maxBytes:
        options.retention?.maxBytes ??
        readPositiveInteger(
          process.env.STATION_EVENT_LOG_MAX_BYTES,
          DEFAULT_EVENT_LOG_RETENTION.maxBytes,
        ),
    };
    this.now = options.now ?? (() => new Date());
  }

  get directory(): string {
    return this.eventLogPath;
  }

  async queryEvents(
    start: number,
    end: number,
    userId: string,
  ): Promise<any[]> {
    const events: any[] = [];
    let names: string[];
    try {
      names = await readdir(this.eventLogPath);
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw error;
    }
    const files = names.filter((name) => EVENT_FILE_PATTERN.test(name)).sort();
    const present = new Set(files);
    for (const name of this.timeBounds.keys()) {
      if (!present.has(name)) this.timeBounds.delete(name);
    }
    for (const name of files) {
      const path = join(this.eventLogPath, name);
      try {
        const before = await eventFileSignature(path);
        const known = this.timeBounds.get(name);
        if (
          known?.signature === before &&
          (known.max < start || known.min > end)
        ) {
          continue;
        }
        let min = Number.POSITIVE_INFINITY;
        let max = Number.NEGATIVE_INFINITY;
        const stream = createReadStream(path);
        const lines = createInterface({ input: stream, crlfDelay: Infinity });
        try {
          for await (const line of lines) {
            if (!line.trim()) continue;
            let event: any;
            try {
              event = JSON.parse(line);
              const time = new Date(event.timestamp).getTime();
              if (!Number.isFinite(time)) continue;
              min = Math.min(min, time);
              max = Math.max(max, time);
              if (
                time >= start &&
                time <= end &&
                (event.userId === userId || event['station.user.id'] === userId)
              ) {
                events.push(event);
              }
            } catch (error) {
              this.logger.warn('Failed to parse event line', {
                file: name,
                error,
              });
            }
          }
        } finally {
          lines.close();
          stream.destroy();
        }
        // Do not memoize a partial observation during an append or replacement.
        if (before === (await eventFileSignature(path))) {
          this.timeBounds.set(name, { signature: before, min, max });
        } else {
          this.timeBounds.delete(name);
        }
      } catch (error) {
        this.timeBounds.delete(name);
        // Concurrent retention can remove a file. Other I/O failures must reach
        // the route's error response, never become an authoritative empty read.
        if (!isMissingFileError(error)) throw error;
      }
    }
    return events;
  }

  async loadRecentEvents(): Promise<void> {
    try {
      if (!existsSync(this.eventLogPath)) {
        await mkdir(this.eventLogPath, { recursive: true });
        this.logger.debug('Created monitoring directory', {
          path: this.eventLogPath,
        });
        return;
      }

      const retention = await this.applyRetentionForCurrentDay();
      const files = await this.listEventLogFiles();
      const recentFiles = files.slice().reverse().slice(0, 2);

      this.logger.info('Discovered persisted event logs', {
        fileCount: files.length,
        recentFileCount: recentFiles.length,
        recentBytes: recentFiles.reduce((total, file) => total + file.size, 0),
        retainedBytes: files.reduce((total, file) => total + file.size, 0),
        removedFileCount: retention.removedFileCount,
        removedBytes: retention.removedBytes,
        retentionDays: this.retention.maxAgeDays,
        retentionMaxBytes: this.retention.maxBytes,
      });
    } catch (error) {
      this.logger.error('Failed to load events from disk', { error });
    }
  }

  async persist(event: any): Promise<void> {
    try {
      if (!existsSync(this.eventLogPath)) {
        await mkdir(this.eventLogPath, { recursive: true });
      }

      try {
        await this.applyRetentionForCurrentDay();
      } catch (error) {
        this.logger.warn('Failed to apply monitoring event retention', {
          error,
        });
      }
      const logPath = this.getTodayEventLogPath();
      await appendFile(logPath, `${JSON.stringify(event)}\n`, 'utf-8');
    } catch (error) {
      this.logger.error('Failed to persist event', { error, event });
    }
  }

  private getTodayEventLogPath(): string {
    const today = this.now().toISOString().split('T')[0];
    return join(this.eventLogPath, `events-${today}.ndjson`);
  }

  private async listEventLogFiles(): Promise<EventLogFile[]> {
    const names = await readdir(this.eventLogPath);
    const files = await Promise.all(
      names.flatMap((name) => {
        const match = EVENT_FILE_PATTERN.exec(name);
        if (!match) return [];
        const path = join(this.eventLogPath, name);
        return [
          stat(path)
            .then((info) => ({
              name,
              path,
              date: match[1],
              size: info.size,
            }))
            .catch((error) => {
              if (isMissingFileError(error)) return null;
              throw error;
            }),
        ];
      }),
    );
    return files
      .filter((file): file is EventLogFile => file !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private async applyRetentionForCurrentDay(): Promise<RetentionResult> {
    const today = this.now().toISOString().split('T')[0];
    if (this.lastRetentionDay === today) {
      return { removedFileCount: 0, removedBytes: 0 };
    }
    if (this.retentionInFlight) {
      await this.retentionInFlight;
      if (this.lastRetentionDay === today) {
        return { removedFileCount: 0, removedBytes: 0 };
      }
    }

    const retention = this.applyRetention(today).then(
      (result) => {
        this.lastRetentionDay = today;
        return result;
      },
      (error) => {
        this.lastRetentionDay = today;
        throw error;
      },
    );
    this.retentionInFlight = retention;
    try {
      return await retention;
    } finally {
      if (this.retentionInFlight === retention) {
        this.retentionInFlight = undefined;
      }
    }
  }

  private async applyRetention(today: string): Promise<RetentionResult> {
    const files = await this.listEventLogFiles();
    const oldestRetainedDay = new Date(`${today}T00:00:00.000Z`);
    oldestRetainedDay.setUTCDate(
      oldestRetainedDay.getUTCDate() - (this.retention.maxAgeDays - 1),
    );
    const oldestRetainedDate = oldestRetainedDay.toISOString().split('T')[0];
    const remove = new Set(
      files
        .filter((file) => file.date !== today && file.date < oldestRetainedDate)
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

    const removedFiles = files.filter((file) => remove.has(file.name));
    await Promise.all(
      removedFiles.map(async (file) => {
        try {
          await unlink(file.path);
        } catch (error) {
          if (!isMissingFileError(error)) throw error;
        }
      }),
    );
    return {
      removedFileCount: removedFiles.length,
      removedBytes: removedFiles.reduce((total, file) => total + file.size, 0),
    };
  }
}

interface RetentionResult {
  removedFileCount: number;
  removedBytes: number;
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

async function eventFileSignature(path: string): Promise<string> {
  const info = await stat(path, { bigint: true });
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}
