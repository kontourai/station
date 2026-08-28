import {
  attachmentKindForMimeType,
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_COUNT,
  CHAT_ATTACHMENT_MAX_NAME_LENGTH,
  CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
  type ChatAttachmentMimeType,
  type ChatImageMimeType,
  validateChatAttachment,
} from '@kontourai/station-contracts/chat-attachment';
import type { FileAttachment } from '../types';
import type { DownscaledImage } from './downscaleImage';
import { sniffImageContainer } from './image-container-sniff';

export interface AttachmentInputCapabilities {
  images: boolean;
  files: boolean;
  /**
   * The engine- or model-specific sentence explaining why `images` is false
   * (archive#3344, from `resolveComposerImageSupport`). Without it a paste
   * onto a text-only engine is refused with a generic line that names nothing
   * the user can act on.
   */
  imageRefusal?: string;
}

export interface ReadChatAttachmentFilesResult {
  attachments: FileAttachment[];
  errors: string[];
}

const MIME_TYPE_BY_EXTENSION: Record<string, ChatAttachmentMimeType> = {
  csv: 'text/csv',
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  json: 'application/json',
  md: 'text/markdown',
  pdf: 'application/pdf',
  png: 'image/png',
  text: 'text/plain',
  txt: 'text/plain',
  webp: 'image/webp',
};

const HEIF_MIME = /^image\/hei(?:c|f)(?:-sequence)?$/iu;
const HEIF_EXTENSION = /\.(?:heic|heif)$/iu;

function isDeclaredHeif(file: Pick<File, 'name' | 'type'>): boolean {
  return HEIF_MIME.test(file.type.trim()) || HEIF_EXTENSION.test(file.name);
}

function safeAttachmentName(name: string): string {
  const leaf = name.split(/[\\/]/u).pop() ?? '';
  const safe = Array.from(leaf)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 0x1f && codePoint !== 0x7f;
    })
    .join('')
    .trim()
    .slice(0, CHAT_ATTACHMENT_MAX_NAME_LENGTH);
  return safe && safe !== '.' && safe !== '..' ? safe : 'attachment';
}

const EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/**
 * Re-point a name at the format its bytes are now in. A `.png` holding WebP
 * bytes is a small lie the rest of the pipeline never corrects: the server
 * checks the declared mime type against the data URL and never reads the
 * extension, so nothing else would catch it.
 */
function withExtensionFor(name: string, mimeType: string): string {
  const suffix = EXTENSION_BY_MIME_TYPE[mimeType];
  if (!suffix) return name;
  const dot = name.lastIndexOf('.');
  const stem = (dot > 0 ? name.slice(0, dot) : name).slice(
    0,
    CHAT_ATTACHMENT_MAX_NAME_LENGTH - suffix.length - 1,
  );
  return `${stem}.${suffix}`;
}

function resolveMimeType(file: File): ChatAttachmentMimeType | null {
  const declared = file.type.trim().toLowerCase();
  if (attachmentKindForMimeType(declared)) {
    return declared as ChatAttachmentMimeType;
  }
  const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
  return MIME_TYPE_BY_EXTENSION[extension] ?? null;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () =>
      reject(new Error(`Could not read ${safeAttachmentName(file.name)}.`));
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error(`Could not read ${safeAttachmentName(file.name)}.`));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

