export const CHAT_ATTACHMENT_MAX_COUNT = 5;
export const CHAT_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const CHAT_ATTACHMENT_MAX_TOTAL_BYTES = 15 * 1024 * 1024;
export const CHAT_ATTACHMENT_MAX_NAME_LENGTH = 160;
/** Maximum encoded JSON command body, including base64 expansion and metadata. */
export const CHAT_ATTACHMENT_MAX_COMMAND_JSON_BYTES = 22 * 1024 * 1024;
/**
 * Bound one chat's durable attachment history.
 *
 * What this actually measures, since blob-backed storage landed (station#3374):
 * the encoded data-URL bytes a conversation has COMMITTED AT DISPATCH, not the
 * bytes currently on disk. It is charged before the turn is sent, released if
 * that dispatch fails, and released in full when the thread is deleted.
 *
 * It therefore OVER-COUNTS, by design and in the safe direction. The blob store
 * is content-addressed, so the same image attached to ten turns occupies disk
 * once while costing quota ten times; and base64 is ~4/3 of the decoded size.
 * A ceiling that tracked live disk instead would have to be recomputed against
 * the store on every dispatch, and would let a chat re-attach one image without
 * limit. Refusing early on a conservative count is the cheaper mistake.
 */
export const CHAT_ATTACHMENT_MAX_SESSION_ENCODED_BYTES = 64 * 1024 * 1024;
/** The same measure, summed across every conversation in one Station home. */
export const CHAT_ATTACHMENT_MAX_STORE_ENCODED_BYTES = 512 * 1024 * 1024;
export const CHAT_ATTACHMENT_MAX_DATA_URL_LENGTH =
  Math.ceil((CHAT_ATTACHMENT_MAX_BYTES * 4) / 3) + 128;

export const CHAT_IMAGE_MIME_TYPES = [
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export const CHAT_FILE_MIME_TYPES = [
  'application/json',
  'application/pdf',
  'text/csv',
  'text/markdown',
  'text/plain',
] as const;

export type ChatImageMimeType = (typeof CHAT_IMAGE_MIME_TYPES)[number];
export type ChatFileMimeType = (typeof CHAT_FILE_MIME_TYPES)[number];
export type ChatAttachmentMimeType = ChatImageMimeType | ChatFileMimeType;
export type ChatAttachmentKind = 'image' | 'file';

/**
 * Provider-neutral, request-scoped chat attachment. The browser keeps the
 * bytes in a data URL so remote Station clients never expose their local file
 * paths to the server or an external agent app.
 */
export interface ChatAttachmentInput {
  kind: ChatAttachmentKind;
  name: string;
  mimeType: ChatAttachmentMimeType;
  /** Raw decoded byte count, independently verified at the server boundary. */
  size: number;
  dataUrl: string;
}

/**
 * An attachment as it survives in the durable event log (station#3374).
 *
 * A `ChatAttachmentInput` carries its bytes inline as a base64 data URL, which
 * is right for a request and wrong for a row that is never deleted: a 5 MB
 * screenshot used to sit in `turn.started`'s payload for the life of the home.
 * Persistence therefore keeps the metadata and swaps the bytes for `blobRef`,
 * a content-addressed handle into the attachment blob store.
 *
 * Exactly one of the two byte sources is meaningful at a time, and BOTH are
 * optional because each is absent in a real case:
 * - `dataUrl` alone — a row written before blob storage existed. Still read.
 * - `blobRef` alone — the reference could not be resolved to bytes, either
 *   because retention reclaimed the blob or because the caller asked for a
 *   bounded read that deliberately withholds them.
 * - both — the normal read: the reference resolved and the bytes are attached.
 *
 * A consumer that needs the bytes must check `dataUrl` rather than assume it.
 */
export interface PersistedChatAttachment
  extends Omit<ChatAttachmentInput, 'dataUrl'> {
  dataUrl?: string;
  /** `sha256-<64 lowercase hex>` — see the attachment blob store. */
  blobRef?: string;
}

export interface ParsedChatAttachmentDataUrl {
  mimeType: string;
  base64: string;
  decodedBytes: number;
}

const IMAGE_MIME_TYPE_SET = new Set<string>(CHAT_IMAGE_MIME_TYPES);
const FILE_MIME_TYPE_SET = new Set<string>(CHAT_FILE_MIME_TYPES);
function isCanonicalBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  const firstPadding = value.indexOf('=');
  const contentEnd = firstPadding < 0 ? value.length : firstPadding;
  if (
    firstPadding >= 0 &&
    !(
      firstPadding >= value.length - 2 &&
      /^={1,2}$/u.test(value.slice(firstPadding))
    )
  ) {
    return false;
  }
  for (let index = 0; index < contentEnd; index += 1) {
    const code = value.charCodeAt(index);
    const allowed =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!allowed) return false;
  }
  return true;
}

function hasUnsafeAttachmentNameCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      character === '/' ||
      character === '\\' ||
      codePoint <= 0x1f ||
      codePoint === 0x7f
    );
  });
}

export function attachmentKindForMimeType(
  mimeType: string,
): ChatAttachmentKind | null {
  if (IMAGE_MIME_TYPE_SET.has(mimeType)) return 'image';
  if (FILE_MIME_TYPE_SET.has(mimeType)) return 'file';
  return null;
}

