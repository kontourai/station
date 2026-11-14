import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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
      writeFileSync(
        join(directory, `${attachment.id}.json`),
        JSON.stringify({ attachment, blobRef }),
        { flag: 'wx', mode: 0o600 },
      );
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
   * Gives up files of this binding, then deletes each of their blobs that no
   * binding in this store still names (the byte store is deduplicated, so the
   * same bytes may back another file). A binding that cannot be read might
   * name any blob, so then nothing is deleted. The caller must hold the
   * store's cross-process lock across this call and every `store`, or another
   * process could publish the same bytes between the scan and the deletion
   * (`ProjectRoomAttachments`).
   */
  reclaim(binding: readonly string[], ids: readonly string[]) {
    const directory = this.directory(binding);
    const refs = new Set<string>();
    for (const id of ids) {
      if (!/^[0-9a-f-]{36}$/.test(id)) continue;
      const path = join(directory, `${id}.json`);
      const ref = this.blobRef(path);
      rmSync(path, { force: true });
      if (ref) refs.add(ref);
    }
    if (!refs.size) return;
    const bindings = join(this.root, 'bindings');
    for (const key of existsSync(bindings) ? readdirSync(bindings) : [])
      for (const name of readdirSync(join(bindings, key))) {
        const ref = this.blobRef(join(bindings, key, name));
        if (!ref) return;
        refs.delete(ref);
        if (!refs.size) return;
      }
    for (const ref of refs) this.blobs.removeByRef(ref);
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
  private blobRef(path: string): string | undefined {
    try {
      const stored: unknown = JSON.parse(readFileSync(path, 'utf8'));
      return stored &&
        typeof stored === 'object' &&
        'blobRef' in stored &&
        typeof stored.blobRef === 'string'
        ? stored.blobRef
        : undefined;
    } catch {
      return undefined;
    }
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
  /** Gives up these files, and the bytes no other file names. */
  release(binding: readonly string[], ids: readonly string[]): void {
    this.held();
    this.files.reclaim(binding, ids);
  }
  /** Releases the files no standing message needs (see `RoomAttachments.stale`). */
  sweep(
    binding: readonly string[],
    unsentBefore: number,
    links: (ids: string[]) => { standing: Set<string>; linked: Set<string> },
  ): void {
    this.held();
    this.files.reclaim(binding, this.files.stale(binding, unsentBefore, links));
  }
  private held() {
    if (!this.holding)
      throw new Error(
        'Project room files are written only under the store lock.',
      );
  }
}
