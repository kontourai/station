import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  type ClientOrigin,
  isClientOrigin,
  type TaskOutputCreateInput,
  type TaskOutputRecord,
} from '@kontourai/station-contracts';
import { fsyncDirectorySync } from '@kontourai/station-shared/fs-windows-compat';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { expandTilde } from '../../utils/paths';
import type { TaskGraphService } from './task-graph-service.js';

export const TASK_OUTPUT_MAX_BYTES = 5 * 1024 * 1024;
export const TASK_OUTPUT_MAX_PER_TASK = 100;
export const TASK_OUTPUT_MAX_HOME_BYTES = 512 * 1024 * 1024;
const STORE_MAX_BYTES = 1024 * 1024;
const STORE_MAX_OUTPUTS = 10_000;
const STORE_MAX_RECEIPTS = 512;
const STORE_MAX_TOMBSTONES = 512;
const STORE_MAX_SNAPSHOTS = STORE_MAX_OUTPUTS;
const OPERATION_ID_MAX_LENGTH = 160;
const TITLE_MAX_LENGTH = 240;
const TASK_ID_MAX_LENGTH = 240;
const PROJECT_ID_MAX_LENGTH = 240;
const PATH_MAX_LENGTH = 4096;
const FILE_NAME_MAX_LENGTH = 240;
const MEDIA_TYPE_MAX_LENGTH = 160;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const SHA256_REF = /^sha256:[a-f0-9]{64}$/;
const CANONICAL_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type StoredOutput = TaskOutputRecord & {
  operationId: string;
  fingerprint: string;
};
type DeletedOperation = {
  taskId: string;
  operationId: string;
  fingerprint: string;
  outputId: string;
};
type Store = {
  schemaVersion: 1;
  outputs: StoredOutput[];
  tombstones: string[];
  deletedOperations: DeletedOperation[];
};
type TaskOutputLimits = {
  maxBytes: number;
  maxPerTask: number;
  maxHomeBytes: number;
  maxDeletedOperations: number;
  maxTombstones: number;
};
type ReconciledStore = { store: Store; verifiedBytes: number };
type SourceSnapshotPort = {
  /** Undefined proves the conservative no-O_NOFOLLOW refusal path. */
  noFollow: number | undefined;
  observe?: (stage: 'after-open' | 'after-read', path: string) => void;
};

export class TaskOutputConflictError extends Error {}
export class TaskOutputUnavailableError extends Error {}
export class TaskOutputNotFoundError extends Error {}
/** A delayed identical create was deleted and must never recreate bytes. */
export class TaskOutputDeletedOperationError extends Error {}
/** Publication crossed rename but its durable readback could not be proven. */
export class TaskOutputCommitUncertainError extends TaskOutputUnavailableError {}

/**
 * Deep personal-home authority for immutable Task workspace-file snapshots.
 * It intentionally owns neither Task graph relations nor attachment blobs.
 */
export class TaskOutputModule {
  private readonly home: string;
  private readonly root: string;
  private readonly indexPath: string;
  private readonly blobRoot: string;
  private readonly limits: TaskOutputLimits;

  constructor(
    private readonly input: {
      homeDir: string;
      taskGraphService: TaskGraphService;
      hosted?: () => boolean;
      now?: () => Date;
      /** Test-only bounded fixtures; production uses the exported limits. */
      limits?: Partial<TaskOutputLimits>;
      /** Test-only source-race observation and O_NOFOLLOW capability seam. */
      sourceSnapshotPort?: SourceSnapshotPort;
      /** Test-only post-commit reclamation seam. Never an authority hook. */
      afterDeleteCommitCleanup?: () => void;
    },
  ) {
    this.home = resolve(input.homeDir);
    this.root = join(this.home, 'task-outputs');
    this.indexPath = join(this.root, 'index.json');
    this.blobRoot = join(this.root, 'snapshots');
    this.limits = {
      maxBytes: input.limits?.maxBytes ?? TASK_OUTPUT_MAX_BYTES,
      maxPerTask: input.limits?.maxPerTask ?? TASK_OUTPUT_MAX_PER_TASK,
      maxHomeBytes: input.limits?.maxHomeBytes ?? TASK_OUTPUT_MAX_HOME_BYTES,
      maxDeletedOperations:
        input.limits?.maxDeletedOperations ?? STORE_MAX_RECEIPTS,
      maxTombstones: input.limits?.maxTombstones ?? STORE_MAX_TOMBSTONES,
    };
    if (!isLimits(this.limits))
      throw new Error('Invalid Task Output test limits');
  }

  async list(taskId: string): Promise<TaskOutputRecord[]> {
    this.assertPersonal();
    this.assertTaskExists(taskId);
    const { store } = await this.withLock(() => this.reconcileStoreLocked());
    return store.outputs
      .filter((output) => output.taskId === taskId)
      .map(stripStoredOutput);
  }

  async read(taskId: string, outputId: string): Promise<TaskOutputRecord> {
    this.assertPersonal();
    this.assertTaskExists(taskId);
    const { store } = await this.withLock(() => this.reconcileStoreLocked());
    return stripStoredOutput(this.findInStore(store, taskId, outputId));
  }

  /** Startup callers may reconcile the bounded snapshot/index authority. */
  async reconcile(): Promise<void> {
    this.assertPersonal();
    await this.withLock(() => this.reconcileStoreLocked());
  }

