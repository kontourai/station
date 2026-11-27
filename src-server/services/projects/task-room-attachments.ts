import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  type ChatAttachmentInput,
  parseChatAttachmentDataUrl,
  sniffChatImageMimeType,
  validateChatAttachments,
} from '@kontourai/station-contracts/chat-attachment';
import {
  isTaskRoomAttachments,
  type TaskRoomAttachment,
} from '@kontourai/station-contracts/project-task-room';
import { acquireFileMutationLockAsync } from '@kontourai/station-shared/lifecycle-events';
import { createLogger } from '../../utils/logger.js';
import {
  AttachmentBlobStore,
  attachmentBlobRefFor,
} from '../orchestration/attachment-blob-store.js';
import { publishThroughOwnedFile } from '../orchestration/owned-staging-file.js';

const logger = createLogger({ name: 'project-room-attachments' });

/** Files stored under one binding (a Task incarnation or a Project room). */
const FILES_PER_BINDING = 1280;

const BLOB_REF = /^sha256-[0-9a-f]{64}$/;
/**
 * The blob reference a record names, only when its identity is fully
 * determined (#4852 review): a record that parses names its `blobRef`; a
 * damaged one names a reference only if its text holds exactly one `sha256-`
 * token, and that token is a complete `"blobRef":"sha256-<64 hex>"` value.
 * Anything else (a truncated reference, a second hash, a parsed record
 * without a valid `blobRef`) is unknown, so its bytes cannot be ruled out.
 */
function recordReferences(raw: string): string[] {
  let stored: unknown;
  try {
    stored = JSON.parse(raw);
  } catch {
    const tokens = raw.match(/sha256-/g)?.length ?? 0;
    const whole = /"blobRef":"(sha256-[0-9a-f]{64})"/.exec(raw);
    return tokens === 1 && whole ? [whole[1]!] : [];
  }
  return stored &&
    typeof stored === 'object' &&
    'blobRef' in stored &&
    typeof stored.blobRef === 'string' &&
    BLOB_REF.test(stored.blobRef)
    ? [stored.blobRef]
    : [];
}
function describeError(error: unknown) {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : error instanceof Error
      ? error.message
      : String(error);
}

/**
 * What a store directory is (#4852 review): `absent` only when the lookup
 * says ENOENT. Any other lookup error (EACCES, EIO), a link, or anything that
 * is not a directory is returned as the reason it cannot be trusted, so a
 * tree that cannot be inspected is never mistaken for an empty one.
 */
function storeDirectory(path: string): 'absent' | 'directory' | string {
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) return 'a link, which is not supported';
    return entry.isDirectory() ? 'directory' : 'not a directory';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'absent'
      : describeError(error);
  }
}

/**
 * A filesystem failure while storing files (a directory that cannot be made
 * or listed, bytes that could not be saved, a record that could not be
 * published), as distinct from input the store refuses (#4852 review).
 */
class RoomStorageFailure extends Error {}
/** An error a filesystem call raised (it carries an `E…` code). */
function isFilesystemError(error: unknown) {
  return (
    error instanceof Error &&
    /^E[A-Z0-9]+$/.test(String((error as NodeJS.ErrnoException).code ?? ''))
  );
}
/** Runs one storage step, typing any failure as `RoomStorageFailure`. */
function storage<T>(step: () => T): T {
  try {
    return step();
  } catch (error) {
    throw new RoomStorageFailure(describeError(error), { cause: error });
  }
}

/**
 * Room attachment bytes. Bindings (which room may read which file) are kept
 * apart from the deduplicated byte store. A binding is an identity tuple, so
 * a recreated Task or Project never reads its predecessor's files.
 */
