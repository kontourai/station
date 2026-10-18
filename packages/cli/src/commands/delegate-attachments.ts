import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { StagedAttachmentReference } from '@kontourai/station-contracts/attachment-staging';
import {
  attachmentKindForMimeType,
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_COUNT,
  type ChatAttachmentInput,
  type ChatAttachmentMimeType,
  validateChatAttachments,
} from '@kontourai/station-contracts/chat-attachment';
import {
  cancelAttachmentStage,
  getAttachmentStagingCapability,
  prepareAttachmentStage,
  uploadAttachmentStage,
} from '@kontourai/station-sdk/client';

const MIME: Record<string, ChatAttachmentMimeType> = {
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

export async function loadDelegateAttachments(
  paths: string[],
): Promise<ChatAttachmentInput[]> {
  if (paths.length > CHAT_ATTACHMENT_MAX_COUNT)
    throw new Error(
      `A delegation can include at most ${CHAT_ATTACHMENT_MAX_COUNT} attachments.`,
    );
  const attachments: ChatAttachmentInput[] = [];
  for (const path of paths) {
    if (!path.trim()) throw new Error('--attach requires a non-empty path.');
    const file = await open(path, 'r');
    let bytes: Buffer;
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error('--attach requires a regular file.');
      if (stat.size > CHAT_ATTACHMENT_MAX_BYTES)
        throw new Error(
          `Attachment exceeds the ${CHAT_ATTACHMENT_MAX_BYTES}-byte limit.`,
        );
      // Bound the read as well as the stat: the file can grow between them.
      const buffer = Buffer.alloc(CHAT_ATTACHMENT_MAX_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(
          buffer,
          size,
          buffer.length - size,
        );
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > CHAT_ATTACHMENT_MAX_BYTES)
        throw new Error(
          `Attachment exceeds the ${CHAT_ATTACHMENT_MAX_BYTES}-byte limit.`,
        );
      bytes = buffer.subarray(0, size);
    } finally {
      await file.close();
    }
    const mimeType = MIME[extname(path).toLowerCase()] ?? 'text/plain';
    attachments.push({
      kind: attachmentKindForMimeType(mimeType)!,
      name: basename(path),
      mimeType,
      size: bytes.length,
      dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
    });
    const error = validateChatAttachments(attachments);
    if (error) throw new Error(error);
  }
  return attachments;
}

export async function stageDelegateAttachments(
  apiBase: string,
  attachments: ChatAttachmentInput[],
): Promise<StagedAttachmentReference[]> {
  const capability = await getAttachmentStagingCapability(apiBase);
  if (capability.state !== 'supported' || capability.delegationFiles !== true)
    throw new Error('This Station does not support delegation files.');
  const stages: string[] = [];
  try {
    const references: StagedAttachmentReference[] = [];
    for (const attachment of attachments) {
      const preparation = await prepareAttachmentStage(apiBase, {
        ...attachment,
        clientAttachmentId: randomUUID(),
      });
      stages.push(preparation.stageId);
      references.push(
        await uploadAttachmentStage(apiBase, preparation, attachment.dataUrl),
      );
    }
    return references;
  } catch (error) {
    // No delegation has been sent yet. Do not retain a partial upload batch.
    await Promise.allSettled(
      stages.map((id) => cancelAttachmentStage(apiBase, id)),
    );
    throw error;
  }
}
