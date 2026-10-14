import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import {
  KnowledgeStoreConflictError,
  KnowledgeStoreCorruptionError,
  KnowledgeStoreUnavailableError,
} from '../knowledge-store/errors.js';
import { knowledgeStoreTransactionOps } from '../telemetry/metrics.js';

/**
 * On-disk protocol of a Project document root. These names and the journal
 * shape are deliberately the ones Station has always written under a
 * namespace's document directory, so a journal left by an earlier Station
 * build is recovered here, and a root this module writes stays readable by
 * that build. Changing any of them is a migration, not a refactor.
 */
const JOURNAL_VERSION = 1;
const JOURNAL_FILE = '.station-knowledge-transaction.json';
const LEGACY_LOCK_FILE = '.station-knowledge-mutation';
/** Relative to the Station home; the lock name is the root's identity. */
const DOCUMENT_ROOT_COORDINATION_DIRECTORY = join(
  'coordination',
  'knowledge-file-transactions',
);

type JournalEntry = {
  path: string;
  before: string | null;
  after: string | null;
};

type Journal = {
  version: typeof JOURNAL_VERSION;
  transactionId: string;
  operation: string;
  phase: 'prepared' | 'committed';
  entries: JournalEntry[];
};

type TransactionContext = {
  journal: Journal;
  observed: Map<string, string>;
  observedExternal: Map<string, string>;
  observedDirectories: Map<string, string>;
  staged: Map<string, Buffer | null>;
  closed: boolean;
};

export type ProjectDocumentDirectoryEntry = {
  name: string;
  kind: 'file' | 'directory';
};

/**
 * The checked file capability one document transaction lends its callback.
 * Writes are staged in memory and published only after the callback returns
 * and its read set still matches disk. It is inert once the transaction ends.
 */
export interface ProjectDocumentFiles {
  readText(path: string): string | null;
  /** Reads a file outside the root and fails the commit if it changes. */
  readExternalText(path: string): string | null;
  writeText(path: string, value: string): void;
  remove(path: string): void;
  listDirectoryEntries(path: string): ProjectDocumentDirectoryEntry[];
}

export interface ProjectDocumentTransactionFaults {
  afterLockAcquired?: () => void;
  beforeFileReplace?: (path: string) => void;
  afterJournalWrite?: (journal: Readonly<Journal>) => void;
  afterFilePublish?: (path: string) => void;
  afterCommitMarker?: (journal: Readonly<Journal>) => void;
}

function unavailable(error: unknown): KnowledgeStoreUnavailableError {
  return error instanceof KnowledgeStoreUnavailableError
    ? error
    : new KnowledgeStoreUnavailableError({ cause: error });
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT';
}

function digest(value: Buffer | null): string {
  return value === null
    ? 'missing'
    : createHash('sha256').update(value).digest('hex');
}

