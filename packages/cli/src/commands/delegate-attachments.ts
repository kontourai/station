import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import type { StagedAttachmentReference } from '@kontourai/station-contracts/attachment-staging';
import {
  attachmentKindForMimeType,
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_COUNT,
  type ChatAttachmentInput,
  type ChatAttachmentMimeType,
} from '@kontourai/station-contracts/chat-attachment';
import {
  cancelAttachmentStage,
  getAttachmentStagingCapability,
  prepareAttachmentStage,
  uploadAttachmentStage,
} from '@kontourai/station-sdk/client';
import {
  assertDelegationFileData,
  assertDelegationFileNames,
  DelegationFileRefusal,
} from '@kontourai/station-shared/delegation-files';

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
    throw new DelegationFileRefusal('delegation_files_count');
  assertDelegationFileNames(paths.map((path) => basename(path)));
  const attachments: ChatAttachmentInput[] = [];
  for (const path of paths) {
    if (!path.trim()) throw new Error('--attach requires a non-empty path.');
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const stat = await file.stat();
      if (!stat.isFile())
        throw new DelegationFileRefusal('delegation_files_invalid_data');
      if (stat.size > CHAT_ATTACHMENT_MAX_BYTES)
        throw new DelegationFileRefusal('delegation_files_size');
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
        throw new DelegationFileRefusal('delegation_files_size');
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
    assertDelegationFileData(attachments);
  }
  return attachments;
}

export async function stageDelegateAttachments(
  apiBase: string,
  attachments: ChatAttachmentInput[],
): Promise<StagedAttachmentReference[]> {
  const capability = await getAttachmentStagingCapability(apiBase);
  if (capability.state !== 'supported' || capability.delegationFiles !== true)
    throw new DelegationFileRefusal('delegation_files_unsupported');
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
    await cancelDelegateAttachmentStages(apiBase, stages);
    throw error;
  }
}

/** Cancellation is best-effort cleanup and must never replace the dispatch failure. */
export async function cancelDelegateAttachmentStages(
  apiBase: string,
  stageIds: readonly string[],
): Promise<void> {
  await Promise.allSettled(
    stageIds.map((id) => cancelAttachmentStage(apiBase, id)),
  );
}
