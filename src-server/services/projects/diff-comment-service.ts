/**
 * DiffCommentService — inline diff review comments, persisted per project.
 *
 * Comments anchor to a (filePath, side, lineNumber) in a project's diff and are
 * stored as a single JSON array under `<workspace>/.station/diff-comments.json`
 * (the same `.station/` convention the trust-bundle store uses). The service is
 * stateless; the route resolves the store path from a project slug, mirroring
 * the trust-bundle route's `resolveLocations` pattern.
 */

import { randomUUID } from 'node:crypto';
import { posix, win32 } from 'node:path';
import type {
  DiffComment,
  DiffCommentCreateInput,
} from '@kontourai/station-contracts/diff-comment';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import {
  reviewCommentsCreated,
  reviewCommentsDeleted,
  reviewCommentsListed,
} from '../../telemetry/metrics.js';
import { JsonFileStore } from '../infra/json-store.js';

type DiffCommentStore = Pick<JsonFileStore<DiffComment[]>, 'read' | 'write'>;
// Async-compatible seam (archive#2646): the default is the ASYNC cross-process lock
// so a contended acquisition yields the event loop; sync test fakes remain
// assignable (awaiting a non-promise is a no-op).
type DiffCommentMutationLock = (
  lockPath: string,
) => (() => void | Promise<void>) | Promise<() => void | Promise<void>>;
type DiffCommentStoreFactory = (storePath: string) => DiffCommentStore;

const GENERATED_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface DiffCommentServiceOptions {
  /** Injectable only for deterministic cross-process mutation tests. */
  acquireMutationLock?: DiffCommentMutationLock;
  /** Injectable only for durable-write fault-injection tests. */
  storeFactory?: DiffCommentStoreFactory;
}

export class DiffCommentStoreValidationError extends Error {
  constructor() {
    super('Diff comment store is invalid');
    this.name = 'DiffCommentStoreValidationError';
  }
}

export class DiffCommentValidationError extends Error {
  constructor() {
    super('Diff comment is invalid');
    this.name = 'DiffCommentValidationError';
  }
}

/** The project has no resolvable comment store (no working directory) → 404. */
export class DiffCommentStoreUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiffCommentStoreUnavailableError';
  }
}

export class DiffCommentService {
  private readonly acquireMutationLock: DiffCommentMutationLock;
  private readonly storeFactory: DiffCommentStoreFactory;

  constructor(options: DiffCommentServiceOptions = {}) {
    this.acquireMutationLock =
      options.acquireMutationLock ?? acquireFileMutationLockAsync;
    this.storeFactory =
      options.storeFactory ??
      ((storePath) =>
        new JsonFileStore<DiffComment[]>(storePath, [], {
          onCorruption: 'throw',
          durableAtomicWrite: true,
        }));
  }

  private store(storeFilePath: string): DiffCommentStore {
    return this.storeFactory(storeFilePath);
  }