export function parseChatAttachmentDataUrl(
  dataUrl: string,
): ParsedChatAttachmentDataUrl | null {
  if (dataUrl.length > CHAT_ATTACHMENT_MAX_DATA_URL_LENGTH) return null;
  const separator = dataUrl.indexOf(',');
  if (separator < 0) return null;
  const header = dataUrl.slice(0, separator);
  const base64 = dataUrl.slice(separator + 1);
  const match = /^data:([^;,]+);base64$/u.exec(header);
  if (!match || !isCanonicalBase64(base64)) return null;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return {
    mimeType: match[1].toLowerCase(),
    base64,
    decodedBytes: (base64.length / 4) * 3 - padding,
  };
}

export function validateChatAttachment(
  attachment: ChatAttachmentInput,
): string | null {
  const descriptorError = validateAttachmentDescriptor(attachment);
  if (descriptorError) return descriptorError;

  const parsed = parseChatAttachmentDataUrl(attachment.dataUrl);
  if (
    !parsed ||
    parsed.mimeType !== attachment.mimeType ||
    parsed.decodedBytes !== attachment.size
  ) {
    return 'Attachment data does not match its declared type and size.';
  }
  return null;
}

/** One shared descriptor check; byte-bearing requests add data-url agreement. */
function validateAttachmentDescriptor(
  attachment: Pick<
    PersistedChatAttachment,
    'kind' | 'name' | 'mimeType' | 'size'
  >,
): string | null {
  if (
    attachment.name.length === 0 ||
    attachment.name.length > CHAT_ATTACHMENT_MAX_NAME_LENGTH ||
    attachment.name !== attachment.name.trim() ||
    attachment.name === '.' ||
    attachment.name === '..' ||
    hasUnsafeAttachmentNameCharacter(attachment.name)
  ) {
    return 'Attachment name is unsafe.';
  }

  const expectedKind = attachmentKindForMimeType(attachment.mimeType);
  if (!expectedKind || expectedKind !== attachment.kind) {
    return `Attachment type ${attachment.mimeType} is not supported.`;
  }
  if (
    !Number.isSafeInteger(attachment.size) ||
    attachment.size < 1 ||
    attachment.size > CHAT_ATTACHMENT_MAX_BYTES
  ) {
    return `Attachment exceeds the ${CHAT_ATTACHMENT_MAX_BYTES}-byte limit.`;
  }

  return null;
}

/**
 * Validate persisted attachment metadata without reading its data URL or blob.
 * Used by bounded descriptor reads that must not materialize attachment bytes.
 */
export function validatePersistedChatAttachmentDescriptor(
  attachment: Pick<
    PersistedChatAttachment,
    'kind' | 'name' | 'mimeType' | 'size'
  >,
): string | null {
  return validateAttachmentDescriptor(attachment);
}

export function validateChatAttachments(
  attachments: ChatAttachmentInput[],
): string | null {
  if (attachments.length > CHAT_ATTACHMENT_MAX_COUNT) {
    return `A message can include at most ${CHAT_ATTACHMENT_MAX_COUNT} attachments.`;
  }
  let totalBytes = 0;
  for (const attachment of attachments) {
    const error = validateChatAttachment(attachment);
    if (error) return error;
    totalBytes += attachment.size;
    if (totalBytes > CHAT_ATTACHMENT_MAX_TOTAL_BYTES) {
      return `Attachments exceed the ${CHAT_ATTACHMENT_MAX_TOTAL_BYTES}-byte combined limit.`;
    }
  }
  return null;
}

/**
 * Bound inline attachments arriving as chat-input file parts
 * (`{type:'file', mediaType, url:'data:...'}`) — the shape `POST
 * /agents/:slug/chat` accepts (station#2828).
 *
 * Same limits as `validateChatAttachments`, deliberately NOT the same
 * function: that one validates a request-scoped attachment carrying `name`
 * and a declared `size`, and its name-safety and size-agreement checks have
 * nothing to read here. Passing a synthesized name would make those checks
 * pass vacuously — a guard reporting success over a field it never saw. What
 * this shape can carry is checked: count, per-attachment decoded size,
 * combined size, and a supported media type, all from the shared constants
 * above so the two paths cannot drift apart.
 */
export function validateChatInputFileParts(
  parts: readonly { mediaType?: unknown; url?: unknown }[],
): string | null {
  if (parts.length > CHAT_ATTACHMENT_MAX_COUNT) {
    return `A message can include at most ${CHAT_ATTACHMENT_MAX_COUNT} attachments.`;
  }
  let totalBytes = 0;
  for (const part of parts) {
    if (typeof part.url !== 'string') {
      return 'Attachment data is missing or not a string.';
    }
    if (part.url.length > CHAT_ATTACHMENT_MAX_DATA_URL_LENGTH) {
      return `Attachment exceeds the ${CHAT_ATTACHMENT_MAX_BYTES}-byte limit.`;
    }
    const parsed = parseChatAttachmentDataUrl(part.url);
    if (!parsed) {
      return 'Attachment data does not match its declared type and size.';
    }
    if (!attachmentKindForMimeType(parsed.mimeType)) {
      return `Attachment type ${parsed.mimeType} is not supported.`;
    }
    if (
      typeof part.mediaType === 'string' &&
      part.mediaType !== parsed.mimeType
    ) {
      return 'Attachment data does not match its declared type and size.';
    }
    if (
      parsed.decodedBytes < 1 ||
      parsed.decodedBytes > CHAT_ATTACHMENT_MAX_BYTES
    ) {
      return `Attachment exceeds the ${CHAT_ATTACHMENT_MAX_BYTES}-byte limit.`;
    }
    totalBytes += parsed.decodedBytes;
    if (totalBytes > CHAT_ATTACHMENT_MAX_TOTAL_BYTES) {
      return `Attachments exceed the ${CHAT_ATTACHMENT_MAX_TOTAL_BYTES}-byte combined limit.`;
    }
  }
  return null;
}
