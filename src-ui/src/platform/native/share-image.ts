/**
 * JS-side contract for images a native host reads from outside the WebView:
 * the Android share target (`image-share-intake`) and the mobile system
 * clipboard (`clipboard-image`), both owned by the station-media-intake plugin
 * (`src-desktop/plugins/media-intake`). This module defines the
 * platform-neutral payload shape that plugin hands to the React app, plus the
 * defensive validation that turns that untrusted payload into `File` objects
 * the existing chat-attachment pipeline already knows how to accept.
 *
 * Shared content is untrusted: the payload is validated with the same
 * fail-closed posture as {@link parseCapabilityReport} before anything reaches
 * React state, and only image MIME types the composer already supports are
 * admitted. Byte limits are deferred to `readChatAttachmentFiles`, so a shared
 * image flows through the exact same MIME/size/capability validation as the
 * file picker, paste, and drag-and-drop.
 */
import {
  CHAT_ATTACHMENT_MAX_COUNT,
  CHAT_ATTACHMENT_MAX_NAME_LENGTH,
  CHAT_IMAGE_MIME_TYPES,
  type ChatImageMimeType,
  parseChatAttachmentDataUrl,
} from '@kontourai/station-contracts/chat-attachment';

/**
 * One image handed over by a native share target. `dataUrl` is a
 * base64-encoded `data:` URL — the receiver is responsible for reading the
 * shared content (content URI, file path, or raw bytes) and encoding it,
 * mirroring how the browser keeps attachment bytes inline so no local path is
 * ever exposed.
 */
export interface SharedImageFile {
  name: string;
  mimeType: ChatImageMimeType;
  dataUrl: string;
}

export interface NativeSharedImagePayload {
  files: SharedImageFile[];
}

const IMAGE_MIME_TYPE_SET = new Set<string>(CHAT_IMAGE_MIME_TYPES);

/**
 * Path separators, control (Cc), format (Cf: bidi overrides, zero-width
 * characters) and line/paragraph separators (Zl, Zp) can disguise or split a
 * name. The native plugin replaces such names; one arriving here is refused.
 */
const UNSAFE_NAME = /[/\\\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function parseSharedImageFile(value: unknown): SharedImageFile | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  const { name, mimeType, dataUrl } = candidate;
  if (
    typeof name !== 'string' ||
    name.trim().length === 0 ||
    name.length > CHAT_ATTACHMENT_MAX_NAME_LENGTH ||
    UNSAFE_NAME.test(name) ||
    typeof mimeType !== 'string' ||
    !IMAGE_MIME_TYPE_SET.has(mimeType) ||
    typeof dataUrl !== 'string'
  ) {
    return null;
  }
  const parsed = parseChatAttachmentDataUrl(dataUrl);
  if (!parsed || parsed.mimeType !== mimeType || parsed.decodedBytes < 1) {
    return null;
  }
  return { name, mimeType: mimeType as ChatImageMimeType, dataUrl };
}

/**
 * Fail-closed validator for a native share-target payload. Returns the
 * validated image list, or `null` when the payload is not a well-formed,
 * bounded set of supported images. An empty file list is rejected: an intake
 * with nothing to share is not a valid share.
 */
export function parseNativeSharedImagePayload(
  value: unknown,
): NativeSharedImagePayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.files)) return null;
  if (
    candidate.files.length < 1 ||
    candidate.files.length > CHAT_ATTACHMENT_MAX_COUNT
  ) {
    return null;
  }
  const files: SharedImageFile[] = [];
  for (const entry of candidate.files) {
    const file = parseSharedImageFile(entry);
    if (!file) return null;
    files.push(file);
  }
  return { files };
}

/**
 * A native read that may find nothing (a clipboard without an image, no
 * pending share): `{ files: [] }` is an empty list, anything else must pass
 * {@link parseNativeSharedImagePayload}. `null` when the reply is malformed.
 */
export function parseNativeImageList(
  value: unknown,
): NativeSharedImagePayload | null {
  if (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as { files?: unknown }).files) &&
    (value as { files: unknown[] }).files.length === 0
  ) {
    return { files: [] };
  }
  return parseNativeSharedImagePayload(value);
}

function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return buffer;
}

/**
 * Materialize validated shared images as `File` objects so they can enter the
 * shared `readChatAttachmentFiles` pipeline unchanged.
 */
export function sharedImagesToFiles(files: SharedImageFile[]): File[] {
  return files.map(
    (file) =>
      new File([dataUrlToArrayBuffer(file.dataUrl)], file.name, {
        type: file.mimeType,
      }),
  );
}