export class RoomAttachments {
  private readonly blobs: AttachmentBlobStore;
  private readonly leftovers: readonly string[];
  constructor(
    private readonly root: string,
    /** Names the owner in the limit refusal ("This Task has…"). */
    private readonly owner: string,
    /**
     * `leftovers` names trees an earlier build may have left in the root:
     * absent or empty is fine, anything else is unknown (see `scanReferences`).
     */
    private readonly options: {
      referenceBoundBudget?: boolean;
      leftovers?: readonly string[];
    } = {},
  ) {
    this.leftovers = options.leftovers ?? [];
    this.blobs = new AttachmentBlobStore({
      rootDir: join(root, 'blobs'),
      retention: false,
    });
  }
  lock() {
    mkdirSync(this.root, { recursive: true });
    return acquireFileMutationLockAsync(join(this.root, 'store.lock'));
  }
  private directory(binding: readonly string[]) {
    const key = createHash('sha256')
      .update(JSON.stringify(binding))
      .digest('hex');
    return join(this.root, 'bindings', key);
  }
  store(
    binding: readonly string[],
    inputs: ChatAttachmentInput[],
  ): TaskRoomAttachment[] {
    const error = validateChatAttachments(inputs);
    if (error) throw new Error(error);
    // A declared image type is a claim the bytes must make too: bytes that
    // are not that image are never stored and served as one.
    for (const input of inputs)
      if (
        input.kind === 'image' &&
        sniffChatImageMimeType(
          Buffer.from(
            parseChatAttachmentDataUrl(input.dataUrl)!.base64.slice(0, 24),
            'base64',
          ),
        ) !== input.mimeType
      )
        throw new Error(`${input.name} is not a ${input.mimeType} image.`);
    const directory = this.directory(binding);
    const stored = storage(() => {
      mkdirSync(directory, { recursive: true });
      return readdirSync(directory).length;
    });
    if (stored + inputs.length > FILES_PER_BINDING)
      throw new Error(`This ${this.owner} has reached its attachment limit.`);
    const uploads = inputs.map(({ dataUrl, ...metadata }) => ({
      metadata,
      bytes: Buffer.from(parseChatAttachmentDataUrl(dataUrl)!.base64, 'base64'),
    }));
    if (
      this.options.referenceBoundBudget &&
      !storage(() =>
        this.blobs.prepareReferencedWrite(
          new Map(
            uploads.map(({ bytes }) => [
              attachmentBlobRefFor(bytes),
              bytes.length,
            ]),
          ),
          () => {
            const { byRecord, unknown } = this.scanReferences();
            if (!unknown.length) return new Set([...byRecord.values()].flat());
          },
        ),
      )
    )
      throw new TaskRoomAttachmentCapacityError();
    return uploads.map(({ bytes, metadata }) => {
      const blobRef = this.blobs.writeBytes(bytes);
      if (!blobRef)
        throw new RoomStorageFailure('Attachment bytes could not be saved.');
      const attachment = { ...metadata, id: randomUUID() };
      // Written whole, then renamed into place: a crash leaves a staging
      // file outside the bindings, never a torn record in them.
      // A failed attempt removes its own staging file (#4852 review).
      const staging = join(this.root, 'staging');
      storage(() => {
        mkdirSync(staging, { recursive: true });
        publishThroughOwnedFile(
          join(staging, `${attachment.id}.json`),
          JSON.stringify({ attachment, blobRef }),
          (pending) =>
            renameSync(pending, join(directory, `${attachment.id}.json`)),
        );
      });
      return attachment;
    });
  }
  read(
    binding: readonly string[],
    id: string,
  ):
    | { attachment: TaskRoomAttachment; dataUrl: string; bytes: Buffer }
    | undefined {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    const path = join(this.directory(binding), `${id}.json`);
    if (!existsSync(path)) return undefined;
    const stored: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      !stored ||
      typeof stored !== 'object' ||
      !('attachment' in stored) ||
      !('blobRef' in stored) ||
      typeof stored.blobRef !== 'string'
    )
      return undefined;
    const attachments = [stored.attachment];
    if (!isTaskRoomAttachments(attachments)) return undefined;
    const [attachment] = attachments;
    const bytes = this.blobs.readBytes(stored.blobRef);
    if (!bytes || bytes.length !== attachment.size) return undefined;
    return {
      attachment,
      bytes,
      dataUrl: `data:${attachment.mimeType};base64,${bytes.toString('base64')}`,
    };
  }
  /**
   * Every record's blob references, read before anything changes. A record
   * that cannot be parsed still protects any `sha256-` reference recoverable
   * from its text; a record (or directory) whose references cannot be known
   * at all (unparseable with none recoverable, or unreadable: EIO, EACCES)
   * is listed in `unknown`. So is every directory level that is not a
   * plain directory or cannot be looked up (`storeDirectory`); only a tree
   * root or level that does not exist counts as empty. A `leftovers` tree
   * that exists and is not empty, or is a link or unreadable, is unknown
   * too: it may hold records an operator meant to restore, so nothing is
   * deleted and nothing in it is read or applied.
   */
  scanReferences(): {
    byRecord: Map<string, string[]>;
    unknown: { path: string; reason: string }[];
  } {
    const byRecord = new Map<string, string[]>();
    const unknown: { path: string; reason: string }[] = [];
    const list = (path: string) => {
      try {
        return readdirSync(path);
      } catch (error) {
        unknown.push({ path, reason: describeError(error) });
        return [];
      }
    };
    const directory = (path: string) => {
      const kind = storeDirectory(path);
      if (kind === 'absent' || kind === 'directory') return kind;
      unknown.push({ path, reason: kind });
      return undefined;
    };
    for (const tree of this.leftovers) {
      const path = join(this.root, tree);
      if (directory(path) === 'directory' && list(path).length)
        unknown.push({
          path,
          reason:
            'left by an earlier build and not empty: stop Station, apply any intended repair to bindings/ by hand, then remove it',
        });
    }
    // Only `bindings/` holds records (#4852 review).
    const top = join(this.root, 'bindings');
    if (directory(top) === 'directory')
      for (const key of list(top)) {
        if (directory(join(top, key)) !== 'directory') continue;
        for (const name of list(join(top, key))) {
          const path = join(top, key, name);
          let raw: string;
          try {
            raw = readFileSync(path, 'utf8');
          } catch (error) {
            unknown.push({ path, reason: describeError(error) });
            continue;
          }
          const refs = recordReferences(raw);
          if (refs.length) byRecord.set(path, refs);
          else unknown.push({ path, reason: 'no readable blob reference' });
        }
      }
    return { byRecord, unknown };
  }
  /**
   * Gives up files of this binding, then deletes each of their blobs that no
   * other record names (the byte store is deduplicated, so the same bytes may
   * back another file). Fails closed: if any record's references cannot be
   * known, nothing is removed or deleted and the unknown records are
   * returned. The caller must hold the store's cross-process lock across this
   * call and every `store` (`ProjectRoomAttachments`).
   */
  reclaim(
    binding: readonly string[],
    ids: readonly string[],
  ): {
    scanned: boolean;
    unknown: { path: string; reason: string }[];
    /** Released records kept because their bytes could not be deleted. */
    kept: number;
  } {
    // Nothing to give up: nothing to prove, and no scan (an upload's sweep
    // usually finds nothing stale).
    if (!ids.length) return { scanned: false, unknown: [], kept: 0 };
    const { byRecord, unknown } = this.scanReferences();
    if (unknown.length) return { scanned: true, unknown, kept: 0 };
    const directory = this.directory(binding);
    const released = new Set(
      ids
        .filter((id) => /^[0-9a-f-]{36}$/.test(id))
        .map((id) => join(directory, `${id}.json`)),
    );
    const candidates = new Set<string>();
    const named = new Set<string>();
    for (const [path, refs] of byRecord)
      for (const ref of refs)
        (released.has(path) ? candidates : named).add(ref);
    // Bytes go first, and a record goes only once nothing it names is still
    // owed a deletion: a failed unlink keeps the record, its quota charge and
    // its retry (a later sweep releases it again) (#4852 review).
    const stuck = new Set<string>();
    for (const ref of candidates)
      if (!named.has(ref) && !this.blobs.removeByRefConfirmed(ref))
        stuck.add(ref);
    let kept = 0;
    for (const path of released) {
      if ((byRecord.get(path) ?? []).some((ref) => stuck.has(ref))) {
        kept += 1;
        continue;
      }
      rmSync(path, { force: true });
    }
    return { scanned: true, unknown: [], kept };
  }
  /** Whether these bytes are stored, intact. */
  hasBlob(ref: string) {
    return this.blobs.readBytes(ref) !== undefined;
  }
  /**
   * This binding's files no standing message needs: any whose message was
   * deleted, and unsent uploads older than `unsentBefore` (epoch ms).
   * `standing` names, of the ids it is asked about, those linked to a message
   * that still stands; `linked`, those linked to any message.
   */
  stale(
    binding: readonly string[],
    unsentBefore: number,
    links: (ids: string[]) => { standing: Set<string>; linked: Set<string> },
  ): string[] {
    const directory = this.directory(binding);
    if (!existsSync(directory)) return [];
    const ids = readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length));
    if (!ids.length) return [];
    const { standing, linked } = links(ids);
    return ids.filter((id) => {
      if (standing.has(id)) return false;
      if (linked.has(id)) return true;
      try {
        return statSync(join(directory, `${id}.json`)).mtimeMs < unsentBefore;
      } catch {
        return false;
      }
    });
  }
  /** Each descriptor must name a stored file of this binding, field for field. */
  resolve(
    binding: readonly string[],
    attachments: TaskRoomAttachment[],
  ): ChatAttachmentInput[] {
    if (!isTaskRoomAttachments(attachments))
      throw new Error(`Invalid ${this.owner} attachments.`);
    return attachments.map((attachment) => {
      const stored = this.read(binding, attachment.id);
      if (
        !stored ||
        ['kind', 'name', 'mimeType', 'size'].some(
          (key) =>
            Reflect.get(stored.attachment, key) !==
            Reflect.get(attachment, key),
        )
      )
        throw new Error(
          `${attachment.name} is unavailable. Choose the file again.`,
        );
      const { id: _id, ...metadata } = stored.attachment;
      return { ...metadata, dataUrl: stored.dataUrl };
    });
  }
}

