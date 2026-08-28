import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  attachmentBlobBytesReclaimed,
  attachmentBlobBytesStored,
  attachmentBlobOperations,
} from '../../telemetry/metrics.js';

interface BlobStoreLogger {
  debug: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

const MIB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_ATTACHMENT_BLOB_RETENTION = {
  maxAgeDays: 90,
  maxBytes: 512 * MIB,
} as const;

export interface AttachmentBlobRetentionPolicy {
  maxAgeDays: number;
  maxBytes: number;
}

/**
 * `sha256-` plus 64 lowercase hex characters, and nothing else. Every path this
 * store builds is derived from a value that matched this, so a reference read
 * back out of a persisted event cannot name a file outside the store's root —
 * the ref never reaches the filesystem unvalidated.
 */
const BLOB_REF_PATTERN = /^sha256-[0-9a-f]{64}$/;

export function isAttachmentBlobRef(value: unknown): value is string {
  return typeof value === 'string' && BLOB_REF_PATTERN.test(value);
}

export interface AttachmentBlobStoreOptions {
  rootDir: string;
  logger?: BlobStoreLogger;
  retention?: Partial<AttachmentBlobRetentionPolicy>;
  now?: () => number;
}

interface BlobFile {
  path: string;
  size: number;
  modifiedAt: number;
}

/**
 * Telemetry observes this store; it is never a condition of it. This store
 * sits on the persistence path, so an instrument that is absent or that throws
 * must not be able to fail a write, or lose a read the file was there for.
 *
 * The instrument is passed as a thunk rather than a value on purpose: a test
 * double that replaces the metrics module without listing an export makes the
 * NAME itself throw on access, before any `.add` call could be guarded. The
 * codebase has already lost a counter to exactly that, silently.
 */
function count(
  instrument: () => {
    add: (value: number, attributes?: Record<string, string>) => void;
  },
  value: number,
  attributes?: Record<string, string>,
): void {
  try {
    instrument().add(value, attributes);
  } catch {
    // Observation only.
  }
}

/**
 * Content-addressed storage for chat attachment bytes (archive#3374).
 *
 * The event log records that a turn carried `screenshot.png`; this holds the
 * pixels. Addressing by SHA-256 of the decoded bytes means the same image
 * pasted into ten turns is stored once, and a reference is valid for exactly
 * one byte sequence — a corrupted or substituted file cannot masquerade as the
 * original, because {@link read} re-derives the digest before returning it.
 *
 * Every method is synchronous on purpose: its caller is `EventStore.appendEvent`,
 * which runs inside a SQLite savepoint on the single-threaded persistence path.
 *
 * Nothing here is authoritative: a failed write returns `undefined` so the
 * caller keeps the bytes inline rather than losing them, and a failed read
 * returns `undefined` so the caller can render an honest placeholder. Losing an
 * attachment must never fail a turn.
 */
export class AttachmentBlobStore {
  private readonly rootDir: string;
  private readonly logger?: BlobStoreLogger;
  private readonly retention: AttachmentBlobRetentionPolicy;
  private readonly now: () => number;
  private lastRetentionDay?: number;

  constructor(options: AttachmentBlobStoreOptions) {
    this.rootDir = options.rootDir;
    this.logger = options.logger;
    this.now = options.now ?? (() => Date.now());
    this.retention = {
      maxAgeDays:
        options.retention?.maxAgeDays ??
        readPositiveInteger(
          process.env.STATION_ATTACHMENT_RETENTION_DAYS,
          DEFAULT_ATTACHMENT_BLOB_RETENTION.maxAgeDays,
        ),
      maxBytes:
        options.retention?.maxBytes ??
        readPositiveInteger(
          process.env.STATION_ATTACHMENT_MAX_BYTES,
          DEFAULT_ATTACHMENT_BLOB_RETENTION.maxBytes,
        ),
    };
  }

  get directory(): string {
    return this.rootDir;
  }