function isCanonicalBase64(value: string): boolean {
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function lockIdentity(
  rootRealpath: string,
  device: number,
  inode: number,
): string {
  return createHash('sha256')
    .update(`${rootRealpath}\0${device}\0${inode}`)
    .digest('hex');
}

function readDirectoryEntries(path: string): ProjectDocumentDirectoryEntry[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .map((entry) => {
        if (entry.isSymbolicLink()) {
          throw new KnowledgeStoreCorruptionError(
            `Knowledge directory contains a symlink: ${join(path, entry.name)}`,
          );
        }
        if (entry.isDirectory()) {
          return { name: entry.name, kind: 'directory' as const };
        }
        if (entry.isFile()) {
          return { name: entry.name, kind: 'file' as const };
        }
        throw new KnowledgeStoreCorruptionError(
          `Knowledge directory contains an unsupported entry: ${join(path, entry.name)}`,
        );
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    if (isMissing(error)) return [];
    if (error instanceof KnowledgeStoreCorruptionError) throw error;
    throw unavailable(error);
  }
}

/**
 * One crash-safe, multi-file publication boundary for a Project document root
 * (a knowledge namespace's `metadata.json` and `files/` tree). Constructed only
 * by {@link ProjectFileTransactions}, which holds the Project lock around it.
 *
 * The journal is durable before any target is replaced. A prepared journal is
 * rolled back on the next locked read or mutation unless its complete
 * after-image already matches disk; a committed journal is cleanup only. This
 * gives callers atomic visibility without pretending several renames are one
 * OS transaction.
 */
export class ProjectDocumentRoot {
  private readonly root: string;
  private readonly journalPath: string;
  private readonly lockPath: string;
  private readonly rootDevice: number;
  private readonly rootInode: number;
  private readonly rootRealpath: string;

  constructor(
    root: string,
    stationHome: string,
    private readonly faults: ProjectDocumentTransactionFaults = {},
  ) {
    this.root = resolve(root);
    this.journalPath = join(this.root, JOURNAL_FILE);
    try {
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      const rootInfo = lstatSync(this.root);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
        throw new KnowledgeStoreCorruptionError(
          'Knowledge store root must be a real directory, not a symlink',
        );
      }
      this.rootDevice = rootInfo.dev;
      this.rootInode = rootInfo.ino;
      this.rootRealpath = realpathSync(this.root);
      // The root lock lives in the Station home, not beside the root: a
      // configured namespace directory may sit under a read-only parent, and
      // two Projects configured onto one directory must share one lock. The
      // name is the root's identity, so adjacent roots never collide.
      const coordinationRoot = join(
        resolve(stationHome),
        DOCUMENT_ROOT_COORDINATION_DIRECTORY,
      );
      mkdirSync(coordinationRoot, { recursive: true, mode: 0o700 });
      const coordinationInfo = lstatSync(coordinationRoot);
      if (
        !coordinationInfo.isDirectory() ||
        coordinationInfo.isSymbolicLink() ||
        (process.getuid !== undefined &&
          (coordinationInfo.uid !== process.getuid() ||
            (coordinationInfo.mode & 0o077) !== 0))
      ) {
        throw new KnowledgeStoreCorruptionError(
          'Knowledge lock coordination root is not private to this user',
        );
      }
      this.lockPath = join(
        coordinationRoot,
        `${lockIdentity(this.rootRealpath, this.rootDevice, this.rootInode)}.lock`,
      );
    } catch (error) {
      if (error instanceof KnowledgeStoreCorruptionError) throw error;
      throw unavailable(error);
    }
  }

  async run<T>(
    operation: string,
    body: (files: ProjectDocumentFiles) => T | Promise<T>,
  ): Promise<T> {
    let release: () => Promise<void>;
    try {
      this.validateRootIdentity();
      release = await acquireFileMutationLockAsync(this.lockPath);
    } catch (error) {
      this.observe(operation, 'unavailable');
      throw error instanceof KnowledgeStoreCorruptionError
        ? error
        : unavailable(error);
    }
    try {
      this.faults.afterLockAcquired?.();
      this.validateRootIdentity();
      this.recoverLocked();
      const context: TransactionContext = {
        journal: {
          version: JOURNAL_VERSION,
          transactionId: randomUUID(),
          operation,
          phase: 'prepared',
          entries: [],
        },
        observed: new Map(),
        observedExternal: new Map(),
        observedDirectories: new Map(),
        staged: new Map(),
        closed: false,
      };
      let result: T;
      try {
        result = await body(this.capability(context));
      } catch (error) {
        // The body only stages after-images in memory. Nothing is published,
        // so a filesystem rollback here could overwrite an external writer
        // that correctly caused the body to fail.
        this.observe(operation, 'rejected');
        throw error;
      } finally {
        context.closed = true;
      }
      try {
        this.verifyReadSet(context);
        if (context.journal.entries.length === 0) return result;
        this.persistJournal(context.journal);
        for (const entry of this.publicationOrder(context.journal.entries)) {
          this.validateRootIdentity();
          const path = join(this.root, entry.path);
          const value = context.staged.get(entry.path) ?? null;
          if (value === null) this.removePublished(path);
          else this.atomicWrite(path, value);
          this.faults.afterFilePublish?.(path);
        }
        context.journal.phase = 'committed';
        this.persistJournal(context.journal);
        this.faults.afterCommitMarker?.(context.journal);
        this.removeJournal();
        this.observe(operation, 'applied');
        return result;
      } catch (error) {
        if (context.journal.phase === 'prepared') {
          this.rollback(context.journal);
          this.removeJournal();
        } else if (this.allEntriesMatch(context.journal, 'after')) {
          // Every target is durably published. A lost commit-marker response
          // or cleanup error cannot turn that applied fact into a failure that
          // invites a duplicate retry.
          this.observe(operation, 'applied-readback');
          return result;
        }
        this.observe(
          operation,
          error instanceof KnowledgeStoreConflictError
            ? 'conflict'
            : 'unavailable',
        );
        throw error instanceof KnowledgeStoreConflictError ||
          error instanceof KnowledgeStoreCorruptionError
          ? error
          : unavailable(error);
      }
    } finally {
      try {
        await release();
      } catch {
        // Releasing the lock is cleanup; it cannot rewrite an outcome.
        this.observe(operation, 'lock-release-unavailable');
      }
    }
  }

  private capability(context: TransactionContext): ProjectDocumentFiles {
    const open = () => {
      if (context.closed) {
        throw new Error('Knowledge document transaction is closed');
      }
    };
    return Object.freeze({
      readText: (path: string) => {
        open();
        const buffer = this.readBuffer(context, path);
        return buffer === null ? null : buffer.toString('utf8');
      },
      readExternalText: (path: string) => {
        open();
        const absolute = resolve(path);
        const value = this.readExternalPublished(absolute);
        if (!context.observedExternal.has(absolute)) {
          context.observedExternal.set(absolute, digest(value));
        }
        return value === null ? null : value.toString('utf8');
      },
      writeText: (path: string, value: string) => {
        open();
        this.writeBuffer(context, path, Buffer.from(value, 'utf8'));
      },
      remove: (path: string) => {
        open();
        this.writeBuffer(context, path, null);
      },
      listDirectoryEntries: (path: string) => {
        open();
        return this.listDirectoryEntries(context, path);
      },
    });
  }

  private listDirectoryEntries(
    context: TransactionContext,
    path: string,
  ): ProjectDocumentDirectoryEntry[] {
    const rel = relative(this.root, resolve(path));
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new KnowledgeStoreCorruptionError(
        `Knowledge directory escapes the store root: ${path}`,
      );
    }
    this.assertNoSymlink(path);
    const entries = readDirectoryEntries(path);
    if (!context.observedDirectories.has(rel)) {
      context.observedDirectories.set(rel, JSON.stringify(entries));
    }
    return entries;
  }

  private relativePath(path: string): string {
    const absolute = resolve(path);
    const rel = relative(this.root, absolute);
    if (
      !rel ||
      rel === '..' ||
      rel.startsWith(`..${sep}`) ||
      isAbsolute(rel) ||
      rel === JOURNAL_FILE ||
      rel === LEGACY_LOCK_FILE
    ) {
      throw new KnowledgeStoreCorruptionError(
        `Knowledge transaction path escapes or targets internal state: ${path}`,
      );
    }
    return rel;
  }

  /**
   * Canonicalizes a retained journal path with the host's native path rules.
   * POSIX `\\` is a literal filename character, not a separator; rewriting it
   * would make a legitimate crashed journal unrecoverable.
   */
  private canonicalJournalPath(path: string): string {
    return this.relativePath(join(this.root, path));
  }

  private readBuffer(context: TransactionContext, path: string): Buffer | null {
    const rel = this.relativePath(path);
    if (context.staged.has(rel)) return context.staged.get(rel) ?? null;
    const value = this.readPublished(path);
    if (!context.observed.has(rel)) context.observed.set(rel, digest(value));
    return value;
  }

  private readPublished(path: string): Buffer | null {
    this.assertNoSymlink(path);
    try {
      return readFileSync(path);
    } catch (error) {
      if (isMissing(error)) return null;
      throw unavailable(error);
    }
  }

  private readExternalPublished(path: string): Buffer | null {
    try {
      return readFileSync(path);
    } catch (error) {
      if (isMissing(error)) return null;
      throw unavailable(error);
    }
  }

  private writeBuffer(
    context: TransactionContext,
    path: string,
    value: Buffer | null,
  ): void {
    const rel = this.relativePath(path);
    const current = this.readBuffer(context, path);
    let entry = context.journal.entries.find(
      (candidate) => candidate.path === rel,
    );
    if (entry) {
      entry.after = value?.toString('base64') ?? null;
    } else {
      const observed = context.observed.get(rel);
      if (observed !== undefined && observed !== digest(current)) {
        throw new KnowledgeStoreConflictError(rel);
      }
      entry = {
        path: rel,
        before: current?.toString('base64') ?? null,
        after: value?.toString('base64') ?? null,
      };
      context.journal.entries.push(entry);
    }
    context.staged.set(rel, value);
    context.observed.set(rel, digest(value));
  }

  private verifyReadSet(context: TransactionContext): void {
    const stagedPaths = new Set(
      context.journal.entries.map((entry) => entry.path),
    );
    for (const entry of context.journal.entries) {
      const before =
        entry.before === null ? null : Buffer.from(entry.before, 'base64');
      if (
        digest(this.readPublished(join(this.root, entry.path))) !==
        digest(before)
      ) {
        throw new KnowledgeStoreConflictError(entry.path);
      }
    }
    for (const [rel, expected] of context.observed) {
      if (stagedPaths.has(rel)) continue;
      if (digest(this.readPublished(join(this.root, rel))) !== expected) {
        throw new KnowledgeStoreConflictError(rel);
      }
    }
    for (const [rel, expected] of context.observedDirectories) {
      const current = readDirectoryEntries(join(this.root, rel));
      if (JSON.stringify(current) !== expected) {
        throw new KnowledgeStoreConflictError(rel || '.');
      }
    }
    for (const [path, expected] of context.observedExternal) {
      if (digest(this.readExternalPublished(path)) !== expected) {
        throw new KnowledgeStoreConflictError(path);
      }
    }
  }

  /** Documents first, then metadata, then removals. */
  private publicationOrder(entries: JournalEntry[]): JournalEntry[] {
    const rank = (entry: JournalEntry) => {
      if (entry.after === null) return 2;
      return entry.path === 'metadata.json' ? 1 : 0;
    };
    return [...entries].sort((left, right) => rank(left) - rank(right));
  }

  /**
   * Resolves whatever a crashed writer left before this transaction may read.
   * A journal is never ignored: it is completed, rolled back, or the root is
   * refused (corrupt journal, or bytes matching neither side).
   */
  private recoverLocked(): void {
    const journal = this.loadJournal();
    if (!journal) return;
    if (journal.phase === 'prepared') {
      if (this.allEntriesMatch(journal, 'after')) {
        // Crash after the final publish but before the commit marker.
        this.observe(journal.operation, 'commit-readback');
      } else {
        this.rollback(journal);
        this.observe(journal.operation, 'recovered');
      }
    } else {
      this.observe(journal.operation, 'commit-cleanup');
    }
    this.removeJournal();
  }

  private allEntriesMatch(journal: Journal, side: 'before' | 'after'): boolean {
    return journal.entries.every((entry) => {
      const encoded = entry[side];
      const expected = encoded === null ? null : Buffer.from(encoded, 'base64');
      return (
        digest(this.readPublished(join(this.root, entry.path))) ===
        digest(expected)
      );
    });
  }

  private observe(operation: string, outcome: string): void {
    try {
      knowledgeStoreTransactionOps.add(1, { operation, outcome });
    } catch {
      // Telemetry is an observer, never storage authority.
    }
  }

  private rollback(journal: Journal): void {
    this.validateRootIdentity();
    for (const entry of [...journal.entries].reverse()) {
      const path = join(this.root, entry.path);
      const current = this.readPublished(path);
      const before =
        entry.before === null ? null : Buffer.from(entry.before, 'base64');
      const after =
        entry.after === null ? null : Buffer.from(entry.after, 'base64');
      if (digest(current) === digest(before)) continue;
      if (digest(current) !== digest(after)) {
        throw new KnowledgeStoreConflictError(entry.path);
      }
      if (before === null) this.removePublished(path);
      else this.atomicWrite(path, before);
    }
  }

  private loadJournal(): Journal | null {
    let raw: string;
    try {
      raw = readFileSync(this.journalPath, 'utf8');
    } catch (error) {
      if (isMissing(error)) return null;
      throw unavailable(error);
    }
    try {
      const value = JSON.parse(raw) as Partial<Journal>;
      if (
        value.version !== JOURNAL_VERSION ||
        typeof value.transactionId !== 'string' ||
        typeof value.operation !== 'string' ||
        (value.phase !== 'prepared' && value.phase !== 'committed') ||
        !Array.isArray(value.entries) ||
        value.entries.some(
          (entry) =>
            !entry ||
            typeof entry.path !== 'string' ||
            (entry.before !== null &&
              (typeof entry.before !== 'string' ||
                !isCanonicalBase64(entry.before))) ||
            (entry.after !== null &&
              (typeof entry.after !== 'string' ||
                !isCanonicalBase64(entry.after))),
        )
      ) {
        throw new Error('unexpected journal shape');
      }
      const paths = new Set<string>();
      for (const entry of value.entries) {
        const canonical = this.canonicalJournalPath(entry.path);
        if (canonical !== entry.path) {
          throw new Error('non-canonical journal path');
        }
        if (paths.has(canonical)) throw new Error('duplicate journal path');
        paths.add(canonical);
      }
      return value as Journal;
    } catch (error) {
      throw new KnowledgeStoreCorruptionError(
        'Knowledge transaction journal is corrupt; refusing to read or mutate the store',
        { cause: error },
      );
    }
  }

  private persistJournal(journal: Journal): void {
    this.atomicWrite(
      this.journalPath,
      Buffer.from(`${JSON.stringify(journal)}\n`, 'utf8'),
    );
    this.faults.afterJournalWrite?.(journal);
  }

  private removeJournal(): void {
    this.removePublished(this.journalPath);
  }

  private atomicWrite(path: string, value: Buffer): void {
    const directory = dirname(path);
    this.assertNoSymlink(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.assertNoSymlink(path);
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
      writeFileSync(descriptor, value);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      this.faults.beforeFileReplace?.(path);
      this.validateRootIdentity();
      renameSync(temporary, path);
      this.syncDirectory(directory);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try {
        this.validateRootIdentity();
        rmSync(temporary, { force: true });
      } catch {
        // If the root identity changed, never follow the replacement path
        // merely to clean a temporary in the old directory.
      }
    }
  }

  private removePublished(path: string): void {
    this.assertNoSymlink(path);
    try {
      this.faults.beforeFileReplace?.(path);
      this.validateRootIdentity();
      unlinkSync(path);
      this.syncDirectory(dirname(path));
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  private syncDirectory(directory: string): void {
    const descriptor = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }

  private assertNoSymlink(path: string): void {
    const rel = relative(this.root, resolve(path));
    const parts = rel.split(sep).filter(Boolean);
    let current = this.root;
    for (const part of parts) {
      current = join(current, part);
      try {
        if (lstatSync(current).isSymbolicLink()) {
          throw new KnowledgeStoreCorruptionError(
            `Knowledge store path contains a symlink: ${current}`,
          );
        }
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
    }
  }

  private validateRootIdentity(): void {
    try {
      const current = lstatSync(this.root);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== this.rootDevice ||
        current.ino !== this.rootInode ||
        realpathSync(this.root) !== this.rootRealpath
      ) {
        throw new KnowledgeStoreCorruptionError(
          'Knowledge store root identity changed after composition',
        );
      }
    } catch (error) {
      if (error instanceof KnowledgeStoreCorruptionError) throw error;
      throw new KnowledgeStoreUnavailableError({ cause: error });
    }
  }
}