type Scope = { taskId: string; taskCreatedAt: string; projectId: string };
const taskBinding = (scope: Scope) => [
  scope.projectId,
  scope.taskId,
  scope.taskCreatedAt,
];

/** Task incarnation bindings are separate from the deduplicated byte store. */
export class TaskRoomAttachments {
  private readonly files: RoomAttachments;
  constructor(root: string) {
    this.files = new RoomAttachments(root, 'Task', {
      referenceBoundBudget: true,
    });
  }
  async store(
    resolveScope: () => Promise<Scope | undefined>,
    inputs: ChatAttachmentInput[],
  ): Promise<TaskRoomAttachment[] | undefined> {
    const unlock = await this.files.lock();
    try {
      const scope = await resolveScope();
      return scope && this.files.store(taskBinding(scope), inputs);
    } finally {
      await unlock();
    }
  }
  read(scope: Scope, id: string) {
    return this.files.read(taskBinding(scope), id);
  }
  resolve(
    scope: Scope,
    attachments: TaskRoomAttachment[],
  ): ChatAttachmentInput[] {
    return this.files.resolve(taskBinding(scope), attachments);
  }
}

export class TaskRoomAttachmentCapacityError extends Error {
  constructor() {
    super('The Station Task-room attachment store has reached its size limit.');
  }
}

