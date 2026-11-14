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
  ) {
    this.blobs = new AttachmentBlobStore({ rootDir: join(root, 'blobs') });
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
   * Gives up files of this binding: their bindings go, which frees their
   * place in the binding's quota. Bytes are never deleted here. The byte store
   * is deduplicated and shared by every binding and process, and nothing here
   * coordinates a reference scan with another process publishing the same
   * bytes, so a blob this path deleted could already back a new message
   * elsewhere. Unreferenced bytes are left to the store's own age and size
   * retention until a coordinated sweep exists (#4942).
   */
  release(binding: readonly string[], ids: readonly string[]) {
    const directory = this.directory(binding);
    for (const id of ids) {
      if (!/^[0-9a-f-]{36}$/.test(id)) continue;
      rmSync(join(directory, `${id}.json`), { force: true });
    }
  }
  /**
   * Releases this binding's files that no standing message needs: any whose
   * message was deleted, and unsent uploads older than `unsentBefore` (epoch
   * ms). `standing` names, of the ids it is asked about, those linked to a
   * message that still stands; `linked`, those linked to any message.
   */
  sweep(
    binding: readonly string[],
    unsentBefore: number,
    links: (ids: string[]) => { standing: Set<string>; linked: Set<string> },
  ) {
    const directory = this.directory(binding);
    if (!existsSync(directory)) return;
    const ids = readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length));
    if (!ids.length) return;
    const { standing, linked } = links(ids);
    this.release(
      binding,
      ids.filter((id) => {
        if (standing.has(id)) return false;
        if (linked.has(id)) return true;
        try {
          return statSync(join(directory, `${id}.json`)).mtimeMs < unsentBefore;
        } catch {
          return false;
        }
      }),
    );
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