async function settleTransformationReceipt(
  receipt: NonNullable<FileAttachment['transformation']>,
  output: { data: string; name: string; mimeType: string; bytes: number },
): Promise<FileAttachment['transformation']> {
  const payload = output.data.slice(output.data.indexOf(',') + 1);
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return {
    ...receipt,
    output: {
      name: output.name,
      mimeType: output.mimeType,
      bytes: output.bytes,
      sha256: [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
    },
  };
}

export async function readChatAttachmentFiles(
  files: Iterable<File>,
  existing: FileAttachment[],
  capabilities: AttachmentInputCapabilities,
): Promise<ReadChatAttachmentFilesResult> {
  const attachments: FileAttachment[] = [];
  const errors: string[] = [];
  let heifSourceBytes = 0;
  let totalBytes = existing.reduce(
    (total, attachment) => total + attachment.size,
    0,
  );

  for (const file of files) {
    const name = safeAttachmentName(file.name);
    if (existing.length + attachments.length >= CHAT_ATTACHMENT_MAX_COUNT) {
      errors.push(
        `A message can include at most ${CHAT_ATTACHMENT_MAX_COUNT} attachments.`,
      );
      break;
    }
    const container = await sniffImageContainer(file);
    const declaredHeif = isDeclaredHeif(file);
    let sourceFile = file;
    let transformation: FileAttachment['transformation'];
    let isHeif = false;
    let mimeType = resolveMimeType(file);
    // ISO-BMFF is inspected before a claimed JPEG/PNG/WebP MIME can take the
    // normal data-url path. Conversely, a claimed HEIF must carry BMFF magic.
    if (container === 'bmff' || declaredHeif) {
      if (container !== 'bmff') {
        errors.push(
          `${name} is declared as HEIF but does not contain HEIF container bytes.`,
        );
        continue;
      }
      if (mimeType) {
        errors.push(
          `${name} declares ${mimeType} but contains an ISO-BMFF image container.`,
        );
        continue;
      }
      // Keep the inspector and its worker bootstrap out of every ordinary
      // composer entry. This is the only import edge to the HEIF assets.
      const prepared = await import('./heif-attachment').then((module) =>
        module.prepareHeifAttachment(file, name, heifSourceBytes, {
          magicSaysBmff: true,
        }),
      );
      if (prepared.kind === 'not-heif') {
        errors.push(`${name} is not a supported image or document.`);
        continue;
      }
      isHeif = true;
      if (!capabilities.images) {
        errors.push(
          capabilities.imageRefusal ??
            'This agent does not support image attachments.',
        );
        continue;
      }
      if (prepared.kind === 'rejected') {
        errors.push(prepared.error);
        continue;
      }
      heifSourceBytes += prepared.sourceBytes;
      sourceFile = prepared.file;
      transformation = prepared.receipt;
      mimeType = 'image/jpeg';
    } else if (!mimeType) {
      errors.push(`${name} is not a supported image or document.`);
      continue;
    }
    const kind = mimeType ? attachmentKindForMimeType(mimeType) : null;
    if (!mimeType || !kind) {
      errors.push(`${name} is not a supported image or document.`);
      continue;
    }
    if (
      (kind === 'image' && !capabilities.images) ||
      (kind === 'file' && !capabilities.files)
    ) {
      errors.push(
        kind === 'image'
          ? (capabilities.imageRefusal ??
              'This agent does not support image attachments.')
          : 'This agent does not support document attachments.',
      );
      continue;
    }
    if (sourceFile.size < 1) {
      errors.push(`${name} is empty.`);
      continue;
    }

    // archive#3375: an oversized image is shrunk to fit rather than refused —
    // a pasted 4K screenshot should just work. The caps stay exactly where they
    // were; they now apply to what is about to be sent instead of to what was
    // picked. The module is loaded here, and only here, so the canvas ladder
    // stays out of the composer's own chunk for every attachment that fits.
    let downscaled: DownscaledImage | null = null;
    if (sourceFile.size > CHAT_ATTACHMENT_MAX_BYTES) {
      // Each branch below names what actually happened. "Could not be resized"
      // over a format nothing tried to resize would be a reason the code never
      // derived.
      let refusal = `${name} must be smaller than 5 MB.`;
      if (kind === 'image') {
        // Neither the chunk fetch nor the canvas re-encode is guaranteed to
        // resolve — `station upgrade` rebuilds `dist-ui` under open tabs, and
        // this import is the composer's one dynamic import without a
        // LazyBoundary. A rejection here would reach `void
        // handleAttachmentFiles(...)` and vanish, leaving a paste that says
        // nothing at all; before this feature the same paste got a size error.
        refusal = `${name} is larger than 5 MB and could not be resized on this device.`;
        try {
          const downscale = await import('./downscaleImage');
          if (!downscale.canResizeFormat(mimeType as ChatImageMimeType)) {
            refusal = `${name} is larger than 5 MB. ${downscale.formatNotResizableReason()}`;
          } else {
            const outcome = await downscale.downscaleImageToFit(
              sourceFile,
              mimeType as ChatImageMimeType,
            );
            if (outcome.status === 'resized') downscaled = outcome.image;
            else if (outcome.status === 'too-large') {
              refusal = `${name} is larger than 5 MB and could not be resized small enough.`;
            } else {
              // Never became an image here — claiming the ladder ran and came
              // up short would describe work that did not happen.
              refusal = `${name} could not be read as an image on this device.`;
            }
          }
        } catch {
          // Keep the device-level refusal: which half failed is not something
          // this can tell the user, and guessing would be a made-up reason.
        }
      }
      if (!downscaled) {
        errors.push(refusal);
        continue;
      }
    }

    const effectiveName = downscaled
      ? withExtensionFor(name, downscaled.mimeType)
      : isHeif
        ? sourceFile.name
        : name;
    const effectiveMimeType = downscaled ? downscaled.mimeType : mimeType;
    const effectiveSize = downscaled ? downscaled.bytes : sourceFile.size;
    if (totalBytes + effectiveSize > CHAT_ATTACHMENT_MAX_TOTAL_BYTES) {
      errors.push('Attachments must be smaller than 15 MB combined.');
      break;
    }

    try {
      const data = downscaled
        ? downscaled.dataUrl
        : await readAsDataUrl(sourceFile);
      const settledTransformation = transformation
        ? await settleTransformationReceipt(transformation, {
            data,
            name: effectiveName,
            mimeType: effectiveMimeType,
            bytes: effectiveSize,
          })
        : undefined;
      const attachment: FileAttachment = {
        id:
          globalThis.crypto?.randomUUID?.() ??
          `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: effectiveName,
        type: effectiveMimeType,
        size: effectiveSize,
        data,
        preview: kind === 'image' ? data : undefined,
        ...(downscaled
          ? {
              resized: {
                fromBytes: file.size,
                fromMimeType: file.type || 'application/octet-stream',
                width: downscaled.width,
                height: downscaled.height,
              },
            }
          : {}),
        ...(settledTransformation
          ? { transformation: settledTransformation }
          : {}),
      };
      const validationError = validateChatAttachment({
        kind,
        name: effectiveName,
        mimeType: effectiveMimeType,
        size: effectiveSize,
        dataUrl: data,
      });
      if (validationError) {
        errors.push(`${effectiveName}: ${validationError}`);
        continue;
      }
      attachments.push(attachment);
      totalBytes += effectiveSize;
    } catch (error) {
      errors.push(
        error instanceof Error ? error.message : `Could not read ${name}.`,
      );
    }
  }

  return { attachments, errors: [...new Set(errors)] };
}