/**
 * Project-room files (#4812). Bytes are deleted only when no binding names
 * them, under one store-wide cross-process lock that every upload (blob and
 * binding publication), every release (binding removal, reference scan and
 * deletion) and every message that names files also holds, so no process can
 * publish or link the same bytes between the reference scan and the deletion
 * (#4852 review). The byte store's age and size eviction is off: it cannot
 * tell a live blob from a released one. Every byte on disk therefore backs a
 * live binding, and the bindings are bounded by the per-binding file limit.
 *
 * The lock is the yielding form (`acquireFileMutationLockAsync`), so waiting
 * on it never blocks the event loop. A caller runs its whole operation inside
 * `locked`, including its authority check, so a person whose access changed
 * while waiting is refused there, before anything is written. `store`,
 * `release` and `sweep` refuse to run outside `locked`.
 *
 * Fails closed: when any file record's references cannot be known (damaged
 * or unreadable, or a `bindings/` level that is a link, not a directory, or
 * cannot be looked up), a release removes and deletes nothing. Every upload
 * re-derives the store's health under the lock, by the same scan of
 * `bindings/` that a release uses, and is refused with
 * `ProjectRoomFilesUnavailable` while any record is unknown. Admission
 * depends on no cached observation and no file write, so every live process
 * refuses alike; `reclamation-blocked.json` (best effort) only tells the
 * operator which records to repair. Reading and resolving existing files
 * never consult it.
 *
 * Supported repair is offline only (#4852 review): stop every Station process
 * using the home, fix or remove the damaged record under `bindings/`, and
 * start Station again. Changing `bindings/` while any Station process runs
 * is not supported, and Station cannot detect it: a release scanning at that
 * moment could miss a record and delete its bytes. A `repair/` directory
 * left by an earlier build blocks uploads and releases while it holds
 * anything (or is a link, or unreadable) and is never applied or deleted:
 * the operator applies any intended repair to `bindings/` by hand, with
 * Station stopped, and removes it. A storage failure while writing is
 * refused as unavailable too, not as invalid input.
 */
