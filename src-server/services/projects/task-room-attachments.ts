import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  type ChatAttachmentInput,
  parseChatAttachmentDataUrl,
  validateChatAttachments,
} from '@kontourai/station-contracts/chat-attachment';
import {
  isTaskRoomAttachments,
  type TaskRoomAttachment,
} from '@kontourai/station-contracts/project-task-room';
import { AttachmentBlobStore } from '../orchestration/attachment-blob-store.js';

type Scope = { taskId: string; taskCreatedAt: string; projectId: string };

/** Task incarnation bindings are separate from the deduplicated byte store. */
export class TaskRoomAttachments {
  private readonly blobs: AttachmentBlobStore;
  constructor(private readonly root: string) {
    this.blobs = new AttachmentBlobStore({ rootDir: join(root, 'blobs') });
  }
  private directory(scope: Scope) {
    const key = createHash('sha256')
      .update(
        JSON.stringify([scope.projectId, scope.taskId, scope.taskCreatedAt]),
      )
      .digest('hex');
    return join(this.root, 'bindings', key);
  }
  store(scope: Scope, inputs: ChatAttachmentInput[]): TaskRoomAttachment[] {
    const error = validateChatAttachments(inputs);
    if (error) throw new Error(error);
    const directory = this.directory(scope);
    mkdirSync(directory, { recursive: true });
    if (readdirSync(directory).length + inputs.length > 1280)
      throw new Error('This Task has reached its attachment limit.');
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
    scope: Scope,
    id: string,
  ):
    | { attachment: TaskRoomAttachment; dataUrl: string; bytes: Buffer }
    | undefined {
    if (!/^[0-9a-f-]{36}$/.test(id)) return undefined;
    const path = join(this.directory(scope), `${id}.json`);
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
  resolve(
    scope: Scope,
    attachments: TaskRoomAttachment[],
  ): ChatAttachmentInput[] {
    if (!isTaskRoomAttachments(attachments))
      throw new Error('Invalid Task attachments.');
    return attachments.map((attachment) => {
      const stored = this.read(scope, attachment.id);
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
