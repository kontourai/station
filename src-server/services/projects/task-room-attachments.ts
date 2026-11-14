import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
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
import { AttachmentBlobStore } from '../orchestration/attachment-blob-store.js';

/** Files stored under one binding (a Task incarnation or a Project room). */
const FILES_PER_BINDING = 1280;

const BLOB_REFERENCE = /sha256-[0-9a-f]{64}/g;
/**
 * The blob references a record names: its `blobRef` when it parses, else
 * every reference recoverable from its text (conservative), else none.
 */
function recordReferences(raw: string): string[] {
  try {
    const stored: unknown = JSON.parse(raw);
    if (
      stored &&
      typeof stored === 'object' &&
      'blobRef' in stored &&
      typeof stored.blobRef === 'string' &&
      /^sha256-[0-9a-f]{64}$/.test(stored.blobRef)
    )
      return [stored.blobRef];
  } catch {
    // A damaged record: fall through to recovering references from its text.
  }
  return [...new Set(raw.match(BLOB_REFERENCE) ?? [])];
}
function describeError(error: unknown) {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : error instanceof Error
      ? error.message
      : String(error);
}

/**
 * Room attachment bytes. Bindings (which room may read which file) are kept
 * apart from the deduplicated byte store. A binding is an identity tuple, so
 * a recreated Task or Project never reads its predecessor's files.
 */
export class RoomAttachments {
  private readonly blobs: AttachmentBlobStore;
  constructor(
    private readonly root: string,
    /** Names the owner in the limit refusal ("This Task has…"). */
    private readonly owner: string,
    /** `retention: false` turns off the byte store's age and size eviction. */
    options: { retention?: false } = {},
  ) {
    this.blobs = new AttachmentBlobStore({
      rootDir: join(root, 'blobs'),
      ...(options.retention === false ? { retention: false } : {}),
    });
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
    mkdirSync(directory, { recursive: true });
    if (readdirSync(directory).length + inputs.length > FILES_PER_BINDING)
      throw new Error(`This ${this.owner} has reached its attachment limit.`);
    return inputs.map(({ dataUrl, ...metadata }) => {
      const blobRef = this.blobs.write(
        parseChatAttachmentDataUrl(dataUrl)!.base64,
      );
      if (!blobRef) throw new Error('Attachment bytes could not be saved.');
      const attachment = { ...metadata, id: randomUUID() };
      // Written whole, then renamed into place: a crash leaves a staging
      // file outside the bindings, never a torn record in them.
      const staging = join(this.root, 'staging');
      mkdirSync(staging, { recursive: true });
      const pending = join(staging, `${attachment.id}.json`);
      writeFileSync(pending, JSON.stringify({ attachment, blobRef }), {
        flag: 'wx',
        mode: 0o600,
      });
      renameSync(pending, join(directory, `${attachment.id}.json`));
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
   * is listed in `unknown`.
   */
  scanReferences(): {
    byRecord: Map<string, string[]>;
    unknown: { path: string; reason: string }[];
  } {
    const byRecord = new Map<string, string[]>();
    const unknown: { path: string; reason: string }[] = [];
    const bindings = join(this.root, 'bindings');
    if (!existsSync(bindings)) return { byRecord, unknown };
    const list = (path: string) => {
      try {
        return readdirSync(path);
      } catch (error) {
        unknown.push({ path, reason: describeError(error) });
        return [];
      }
    };
    for (const key of list(bindings))
      for (const name of list(join(bindings, key))) {
        const path = join(bindings, key, name);
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
  ): { scanned: boolean; unknown: { path: string; reason: string }[] } {
    // Nothing to give up: nothing to prove, and no scan (an upload's sweep
    // usually finds nothing stale).
    if (!ids.length) return { scanned: false, unknown: [] };
    const { byRecord, unknown } = this.scanReferences();
    if (unknown.length) return { scanned: true, unknown };
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
    for (const path of released) rmSync(path, { force: true });
    for (const ref of candidates)
      if (!named.has(ref)) this.blobs.removeByRef(ref);
    return { scanned: true, unknown: [] };
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
    this.files = new RoomAttachments(root, 'Task');
  }
  store(scope: Scope, inputs: ChatAttachmentInput[]): TaskRoomAttachment[] {
    return this.files.store(taskBinding(scope), inputs);
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
 * or unreadable), a release removes and deletes nothing and writes
 * `reclamation-blocked.json` naming each such record. While that marker
 * exists every upload re-checks the store and is refused with
 * `ProjectRoomFilesUnavailable` until an operator repairs or removes the
 * records; the first check that finds every record readable clears it.
 * Reading and resolving existing files never consult it.
 */
export class ProjectRoomAttachments {
  private readonly files: RoomAttachments;
  private holding = 0;
  constructor(private readonly root: string) {
    this.files = new RoomAttachments(root, 'room', { retention: false });
  }
  /** Runs `operation` while holding the store's cross-process lock. */
  async locked<T>(operation: () => Promise<T> | T): Promise<T> {
    mkdirSync(this.root, { recursive: true });
    const unlock = await acquireFileMutationLockAsync(
      join(this.root, 'store.lock'),
    );
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
    if (existsSync(this.marker)) {
      const { unknown } = this.files.scanReferences();
      if (unknown.length) {
        this.block(unknown);
        throw new ProjectRoomFilesUnavailable(unknown);
      }
      rmSync(this.marker, { force: true });
    }
    return this.files.store(binding, inputs);
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
   * the store could not prove its references and nothing changed.
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
  }): ReclaimOutcome {
    if (result.unknown.length) {
      this.block(result.unknown);
      return 'blocked';
    }
    // Only a full scan that read every record clears a block.
    if (result.scanned) rmSync(this.marker, { force: true });
    return 'reclaimed';
  }
  /** Records why reclamation stopped, for the operator (written whole). */
  private block(unknown: { path: string; reason: string }[]) {
    const pending = join(this.root, 'staging', 'reclamation-blocked.json');
    mkdirSync(join(this.root, 'staging'), { recursive: true });
    writeFileSync(
      pending,
      JSON.stringify(
        {
          since: new Date().toISOString(),
          note: 'Project room file records could not be read, so no stored bytes are deleted and new attachments are refused. Repair each record (restore it, or fix its permissions) or remove it once you have decided its file is not needed; the next upload re-checks and clears this file.',
          records: unknown,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    renameSync(pending, this.marker);
  }
  private held() {
    if (!this.holding)
      throw new Error(
        'Project room files are written only under the store lock.',
      );
  }
}

/** What a release did: reclaimed, or stopped because the store was unsure. */
export type ReclaimOutcome = 'reclaimed' | 'blocked';
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
