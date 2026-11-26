import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  type IndependentReviewReceipt,
  type IndependentReviewRequest,
  type IndependentReviewRequestStatus,
  type IndependentReviewRunResult,
  parseIndependentReviewReceipt,
} from '@kontourai/station-contracts/review-evidence';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { publishJsonFileWithOwnedLock } from '../../domain/file-storage-helpers.js';
import {
  canonicalReviewJson,
  reviewEvidenceId,
} from './review-evidence-identity.js';
import {
  ReviewProjectLockUnavailableError,
  ReviewProjectWorkspaceMissingError,
  type ReviewReceiptReadOptions,
  type ReviewReceiptReference,
  type ReviewReceiptStore,
  ReviewRequestConflictError,
  type ReviewStorageIdentity,
  type ReviewSubmissionAdmission,
  type ReviewSubmissionStore,
  type ReviewTaskBinding,
  type ReviewWriteGuard,
} from './review-evidence-module.js';

const RECEIPT_DIRECTORY = join('.station', 'review-evidence', 'receipts');
const MAX_RECEIPT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_RECEIPTS_PER_PROJECT = 256;
const RECEIPT_ID = /^[0-9a-f]{64}$/;
// Reads still take the coordination lock (the reference read can repair a
// stale index, which is a write) but degrade to per-project unavailability
// sooner than a mutation would: a contended project costs the aggregate a
// bounded ~2.5s, not the full 10s mutation deadline.
const READ_LOCK_TIMEOUT_MS = 2_500;
const INDEX_FILE = '.index.json';
const REQUEST_DIRECTORY = '.requests';
const MAX_INDEX_BYTES = 128 * 1024;
const MAX_SUBMISSION_BYTES = 64 * 1024;

type RootIdentity = ReviewStorageIdentity;

interface StoredSubmission {
  schemaVersion: 1 | 2;
  taskBinding?: ReviewTaskBinding;
  requestId: string;
  projectSlug: string;
  requestSha256: string;
  ownerId: string;
  ownerPid: number;
  phase: 'prepared' | 'invoking';
  state:
    | 'running'
    | 'completed'
    | 'rejected'
    | 'indeterminate'
    | 'not-verified';
  startedAt: string;
  updatedAt: string;
  receiptId?: string;
  attachment?: IndependentReviewRunResult['attachment'];
  cleanup?: IndependentReviewRunResult['cleanup'];
  failureReason?: string;
  unavailableLenses?: string[];
}

interface ReviewProjectWorkspaceResolver {
  workspace(projectSlug: string): string | undefined;
}

interface FileReviewReceiptStoreOptions {
  /** Protected evidence is never pruned; admission fails at this bound. */
  maxReceiptsPerProject?: number;
  /** Station-owned private directory for cross-process mutation capabilities. */
  coordinationDirectory: string;
  acquireLock?: typeof acquireFileMutationLockAsync;
  diagnostic?: (operation: string, error: unknown) => void;
  beforeReceiptCommit?: () => void | Promise<void>;
}

