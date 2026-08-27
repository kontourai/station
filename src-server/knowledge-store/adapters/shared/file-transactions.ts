import { AsyncLocalStorage } from 'node:async_hooks';
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
import { knowledgeStoreTransactionOps } from '../../../telemetry/metrics.js';
import { resolveHomeDir } from '../../../utils/paths.js';
import {
  isKnowledgeStoreError,
  KnowledgeStoreConflictError,
  KnowledgeStoreCorruptionError,
  KnowledgeStoreUnavailableError,
} from '../../errors.js';

const JOURNAL_VERSION = 1;
const JOURNAL_FILE = '.station-knowledge-transaction.json';
const LEGACY_LOCK_FILE = '.station-knowledge-mutation';
const COORDINATION_DIRECTORY = join(
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
};

export type KnowledgeDirectoryEntry = {
  name: string;
  kind: 'file' | 'directory';
};

export type KnowledgeFileTransactionHooks = {
  afterLockAcquired?: () => void;
  beforeFileReplace?: (path: string) => void;
  afterJournalWrite?: (journal: Readonly<Journal>) => void;
  afterFilePublish?: (path: string) => void;
  afterCommitMarker?: (journal: Readonly<Journal>) => void;
};

export { KnowledgeStoreConflictError, KnowledgeStoreCorruptionError };

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

/**
 * One crash-safe publication boundary for a file-backed knowledge root.
 *
 * The journal is durable before every target replacement. A prepared journal
 * is rolled back on the next locked read or mutation; a committed journal is
 * only cleanup debris. This deliberately provides atomic visibility to Station
 * callers without pretending several filesystem renames form one OS transaction.
 */
export class KnowledgeFileTransactions {
  private readonly root: string;
  private readonly journalPath: string;
  private readonly lockPath: string;
  private readonly storage = new AsyncLocalStorage<TransactionContext>();
  private readonly hooks: KnowledgeFileTransactionHooks;
  private readonly rootDevice!: number;
  private readonly rootInode!: number;
  private readonly rootRealpath!: string;

  constructor(root: string, hooks: KnowledgeFileTransactionHooks = {}) {
    this.root = resolve(root);
    this.journalPath = join(this.root, JOURNAL_FILE);
    this.hooks = hooks;
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
      // The coordination directory belongs to Station, rather than to the
      // knowledge root's parent or the host's shared temporary directory. The
      // root itself may be writable while its parent is intentionally read
      // only, and a stable root identity keeps distinct adjacent roots from
      // sharing a lock name.
      const coordinationRoot = join(
        resolve(resolveHomeDir()),
        COORDINATION_DIRECTORY,
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
      const lockIdentity = createHash('sha256')
        .update(`${this.rootRealpath}\0${this.rootDevice}\0${this.rootInode}`)
        .digest('hex');
      this.lockPath = join(coordinationRoot, `${lockIdentity}.lock`);
    } catch (error) {
      if (error instanceof KnowledgeStoreCorruptionError) throw error;
      throw unavailable(error);
    }
  }

  async read<T>(body: () => T | Promise<T>): Promise<T> {
    return this.mutate('read-repair', body);
  }