  /**
   * List comments for a project, optionally filtered to one file. Sorted by
   * creation time so threads read top-to-bottom in the order they were left.
   */
  list(storeFilePath: string, filePath?: string): DiffComment[] {
    const all = this.read(storeFilePath);
    const scoped = filePath
      ? all.filter((comment) => comment.filePath === filePath)
      : all;
    return [...scoped].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * List comments across many project stores, newest first — the shape the
   * cross-project review queue consumes. Each comment already carries its own
   * `projectId`, so callers can group/route without extra lookups. Missing or
   * empty stores contribute nothing (a project may never have a comment file).
   */
  listAcross(storeFilePaths: string[]): DiffComment[] {
    const all = storeFilePaths.flatMap((path) => this.read(path));
    reviewCommentsListed.add(1, { stores: storeFilePaths.length });
    return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async create(
    storeFilePath: string,
    input: DiffCommentCreateInput,
  ): Promise<DiffComment> {
    const body = input.body.trim();
    if (!body) {
      throw new Error('Comment body is required');
    }
    const draft = {
      id: randomUUID(),
      projectId: input.projectId,
      filePath: input.filePath,
      side: input.side,
      lineNumber: input.lineNumber,
      body,
      ...(input.authorId === undefined ? {} : { authorId: input.authorId }),
    };
    // Validate before taking the lock so malformed input never enters the
    // critical section. The timestamp here is only a shape probe; the stamp
    // that is persisted is taken at commit time below.
    try {
      const probeStamp = new Date().toISOString();
      validateDiffComment({
        ...draft,
        createdAt: probeStamp,
        updatedAt: probeStamp,
      });
    } catch (error) {
      if (error instanceof DiffCommentStoreValidationError) {
        throw new DiffCommentValidationError();
      }
      throw error;
    }
    // Stamp INSIDE the mutation lock. `list()` promises threads read "in the
    // order they were left", but a writer that blocks on the lock would
    // otherwise carry the timestamp it took before waiting — sorting it ahead
    // of a comment that was actually written and committed first. Taking the
    // stamp at commit time makes creation order and persisted order agree.
    let comment: DiffComment = {
      ...draft,
      createdAt: '',
      updatedAt: '',
    };
    await this.mutate(storeFilePath, (comments) => {
      const now = new Date().toISOString();
      comment = { ...draft, createdAt: now, updatedAt: now };
      return {
        result: undefined,
        next: [...comments, comment],
      };
    });
    reviewCommentsCreated.add(1, { side: input.side });
    return comment;
  }

  /** Delete a comment by id. Returns true when a comment was removed. */
  async delete(storeFilePath: string, id: string): Promise<boolean> {
    const removed = await this.mutate(storeFilePath, (comments) => {
      const remaining = comments.filter((comment) => comment.id !== id);
      return {
        result: remaining.length !== comments.length,
        next: remaining.length === comments.length ? undefined : remaining,
      };
    });
    if (!removed) return false;
    reviewCommentsDeleted.add(1);
    return true;
  }

  private read(storeFilePath: string): DiffComment[] {
    return validateDiffCommentStore(this.store(storeFilePath).read());
  }

  private async mutate<T>(
    storeFilePath: string,
    mutation: (comments: DiffComment[]) => { result: T; next?: DiffComment[] },
  ): Promise<T> {
    const release = await this.acquireMutationLock(`${storeFilePath}.mutation`);
    try {
      const outcome = mutation(this.read(storeFilePath));
      if (outcome.next) {
        this.store(storeFilePath).write(validateDiffCommentStore(outcome.next));
      }
      return outcome.result;
    } finally {
      await release();
    }
  }
}

function validateDiffCommentStore(value: unknown): DiffComment[] {
  if (!Array.isArray(value)) throw new DiffCommentStoreValidationError();
  const comments = value.map(validateDiffComment);
  if (new Set(comments.map((comment) => comment.id)).size !== comments.length) {
    throw new DiffCommentStoreValidationError();
  }
  return comments;
}

function validateDiffComment(value: unknown): DiffComment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DiffCommentStoreValidationError();
  }
  const comment = value as Record<string, unknown>;
  const required = [
    'id',
    'projectId',
    'filePath',
    'side',
    'lineNumber',
    'body',
    'createdAt',
    'updatedAt',
  ];
  if (
    required.some((key) => !Object.hasOwn(comment, key)) ||
    Object.keys(comment).some(
      (key) => ![...required, 'authorId'].includes(key),
    ) ||
    !isGeneratedId(comment.id) ||
    !isCanonicalText(comment.projectId) ||
    !isRelativeFilePath(comment.filePath) ||
    (comment.side !== 'additions' && comment.side !== 'deletions') ||
    !Number.isSafeInteger(comment.lineNumber) ||
    (comment.lineNumber as number) < 1 ||
    !isCanonicalBody(comment.body) ||
    !isCanonicalTimestamp(comment.createdAt) ||
    !isCanonicalTimestamp(comment.updatedAt) ||
    comment.updatedAt !== comment.createdAt ||
    (Object.hasOwn(comment, 'authorId') && !isCanonicalText(comment.authorId))
  ) {
    throw new DiffCommentStoreValidationError();
  }
  return comment as unknown as DiffComment;
}

function isGeneratedId(value: unknown): value is string {
  return typeof value === 'string' && GENERATED_ID_PATTERN.test(value);
}

function isCanonicalText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.trim() === value &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

function isRelativeFilePath(value: unknown): value is string {
  return (
    isCanonicalText(value) &&
    !posix.isAbsolute(value) &&
    !win32.isAbsolute(value) &&
    value !== '..' &&
    value !== '.' &&
    !value.startsWith('../') &&
    !value.endsWith('/') &&
    !value.includes('\\') &&
    posix.normalize(value) === value &&
    !value.split('/').includes('..')
  );
}

function isCanonicalBody(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.trim() === value
  );
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}