/** Immutable, content-addressed repository-local review receipt authority. */
export class FileReviewReceiptStore
  implements ReviewReceiptStore, ReviewSubmissionStore
{
  readonly #maxReceiptsPerProject: number;
  readonly #coordinationDirectory: string;
  readonly #ownerId = randomUUID();
  readonly #acquireLock: typeof acquireFileMutationLockAsync;
  readonly #diagnostic: (operation: string, error: unknown) => void;
  readonly #beforeReceiptCommit?: () => void | Promise<void>;

  constructor(
    private readonly projects: ReviewProjectWorkspaceResolver,
    options: FileReviewReceiptStoreOptions,
  ) {
    this.#maxReceiptsPerProject =
      options.maxReceiptsPerProject ?? DEFAULT_MAX_RECEIPTS_PER_PROJECT;
    this.#coordinationDirectory = resolve(options.coordinationDirectory);
    this.#acquireLock = options.acquireLock ?? acquireFileMutationLockAsync;
    this.#diagnostic = options.diagnostic ?? (() => {});
    this.#beforeReceiptCommit = options.beforeReceiptCommit;
    if (
      !Number.isInteger(this.#maxReceiptsPerProject) ||
      this.#maxReceiptsPerProject < 1 ||
      this.#maxReceiptsPerProject > 10_000
    ) {
      throw new Error('Review receipt capacity is invalid.');
    }
  }

  async write(
    input: Omit<IndependentReviewReceipt, 'receiptId'>,
    guard?: ReviewWriteGuard,
  ): Promise<IndependentReviewReceipt> {
    const receiptId = reviewEvidenceId(input);
    const receipt: IndependentReviewReceipt = { ...input, receiptId };
    const serialized = `${canonicalReviewJson(receipt)}\n`;
    if (Buffer.byteLength(serialized) > MAX_RECEIPT_BYTES) {
      throw new Error('Review receipt exceeds the byte limit.');
    }
    return this.#withProjectLock(
      input.target.projectSlug,
      async (root) => {
        const directory = await this.#receiptDirectory(root, true);
        const directoryIdentity = await captureRootIdentity(directory);
        const existing = await this.read(receiptId, input.target.projectSlug, {
          storageIdentity: root,
        });
        if (existing) {
          if (canonicalReviewJson(existing) !== canonicalReviewJson(receipt)) {
            throw new Error('Review receipt identity collision.');
          }
          await this.#ensureIndexed(
            directory,
            receipt,
            root,
            directoryIdentity,
            guard?.assertCurrent,
          );
          return existing;
        }
        const names = await this.#receiptNames(directory);
        if (names.length >= this.#maxReceiptsPerProject) {
          throw new Error(
            'Review receipt capacity is exhausted by protected evidence.',
          );
        }
        await publishJsonFileWithOwnedLock(
          join(directory, `${receiptId}.json`),
          receipt,
          {
            maxBytes: MAX_RECEIPT_BYTES,
            label: 'Review receipt',
            assertCurrent: guard?.assertCurrent,
            beforeCommit: async () => {
              await this.#beforeReceiptCommit?.();
              await validatePublicationIdentity(root, directoryIdentity);
              guard?.assertCurrent?.();
            },
          },
        );
        await this.#ensureIndexed(
          directory,
          receipt,
          root,
          directoryIdentity,
          guard?.assertCurrent,
        );
        return receipt;
      },
      guard,
    );
  }

  async read(
    receiptId: string,
    projectSlug: string,
    options?: ReviewReceiptReadOptions,
  ): Promise<IndependentReviewReceipt | null | undefined> {
    if (!RECEIPT_ID.test(receiptId)) return null;
    const root =
      options?.storageIdentity ?? (await this.#rootIdentity(projectSlug));
    const directory = await this.#receiptDirectory(root, false);
    const directoryIdentity = await captureRootIdentity(directory).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      },
    );
    const path = join(directory, `${receiptId}.json`);
    let bytes: string;
    let descriptor: Awaited<ReturnType<typeof open>> | undefined;
    try {
      descriptor = await open(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      const stat = await descriptor.stat();
      assertRegularFile(stat);
      await validateRootIdentity(root);
      if (directoryIdentity) await validateRootIdentity(directoryIdentity);
      if (stat.size > MAX_RECEIPT_BYTES) {
        throw new Error('Review receipt exceeds the byte limit.');
      }
      bytes = await descriptor.readFile('utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    } finally {
      await descriptor?.close();
    }
    const parsed = parseIndependentReviewReceipt(JSON.parse(bytes));
    const { receiptId: storedId, ...body } = parsed;
    if (storedId !== receiptId || reviewEvidenceId(body) !== receiptId) {
      throw new Error('Review receipt content identity is invalid.');
    }
    if (parsed.target.projectSlug !== projectSlug) {
      throw new Error('Review receipt project binding is invalid.');
    }
    let visible = true;
    if (options?.includeTaskReviews === false || options?.taskAssociation) {
      const submission = await this.#readSubmission(
        parsed.requestId,
        projectSlug,
        root,
      );
      if (!submission && options.includeTaskReviews === false)
        throw new Error('Review request association is unavailable.');
      visible =
        !submission?.taskBinding ||
        (options.includeTaskReviews !== false &&
          (!options.taskAssociation ||
            canonicalReviewJson(submission.taskBinding) ===
              canonicalReviewJson(options.taskAssociation.binding ?? null)));
    }
    await validateRootIdentity(root);
    if (directoryIdentity) await validateRootIdentity(directoryIdentity);
    if (!visible) return undefined;
    return parsed;
  }

  async list(
    projectSlug: string,
    includeTaskReviews = true,
  ): Promise<IndependentReviewReceipt[]> {
    const entries = await this.references(projectSlug);
    const receipts: IndependentReviewReceipt[] = [];
    for (const entry of entries) {
      const receipt = await this.read(entry.receiptId, projectSlug, {
        includeTaskReviews,
      });
      if (receipt === undefined) continue;
      if (!receipt) {
        throw new Error('Review receipt index references missing evidence.');
      }
      receipts.push(receipt);
    }
    return receipts;
  }

  async references(projectSlug: string): Promise<ReviewReceiptReference[]> {
    return this.#withProjectLock(
      projectSlug,
      async (root) => {
        const directory = await this.#receiptDirectory(root, false);
        const names = await this.#receiptNames(directory);
        if (names.length === 0) return [];
        const indexed = await this.#readIndex(directory).catch(() => []);
        const indexedIds = new Set(indexed.map((entry) => entry.receiptId));
        const actualIds = new Set(
          names.map((name) => name.slice(0, -'.json'.length)),
        );
        if (
          indexed.length !== names.length ||
          [...actualIds].some((receiptId) => !indexedIds.has(receiptId))
        ) {
          const rebuilt: ReviewReceiptReference[] = [];
          for (const receiptId of actualIds) {
            const receipt = await this.read(receiptId, projectSlug, {
              storageIdentity: root,
            });
            if (!receipt) {
              throw new Error(
                'Review receipt inventory changed during repair.',
              );
            }
            rebuilt.push(referenceFor(receipt));
          }
          const directoryIdentity = await captureRootIdentity(directory);
          await this.#writeIndex(directory, rebuilt, root, directoryIdentity);
          return sortReferences(rebuilt);
        }
        return sortReferences(indexed);
      },
      { lockTimeoutMs: READ_LOCK_TIMEOUT_MS },
    );
  }

  async begin(input: {
    request: IndependentReviewRequest;
    startedAt: string;
    taskBinding?: ReviewTaskBinding;
    assertCurrent?: () => void;
  }): Promise<ReviewSubmissionAdmission> {
    const projectSlug = input.request.target.projectSlug;
    return this.#withProjectLock(
      projectSlug,
      async (root) => {
        const existing = await this.#readSubmission(
          input.request.requestId,
          projectSlug,
          root,
        );
        const requestSha256 = reviewEvidenceId(input.request);
        if (existing) {
          if (
            existing.requestSha256 !== requestSha256 ||
            canonicalReviewJson(existing.taskBinding ?? null) !==
              canonicalReviewJson(input.taskBinding ?? null)
          ) {
            throw new ReviewRequestConflictError();
          }
          if (
            existing.state === 'running' &&
            existing.ownerId === this.#ownerId &&
            existing.phase === 'prepared'
          ) {
            return { kind: 'acquired', storageIdentity: { ...root } };
          }
          if (
            existing.state === 'running' &&
            existing.ownerId === this.#ownerId &&
            existing.phase === 'invoking'
          ) {
            const reconciled: StoredSubmission = {
              ...existing,
              state: 'indeterminate',
              updatedAt: input.startedAt,
              failureReason:
                'The independent review outcome is uncertain and must not be retried automatically.',
            };
            await this.#writeSubmission(reconciled, root, input.assertCurrent);
            return {
              kind: 'existing',
              status: await this.#projectSubmission(reconciled, root),
            };
          }
          return {
            kind: 'existing',
            status: await this.#projectSubmission(existing, root),
          };
        }
        const requestNames = await this.#submissionNames(root);
        if (requestNames.length >= this.#maxReceiptsPerProject) {
          throw new Error(
            'Review request capacity is exhausted by protected evidence.',
          );
        }
        const record: StoredSubmission = {
          schemaVersion: input.taskBinding ? 2 : 1,
          ...(input.taskBinding ? { taskBinding: input.taskBinding } : {}),
          requestId: input.request.requestId,
          projectSlug,
          requestSha256,
          ownerId: this.#ownerId,
          ownerPid: process.pid,
          phase: 'prepared',
          state: 'running',
          startedAt: input.startedAt,
          updatedAt: input.startedAt,
        };
        input.assertCurrent?.();
        await this.#writeSubmission(record, root, input.assertCurrent);
        return { kind: 'acquired', storageIdentity: { ...root } };
      },
      { assertCurrent: input.assertCurrent },
    );
  }

  async hasTaskRequest(
    projectSlug: string,
    requestId: string,
    binding: ReviewTaskBinding,
  ): Promise<boolean> {
    return this.#withProjectLock(
      projectSlug,
      async (root) => {
        const record = await this.#readSubmission(requestId, projectSlug, root);
        if (!record) return false;
        if (
          canonicalReviewJson(record.taskBinding ?? null) !==
          canonicalReviewJson(binding)
        )
          throw new ReviewRequestConflictError();
        return true;
      },
      { lockTimeoutMs: READ_LOCK_TIMEOUT_MS },
    );
  }

  async taskRequestIds(
    projectSlug: string,
    binding: ReviewTaskBinding,
  ): Promise<{ requestIds: string[]; omitted: number }> {
    return this.#withProjectLock(
      projectSlug,
      async (root) => {
        const records: StoredSubmission[] = [];
        for (const name of await this.#submissionNames(root)) {
          const path = join(
            await this.#receiptDirectory(root, false),
            REQUEST_DIRECTORY,
            name,
          );
          const value = JSON.parse(
            await readJsonFileDescriptor(
              path,
              MAX_SUBMISSION_BYTES,
              'Review request state',
            ),
          );
          const record = parseStoredSubmission(
            value,
            value.requestId,
            projectSlug,
          );
          if (
            name !== `${reviewEvidenceId({ requestId: record.requestId })}.json`
          )
            throw new Error('Review request identity is invalid.');
          if (
            canonicalReviewJson(record.taskBinding ?? null) ===
            canonicalReviewJson(binding)
          )
            records.push(record);
        }
        records.sort(
          (a, b) =>
            b.startedAt.localeCompare(a.startedAt) ||
            a.requestId.localeCompare(b.requestId),
        );
        return {
          requestIds: records.slice(0, 20).map((record) => record.requestId),
          omitted: Math.max(0, records.length - 20),
        };
      },
      { lockTimeoutMs: READ_LOCK_TIMEOUT_MS },
    );
  }

  async invoking(input: {
    request: IndependentReviewRequest;
    updatedAt: string;
    guard?: ReviewWriteGuard;
  }): Promise<void> {
    await this.#settleSubmission(
      input.request,
      (current) => ({
        ...current,
        phase: 'invoking',
        updatedAt: input.updatedAt,
      }),
      input.guard,
    );
  }

  async complete(input: {
    request: IndependentReviewRequest;
    result: IndependentReviewRunResult;
    completedAt: string;
    guard?: ReviewWriteGuard;
  }): Promise<IndependentReviewRequestStatus> {
    return this.#settleSubmission(
      input.request,
      (current) => ({
        ...current,
        state: 'completed',
        updatedAt: input.completedAt,
        receiptId: input.result.receipt.receiptId,
        attachment: input.result.attachment,
        cleanup: input.result.cleanup,
        failureReason: undefined,
      }),
      input.guard,
    );
  }

  async fail(input: {
    request: IndependentReviewRequest;
    state: 'rejected' | 'indeterminate' | 'not-verified';
    updatedAt: string;
    unavailableLenses?: string[];
    failureReason?: string;
    guard?: ReviewWriteGuard;
  }): Promise<IndependentReviewRequestStatus> {
    return this.#settleSubmission(
      input.request,
      (current) => ({
        ...current,
        state: input.state,
        updatedAt: input.updatedAt,
        failureReason:
          input.state === 'rejected'
            ? 'The independent review request was rejected before reviewer execution.'
            : input.state === 'not-verified'
              ? (input.failureReason ??
                'No eligible read-only reviewer was available; human review is required.')
              : 'The independent review outcome is uncertain and must not be retried automatically.',
        ...(input.state === 'not-verified'
          ? { unavailableLenses: input.unavailableLenses ?? ['human-review'] }
          : {}),
      }),
      input.guard,
    );
  }

  async status(
    requestId: string,
    projectSlug: string,
    currentOwnerActive = false,
    includeTaskReviews = true,
  ): Promise<IndependentReviewRequestStatus | null> {
    return this.#withProjectLock(projectSlug, async (root) => {
      const record = await this.#readSubmission(requestId, projectSlug, root);
      if (!record) return null;
      if (!includeTaskReviews && record.taskBinding) return null;
      const lostSameOwnerInvocation =
        record.ownerId === this.#ownerId &&
        record.phase === 'invoking' &&
        !currentOwnerActive;
      const deadForeignOwner =
        record.ownerId !== this.#ownerId && !processIsAlive(record.ownerPid);
      if (
        record.state === 'running' &&
        (lostSameOwnerInvocation || deadForeignOwner)
      ) {
        const reconciled: StoredSubmission = {
          ...record,
          state: 'indeterminate',
          updatedAt: new Date().toISOString(),
          failureReason:
            'The independent review outcome is uncertain and must not be retried automatically.',
        };
        await this.#writeSubmission(reconciled, root);
        return this.#projectSubmission(reconciled, root, includeTaskReviews);
      }
      return this.#projectSubmission(record, root, includeTaskReviews);
    });
  }

  async #receiptNames(directory: string): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    const names = entries
      .filter((name) => name.endsWith('.json') && name !== INDEX_FILE)
      .sort();
    if (
      names.some((name) => !RECEIPT_ID.test(name.slice(0, -'.json'.length)))
    ) {
      throw new Error('Review receipt directory contains an invalid entry.');
    }
    if (names.length > this.#maxReceiptsPerProject) {
      throw new Error('Review receipt capacity invariant is unavailable.');
    }
    return names;
  }

  async #receiptDirectory(
    root: RootIdentity,
    create: boolean,
  ): Promise<string> {
    await validateRootIdentity(root);
    const directory = resolve(root.path, RECEIPT_DIRECTORY);
    const rel = relative(root.path, directory);
    if (!rel || rel.startsWith(`..${sep}`) || rel === '..') {
      throw new Error(
        'Review receipt directory escapes the project workspace.',
      );
    }
    await assertNoSymlinkPath(root.path, dirname(directory));
    if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
    const stat = await lstat(directory).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' && !create) return undefined;
        throw error;
      },
    );
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new Error('Review receipt directory is unavailable.');
    }
    await validateRootIdentity(root);
    return directory;
  }

  async #rootIdentity(projectSlug: string): Promise<RootIdentity> {
    const workspace = this.projects.workspace(projectSlug);
    if (!workspace) throw new ReviewProjectWorkspaceMissingError(projectSlug);
    return captureRootIdentity(resolve(workspace));
  }

  async #withProjectLock<T>(
    projectSlug: string,
    operation: (root: RootIdentity) => Promise<T>,
    options?: ReviewWriteGuard & { lockTimeoutMs?: number },
  ): Promise<T> {
    options?.assertCurrent?.();
    const root =
      options?.storageIdentity ?? (await this.#rootIdentity(projectSlug));
    await ensurePrivateDirectory(this.#coordinationDirectory);
    const lockIdentity = createHash('sha256')
      .update(`${root.realpath}\0${root.dev}\0${root.ino}`)
      .digest('hex');
    let release: Awaited<ReturnType<typeof acquireFileMutationLockAsync>>;
    try {
      release = await this.#acquireLock(
        join(this.#coordinationDirectory, `${lockIdentity}.mutation`),
        options?.lockTimeoutMs === undefined
          ? undefined
          : { timeoutMs: options.lockTimeoutMs },
      );
    } catch (error) {
      throw new ReviewProjectLockUnavailableError(projectSlug, error);
    }
    let value!: T;
    let operationCompleted = false;
    let operationError: unknown;
    try {
      await validateRootIdentity(root);
      options?.assertCurrent?.();
      value = await operation(root);
      operationCompleted = true;
    } catch (error) {
      operationError = error;
    }
    try {
      await release();
    } catch (error) {
      this.#observeDiagnostic('lock.release', error);
      if (!operationCompleted && operationError === undefined) {
        operationError = error;
      }
    }
    if (operationError !== undefined) throw operationError;
    return value;
  }

  async #readIndex(directory: string): Promise<ReviewReceiptReference[]> {
    const raw = await readJsonFileDescriptor(
      join(directory, INDEX_FILE),
      MAX_INDEX_BYTES,
      'Review receipt index',
    );
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value) || value.length > this.#maxReceiptsPerProject) {
      throw new Error('Review receipt index is invalid.');
    }
    return value.map((entry) => parseReference(entry));
  }

  async #writeIndex(
    directory: string,
    entries: ReviewReceiptReference[],
    root: RootIdentity,
    directoryIdentity: RootIdentity,
    assertCurrent?: () => void,
  ): Promise<void> {
    const sorted = sortReferences(entries);
    if (sorted.length > this.#maxReceiptsPerProject) {
      throw new Error('Review receipt capacity invariant is unavailable.');
    }
    await publishJsonFileWithOwnedLock(join(directory, INDEX_FILE), sorted, {
      maxBytes: MAX_INDEX_BYTES,
      label: 'Review receipt index',
      assertCurrent,
      beforeCommit: async () => {
        await validatePublicationIdentity(root, directoryIdentity);
        assertCurrent?.();
      },
    });
  }

  async #ensureIndexed(
    directory: string,
    receipt: IndependentReviewReceipt,
    root: RootIdentity,
    directoryIdentity: RootIdentity,
    assertCurrent?: () => void,
  ): Promise<void> {
    const current = await this.#readIndex(directory).catch(() => []);
    const next = current.filter(
      (entry) => entry.receiptId !== receipt.receiptId,
    );
    next.push(referenceFor(receipt));
    await this.#writeIndex(
      directory,
      next,
      root,
      directoryIdentity,
      assertCurrent,
    );
  }

  async #submissionPath(
    requestId: string,
    root: RootIdentity,
    create: boolean,
  ): Promise<string> {
    const receiptDirectory = await this.#receiptDirectory(root, create);
    const requestDirectory = join(receiptDirectory, REQUEST_DIRECTORY);
    if (create) await mkdir(requestDirectory, { recursive: true, mode: 0o700 });
    const info = await lstat(requestDirectory).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT' && !create) return undefined;
        throw error;
      },
    );
    if (info && (!info.isDirectory() || info.isSymbolicLink())) {
      throw new Error('Review request directory is unavailable.');
    }
    return join(requestDirectory, `${reviewEvidenceId({ requestId })}.json`);
  }

  async #submissionNames(root: RootIdentity): Promise<string[]> {
    const receiptDirectory = await this.#receiptDirectory(root, false);
    const requestDirectory = join(receiptDirectory, REQUEST_DIRECTORY);
    let names: string[];
    try {
      names = await readdir(requestDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (
      names.some(
        (name) =>
          !name.endsWith('.json') ||
          !RECEIPT_ID.test(name.slice(0, -'.json'.length)),
      )
    ) {
      throw new Error('Review request directory contains an invalid entry.');
    }
    if (names.length > this.#maxReceiptsPerProject) {
      throw new Error('Review request capacity invariant is unavailable.');
    }
    return names.sort();
  }

  async #readSubmission(
    requestId: string,
    projectSlug: string,
    root: RootIdentity,
  ): Promise<StoredSubmission | null> {
    const path = await this.#submissionPath(requestId, root, false);
    let raw: string;
    try {
      raw = await readJsonFileDescriptor(
        path,
        MAX_SUBMISSION_BYTES,
        'Review request state',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return parseStoredSubmission(JSON.parse(raw), requestId, projectSlug);
  }

  async #writeSubmission(
    record: StoredSubmission,
    root: RootIdentity,
    assertCurrent?: () => void,
  ): Promise<void> {
    const path = await this.#submissionPath(record.requestId, root, true);
    const requestDirectoryIdentity = await captureRootIdentity(dirname(path));
    await publishJsonFileWithOwnedLock(path, record, {
      maxBytes: MAX_SUBMISSION_BYTES,
      label: 'Review request state',
      assertCurrent,
      beforeCommit: async () => {
        await validatePublicationIdentity(root, requestDirectoryIdentity);
        assertCurrent?.();
      },
    });
  }

  async #settleSubmission(
    request: IndependentReviewRequest,
    transition: (current: StoredSubmission) => StoredSubmission,
    guard?: ReviewWriteGuard,
  ): Promise<IndependentReviewRequestStatus> {
    return this.#withProjectLock(
      request.target.projectSlug,
      async (root) => {
        const current = await this.#readSubmission(
          request.requestId,
          request.target.projectSlug,
          root,
        );
        if (!current || current.requestSha256 !== reviewEvidenceId(request)) {
          throw new Error('Review request state is unavailable.');
        }
        if (current.state !== 'running')
          return this.#projectSubmission(current, root);
        if (current.ownerId !== this.#ownerId) {
          throw new Error('Review request is owned by another runtime.');
        }
        const next = transition(current);
        await this.#writeSubmission(next, root, guard?.assertCurrent);
        return this.#projectSubmission(next, root);
      },
      guard,
    );
  }

  async #projectSubmission(
    record: StoredSubmission,
    root: RootIdentity,
    includeTaskReviews = true,
  ): Promise<IndependentReviewRequestStatus> {
    if (record.state !== 'completed') {
      return {
        requestId: record.requestId,
        projectSlug: record.projectSlug,
        state: record.state,
        startedAt: record.startedAt,
        updatedAt: record.updatedAt,
        ...(record.failureReason
          ? { failureReason: record.failureReason }
          : {}),
        ...(record.unavailableLenses
          ? { unavailableLenses: record.unavailableLenses }
          : {}),
      };
    }
    if (!record.receiptId || !record.attachment || !record.cleanup) {
      throw new Error('Completed review request state is corrupt.');
    }
    const receipt = await this.read(record.receiptId, record.projectSlug, {
      storageIdentity: root,
      includeTaskReviews,
    });
    if (!receipt || receipt.requestId !== record.requestId) {
      throw new Error('Completed review request receipt is unavailable.');
    }
    return {
      requestId: record.requestId,
      projectSlug: record.projectSlug,
      state: 'completed',
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      result: {
        receipt,
        attachment: record.attachment,
        cleanup: record.cleanup,
      },
      ...(receipt.routing ? { routing: receipt.routing } : {}),
    };
  }

  #observeDiagnostic(operation: string, error: unknown): void {
    try {
      this.#diagnostic(operation, error);
    } catch {}
  }
}