  async mutate<T>(operation: string, body: () => T | Promise<T>): Promise<T> {
    if (this.storage.getStore()) return body();
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
      this.hooks.afterLockAcquired?.();
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
      };
      let result: T;
      try {
        result = await this.storage.run(context, body);
      } catch (error) {
        // The body only stages after-images in memory. No journal or target has
        // been published yet, so a filesystem rollback here could overwrite an
        // external writer that correctly caused the body to fail.
        this.observe(operation, 'rejected');
        throw error;
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
          this.hooks.afterFilePublish?.(path);
        }
        context.journal.phase = 'committed';
        this.persistJournal(context.journal);
        this.hooks.afterCommitMarker?.(context.journal);
        this.removeJournal();
        this.observe(operation, 'applied');
        return result;
      } catch (error) {
        if (context.journal.phase === 'prepared') {
          this.rollback(context.journal);
          this.removeJournal();
        } else if (this.allEntriesMatch(context.journal, 'after')) {
          // Every authoritative/derived target is durably published. A lost
          // commit-marker response or cleanup error cannot turn that applied
          // fact into a caller-visible failure that invites a duplicate retry.
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
    } catch (error) {
      if (isKnowledgeStoreError(error)) throw error;
      throw error;
    } finally {
      try {
        await release();
      } catch {
        // Releasing the coordination artifact is cleanup. It cannot rewrite an
        // already-classified mutation or read outcome.
        this.observe(operation, 'lock-release-unavailable');
      }
    }
  }

  readText(path: string): string | null {
    const buffer = this.readBuffer(path);
    return buffer === null ? null : buffer.toString('utf8');
  }

  readExternalText(path: string): string | null {
    const context = this.storage.getStore();
    if (!context) {
      throw new Error('External knowledge reads require an active transaction');
    }
    const absolute = resolve(path);
    const value = this.readExternalPublished(absolute);
    if (!context.observedExternal.has(absolute)) {
      context.observedExternal.set(absolute, digest(value));
    }
    return value === null ? null : value.toString('utf8');
  }

  listFileNames(path: string): string[] {
    return this.listDirectoryEntries(path).map((entry) => entry.name);
  }

  listDirectoryEntries(path: string): KnowledgeDirectoryEntry[] {
    const rel = relative(this.root, resolve(path));
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new KnowledgeStoreCorruptionError(
        `Knowledge directory escapes the store root: ${path}`,
      );
    }
    this.assertNoSymlink(path);
    let entries: KnowledgeDirectoryEntry[];
    try {
      entries = readdirSync(path, { withFileTypes: true })
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
      if (isMissing(error)) entries = [];
      else if (error instanceof KnowledgeStoreCorruptionError) throw error;
      else throw unavailable(error);
    }
    const context = this.storage.getStore();
    if (context && !context.observedDirectories.has(rel)) {
      context.observedDirectories.set(rel, JSON.stringify(entries));
    }
    return entries;
  }

  writeText(path: string, value: string): void {
    this.writeBuffer(path, Buffer.from(value, 'utf8'));
  }

  remove(path: string): void {
    this.writeBuffer(path, null);
  }

  move(source: string, target: string): void {
    const content = this.readBuffer(source);
    if (content === null) return;
    // Publish the destination before removing the source. The durable journal
    // can restore either side if the process stops between these two steps.
    this.writeBuffer(target, content);
    this.writeBuffer(source, null);
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
   * In particular, POSIX `\\` is a valid literal filename character, not a
   * second path separator. Replacing separators here would make a durable
   * journal unrecoverable after a crash for a legitimate filename.
   */
  private canonicalJournalPath(path: string): string {
    return this.relativePath(join(this.root, path));
  }

  private readBuffer(path: string): Buffer | null {
    const rel = this.relativePath(path);
    const context = this.storage.getStore();
    if (context?.staged.has(rel)) return context.staged.get(rel) ?? null;
    const value = this.readPublished(path);
    if (context && !context.observed.has(rel)) {
      context.observed.set(rel, digest(value));
    }
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

  private writeBuffer(path: string, value: Buffer | null): void {
    const context = this.storage.getStore();
    if (!context) {
      throw new Error(
        'Knowledge file publication requires an active transaction',
      );
    }
    const rel = this.relativePath(path);
    const current = this.readBuffer(path);
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
      const path = join(this.root, entry.path);
      const before =
        entry.before === null ? null : Buffer.from(entry.before, 'base64');
      if (digest(this.readPublished(path)) !== digest(before)) {
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
      const path = join(this.root, rel);
      let current: KnowledgeDirectoryEntry[];
      try {
        current = readdirSync(path, { withFileTypes: true })
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
        if (isMissing(error)) current = [];
        else if (error instanceof KnowledgeStoreCorruptionError) throw error;
        else throw unavailable(error);
      }
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

  private publicationOrder(entries: JournalEntry[]): JournalEntry[] {
    const isMetadata = (path: string) =>
      path === 'metadata.json' ||
      path === 'graph-index.json' ||
      path === 'alias-index.json' ||
      path === 'path-index.json';
    return [...entries].sort((left, right) => {
      const rank = (entry: JournalEntry) => {
        if (entry.after === null) return 2;
        return isMetadata(entry.path) ? 1 : 0;
      };
      return rank(left) - rank(right);
    });
  }

  private recoverLocked(): void {
    const journal = this.loadJournal();
    if (!journal) return;
    if (journal.phase === 'prepared') {
      if (this.allEntriesMatch(journal, 'after')) {
        // Crash after the final publish but before/during the commit marker.
        // The complete after-image is the exact applied fact.
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
    this.hooks.afterJournalWrite?.(journal);
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
      this.hooks.beforeFileReplace?.(path);
      this.validateRootIdentity();
      renameSync(temporary, path);
      this.syncDirectory(directory);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try {
        this.validateRootIdentity();
        rmSync(temporary, { force: true });
      } catch {
        // If the composed root identity changed, never follow the replacement
        // path merely to clean a temporary in the old directory.
      }
    }
  }

  private removePublished(path: string): void {
    this.assertNoSymlink(path);
    try {
      this.hooks.beforeFileReplace?.(path);
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
