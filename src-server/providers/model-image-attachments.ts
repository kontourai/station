import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { basename } from 'node:path';
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_COUNT,
  CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
  CHAT_IMAGE_MIME_TYPES,
  type ChatAttachmentInput,
  type ChatImageMimeType,
  validateChatAttachment,
} from '@kontourai/station-contracts/chat-attachment';

/**
 * Images a model or its tools produced — a `Read` of a PNG, an MCP
 * screenshot, Codex's `imageView` — turned into the same attachment shape a
 * user's pasted image takes, so EventStore's ingress stores the bytes as a
 * content-addressed blob and every device can fetch them.
 *
 * Every adapter goes through this one collector so the allowlist and limits
 * cannot drift between engines: the chat image types, at most
 * {@link CHAT_ATTACHMENT_MAX_COUNT} per event, each within
 * {@link CHAT_ATTACHMENT_MAX_BYTES} and together within
 * {@link CHAT_ATTACHMENT_MAX_TOTAL_BYTES}. Those are the limits EventStore's
 * ingress enforces on an attachment-bearing event, so an event built here is
 * never rejected there for its images.
 *
 * An image that does not fit is never persisted and never silently vanishes:
 * `add` returns a bounded text marker saying what was dropped and why, which
 * the adapter puts in the tool's own output where its bytes used to be.
 */

const MIB = 1024 * 1024;
const IMAGE_MIME_SET = new Set<string>(CHAT_IMAGE_MIME_TYPES);
const EXTENSION: Record<ChatImageMimeType, string> = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export type ModelImageOutcome =
  | { kind: 'attached'; name: string; marker: string }
  | { kind: 'omitted'; marker: string };

/** A display-safe rendering of an engine-supplied type string. */
function describeMimeType(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return 'an unknown type';
  const safe = value.slice(0, 64).replace(/[^A-Za-z0-9.+/-]/g, '');
  return safe || 'an unknown type';
}

function normalizeMimeType(value: unknown): ChatImageMimeType | undefined {
  if (typeof value !== 'string') return undefined;
  const lowered = value.trim().toLowerCase();
  const canonical = lowered === 'image/jpg' ? 'image/jpeg' : lowered;
  return IMAGE_MIME_SET.has(canonical)
    ? (canonical as ChatImageMimeType)
    : undefined;
}

/** A name that passes the attachment contract's name check, or undefined. */
function safeName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim().slice(0, 160).trim();
  if (
    !trimmed ||
    trimmed === '.' ||
    trimmed === '..' ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the name check refuses control characters.
    /[/\\\u0000-\u001f\u007f]/u.test(trimmed)
  )
    return undefined;
  return trimmed;
}

export class ModelImageCollector {
  private readonly attachments: ChatAttachmentInput[] = [];
  private totalBytes = 0;

  /** `namePrefix` names images the engine gave no name (`image-1.png`). */
  constructor(private readonly namePrefix = 'image') {}

  /**
   * One engine-supplied image as base64 plus its declared type. Whitespace in
   * the base64 is tolerated (some MCP servers wrap it); anything else that is
   * not canonical base64 is refused, not repaired.
   */
  addBase64(
    mimeType: unknown,
    base64: unknown,
    nameHint?: string,
  ): ModelImageOutcome {
    const type = normalizeMimeType(mimeType);
    if (!type) {
      return {
        kind: 'omitted',
        marker: `[image not shown: ${describeMimeType(mimeType)} is not a supported image type]`,
      };
    }
    if (typeof base64 !== 'string' || base64.length === 0) {
      return {
        kind: 'omitted',
        marker: '[image not shown: the image data was missing]',
      };
    }
    // Refuse on the ENCODED length before copying anything: a whitespace strip
    // of an unbounded string is itself an unbounded allocation.
    if (base64.length > Math.ceil((CHAT_ATTACHMENT_MAX_BYTES * 4) / 3) + 4096) {
      return this.tooLarge();
    }
    const compact = base64.replace(/\s+/g, '');
    const padding = compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0;
    const decodedBytes = Math.floor((compact.length / 4) * 3) - padding;
    if (decodedBytes > CHAT_ATTACHMENT_MAX_BYTES) return this.tooLarge();
    return this.accept(type, compact, decodedBytes, nameHint);
  }

  /** A `data:<type>;base64,<bytes>` URL; any other URL is not an image here. */
  addDataUrl(url: unknown, nameHint?: string): ModelImageOutcome {
    if (typeof url !== 'string') {
      return {
        kind: 'omitted',
        marker: '[image not shown: the image data was missing]',
      };
    }
    const match = /^data:([^;,]{1,128});base64,/iu.exec(url.slice(0, 160));
    if (!match) {
      return {
        kind: 'omitted',
        marker: '[image not shown: only inline image data can be shown]',
      };
    }
    return this.addBase64(match[1], url.slice(match[0].length), nameHint);
  }