function assertRegularFile(stat: Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new Error('Review receipt must be a single regular file.');
  }
}

async function assertNoSymlinkPath(
  root: string,
  targetParent: string,
): Promise<void> {
  const rel = relative(root, targetParent);
  if (rel.startsWith(`..${sep}`) || rel === '..') {
    throw new Error('Review receipt path escapes the workspace.');
  }
  let current = root;
  for (const segment of rel.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('Review receipt path contains an unsafe component.');
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

async function captureRootIdentity(path: string): Promise<RootIdentity> {
  const resolved = resolve(path);
  const info = await lstat(resolved);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error('Review evidence root must be a real directory.');
  }
  return {
    path: resolved,
    realpath: await realpath(resolved),
    dev: info.dev,
    ino: info.ino,
  };
}

async function validateRootIdentity(identity: RootIdentity): Promise<void> {
  const current = await captureRootIdentity(identity.path);
  if (
    current.dev !== identity.dev ||
    current.ino !== identity.ino ||
    current.realpath !== identity.realpath
  ) {
    throw new Error('Review evidence root identity changed.');
  }
}

async function validatePublicationIdentity(
  root: RootIdentity,
  directory: RootIdentity,
): Promise<void> {
  await validateRootIdentity(root);
  await validateRootIdentity(directory);
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (process.getuid !== undefined &&
      (info.uid !== process.getuid() || (info.mode & 0o077) !== 0))
  ) {
    throw new Error('Review evidence coordination directory is not private.');
  }
}

