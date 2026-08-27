import {
  ATTACHMENT_STAGING_MAX_CONCURRENT_UPLOADS,
  type StagedAttachmentReference,
} from '@kontourai/station-contracts/attachment-staging';
import {
  attachmentKindForMimeType,
  type ChatAttachmentInput,
} from '@kontourai/station-contracts/chat-attachment';
import {
  type AttachmentStageUploadTransport,
  getAttachmentStagingCapability,
  prepareAttachmentStage,
  uploadAttachmentStage,
} from '@kontourai/station-sdk/client';
import type { FileAttachment } from '../types';

export type ComposerAttachmentDispatch =
  | { kind: 'legacy-inline'; attachments: ChatAttachmentInput[] }
  | { kind: 'staged'; references: StagedAttachmentReference[] };

export type ComposerAttachmentStageUpdate = {
  clientAttachmentId: string;
  state:
    | 'queued'
    | 'uploading'
    | 'retryable'
    | 'complete'
    | 'accepted'
    | 'cancelled'
    | 'failed';
  progress: number;
  stageId?: string;
  reference?: StagedAttachmentReference;
  delivery?: 'legacy-inline' | 'staged';
  error?: string;
};

function inputFor(
  attachment: FileAttachment,
): ChatAttachmentInput & { clientAttachmentId: string } {
  const kind = attachmentKindForMimeType(attachment.type);
  if (!kind)
    throw new Error(`${attachment.name} has an unsupported attachment type.`);
  return {
    clientAttachmentId: attachment.id,
    kind,
    name: attachment.name,
    mimeType: attachment.type as ChatAttachmentInput['mimeType'],
    size: attachment.size,
    dataUrl: attachment.data,
  };
}

/** Used only after the composer has already verified the old-host handshake. */
export function inlineComposerAttachments(
  attachments: readonly FileAttachment[],
): ChatAttachmentInput[] {
  return attachments.map(inputFor);
}

/** One supervised queue for picker, paste and drop; the observer gets no bytes or grants. */
export async function stageComposerAttachments(
  apiBase: string,
  attachments: readonly FileAttachment[],
  signal?: AbortSignal,
  observer?: (update: ComposerAttachmentStageUpdate) => void,
  transport?: AttachmentStageUploadTransport,
): Promise<ComposerAttachmentDispatch> {
  const inputs = attachments.map(inputFor);
  if (inputs.length === 0) return { kind: 'legacy-inline', attachments: [] };
  for (const input of inputs)
    observer?.({
      clientAttachmentId: input.clientAttachmentId,
      state: 'queued',
      progress: 0,
    });
  const capability = await getAttachmentStagingCapability(apiBase, { signal });
  if (capability.state === 'legacy') {
    for (const input of inputs)
      observer?.({
        clientAttachmentId: input.clientAttachmentId,
        state: 'complete',
        progress: 1,
        delivery: 'legacy-inline',
      });
    return { kind: 'legacy-inline', attachments: inputs };
  }
  if (capability.state !== 'supported')
    throw new Error(
      'This Station does not advertise a valid attachment staging capability.',
    );
  const results: StagedAttachmentReference[] = new Array(inputs.length);
  const failures: Error[] = [];
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const index = cursor++;
      const input = inputs[index];
      if (!input) return;
      try {
        observer?.({
          clientAttachmentId: input.clientAttachmentId,
          state: 'uploading',
          progress: 0,
          delivery: 'staged',
        });
        const preparation = await prepareAttachmentStage(apiBase, input, {
          signal,
          timeoutMs: null,
        });
        observer?.({
          clientAttachmentId: input.clientAttachmentId,
          state: 'uploading',
          progress: 0,
          stageId: preparation.stageId,
          delivery: 'staged',
        });
        const reference = await uploadAttachmentStage(
          apiBase,
          preparation,
          input.dataUrl,
          {
            signal,
            timeoutMs: null,
            transport,
            onProgress: ({ loaded, total }) =>
              observer?.({
                clientAttachmentId: input.clientAttachmentId,
                state: 'uploading',
                progress: total > 0 ? Math.min(1, loaded / total) : 0,
                stageId: preparation.stageId,
                delivery: 'staged',
              }),
          },
        );
        results[index] = reference;
        observer?.({
          clientAttachmentId: input.clientAttachmentId,
          state: 'complete',
          progress: 1,
          stageId: preparation.stageId,
          reference,
          delivery: 'staged',
        });
      } catch (error) {
        const failure =
          error instanceof Error ? error : new Error(String(error));
        failures.push(failure);
        observer?.({
          clientAttachmentId: input.clientAttachmentId,
          state: signal?.aborted ? 'cancelled' : 'retryable',
          progress: 0,
          error: signal?.aborted ? undefined : failure.message,
        });
      }
    }
  };
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          ATTACHMENT_STAGING_MAX_CONCURRENT_UPLOADS,
          inputs.length,
        ),
      },
      () => worker(),
    ),
  );
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      'One or more attachment stages did not complete.',
    );
  return { kind: 'staged', references: results };
}
