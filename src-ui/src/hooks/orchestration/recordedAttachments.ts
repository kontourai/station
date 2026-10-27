import type { PersistedChatAttachment } from '@kontourai/station-contracts/chat-attachment';
import {
  attachmentObjectUrlKey,
  seedAttachmentObjectUrl,
} from '../../components/chat/attachment-object-urls';
import { dataUrlBlob } from '../../components/chat/attachment-thumbnails';
import type { ChatMessage } from '../../types';

type ContentPart = NonNullable<ChatMessage['contentParts']>[number];

/** Exact decoded byte count of a base64 `data:` URL, or null for any other. */
function base64DataUrlBytes(url: string): number | null {
  const match = /^data:[^;,]*;base64,/.exec(url);
  if (!match) return null;
  const payload = url.length - match[0].length;
  const padding = url.endsWith('==') ? 2 : url.endsWith('=') ? 1 : 0;
  return (payload / 4) * 3 - padding;
}

/**
 * The bytes the composer row sent for this recorded attachment, only when the
 * row's part at the same position provably is that file: same name, same
 * type, same decoded size. Pasted images are routinely all `image.png`, so a
 * name alone would pin another file's bytes on this chip (and Send again
 * would resend them). Any doubt carries nothing over.
 */
function sentBytesFor(
  sent: ContentPart | undefined,
  attachment: PersistedChatAttachment,
): string | undefined {
  const url = sent?.url;
  if (
    !url ||
    sent.name !== attachment.name ||
    sent.mediaType !== attachment.mimeType ||
    base64DataUrlBytes(url) !== attachment.size
  )
    return undefined;
  return url;
}

/**
 * Hand bytes this client already holds to the attachment cache under the
 * recorded reference, so the chip resolves the reference without fetching
 * what it just sent. Best effort: without object URLs, the chip fetches.
 */
function seedRecordedBytes(
  blobRef: string,
  mediaType: string,
  dataUrl: string,
): void {
  if (typeof URL.createObjectURL !== 'function') return;
  const blob = dataUrlBlob(dataUrl);
  if (blob)
    seedAttachmentObjectUrl(attachmentObjectUrlKey(blobRef, mediaType), blob);
}

/**
 * The composer row's file parts, made what the turn recorded. The row was
 * built before the send and holds only what the composer had: inline bytes
 * when it still had them, or nothing at all when the send went out as staged
 * references after a reload. `turn.started` names the recorded attachments, so
 * the row adopts them in order — the parts the transcript projection builds on
 * reload.
 *
 * A part with a `blobRef` keeps no inline bytes: holding up to five
 * multi-megabyte data URLs per send for the chat's life is what the reference
 * exists to avoid. The bytes this client sent are seeded into the bounded
 * attachment cache under that reference instead, so the chip stays a preview
 * through the switch. Only a part with no reference keeps its bytes inline.
 */
export function withRecordedAttachments(
  message: ChatMessage,
  attachments: readonly PersistedChatAttachment[] | undefined,
): Pick<ChatMessage, 'contentParts'> | undefined {
  if (!attachments?.length) return undefined;
  // A row with no parts renders its `content`; once it has parts, the text
  // must be one of them or adopting the files would hide it.
  const parts =
    message.contentParts ??
    (message.content ? [{ type: 'text', content: message.content }] : []);
  const local = parts.filter((part) => part.type === 'file');
  const recorded = attachments.map((attachment, index) => {
    const bytes = attachment.dataUrl ?? sentBytesFor(local[index], attachment);
    if (attachment.blobRef !== undefined && bytes)
      seedRecordedBytes(attachment.blobRef, attachment.mimeType, bytes);
    return {
      type: 'file' as const,
      ...(attachment.blobRef === undefined
        ? bytes
          ? { url: bytes }
          : {}
        : { blobRef: attachment.blobRef }),
      mediaType: attachment.mimeType,
      name: attachment.name,
    };
  });
  return {
    contentParts: [
      ...parts.filter((part) => part.type !== 'file'),
      ...recorded,
    ],
  };
}