  /** Bytes already in memory (a host file read). */
  addBytes(
    mimeType: ChatImageMimeType,
    bytes: Buffer,
    nameHint?: string,
  ): ModelImageOutcome {
    if (bytes.length > CHAT_ATTACHMENT_MAX_BYTES) return this.tooLarge();
    return this.accept(
      mimeType,
      bytes.toString('base64'),
      bytes.length,
      nameHint,
    );
  }

  /** Attachments accepted so far, or undefined when there are none. */
  result(): ChatAttachmentInput[] | undefined {
    return this.attachments.length > 0 ? [...this.attachments] : undefined;
  }

  private tooLarge(): ModelImageOutcome {
    return {
      kind: 'omitted',
      marker: `[image not shown: larger than the ${CHAT_ATTACHMENT_MAX_BYTES / MIB} MB limit]`,
    };
  }

  private accept(
    mimeType: ChatImageMimeType,
    base64: string,
    decodedBytes: number,
    nameHint: string | undefined,
  ): ModelImageOutcome {
    if (this.attachments.length >= CHAT_ATTACHMENT_MAX_COUNT) {
      return {
        kind: 'omitted',
        marker: `[image not shown: only ${CHAT_ATTACHMENT_MAX_COUNT} images can be shown per tool result]`,
      };
    }
    if (this.totalBytes + decodedBytes > CHAT_ATTACHMENT_MAX_TOTAL_BYTES) {
      return {
        kind: 'omitted',
        marker: `[image not shown: images in this result exceed ${CHAT_ATTACHMENT_MAX_TOTAL_BYTES / MIB} MB combined]`,
      };
    }
    const name =
      safeName(nameHint) ??
      `${this.namePrefix}-${this.attachments.length + 1}.${EXTENSION[mimeType]}`;
    const attachment: ChatAttachmentInput = {
      kind: 'image',
      name,
      mimeType,
      size: decodedBytes,
      dataUrl: `data:${mimeType};base64,${base64}`,
    };
    // The same validator EventStore runs: an image this accepts is one the
    // ingress accepts, so the event cannot be rejected for it downstream.
    if (validateChatAttachment(attachment) !== null) {
      return {
        kind: 'omitted',
        marker: '[image not shown: the image data was not valid]',
      };
    }
    this.attachments.push(attachment);
    this.totalBytes += decodedBytes;
    return { kind: 'attached', name, marker: `[image: ${name}]` };
  }
}

/** The image type the bytes themselves declare, from their magic number. */
export function sniffImageMimeType(
  head: Uint8Array,
): ChatImageMimeType | undefined {
  const starts = (...bytes: number[]) =>
    bytes.every((byte, index) => head[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
    return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38) && (head[4] === 0x37 || head[4] === 0x39))
    return 'image/gif';
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    head[8] === 0x57 &&
    head[9] === 0x45 &&
    head[10] === 0x42 &&
    head[11] === 0x50
  )
    return 'image/webp';
  return undefined;
}

/**
 * Read an image an engine reports having viewed on this host (Codex's
 * `imageView` names a path, not bytes). Bounded and type-checked by content:
 * the file must be a regular file within the per-image limit whose leading
 * bytes are one of the chat image types. The extension is never trusted, so a
 * path naming anything else yields a marker, not its contents.
 *
 * Opened non-blocking and checked with `fstat` on the SAME descriptor that is
 * read, so a FIFO cannot hang the adapter and a swap between check and read
 * cannot substitute a different file.
 */
export function addHostImageFile(
  collector: ModelImageCollector,
  path: unknown,
): ModelImageOutcome {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096) {
    return {
      kind: 'omitted',
      marker: '[image not shown: no image path was reported]',
    };
  }
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return {
        kind: 'omitted',
        marker: '[image not shown: the viewed path is not a file]',
      };
    }
    if (stat.size > CHAT_ATTACHMENT_MAX_BYTES) {
      return {
        kind: 'omitted',
        marker: `[image not shown: larger than the ${CHAT_ATTACHMENT_MAX_BYTES / MIB} MB limit]`,
      };
    }
    // Read one byte past the declared size so a file that grew after the stat
    // is refused rather than silently truncated into a different image.
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length === 0 || length > stat.size) {
      return {
        kind: 'omitted',
        marker: '[image not shown: the image file changed while it was read]',
      };
    }
    const bytes = buffer.subarray(0, length);
    const mimeType = sniffImageMimeType(bytes.subarray(0, 12));
    if (!mimeType) {
      return {
        kind: 'omitted',
        marker:
          '[image not shown: the viewed file is not a supported image type]',
      };
    }
    return collector.addBytes(mimeType, bytes, basename(path));
  } catch {
    return {
      kind: 'omitted',
      marker: '[image not shown: the viewed image could not be read]',
    };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Nothing to report: the read already has its outcome.
      }
    }
  }
}