async function readJsonFileDescriptor(
  path: string,
  maxBytes: number,
  label: string,
): Promise<string> {
  const descriptor = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const info = await descriptor.stat();
    assertRegularFile(info);
    if (info.size > maxBytes) throw new Error(`${label} exceeds byte limit.`);
    return descriptor.readFile('utf8');
  } finally {
    await descriptor.close();
  }
}

function referenceFor(
  receipt: IndependentReviewReceipt,
): ReviewReceiptReference {
  return {
    receiptId: receipt.receiptId,
    projectSlug: receipt.target.projectSlug,
    completedAt: receipt.completedAt,
  };
}

function sortReferences(
  entries: ReviewReceiptReference[],
): ReviewReceiptReference[] {
  return [...entries].sort(
    (left, right) =>
      right.completedAt.localeCompare(left.completedAt) ||
      left.receiptId.localeCompare(right.receiptId),
  );
}

function parseReference(value: unknown): ReviewReceiptReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Review receipt index entry is invalid.');
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) => !['receiptId', 'projectSlug', 'completedAt'].includes(key),
    ) ||
    !RECEIPT_ID.test(String(input.receiptId)) ||
    typeof input.projectSlug !== 'string' ||
    !input.projectSlug ||
    typeof input.completedAt !== 'string' ||
    Number.isNaN(Date.parse(input.completedAt))
  ) {
    throw new Error('Review receipt index entry is invalid.');
  }
  return {
    receiptId: String(input.receiptId),
    projectSlug: input.projectSlug,
    completedAt: input.completedAt,
  };
}

