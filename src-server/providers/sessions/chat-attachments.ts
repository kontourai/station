import {
  type ChatAttachmentInput,
  type PersistedChatAttachment,
  parseChatAttachmentDataUrl,
  validateChatAttachments,
} from '@kontourai/station-contracts/chat-attachment';

/**
 * Narrow a persisted attachment back to a dispatchable one (station#3374).
 *
 * Server-side rather than beside `PersistedChatAttachment` in the contracts
 * package: re-dispatching a recorded turn is a server concern, and this module
 * is already where the other attachment decode/refuse helpers live.
 */
export function persistedChatAttachmentBytes(
  attachment: PersistedChatAttachment,
): ChatAttachmentInput | undefined {
  return attachment.dataUrl === undefined
    ? undefined
    : { ...attachment, dataUrl: attachment.dataUrl };
}

/**
 * Every attachment, or nothing. A caller re-dispatching a recorded turn must
 * not quietly send the model a subset of what the user attached, so a single
 * unresolved reference withdraws the whole set and lets the caller decide.
 */
export function dispatchableChatAttachments(
  attachments: readonly PersistedChatAttachment[] | undefined,
): ChatAttachmentInput[] | undefined {
  if (!attachments?.length) return undefined;
  const resolved: ChatAttachmentInput[] = [];
  for (const attachment of attachments) {
    const bytes = persistedChatAttachmentBytes(attachment);
    if (!bytes) return undefined;
    resolved.push(bytes);
  }
  return resolved;
}

export interface DecodedChatAttachment {
  attachment: ChatAttachmentInput;
  base64: string;
}

export function decodeChatAttachments(
  attachments: ChatAttachmentInput[] | undefined,
): DecodedChatAttachment[] {
  if (!attachments?.length) return [];
  const error = validateChatAttachments(attachments);
  if (error) throw new Error(error);
  return attachments.map((attachment) => {
    const parsed = parseChatAttachmentDataUrl(attachment.dataUrl);
    if (!parsed) {
      throw new Error(`${attachment.name} contains invalid attachment data.`);
    }
    return { attachment, base64: parsed.base64 };
  });
}

export function decodeUtf8Attachment(decoded: DecodedChatAttachment): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.from(decoded.base64, 'base64'),
    );
  } catch {
    throw new Error(`${decoded.attachment.name} is not valid UTF-8 text.`);
  }
}

export function rejectFileAttachments(
  providerName: string,
  decoded: DecodedChatAttachment[],
): void {
  const unsupported = decoded.find(
    ({ attachment }) => attachment.kind === 'file',
  );
  if (unsupported) {
    throw new Error(
      `${providerName} supports image attachments here, but not ${unsupported.attachment.name}. Attach an image or paste the file contents as text.`,
    );
  }
}
