import { authenticatedFetch } from '@kontourai/station-sdk';
import type { FileAttachment } from '../../types';

/**
 * An attachment recovered from a failed turn, before it can be re-sent
 * (station#3385).
 *
 * Since #3374 a restored transcript may carry an attachment as a content
 * reference rather than as bytes, and the byte-budgeted read the chat dock
 * uses always does. A retry composed from those parts alone would send the
 * text and quietly leave the image behind — the same silent-subset the server
 * refuses to make when IT replays a recorded turn.
 */
export type RetryAttachment =
  | ({ kind: 'inline' } & FileAttachment)
  | {
      kind: 'reference';
      id: string;
      name: string;
      type: string;
      blobRef: string;
    };

/** Raised when a retry cannot carry everything the original turn carried. */
export class RetryAttachmentsUnavailableError extends Error {
  constructor(readonly names: string[]) {
    super(
      names.length === 1
        ? `${names[0]} is no longer stored, so this message cannot be sent again with it.`
        : `${names.join(', ')} are no longer stored, so this message cannot be sent again with them.`,
    );
    this.name = 'RetryAttachmentsUnavailableError';
  }
}

/**
 * Read the retryable attachments out of a persisted user turn's parts, in
 * order. A part with neither bytes nor a reference is not skipped — it becomes
 * a `reference` with an empty ref, which fails resolution rather than
 * disappearing.
 */
export function retryAttachmentsFromParts(
  parts: readonly Record<string, unknown>[],
  idPrefix: string,
): RetryAttachment[] {
  return parts
    .filter((part) => part.type === 'file')
    .map((part, index): RetryAttachment => {
      const id = `${idPrefix}-${index}`;
      const name = typeof part.name === 'string' ? part.name : 'attachment';
      const type =
        typeof part.mediaType === 'string'
          ? part.mediaType
          : 'application/octet-stream';
      if (typeof part.url === 'string') {
        return {
          kind: 'inline',
          id,
          name,
          type,
          // Decoded bytes, the same measure the fetched branch reports and the
          // same one `FileAttachment.size` means everywhere else. The data
          // URL's own length counts base64 expansion plus the header, so it
          // over-reports by roughly a third.
          size: dataUrlDecodedBytes(part.url),
          data: part.url,
        };
      }
      return {
        kind: 'reference',
        id,
        name,
        type,
        blobRef: typeof part.blobRef === 'string' ? part.blobRef : '',
      };
    });
}

/** Decoded byte count of a `data:...;base64,` URL, without decoding it. */
function dataUrlDecodedBytes(dataUrl: string): number {
  const separator = dataUrl.indexOf(',');
  if (separator < 0) return 0;
  const base64 = dataUrl.slice(separator + 1);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.max((base64.length / 4) * 3 - padding, 0);
}

function toBase64(bytes: Uint8Array): string {
  // Chunked: spreading a multi-megabyte image into `fromCharCode` exceeds the
  // argument limit and throws.
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + chunkSize),
    );
  }
  return btoa(binary);
}

/**
 * Fetch every referenced attachment's bytes so the retry sends exactly what
 * the original turn did. Throws {@link RetryAttachmentsUnavailableError}
 * naming what could not be recovered — the caller must surface that and NOT
 * send, because a retry that silently drops an image is a recovery affordance
 * that recovers less than it claims.
 */
export async function resolveRetryAttachments(
  attachments: readonly RetryAttachment[],
  apiBase: string,
): Promise<FileAttachment[]> {
  const resolved = await Promise.all(
    attachments.map(async (attachment): Promise<FileAttachment | null> => {
      if (attachment.kind === 'inline') {
        const { kind: _kind, ...file } = attachment;
        return file;
      }
      if (!attachment.blobRef) return null;
      try {
        const response = await authenticatedFetch(
          `${apiBase}/api/attachments/${encodeURIComponent(attachment.blobRef)}`,
        );
        if (!response.ok) return null;
        const bytes = new Uint8Array(await response.arrayBuffer());
        return {
          id: attachment.id,
          name: attachment.name,
          type: attachment.type,
          size: bytes.byteLength,
          data: `data:${attachment.type};base64,${toBase64(bytes)}`,
        };
      } catch {
        return null;
      }
    }),
  );
  const missing = attachments
    .filter((_attachment, index) => resolved[index] === null)
    .map((attachment) => attachment.name);
  if (missing.length > 0) throw new RetryAttachmentsUnavailableError(missing);
  return resolved as FileAttachment[];
}