  /**
   * Store `base64` and return its reference, or `undefined` when the bytes
   * could not be written. The caller treats `undefined` as "keep them inline".
   */
  write(base64: string): string | undefined {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(base64, 'base64');
    } catch {
      return undefined;
    }
    if (bytes.length === 0) return undefined;
    const digest = createHash('sha256').update(bytes).digest('hex');
    const ref = `sha256-${digest}`;
    const path = this.pathForDigest(digest);
    // Sweep BEFORE storing, never after: a sweep that runs on the way out can
    // reclaim the very blob this call is about to return a reference to, and
    // the caller would persist a reference to nothing.
    this.applyRetention();
    try {
      if (existsSync(path)) {
        // A turn referencing these bytes today makes them referenced today.
        // Without this a blob written 45 days ago and re-attached this morning
        // is still reclaimed on its original clock, taking a live attachment.
        this.touch(path);
        count(() => attachmentBlobOperations, 1, {
          operation: 'write',
          outcome: 'dedup',
        });
        return ref;
      }
      mkdirSync(join(this.rootDir, digest.slice(0, 2)), { recursive: true });
      // Same-directory rename so a reader never observes a partially written
      // blob under a name that promises a complete one.
      const staging = `${path}.${randomBytes(8).toString('hex')}.part`;
      writeFileSync(staging, bytes);
      renameSync(staging, path);
      count(() => attachmentBlobOperations, 1, {
        operation: 'write',
        outcome: 'stored',
      });
      count(() => attachmentBlobBytesStored, bytes.length);
      return ref;
    } catch (error) {
      count(() => attachmentBlobOperations, 1, {
        operation: 'write',
        outcome: 'failed',
      });
      this.logger?.warn('Attachment blob write failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /** {@link readBytes} as base64, for rehydrating a persisted data URL. */
  read(ref: string): string | undefined {
    return this.readBytes(ref)?.toString('base64');
  }

  /**
   * Resolve a reference back to its bytes, or `undefined` when the blob is
   * gone (reclaimed by retention, or never written). Bytes whose digest does
   * not match the reference they were fetched by are refused rather than
   * returned — a reference names exactly one byte sequence, so anything else
   * under that name is not the attachment, whatever put it there.
   */
  readBytes(ref: string): Buffer | undefined {
    if (!isAttachmentBlobRef(ref)) {
      count(() => attachmentBlobOperations, 1, {
        operation: 'read',
        outcome: 'invalid_ref',
      });
      return undefined;
    }
    const digest = ref.slice('sha256-'.length);
    try {
      const bytes = readFileSync(this.pathForDigest(digest));
      if (createHash('sha256').update(bytes).digest('hex') !== digest) {
        count(() => attachmentBlobOperations, 1, {
          operation: 'read',
          outcome: 'digest_mismatch',
        });
        return undefined;
      }
      // A blob someone just read is a blob still in use; retention's age
      // clock must hear about it or a transcript being actively viewed can
      // have its images reclaimed out from under it.
      this.touch(this.pathForDigest(digest));
      count(() => attachmentBlobOperations, 1, {
        operation: 'read',
        outcome: 'hit',
      });
      return bytes;
    } catch {
      count(() => attachmentBlobOperations, 1, {
        operation: 'read',
        outcome: 'miss',
      });
      return undefined;
    }
  }

  /**
   * Delete one blob by reference. The caller owns the decision that nothing
   * references it any more; this only carries it out, and reports nothing —
   * a blob already gone is the outcome the caller wanted.
   */
  removeByRef(ref: string): void {
    if (!isAttachmentBlobRef(ref)) return;
    const digest = ref.slice('sha256-'.length);
    const path = this.pathForDigest(digest);
    try {
      const size = statSync(path).size;
      rmSync(path);
      count(() => attachmentBlobBytesReclaimed, size);
      count(() => attachmentBlobOperations, 1, {
        operation: 'reclaim',
        outcome: 'unreferenced',
      });
    } catch {
      // Absent already, or unlinkable; retention is the backstop either way.
    }
  }

  /**
   * Age pass then size pass, oldest first — the same two axes and the same
   * order `RuntimeEventLog` and `ServerLogStore` already use. Runs at most
   * once a day, and only on a write, so an idle Station never walks the tree.
   */
  applyRetention(options?: { force?: boolean }): void {
    const today = Math.floor(this.now() / DAY_MS);
    if (!options?.force && this.lastRetentionDay === today) return;
    this.lastRetentionDay = today;
    let files: BlobFile[];
    try {
      files = this.listBlobs();
    } catch (error) {
      this.logger?.warn('Attachment blob retention could not list the store', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const cutoff = this.now() - this.retention.maxAgeDays * DAY_MS;
    const retained: BlobFile[] = [];
    let reclaimed = 0;
    for (const file of files) {
      if (file.modifiedAt < cutoff) {
        reclaimed += this.remove(file);
        continue;
      }
      retained.push(file);
    }
    retained.sort((a, b) => a.modifiedAt - b.modifiedAt);
    let retainedBytes = retained.reduce((total, file) => total + file.size, 0);
    for (const file of retained) {
      if (retainedBytes <= this.retention.maxBytes) break;
      const removed = this.remove(file);
      retainedBytes -= removed;
      reclaimed += removed;
    }
    if (reclaimed > 0) {
      count(() => attachmentBlobBytesReclaimed, reclaimed);
      this.logger?.debug('Attachment blob retention reclaimed bytes', {
        bytes: reclaimed,
        retentionDays: this.retention.maxAgeDays,
      });
    }
  }

  private remove(file: BlobFile): number {
    try {
      rmSync(file.path);
      count(() => attachmentBlobOperations, 1, {
        operation: 'reclaim',
        outcome: 'removed',
      });
      return file.size;
    } catch (error) {
      count(() => attachmentBlobOperations, 1, {
        operation: 'reclaim',
        outcome: 'failed',
      });
      this.logger?.warn('Attachment blob could not be reclaimed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  private listBlobs(): BlobFile[] {
    if (!existsSync(this.rootDir)) return [];
    const blobs: BlobFile[] = [];
    for (const shard of readdirSync(this.rootDir, { withFileTypes: true })) {
      if (!shard.isDirectory() || !/^[0-9a-f]{2}$/.test(shard.name)) continue;
      const shardDir = join(this.rootDir, shard.name);
      for (const entry of readdirSync(shardDir, { withFileTypes: true })) {
        if (!entry.isFile() || !/^[0-9a-f]{64}$/.test(entry.name)) continue;
        const path = join(shardDir, entry.name);
        try {
          const stats = statSync(path);
          blobs.push({ path, size: stats.size, modifiedAt: stats.mtimeMs });
        } catch {
          // A blob removed by a concurrent sweep is already reclaimed.
        }
      }
    }
    return blobs;
  }

  /**
   * Move a blob's retention clock to now. Best-effort: failing to record that
   * something is still referenced must never fail the operation that
   * referenced it.
   */
  private touch(path: string): void {
    try {
      const when = new Date(this.now());
      utimesSync(path, when, when);
    } catch {
      // The blob is still readable; only its retention clock is stale.
    }
  }

  private pathForDigest(digest: string): string {
    return join(this.rootDir, digest.slice(0, 2), digest);
  }
}

function readPositiveInteger(
  value: string | undefined,
  fallback: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