export class ProjectRoomAttachments {
  private readonly files: RoomAttachments;
  private holding = 0;
  constructor(private readonly root: string) {
    // `repair/` was the live repair inbox of earlier development builds.
    this.files = new RoomAttachments(root, 'room', {
      leftovers: ['repair'],
    });
  }
  /** Runs `operation` while holding the store's cross-process lock. */
  async locked<T>(operation: () => Promise<T> | T): Promise<T> {
    let unlock: () => Promise<void>;
    try {
      unlock = await this.files.lock();
    } catch (error) {
      // The store root or its lock file could not be written (#4852 review):
      // the files are unavailable. Waiting out another holder is not a
      // filesystem error and stays the generic refusal.
      if (isFilesystemError(error))
        throw new ProjectRoomFilesUnavailable([
          { path: this.root, reason: describeError(error) },
        ]);
      throw error;
    }
    this.holding += 1;
    try {
      return await operation();
    } finally {
      this.holding -= 1;
      await unlock();
    }
  }
  store(
    binding: readonly string[],
    inputs: ChatAttachmentInput[],
  ): TaskRoomAttachment[] {
    this.held();
    // Health is derived afresh for every upload (#4852 review): the same
    // scan a release uses.
    const problems = this.files.scanReferences().unknown;
    if (problems.length) {
      this.block(problems);
      throw new ProjectRoomFilesUnavailable(problems);
    }
    this.unblock();
    try {
      return this.files.store(binding, inputs);
    } catch (error) {
      // A write that failed is the store's condition, not the caller's input.
      if (error instanceof RoomStorageFailure)
        throw new ProjectRoomFilesUnavailable([
          { path: this.root, reason: error.message },
        ]);
      throw error;
    }
  }
  read(binding: readonly string[], id: string) {
    return this.files.read(binding, id);
  }
  resolve(
    binding: readonly string[],
    attachments: TaskRoomAttachment[],
  ): ChatAttachmentInput[] {
    return this.files.resolve(binding, attachments);
  }
  /**
   * Gives up these files, and the bytes no other file names; `blocked` when
   * the store could not prove its references and nothing changed, `kept`
   * when some bytes could not be deleted and their records stay for a retry.
   */
  release(binding: readonly string[], ids: readonly string[]): ReclaimOutcome {
    this.held();
    return this.settle(this.files.reclaim(binding, ids));
  }
  /** Releases the files no standing message needs (see `RoomAttachments.stale`). */
  sweep(
    binding: readonly string[],
    unsentBefore: number,
    links: (ids: string[]) => { standing: Set<string>; linked: Set<string> },
  ): ReclaimOutcome {
    this.held();
    return this.settle(
      this.files.reclaim(
        binding,
        this.files.stale(binding, unsentBefore, links),
      ),
    );
  }
  private get marker() {
    return join(this.root, 'reclamation-blocked.json');
  }
  private settle(result: {
    scanned: boolean;
    unknown: { path: string; reason: string }[];
    kept: number;
  }): ReclaimOutcome {
    if (result.unknown.length) {
      this.block(result.unknown);
      return 'blocked';
    }
    // A full scan that read every record clears the diagnostic.
    if (result.scanned) this.unblock();
    return result.kept ? 'kept' : 'reclaimed';
  }
  /** Tells the operator which records to repair; admission does not rely on it. */
  private block(records: { path: string; reason: string }[]) {
    const repair = join(this.root, 'repair');
    const kinds = new Set(
      records.map((record) =>
        record.path === repair || record.path.startsWith(`${repair}/`)
          ? 'repair'
          : 'bindings',
      ),
    );
    // Each kind of item gets its own instruction (#4852 review).
    const steps = [
      ...(kinds.has('bindings')
        ? [
            'fix each listed path under bindings/: restore the record, fix its permissions, or remove it once you have decided its file is not needed',
          ]
        : []),
      ...(kinds.has('repair')
        ? [
            'a listed repair/ directory was left by an earlier build: apply any repair it was meant to carry to bindings/ by hand, then remove repair/',
          ]
        : []),
    ];
    try {
      const staging = join(this.root, 'staging');
      mkdirSync(staging, { recursive: true });
      publishThroughOwnedFile(
        join(staging, `reclamation-blocked.${randomUUID()}.json`),
        JSON.stringify(
          {
            since: new Date().toISOString(),
            note: `Project room file records could not be read, so no stored bytes are deleted and new attachments are refused. Stop every Station process using this home; ${steps.join('; ')}; then start Station again. The next upload re-checks and clears this file.`,
            records,
          },
          null,
          2,
        ),
        (pending) => renameSync(pending, this.marker),
      );
    } catch (error) {
      // Admission re-derives health on every upload, so the refusal holds
      // without this file. The operator still learns what to repair, from
      // the server log (never from a room response).
      logger.warn(
        'Project room file records need repair, and the diagnostic file could not be written',
        { records, marker: this.marker, error: describeError(error) },
      );
    }
  }
  private unblock() {
    try {
      rmSync(this.marker, { force: true });
    } catch {
      // A marker that cannot be removed only causes a re-check next time.
    }
  }
  private held() {
    if (!this.holding)
      throw new Error(
        'Project room files are written only under the store lock.',
      );
  }
}

/** What a release did: reclaimed, or stopped because the store was unsure. */
export type ReclaimOutcome = 'reclaimed' | 'blocked' | 'kept';
/**
 * A Project room's file store cannot prove which bytes are referenced, so it
 * takes no new attachments until an operator repairs it.
 */
export class ProjectRoomFilesUnavailable extends Error {
  constructor(readonly records: { path: string; reason: string }[]) {
    super(
      'Project room attachments are unavailable until the file store is repaired.',
    );
  }
}