  async create(
    taskId: string,
    input: TaskOutputCreateInput,
    createdClientOrigin?: ClientOrigin,
  ): Promise<TaskOutputRecord> {
    this.assertPersonal();
    const task = await this.assertTaskWorkspace(taskId);
    return this.withLock(() => {
      const normalized = normalizeCreateInput(input);
      const fingerprint = digest(
        JSON.stringify({
          relativePath: normalized.relativePath,
          title: normalized.title,
          declaredMediaType: normalized.declaredMediaType ?? null,
        }),
      );
      const reconciled = this.reconcileStoreLocked();
      const { store } = reconciled;
      const prior = store.outputs.find(
        (output) =>
          output.taskId === taskId &&
          output.operationId === normalized.operationId,
      );
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new TaskOutputConflictError('Task output operation conflicts');
        return stripStoredOutput(prior);
      }
      const deleted = store.deletedOperations.find(
        (receipt) =>
          receipt.taskId === taskId &&
          receipt.operationId === normalized.operationId,
      );
      if (deleted) {
        if (deleted.fingerprint !== fingerprint)
          throw new TaskOutputConflictError('Task output operation conflicts');
        throw new TaskOutputDeletedOperationError('Task output was deleted');
      }
      if (
        store.outputs.filter((output) => output.taskId === taskId).length >=
        this.limits.maxPerTask
      ) {
        throw new TaskOutputUnavailableError('Task output limit reached');
      }
      this.assertReservedDeletionIdentityCapacity(store, 1);
      const snapshot = readWorkspaceSnapshot(
        // resolve(expandTilde(...)), never resolve alone (archive#3155): a
        // workspace binding stores `~/...` verbatim, and `resolve` treats `~`
        // as an ordinary segment, so the root became `<cwd>/~/...`.
        resolve(expandTilde(task.workspaceBinding!.workingDirectory!)),
        normalized.relativePath,
        this.limits.maxBytes,
        this.input.sourceSnapshotPort ?? {
          noFollow: fsConstants.O_NOFOLLOW,
        },
      );
      const digestValue = digest(snapshot.bytes);
      const digestRef = `sha256:${digestValue}` as `sha256:${string}`;
      const alreadyVerified = store.outputs.some(
        (output) =>
          output.materialization.digest === digestRef &&
          output.materialization.contentAvailable,
      );
      if (
        reconciled.verifiedBytes +
          (alreadyVerified ? 0 : snapshot.bytes.length) >
        this.limits.maxHomeBytes
      ) {
        throw new TaskOutputUnavailableError('Task output storage is full');
      }
      this.publishSnapshot(digestValue, snapshot.bytes);
      const output: StoredOutput = {
        schemaVersion: 1,
        id: randomUUID(),
        taskId,
        projectId: task.projectId,
        title: normalized.title,
        source: {
          kind: 'workspace-file',
          relativePath: normalized.relativePath,
        },
        materialization: {
          kind: 'snapshot',
          fileName: basename(normalized.relativePath),
          mediaType:
            normalized.declaredMediaType ??
            mediaTypeFor(normalized.relativePath),
          byteLength: snapshot.bytes.length,
          digest: digestRef,
          contentAvailable: true,
        },
        createdAt: (this.input.now ?? (() => new Date()))().toISOString(),
        ...(createdClientOrigin ? { createdClientOrigin } : {}),
        operationId: normalized.operationId,
        fingerprint,
      };
      store.outputs.push(output);
      assertStore(store);
      this.writeStore(store);
      return stripStoredOutput(output);
    });
  }

  /**
   * Promote one already-declared workspace candidate.  Unlike the ordinary
   * workspace picker this never trusts the path alone: the descriptor-safe
   * acquisition and the declaration digest/length comparison happen while
   * this module owns the publication lock, against the very same byte buffer
   * that is published as the immutable Task snapshot.
   */
  async createDeclared(
    taskId: string,
    input: {
      operationId: string;
      title: string;
      sourceWorkspace: string;
      relativePath: string;
      digest: string;
      length: number;
      declaredMediaType?: string;
      fingerprintContext: string;
      /** Route-owned principal/task witness, evaluated while publication locks. */
      isAuthorized?: () => boolean;
    },
    createdClientOrigin?: ClientOrigin,
  ): Promise<{ outcome: 'kept' | 'already-kept'; output: TaskOutputRecord }> {
    this.assertPersonal();
    return this.withLock(() => {
      if (input.isAuthorized?.() === false)
        throw new TaskOutputNotFoundError('Task output not found');
      const task = this.assertTaskExists(taskId);
      const normalized = normalizeCreateInput(input);
      if (
        !SHA256_HEX.test(input.digest) ||
        input.length < 0 ||
        input.length > this.limits.maxBytes
      )
        throw new TaskOutputNotFoundError('Task output not found');
      const fingerprint = digest(
        JSON.stringify({
          candidate: input.fingerprintContext,
          relativePath: normalized.relativePath,
          title: normalized.title,
          declaredMediaType: normalized.declaredMediaType ?? null,
        }),
      );
      const { store, verifiedBytes } = this.reconcileStoreLocked();
      // Operation receipt identity takes precedence over target deduplication:
      // reusing an operation id for a different admitted candidate is a
      // conflict even if that other candidate has already been kept.
      const prior = store.outputs.find(
        (output) =>
          output.taskId === taskId &&
          output.operationId === normalized.operationId,
      );
      if (prior) {
        if (prior.fingerprint !== fingerprint)
          throw new TaskOutputConflictError('Task output operation conflicts');
        return { outcome: 'already-kept', output: stripStoredOutput(prior) };
      }
      const deleted = store.deletedOperations.find(
        (receipt) =>
          receipt.taskId === taskId &&
          receipt.operationId === normalized.operationId,
      );
      if (deleted) {
        if (deleted.fingerprint !== fingerprint)
          throw new TaskOutputConflictError('Task output operation conflicts');
        throw new TaskOutputDeletedOperationError('Task output was deleted');
      }
      if (
        store.deletedOperations.some(
          (receipt) =>
            receipt.taskId === taskId && receipt.fingerprint === fingerprint,
        )
      ) {
        // A later operation id cannot resurrect an exact candidate that its
        // Task owner deliberately deleted.
        throw new TaskOutputDeletedOperationError('Task output was deleted');
      }
      // A curation target is the exact admitted candidate, not a new copy
      // request. A second operation for the same candidate therefore returns
      // the first immutable record without consuming quota or publishing more
      // bytes, but only after its own operation receipt has been checked.
      const existingTarget = store.outputs.find(
        (output) =>
          output.taskId === taskId && output.fingerprint === fingerprint,
      );
      if (existingTarget)
        return {
          outcome: 'already-kept',
          output: stripStoredOutput(existingTarget),
        };
      if (
        store.outputs.filter((output) => output.taskId === taskId).length >=
        this.limits.maxPerTask
      )
        throw new TaskOutputUnavailableError('Task output limit reached');
      this.assertReservedDeletionIdentityCapacity(store, 1);
      const snapshot = readWorkspaceSnapshot(
        resolve(expandTilde(input.sourceWorkspace)),
        normalized.relativePath,
        this.limits.maxBytes,
        this.input.sourceSnapshotPort ?? { noFollow: fsConstants.O_NOFOLLOW },
      );
      // This is deliberately after descriptor-safe open/read/revalidation and
      // before publication.  A stale declaration can therefore never retain
      // replacement bytes under old provenance.
      if (
        snapshot.bytes.length !== input.length ||
        digest(snapshot.bytes) !== input.digest
      )
        throw new TaskOutputNotFoundError('Task output not found');
      // The descriptor read can take arbitrarily long. Re-evaluate the one
      // route-owned current witness after it, and again immediately before
      // each durable publication boundary; this synchronous lock has no await
      // after either decision.
      if (input.isAuthorized?.() === false)
        throw new TaskOutputNotFoundError('Task output not found');
      const digestRef = `sha256:${input.digest}` as `sha256:${string}`;
      const alreadyVerified = store.outputs.some(
        (output) =>
          output.materialization.digest === digestRef &&
          output.materialization.contentAvailable,
      );
      if (
        verifiedBytes + (alreadyVerified ? 0 : snapshot.bytes.length) >
        this.limits.maxHomeBytes
      )
        throw new TaskOutputUnavailableError('Task output storage is full');
      if (input.isAuthorized?.() === false)
        throw new TaskOutputNotFoundError('Task output not found');
      this.publishSnapshot(input.digest, snapshot.bytes);
      const output: StoredOutput = {
        schemaVersion: 1,
        id: randomUUID(),
        taskId,
        projectId: task.projectId,
        title: normalized.title,
        source: {
          kind: 'workspace-file',
          relativePath: normalized.relativePath,
        },
        materialization: {
          kind: 'snapshot',
          fileName: basename(normalized.relativePath),
          mediaType:
            normalized.declaredMediaType ??
            mediaTypeFor(normalized.relativePath),
          byteLength: snapshot.bytes.length,
          digest: digestRef,
          contentAvailable: true,
        },
        createdAt: (this.input.now ?? (() => new Date()))().toISOString(),
        ...(createdClientOrigin ? { createdClientOrigin } : {}),
        operationId: normalized.operationId,
        fingerprint,
      };
      store.outputs.push(output);
      assertStore(store);
      if (input.isAuthorized?.() === false)
        throw new TaskOutputNotFoundError('Task output not found');
      this.writeStore(store);
      return { outcome: 'kept', output: stripStoredOutput(output) };
    });
  }

  async readContent(
    taskId: string,
    outputId: string,
  ): Promise<{ output: TaskOutputRecord; bytes: Buffer }> {
    this.assertPersonal();
    this.assertTaskExists(taskId);
    return this.withLock(() => {
      const { store } = this.reconcileStoreLocked();
      const output = this.findInStore(store, taskId, outputId);
      if (!output.materialization.contentAvailable) {
        throw new TaskOutputUnavailableError('Task output content unavailable');
      }
      // Content reads independently re-hash the descriptor-backed bytes.
      const bytes = this.readVerifiedSnapshot(output.materialization.digest);
      if (!bytes || bytes.length !== output.materialization.byteLength) {
        throw new TaskOutputUnavailableError('Task output content unavailable');
      }
      return { output: stripStoredOutput(output), bytes };
    });
  }

  async delete(taskId: string, outputId: string): Promise<void> {
    this.assertPersonal();
    this.assertTaskExists(taskId);
    await this.withLock(() => {
      const { store } = this.reconcileStoreLocked();
      const index = store.outputs.findIndex(
        (output) => output.taskId === taskId && output.id === outputId,
      );
      if (index < 0) throw new TaskOutputNotFoundError('Task output not found');
      const candidate = store.outputs[index]!;
      this.assertReservedDeletionIdentityCapacity(store);
      const [removed] = store.outputs.splice(index, 1);
      store.tombstones.push(tombstoneFor(taskId, outputId));
      store.deletedOperations.push({
        taskId,
        operationId: removed.operationId,
        fingerprint: removed.fingerprint,
        outputId,
      });
      this.assertReservedDeletionIdentityCapacity(store);
      assertStore(store);
      this.writeDeleteStoreOrVerify(store, taskId, [candidate]);
      this.reclaimAfterCommittedDelete();
    });
  }

  /**
   * TaskGraph must call this only after its authoritative Task delete commits.
   * Atomic composition with that owner remains a future seam.
   */
  async deleteForTask(taskId: string): Promise<void> {
    this.assertPersonal();
    if (this.input.taskGraphService.readTask(taskId)) {
      throw new TaskOutputUnavailableError(
        'Task outputs require completed Task deletion',
      );
    }
    await this.withLock(() => {
      const { store } = this.reconcileStoreLocked();
      store.outputs = store.outputs.filter(
        (output) => output.taskId !== taskId,
      );
      store.deletedOperations = store.deletedOperations.filter(
        (receipt) => receipt.taskId !== taskId,
      );
      store.tombstones = store.tombstones.filter(
        (tombstone) => !tombstoneBelongsToTask(tombstone, taskId),
      );
      assertStore(store);
      this.assertReservedDeletionIdentityCapacity(store);
      this.writeStore(store);
      this.reclaimAfterCommittedDelete();
    });
  }

  private assertReservedDeletionIdentityCapacity(
    store: Store,
    additions = 0,
  ): void {
    if (
      store.outputs.length + store.deletedOperations.length + additions >
        this.limits.maxDeletedOperations ||
      store.outputs.length + store.tombstones.length + additions >
        this.limits.maxTombstones
    ) {
      throw new TaskOutputUnavailableError(
        'Task output identity capacity is full',
      );
    }
  }

  private writeDeleteStoreOrVerify(
    store: Store,
    taskId: string,
    removed: readonly StoredOutput[],
  ): void {
    try {
      this.writeStore(store);
      return;
    } catch (error) {
      if (!(error instanceof TaskOutputCommitUncertainError)) throw error;
    }
    // A rename may have occurred before the durability primitive reported an
    // error. Never report a definite delete failure when exact readback proves
    // the indexed deletion; otherwise preserve the honest uncertain outcome.
    try {
      const readback = this.readStore();
      const missing = !readback.outputs.some((output) =>
        removed.some((candidate) => output.id === candidate.id),
      );
      const receipt = removed.every((candidate) =>
        readback.deletedOperations.some(
          (entry) =>
            entry.taskId === taskId &&
            entry.outputId === candidate.id &&
            entry.operationId === candidate.operationId &&
            entry.fingerprint === candidate.fingerprint,
        ),
      );
      if (missing && receipt) return;
    } catch {
      // Readback is itself unavailable; keep the definite-claim boundary.
    }
    throw new TaskOutputCommitUncertainError(
      'Task output deletion commit uncertain',
    );
  }

  private reclaimAfterCommittedDelete(): void {
    try {
      this.input.afterDeleteCommitCleanup?.();
      // Uses the freshly committed index, so a shared digest remains referenced.
      this.reconcileStoreLocked();
    } catch {
      // Index authority is already durable. Reclamation is retried by the next
      // locked reconcile and cannot turn a committed delete into a 503.
    }
  }

  private async withLock<T>(work: () => T): Promise<T> {
    this.ensureStorageRoot();
    const release = await acquireFileMutationLockAsync(
      `${this.indexPath}.mutation`,
    );
    try {
      this.ensureStorageRoot();
      return work();
    } finally {
      await release();
    }
  }

  private assertPersonal(): void {
    if (this.input.hosted?.())
      throw new TaskOutputUnavailableError('Task outputs unavailable');
  }

  private assertTaskExists(taskId: string) {
    const task = this.input.taskGraphService.readTask(taskId);
    if (!task) throw new TaskOutputNotFoundError('Task output not found');
    return task;
  }

  private async assertTaskWorkspace(taskId: string) {
    const task = await this.input.taskGraphService.readTaskForOpen(taskId);
    if (!task) throw new TaskOutputNotFoundError('Task output not found');
    const binding = task.workspaceBinding;
    // A presence check, not a path read: nothing here touches the filesystem,
    // so there is nothing to expand. The read itself is in
    // `readWorkspaceSnapshot`, which does `resolve(expandTilde(...))`.
    if (binding?.availability !== 'available' || !binding?.workingDirectory) {
      throw new TaskOutputNotFoundError('Task output not found');
    }
    return task;
  }

  private ensureStorageRoot(): void {
    try {
      ensureOwnedDirectory(this.home, false);
      this.assertInHome(this.root);
      this.assertInHome(this.indexPath);
      this.assertInHome(this.blobRoot);
      ensureOwnedDirectory(this.root, true);
      ensureOwnedDirectory(this.blobRoot, true);
      assertOwnedRegularOrAbsent(this.indexPath);
    } catch (error) {
      if (error instanceof TaskOutputUnavailableError) throw error;
      throw new TaskOutputUnavailableError('Task output storage unavailable');
    }
  }

  private assertInHome(path: string): void {
    const relation = relative(this.home, resolve(path));
    if (
      relation === '..' ||
      relation.startsWith(`..${sep}`) ||
      isAbsolute(relation)
    ) {
      throw new TaskOutputUnavailableError('Task output storage unavailable');
    }
  }

  private findInStore(
    store: Store,
    taskId: string,
    outputId: string,
  ): StoredOutput {
    const output = store.outputs.find(
      (candidate) => candidate.taskId === taskId && candidate.id === outputId,
    );
    if (!output) throw new TaskOutputNotFoundError('Task output not found');
    return output;
  }

  private readStore(): Store {
    try {
      const bytes = readOwnedFile(this.indexPath, STORE_MAX_BYTES);
      if (!bytes) return emptyStore();
      const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
      assertStore(parsed);
      return parsed;
    } catch (error) {
      if (error instanceof TaskOutputUnavailableError) throw error;
      throw new TaskOutputUnavailableError('Task output storage unavailable');
    }
  }

  private writeStore(store: Store): void {
    assertStore(store);
    const encoded = Buffer.from(JSON.stringify(store));
    if (encoded.length > STORE_MAX_BYTES)
      throw new TaskOutputUnavailableError('Task output storage unavailable');
    const temporary = join(this.root, `.index-${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    let renamed = false;
    try {
      descriptor = openSync(
        temporary,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      writeFileSync(descriptor, encoded);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, this.indexPath);
      renamed = true;
      fsyncDirectorySync(this.root);
    } catch (_error) {
      if (renamed) {
        throw new TaskOutputCommitUncertainError(
          'Task output index commit uncertain',
        );
      }
      throw new TaskOutputUnavailableError('Task output storage unavailable');
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {}
      }
      try {
        unlinkSync(temporary);
      } catch {}
    }
  }

  private publishSnapshot(digestValue: string, bytes: Buffer): void {
    if (!SHA256_HEX.test(digestValue) || bytes.length > this.limits.maxBytes) {
      throw new TaskOutputUnavailableError('Task output storage unavailable');
    }
    const target = join(this.blobRoot, digestValue);
    this.assertInHome(target);
    const existing = this.readVerifiedSnapshot(`sha256:${digestValue}`);
    if (existing) return;
    const temporary = join(this.root, `.snapshot-${randomUUID()}.tmp`);
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporary,
        fsConstants.O_WRONLY |
          fsConstants.O_CREAT |
          fsConstants.O_EXCL |
          (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      try {
        // link is exclusive: a contender cannot silently replace its winner.
        linkSync(temporary, target);
        fsyncDirectorySync(this.blobRoot);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const winner = this.readVerifiedSnapshot(`sha256:${digestValue}`);
        if (!winner)
          throw new TaskOutputUnavailableError(
            'Task output storage unavailable',
          );
      }
    } catch (error) {
      if (error instanceof TaskOutputUnavailableError) throw error;
      throw new TaskOutputUnavailableError('Task output storage unavailable');
    } finally {
      if (descriptor !== undefined) {
        try {
          closeSync(descriptor);
        } catch {}
      }
      try {
        unlinkSync(temporary);
        fsyncDirectorySync(this.root);
      } catch {}
    }
  }

  /** Reconciles only inside the mutation lock. It is the storage authority. */
  private reconcileStoreLocked(): ReconciledStore {
    const store = this.readStore();
    const referenced = new Map<string, StoredOutput[]>();
    for (const output of store.outputs) {
      const outputs = referenced.get(output.materialization.digest) ?? [];
      outputs.push(output);
      referenced.set(output.materialization.digest, outputs);
    }
    const entries = readdirSync(this.blobRoot, { withFileTypes: true });
    if (entries.length > STORE_MAX_SNAPSHOTS)
      throw new TaskOutputUnavailableError('Task output storage unavailable');
    const verified = new Map<string, number>();
    const seen = new Set<string>();
    let changed = false;
    for (const entry of entries) {
      if (!SHA256_HEX.test(entry.name))
        throw new TaskOutputUnavailableError('Task output storage unavailable');
      const digestRef = `sha256:${entry.name}` as `sha256:${string}`;
      const bytes = this.readVerifiedSnapshot(digestRef);
      if (!bytes) {
        // A referenced corrupt/missing snapshot stays inspectable but unavailable.
        if (referenced.has(digestRef)) {
          for (const output of referenced.get(digestRef) ?? []) {
            if (output.materialization.contentAvailable) {
              output.materialization.contentAvailable = false;
              changed = true;
            }
          }
          seen.add(digestRef);
          continue;
        }
        // A corrupt blob without an owner is not evidence to retain; it cannot
        // become an output merely by being named like a digest.
        try {
          unlinkSync(join(this.blobRoot, entry.name));
          changed = true;
        } catch {
          throw new TaskOutputUnavailableError(
            'Task output storage unavailable',
          );
        }
        continue;
      }
      seen.add(digestRef);
      if (referenced.has(digestRef)) {
        verified.set(digestRef, bytes.length);
        for (const output of referenced.get(digestRef) ?? []) {
          const available = bytes.length === output.materialization.byteLength;
          if (output.materialization.contentAvailable !== available) {
            output.materialization.contentAvailable = available;
            changed = true;
          }
        }
      } else {
        try {
          unlinkSync(join(this.blobRoot, entry.name));
          changed = true;
        } catch {
          throw new TaskOutputUnavailableError(
            'Task output storage unavailable',
          );
        }
      }
    }
    for (const [digestRef, outputs] of referenced) {
      if (seen.has(digestRef)) continue;
      for (const output of outputs) {
        if (output.materialization.contentAvailable) {
          output.materialization.contentAvailable = false;
          changed = true;
        }
      }
    }
    if (changed) {
      assertStore(store);
      this.writeStore(store);
      fsyncDirectorySync(this.blobRoot);
    }
    return {
      store,
      verifiedBytes: [...verified.values()].reduce(
        (total, size) => total + size,
        0,
      ),
    };
  }

  private readVerifiedSnapshot(
    digestRef: `sha256:${string}`,
  ): Buffer | undefined {
    const digestValue = digestRef.slice('sha256:'.length);
    if (!SHA256_HEX.test(digestValue))
      throw new TaskOutputUnavailableError('Task output storage unavailable');
    const path = join(this.blobRoot, digestValue);
    this.assertInHome(path);
    let before: ReturnType<typeof lstatSync>;
    try {
      before = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new TaskOutputUnavailableError('Task output storage unavailable');
    }
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.size > this.limits.maxBytes
    ) {
      throw new TaskOutputUnavailableError('Task output storage unavailable');
    }
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        path,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      const opened = fstatSync(descriptor);
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size ||
        opened.size > this.limits.maxBytes
      ) {
        throw new TaskOutputUnavailableError('Task output storage unavailable');
      }
      const bytes = readFileSync(descriptor);
      const after = fstatSync(descriptor);
      const current = lstatSync(path);
      if (
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== opened.size ||
        current.isSymbolicLink() ||
        !current.isFile() ||
        current.dev !== opened.dev ||
        current.ino !== opened.ino
      ) {
        throw new TaskOutputUnavailableError('Task output storage unavailable');
      }
      if (bytes.length !== opened.size || digest(bytes) !== digestValue)
        return undefined;
      return bytes;
    } catch (error) {
      if (error instanceof TaskOutputUnavailableError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new TaskOutputUnavailableError('Task output storage unavailable');
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
}

function emptyStore(): Store {
  return {
    schemaVersion: 1,
    outputs: [],
    tombstones: [],
    deletedOperations: [],
  };
}

function stripStoredOutput(output: StoredOutput): TaskOutputRecord {
  const {
    operationId: _operationId,
    fingerprint: _fingerprint,
    ...record
  } = output;
  return record;
}

function normalizeCreateInput(
  input: TaskOutputCreateInput,
): Required<Omit<TaskOutputCreateInput, 'declaredMediaType'>> &
  Pick<TaskOutputCreateInput, 'declaredMediaType'> {
  const operationId = input.operationId?.trim();
  const title = input.title?.trim();
  const relativePath = normalizeRelativePath(input.relativePath);
  if (!isOperationId(operationId))
    throw new TaskOutputUnavailableError('Task output request unavailable');
  if (!isCanonicalText(title, TITLE_MAX_LENGTH))
    throw new TaskOutputUnavailableError('Task output request unavailable');
  const declaredMediaType = input.declaredMediaType?.trim();
  if (declaredMediaType && !isMediaType(declaredMediaType))
    throw new TaskOutputUnavailableError('Task output request unavailable');
  return {
    operationId,
    title,
    relativePath,
    ...(declaredMediaType ? { declaredMediaType } : {}),
  };
}

function normalizeRelativePath(value: string): string {
  const path = value?.trim();
  if (
    !path ||
    path.length > PATH_MAX_LENGTH ||
    isAbsolute(path) ||
    /^[A-Za-z]:/.test(path) ||
    path.startsWith('\\\\') ||
    /[\0\r\n]/.test(path)
  ) {
    throw new TaskOutputNotFoundError('Task output not found');
  }
  const parts = path.split(/[\\/]+/);
  if (parts.some((part) => !part || part === '.' || part === '..'))
    throw new TaskOutputNotFoundError('Task output not found');
  return parts.join('/');
}

function readWorkspaceSnapshot(
  workingDirectory: string,
  relativePath: string,
  maxBytes: number,
  port: SourceSnapshotPort,
): { bytes: Buffer } {
  try {
    // `workingDirectory` arrives already expanded — the caller owns that, so
    // the expansion has one home. `resolve` stays for containment.
    const canonicalRoot = resolve(workingDirectory);
    const candidate = resolve(canonicalRoot, ...relativePath.split('/'));
    const relation = relative(canonicalRoot, candidate);
    if (
      relation === '..' ||
      relation.startsWith(`..${sep}`) ||
      isAbsolute(relation)
    )
      throw new Error('escape');
    const chain = collectWorkspacePathChain(canonicalRoot, relativePath);
    const before = chain.at(-1)!;
    if (!before.stat.isFile() || before.stat.size > maxBytes)
      throw new Error('not-file');
    const descriptor = openSync(
      candidate,
      // O_NOFOLLOW is not available on every platform. The descriptor identity
      // plus full root/intermediate/final lstat recheck below still rejects a
      // link or any pathname replacement before accepting these bytes.
      fsConstants.O_RDONLY | (port.noFollow ?? 0),
    );
    try {
      port.observe?.('after-open', candidate);
      const opened = fstatSync(descriptor);
      if (
        !opened.isFile() ||
        opened.dev !== before.stat.dev ||
        opened.ino !== before.stat.ino ||
        opened.size > maxBytes ||
        opened.mtimeMs !== before.stat.mtimeMs ||
        opened.ctimeMs !== before.stat.ctimeMs
      ) {
        throw new Error('changed');
      }
      const bytes = Buffer.alloc(opened.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(
          descriptor,
          bytes,
          offset,
          bytes.length - offset,
          offset,
        );
        if (count <= 0) throw new Error('short-read');
        offset += count;
      }
      port.observe?.('after-read', candidate);
      const after = fstatSync(descriptor);
      if (
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs
      )
        throw new Error('changed');
      assertWorkspacePathChainUnchanged(chain, opened);
      return { bytes };
    } finally {
      closeSync(descriptor);
    }
  } catch {
    // Source absence, denial, traversal, and link rejection deliberately collapse.
    throw new TaskOutputNotFoundError('Task output not found');
  }
}

type WorkspacePathIdentity = {
  path: string;
  stat: NonNullable<ReturnType<typeof lstatSync>>;
};

function collectWorkspacePathChain(
  root: string,
  relativePath: string,
): WorkspacePathIdentity[] {
  const chain: WorkspacePathIdentity[] = [];
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
    throw new Error('unsafe-root');
  chain.push({ path: root, stat: rootStat });
  let current = root;
  const parts = relativePath.split('/');
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error('symlink');
    if (index < parts.length - 1 && !stat.isDirectory())
      throw new Error('not-directory');
    chain.push({ path: current, stat });
  }
  return chain;
}

function assertWorkspacePathChainUnchanged(
  chain: WorkspacePathIdentity[],
  opened: NonNullable<ReturnType<typeof fstatSync>>,
): void {
  for (const [index, expected] of chain.entries()) {
    const current = lstatSync(expected.path);
    if (
      current.isSymbolicLink() ||
      current.dev !== expected.stat.dev ||
      current.ino !== expected.stat.ino ||
      (index < chain.length - 1 && !current.isDirectory())
    ) {
      throw new Error('path-changed');
    }
  }
  const final = chain.at(-1)!;
  const currentFinal = lstatSync(final.path);
  if (
    !currentFinal.isFile() ||
    currentFinal.dev !== opened.dev ||
    currentFinal.ino !== opened.ino
  ) {
    throw new Error('final-path-changed');
  }
}

function assertStore(value: unknown): asserts value is Store {
  if (
    !isExactRecord(value, [
      'schemaVersion',
      'outputs',
      'tombstones',
      'deletedOperations',
    ])
  )
    throw new TaskOutputUnavailableError('Task output storage unavailable');
  const store = value as Store;
  if (
    store.schemaVersion !== 1 ||
    !Array.isArray(store.outputs) ||
    !Array.isArray(store.tombstones) ||
    !Array.isArray(store.deletedOperations) ||
    store.outputs.length > STORE_MAX_OUTPUTS ||
    store.tombstones.length > STORE_MAX_TOMBSTONES ||
    store.deletedOperations.length > STORE_MAX_RECEIPTS ||
    !store.outputs.every(isStoredOutput) ||
    !store.tombstones.every(isTombstone) ||
    !store.deletedOperations.every(isDeletedOperation)
  ) {
    throw new TaskOutputUnavailableError('Task output storage unavailable');
  }
  const outputIds = new Set<string>();
  const taskOperations = new Set<string>();
  for (const output of store.outputs) {
    const operation = `${output.taskId}\0${output.operationId}`;
    if (outputIds.has(output.id) || taskOperations.has(operation))
      throw new TaskOutputUnavailableError('Task output storage unavailable');
    outputIds.add(output.id);
    taskOperations.add(operation);
  }
  const tombstones = new Set(store.tombstones);
  if (tombstones.size !== store.tombstones.length)
    throw new TaskOutputUnavailableError('Task output storage unavailable');
  const receiptOperations = new Set<string>();
  const receiptOutputIds = new Set<string>();
  for (const receipt of store.deletedOperations) {
    const operation = `${receipt.taskId}\0${receipt.operationId}`;
    if (
      receiptOperations.has(operation) ||
      receiptOutputIds.has(receipt.outputId) ||
      taskOperations.has(operation) ||
      outputIds.has(receipt.outputId) ||
      !tombstones.has(tombstoneFor(receipt.taskId, receipt.outputId))
    ) {
      throw new TaskOutputUnavailableError('Task output storage unavailable');
    }
    receiptOperations.add(operation);
    receiptOutputIds.add(receipt.outputId);
  }
}

function isStoredOutput(value: unknown): value is StoredOutput {
  const keys = [
    'schemaVersion',
    'id',
    'taskId',
    'projectId',
    'title',
    'source',
    'materialization',
    'createdAt',
    'operationId',
    'fingerprint',
  ];
  if (!isRecord(value)) return false;
  if ('createdClientOrigin' in value) keys.push('createdClientOrigin');
  if (!isExactRecord(value, keys)) return false;
  const output = value as unknown as StoredOutput;
  return (
    output.schemaVersion === 1 &&
    CANONICAL_UUID.test(output.id) &&
    isCanonicalText(output.taskId, TASK_ID_MAX_LENGTH) &&
    isCanonicalText(output.projectId, PROJECT_ID_MAX_LENGTH) &&
    isCanonicalText(output.title, TITLE_MAX_LENGTH) &&
    isSource(output.source) &&
    isMaterialization(output.materialization, output.source.relativePath) &&
    isCanonicalIso(output.createdAt) &&
    isOperationId(output.operationId) &&
    SHA256_HEX.test(output.fingerprint) &&
    (output.createdClientOrigin === undefined ||
      isExactClientOrigin(output.createdClientOrigin))
  );
}

function isSource(value: unknown): value is StoredOutput['source'] {
  return (
    isExactRecord(value, ['kind', 'relativePath']) &&
    value.kind === 'workspace-file' &&
    typeof value.relativePath === 'string' &&
    normalizeStoredRelativePath(value.relativePath)
  );
}

function isMaterialization(
  value: unknown,
  relativePath: string,
): value is StoredOutput['materialization'] {
  return (
    isExactRecord(value, [
      'kind',
      'fileName',
      'mediaType',
      'byteLength',
      'digest',
      'contentAvailable',
    ]) &&
    value.kind === 'snapshot' &&
    typeof value.fileName === 'string' &&
    value.fileName === basename(relativePath) &&
    isSafeFileName(value.fileName) &&
    typeof value.mediaType === 'string' &&
    isMediaType(value.mediaType) &&
    typeof value.byteLength === 'number' &&
    Number.isSafeInteger(value.byteLength) &&
    value.byteLength >= 0 &&
    value.byteLength <= TASK_OUTPUT_MAX_BYTES &&
    typeof value.digest === 'string' &&
    SHA256_REF.test(value.digest) &&
    typeof value.contentAvailable === 'boolean'
  );
}

function isDeletedOperation(value: unknown): value is DeletedOperation {
  return (
    isExactRecord(value, [
      'taskId',
      'operationId',
      'fingerprint',
      'outputId',
    ]) &&
    isCanonicalText(value.taskId, TASK_ID_MAX_LENGTH) &&
    isOperationId(value.operationId) &&
    typeof value.fingerprint === 'string' &&
    SHA256_HEX.test(value.fingerprint) &&
    typeof value.outputId === 'string' &&
    CANONICAL_UUID.test(value.outputId)
  );
}

function isExactClientOrigin(value: unknown): boolean {
  if (
    !isClientOrigin(value) ||
    !isExactRecord(value, ['version', 'actor', 'reported'])
  )
    return false;
  const origin = value as unknown as {
    actor: Record<string, unknown>;
    reported: Record<string, unknown>;
  };
  const actorKeys =
    origin.actor.kind === 'device' ? ['kind', 'deviceId'] : ['kind'];
  return (
    isExactRecord(origin.actor, actorKeys) &&
    isExactRecord(origin.reported, ['version', 'surface', 'build'])
  );
}

function isTombstone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > TASK_ID_MAX_LENGTH + 37)
    return false;
  const marker = value.lastIndexOf(':');
  return (
    marker > 0 &&
    isCanonicalText(value.slice(0, marker), TASK_ID_MAX_LENGTH) &&
    CANONICAL_UUID.test(value.slice(marker + 1))
  );
}

function tombstoneFor(taskId: string, outputId: string): string {
  return `${taskId}:${outputId}`;
}

function tombstoneBelongsToTask(tombstone: string, taskId: string): boolean {
  return tombstone.startsWith(`${taskId}:`);
}

function readOwnedFile(path: string, maxBytes: number): Buffer | undefined {
  let before: ReturnType<typeof lstatSync>;
  try {
    before = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes)
    throw new TaskOutputUnavailableError('Task output storage unavailable');
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size ||
      opened.size > maxBytes
    )
      throw new TaskOutputUnavailableError('Task output storage unavailable');
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    const current = lstatSync(path);
    if (
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      after.size !== opened.size ||
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino
    )
      throw new TaskOutputUnavailableError('Task output storage unavailable');
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function ensureOwnedDirectory(path: string, create: boolean): void {
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new TaskOutputUnavailableError('Task output storage unavailable');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create)
      throw error;
    try {
      mkdirSync(path, { mode: 0o700 });
    } catch (mkdirError) {
      if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST')
        throw mkdirError;
    }
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isDirectory())
      throw new TaskOutputUnavailableError('Task output storage unavailable');
  }
}

function assertOwnedRegularOrAbsent(path: string): void {
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isFile())
      throw new TaskOutputUnavailableError('Task output storage unavailable');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isExactRecord(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function isCanonicalText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= maxLength &&
    value.trim() === value &&
    !/[\0\r\n]/.test(value)
  );
}
function isOperationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= OPERATION_ID_MAX_LENGTH &&
    /^[A-Za-z0-9._:-]+$/.test(value)
  );
}
function normalizeStoredRelativePath(value: string): boolean {
  try {
    return normalizeRelativePath(value) === value;
  } catch {
    return false;
  }
}
function isSafeFileName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= FILE_NAME_MAX_LENGTH &&
    value === value.trim() &&
    value === basename(value) &&
    !/[\\/\0\r\n]/.test(value)
  );
}
function isMediaType(value: string): boolean {
  return (
    value.length <= MEDIA_TYPE_MAX_LENGTH &&
    /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(
      value,
    )
  );
}
function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const time = new Date(value);
  return !Number.isNaN(time.valueOf()) && time.toISOString() === value;
}
function isLimits(value: TaskOutputLimits): boolean {
  return (
    Number.isSafeInteger(value.maxBytes) &&
    value.maxBytes >= 0 &&
    value.maxBytes <= TASK_OUTPUT_MAX_BYTES &&
    Number.isSafeInteger(value.maxPerTask) &&
    value.maxPerTask > 0 &&
    value.maxPerTask <= TASK_OUTPUT_MAX_PER_TASK &&
    Number.isSafeInteger(value.maxHomeBytes) &&
    value.maxHomeBytes >= 0 &&
    value.maxHomeBytes <= TASK_OUTPUT_MAX_HOME_BYTES &&
    Number.isSafeInteger(value.maxDeletedOperations) &&
    value.maxDeletedOperations > 0 &&
    value.maxDeletedOperations <= STORE_MAX_RECEIPTS &&
    Number.isSafeInteger(value.maxTombstones) &&
    value.maxTombstones > 0 &&
    value.maxTombstones <= STORE_MAX_TOMBSTONES
  );
}
function digest(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function mediaTypeFor(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase();
  if (extension === 'json') return 'application/json';
  if (
    [
      'txt',
      'md',
      'ts',
      'tsx',
      'js',
      'jsx',
      'css',
      'py',
      'rs',
      'go',
      'log',
    ].includes(extension ?? '')
  )
    return 'text/plain';
  if (extension === 'png') return 'image/png';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'gif') return 'image/gif';
  if (extension === 'webp') return 'image/webp';
  return 'application/octet-stream';
}
