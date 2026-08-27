import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rename, rm, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fsyncDirectorySync } from '@kontourai/station-shared/fs-windows-compat';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { isSafePathSegment } from '../knowledge-index/path-safety.js';
import {
  type JsonFileSnapshot,
  mutateJsonFile,
  publishJsonFileWithOwnedLock,
  readJsonFileSnapshot,
} from './file-storage-helpers.js';

export class FileStorageConflictError extends Error {
  readonly code = 'file_storage_conflict';

  constructor(message: string) {
    super(message);
    this.name = 'FileStorageConflictError';
  }
}

/**
 * The project path is already occupied — a name collision, not a lost race
 * (4-HOME-007). Both are 409s and both were reported with the CAS sentence
 * "Project storage changed before the operation could commit", which told a
 * user creating a second "Audit Alpha" nothing about the name they typed.
 * A separate type is what lets the route answer the two differently; the
 * `instanceof FileStorageConflictError` branches that already exist keep
 * working unchanged.
 */
export class FileStorageAlreadyExistsError extends FileStorageConflictError {
  /** The slug that is already in use, as it exists on disk. */
  readonly takenSlug: string;

  constructor(message: string, takenSlug: string) {
    super(message);
    this.name = 'FileStorageAlreadyExistsError';
    this.takenSlug = takenSlug;
  }
}

export class FileStorageNotFoundError extends Error {
  readonly code = 'file_storage_not_found';

  constructor(message: string) {
    super(message);
    this.name = 'FileStorageNotFoundError';
  }
}

export class FileStorageUnavailableError extends Error {
  readonly code = 'file_storage_unavailable';

  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'FileStorageUnavailableError';
  }
}

export interface StoredFileRevision<T> {
  readonly value: T;
  replace(next: T): Promise<void>;
  remove(): Promise<void>;
}

export interface ProjectStoredFileRevision<T> extends StoredFileRevision<T> {
  createLayout(layoutSlug: string, value: unknown): Promise<void>;
}

export interface ProjectFileTransactionFaults {
  afterLockAcquired?: (projectSlug: string) => Promise<void> | void;
  afterPublish?: (path: string) => void;
  afterRemoveCommit?: (path: string) => void;
}

type Parser<T> = (value: unknown) => T;
type ListParser<T> = (value: unknown) => T[];
interface RevisionOptions {
  projectRevision?: boolean;
  requiredProjectFingerprint?: string;
}

function fingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function readFingerprint(path: string): string | null {
  try {
    return fingerprint(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function assertTransactionSegment(kind: string, value: string): void {
  if (!isSafePathSegment(value) || value === '.') {
    throw new Error(`${kind} must be a safe path segment`);
  }
}

function isStorageOutcomeError(error: unknown): boolean {
  return (
    error instanceof FileStorageConflictError ||
    error instanceof FileStorageNotFoundError ||
    error instanceof FileStorageUnavailableError
  );
}

/**
 * One project-scoped mutation authority. Its lock lives outside the deletable
 * project tree, so Project deletion and every nested Layout/record mutation
 * share an exact cross-process ordering boundary.
 */
export class ProjectFileTransactions {
  readonly #coordinationRoot: string;

  constructor(
    private readonly projectHomeDir: string,
    private readonly faults: ProjectFileTransactionFaults = {},
    private readonly validateProject?: (value: unknown) => unknown,
  ) {
    this.#coordinationRoot = join(projectHomeDir, '.storage-transactions');
  }

  projectDirectory(projectSlug: string): string {
    assertTransactionSegment('project slug', projectSlug);
    return join(this.projectHomeDir, 'projects', projectSlug);
  }

  projectPath(projectSlug: string): string {
    return join(this.projectDirectory(projectSlug), 'project.json');
  }

  layoutPath(projectSlug: string, layoutSlug: string): string {
    assertTransactionSegment('layout slug', layoutSlug);
    return join(
      this.projectDirectory(projectSlug),
      'layouts',
      `${layoutSlug}.json`,
    );
  }

  readProject<T>(
    projectSlug: string,
    parse: Parser<T>,
  ): ProjectStoredFileRevision<T> {
    return this.#readRevision(
      projectSlug,
      this.projectPath(projectSlug),
      parse,
      `Project '${projectSlug}' not found`,
      { projectRevision: true },
    ) as ProjectStoredFileRevision<T>;
  }

  readLayout<T>(
    projectSlug: string,
    layoutSlug: string,
    parse: Parser<T>,
  ): StoredFileRevision<T> {
    const project = this.#readValidatedProject(projectSlug);
    return this.#readRevision(
      projectSlug,
      this.layoutPath(projectSlug, layoutSlug),
      parse,
      `Layout '${layoutSlug}' not found in project '${projectSlug}'`,
      { requiredProjectFingerprint: project.fingerprint ?? undefined },
    );
  }

  async createProject(projectSlug: string, value: unknown): Promise<void> {
    await this.#withProjectLock(projectSlug, async () => {
      const path = this.projectPath(projectSlug);
      if (readFingerprint(path) !== null) {
        throw new FileStorageAlreadyExistsError(
          `Project '${projectSlug}' already exists`,
          projectSlug,
        );
      }
      await this.#publish(path, value);
    });
  }

  async createLayout(
    projectSlug: string,
    layoutSlug: string,
    value: unknown,
  ): Promise<void> {
    const revision = this.readProject(projectSlug, (project) => project);
    await revision.createLayout(layoutSlug, value);
  }

  async upsertRecord<T extends { id: string; projectId: string }>(
    projectSlug: string,
    expectedProjectId: string,
    path: string,
    record: T,
    parse: ListParser<T>,
  ): Promise<void> {
    await this.#withProjectLock(projectSlug, async () => {
      const project = this.#readValidatedProject(projectSlug);
      if (
        !project.value ||
        typeof project.value !== 'object' ||
        (project.value as { id?: unknown }).id !== expectedProjectId
      ) {
        throw new FileStorageConflictError(
          'Project identity changed before the record could commit',
        );
      }
      this.#assertProjectPath(projectSlug, path);
      await mutateJsonFile<unknown>(path, [], (value) => {
        const records = parse(value);
        const index = records.findIndex((entry) => entry.id === record.id);
        if (index >= 0) records[index] = record;
        else records.push(record);
        return records;
      });
    });
  }

  async deleteRecord<T extends { id: string; projectId: string }>(
    projectSlug: string,
    expectedProjectId: string,
    path: string,
    expected: T,
    parse: ListParser<T>,
  ): Promise<boolean> {
    return this.#withProjectLock(projectSlug, async () => {
      const project = this.#readValidatedProject(projectSlug);
      if (
        !project.value ||
        typeof project.value !== 'object' ||
        (project.value as { id?: unknown }).id !== expectedProjectId
      ) {
        throw new FileStorageConflictError(
          'Project identity changed before the record could be deleted',
        );
      }
      this.#assertProjectPath(projectSlug, path);
      let deleted = false;
      await mutateJsonFile<unknown>(path, [], (value) => {
        const records = parse(value);
        const index = records.findIndex((entry) => entry.id === expected.id);
        if (index < 0) return records;
        if (JSON.stringify(records[index]) !== JSON.stringify(expected)) {
          throw new FileStorageConflictError(
            'Stored record changed before deletion could commit',
          );
        }
        records.splice(index, 1);
        deleted = true;
        return records;
      });
      return deleted;
    });
  }

  #readRevision<T>(
    projectSlug: string,
    path: string,
    parse: Parser<T>,
    missingMessage: string,
    options: RevisionOptions = {},
  ): StoredFileRevision<T> {
    let snapshot: JsonFileSnapshot<unknown>;
    try {
      snapshot = readJsonFileSnapshot<unknown>(path, undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FileStorageNotFoundError(missingMessage);
      }
      throw new FileStorageUnavailableError(
        'Project storage is unavailable',
        error,
      );
    }
    if (snapshot.fingerprint === null) {
      throw new FileStorageNotFoundError(missingMessage);
    }
    let value: T;
    try {
      if (options.projectRevision) this.validateProject?.(snapshot.value);
      value = parse(snapshot.value);
    } catch (error) {
      throw new FileStorageUnavailableError(
        'Project storage contains an invalid record',
        error,
      );
    }
    const expected = snapshot.fingerprint;
    let intent: string | undefined;
    let pending: Promise<void> | undefined;
    let applied = false;

    const runIntent = (nextIntent: string, operation: () => Promise<void>) => {
      if (intent !== undefined && intent !== nextIntent) {
        return Promise.reject(
          new FileStorageConflictError(
            'Stored revision already owns a different transition',
          ),
        );
      }
      intent = nextIntent;
      if (applied) return Promise.resolve();
      if (pending) return pending;
      const attempt = operation()
        .then(() => {
          applied = true;
        })
        .finally(() => {
          pending = undefined;
        });
      pending = attempt;
      return attempt;
    };

    const revision = {
      value,
      replace: (next: T): Promise<void> => {
        const serialized = JSON.stringify(next);
        const ownedNext = JSON.parse(serialized) as T;
        return runIntent(`replace:${serialized}`, () =>
          this.#withProjectLock(projectSlug, async () => {
            if (
              options.requiredProjectFingerprint !== undefined &&
              readFingerprint(this.projectPath(projectSlug)) !==
                options.requiredProjectFingerprint
            ) {
              throw new FileStorageConflictError(
                'Project changed before the stored record could update',
              );
            }
            if (readFingerprint(path) !== expected) {
              throw new FileStorageConflictError(
                'Stored record changed before the update could commit',
              );
            }
            await this.#publish(path, ownedNext);
          }),
        );
      },
      remove: (): Promise<void> =>
        runIntent('remove', () =>
          this.#withProjectLock(projectSlug, async () => {
            if (
              options.requiredProjectFingerprint !== undefined &&
              readFingerprint(this.projectPath(projectSlug)) !==
                options.requiredProjectFingerprint
            ) {
              throw new FileStorageConflictError(
                'Project changed before the stored record could be deleted',
              );
            }
            if (readFingerprint(path) !== expected) {
              throw new FileStorageConflictError(
                'Stored record changed before deletion could commit',
              );
            }
            await this.#remove(path);
          }),
        ),
      ...(options.projectRevision
        ? {
            createLayout: (
              layoutSlug: string,
              next: unknown,
            ): Promise<void> => {
              assertTransactionSegment('layout slug', layoutSlug);
              const serialized = JSON.stringify(next);
              const ownedNext = JSON.parse(serialized) as unknown;
              return runIntent(
                `create-layout:${layoutSlug}:${serialized}`,
                () =>
                  this.#withProjectLock(projectSlug, async () => {
                    if (readFingerprint(path) !== expected) {
                      throw new FileStorageConflictError(
                        'Project changed before the Layout could be created',
                      );
                    }
                    const layoutPath = this.layoutPath(projectSlug, layoutSlug);
                    if (readFingerprint(layoutPath) !== null) {
                      throw new FileStorageConflictError(
                        `Layout '${layoutSlug}' already exists`,
                      );
                    }
                    await this.#publish(layoutPath, ownedNext);
                  }),
              );
            },
          }
        : {}),
    };
    return Object.freeze(revision);
  }

  #readValidatedProject(projectSlug: string): JsonFileSnapshot<unknown> {
    let project: JsonFileSnapshot<unknown>;
    try {
      project = readJsonFileSnapshot<unknown>(
        this.projectPath(projectSlug),
        undefined,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new FileStorageNotFoundError(
          `Project '${projectSlug}' not found`,
        );
      }
      throw new FileStorageUnavailableError(
        'Project storage is unavailable',
        error,
      );
    }
    if (project.fingerprint === null) {
      throw new FileStorageNotFoundError(`Project '${projectSlug}' not found`);
    }
    try {
      this.validateProject?.(project.value);
    } catch (error) {
      throw new FileStorageUnavailableError(
        'Project storage contains an invalid record',
        error,
      );
    }
    return project;
  }

  #assertProjectPath(projectSlug: string, path: string): void {
    const projectRoot = resolve(this.projectDirectory(projectSlug));
    const target = resolve(path);
    const fromProject = relative(projectRoot, target);
    if (
      fromProject === '' ||
      fromProject === '..' ||
      fromProject.startsWith(`..${sep}`) ||
      resolve(projectRoot, fromProject) !== target
    ) {
      throw new FileStorageUnavailableError(
        'Project record path is outside its Project storage root',
      );
    }
  }

  async #publish(path: string, value: unknown): Promise<void> {
    try {
      await publishJsonFileWithOwnedLock(path, value);
      this.faults.afterPublish?.(path);
    } catch (error) {
      // A rename may have committed before a later durability/fault seam
      // reported failure. Exact bytes are authoritative for this capability.
      const expected = `${JSON.stringify(value, null, 2)}`;
      try {
        if (readFileSync(path, 'utf8') === expected) return;
      } catch {}
      if (isStorageOutcomeError(error)) throw error;
      throw new FileStorageUnavailableError(
        'Project storage publication is unavailable',
        error,
      );
    }
  }

  async #remove(path: string): Promise<void> {
    const projectDirectory = this.#projectDirectoryContaining(path);
    const removingProject = path === join(projectDirectory, 'project.json');
    if (removingProject) {
      const trashRoot = join(this.#coordinationRoot, 'trash');
      await mkdir(trashRoot, { recursive: true, mode: 0o700 });
      const trash = join(trashRoot, randomUUID());
      try {
        await rename(projectDirectory, trash);
        fsyncDirectorySync(dirname(projectDirectory));
        fsyncDirectorySync(trashRoot);
        this.faults.afterRemoveCommit?.(path);
      } catch (error) {
        if (!existsSync(projectDirectory) && existsSync(trash)) {
          // The rename is the authoritative deletion commit. Trash cleanup is
          // maintenance and must not make an applied delete look retryable.
          await rm(trash, { recursive: true, force: true }).catch(() => {});
          return;
        }
        throw error;
      }
      await rm(trash, { recursive: true, force: true }).catch(() => {});
      return;
    }

    try {
      await unlink(path);
      fsyncDirectorySync(dirname(path));
      this.faults.afterRemoveCommit?.(path);
    } catch (error) {
      if (!existsSync(path)) return;
      throw error;
    }
  }

  #projectDirectoryContaining(path: string): string {
    const projectsRoot = join(this.projectHomeDir, 'projects');
    const relative = path.slice(projectsRoot.length + 1);
    return join(projectsRoot, relative.split(/[\\/]/, 1)[0] ?? '');
  }

  async #withProjectLock<T>(
    projectSlug: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const locksRoot = join(this.#coordinationRoot, 'projects');
    const key = createHash('sha256').update(projectSlug).digest('hex');
    let release: (() => Promise<void>) | undefined;
    try {
      await mkdir(locksRoot, { recursive: true, mode: 0o700 });
      release = await acquireFileMutationLockAsync(
        join(locksRoot, `${key}.mutation`),
      );
      await this.faults.afterLockAcquired?.(projectSlug);
      return await operation();
    } catch (error) {
      if (isStorageOutcomeError(error)) throw error;
      throw new FileStorageUnavailableError(
        'Project storage mutation is unavailable',
        error,
      );
    } finally {
      // Releasing ownership is maintenance after the operation outcome is
      // known. It must not turn a committed mutation into a retryable result.
      await release?.().catch(() => {});
    }
  }
}