function parseStoredSubmission(
  value: unknown,
  requestId: string,
  projectSlug: string,
): StoredSubmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Review request state is invalid.');
  }
  const input = value as Record<string, unknown>;
  const allowed = [
    'schemaVersion',
    'requestId',
    'projectSlug',
    'requestSha256',
    'ownerId',
    'ownerPid',
    'phase',
    'state',
    'startedAt',
    'updatedAt',
    'receiptId',
    'attachment',
    'cleanup',
    'failureReason',
    'unavailableLenses',
    'taskBinding',
  ];
  if (
    Object.keys(input).some((key) => !allowed.includes(key)) ||
    (input.schemaVersion !== 1 && input.schemaVersion !== 2) ||
    (input.schemaVersion === 2
      ? !validTaskBinding(input.taskBinding)
      : input.taskBinding !== undefined) ||
    input.requestId !== requestId ||
    input.projectSlug !== projectSlug ||
    !RECEIPT_ID.test(String(input.requestSha256)) ||
    typeof input.ownerId !== 'string' ||
    !input.ownerId ||
    !Number.isInteger(input.ownerPid) ||
    Number(input.ownerPid) < 1 ||
    !['prepared', 'invoking'].includes(String(input.phase)) ||
    ![
      'running',
      'completed',
      'rejected',
      'indeterminate',
      'not-verified',
    ].includes(String(input.state)) ||
    typeof input.startedAt !== 'string' ||
    Number.isNaN(Date.parse(input.startedAt)) ||
    typeof input.updatedAt !== 'string' ||
    Number.isNaN(Date.parse(input.updatedAt)) ||
    Date.parse(input.updatedAt) < Date.parse(input.startedAt) ||
    (input.state === 'completed'
      ? !(
          RECEIPT_ID.test(String(input.receiptId)) &&
          validStoredAttachment(input.attachment) &&
          validStoredCleanup(input.cleanup)
        )
      : input.receiptId !== undefined ||
        input.attachment !== undefined ||
        input.cleanup !== undefined) ||
    (input.state === 'rejected' ||
      input.state === 'indeterminate' ||
      input.state === 'not-verified') !==
      (typeof input.failureReason === 'string' &&
        input.failureReason.length > 0) ||
    (input.state === 'not-verified'
      ? !(
          Array.isArray(input.unavailableLenses) &&
          input.unavailableLenses.length > 0 &&
          input.unavailableLenses.length <= 8 &&
          input.unavailableLenses.every(
            (lens) => typeof lens === 'string' && lens.length > 0,
          ) &&
          new Set(input.unavailableLenses).size ===
            input.unavailableLenses.length
        )
      : input.unavailableLenses !== undefined) ||
    ((input.state === 'running' || input.state === 'completed') &&
      input.failureReason !== undefined)
  ) {
    throw new Error('Review request state is invalid.');
  }
  return input as unknown as StoredSubmission;
}

function validTaskBinding(value: unknown): value is ReviewTaskBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = ['projectId', 'projectCreatedAt', 'taskId', 'taskCreatedAt'];
  return (
    Object.keys(row).length === keys.length &&
    keys.every(
      (key) =>
        typeof row[key] === 'string' &&
        row[key].length > 0 &&
        row[key].length <= 256,
    )
  );
}

function validStoredAttachment(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (input.status === 'not-requested') {
    return Object.keys(input).length === 1;
  }
  if (input.status === 'attached') {
    return (
      Object.keys(input).length === 2 &&
      typeof input.evidenceId === 'string' &&
      input.evidenceId.length > 0
    );
  }
  return (
    input.status === 'unavailable' &&
    Object.keys(input).length === 2 &&
    typeof input.reason === 'string' &&
    input.reason.length > 0
  );
}

function validStoredCleanup(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  if (input.status === 'completed') return Object.keys(input).length === 1;
  return (
    (input.status === 'retained' || input.status === 'unavailable') &&
    Object.keys(input).length === 2 &&
    typeof input.reason === 'string' &&
    input.reason.length > 0
  );
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
