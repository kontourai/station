import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, resolve, sep } from 'node:path';
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_COUNT,
  CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
  CHAT_IMAGE_MIME_TYPES,
  type ChatAttachmentInput,
  type ChatImageMimeType,
  sniffChatImageMimeType,
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
 * never rejected there for its images. The declared type is only a claim: the
 * decoded bytes must carry that type's magic number, or the image is refused.
 *
 * An image that does not fit is never persisted and never silently vanishes:
 * `add` returns a bounded text marker saying what was dropped and why, which
 * the adapter puts in the tool's own output (see
 * {@link summarizeImageOmissions} for the bounded aggregate form).
 */

const MIB = 1024 * 1024;
const IMAGE_MIME_SET = new Set<string>(CHAT_IMAGE_MIME_TYPES);
const EXTENSION: Record<ChatImageMimeType, string> = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
const OMISSION_PREFIX = '[image not shown: ';

export type ModelImageOutcome =
  | { kind: 'attached'; name: string; marker: string }
  | { kind: 'omitted'; marker: string };

function omitted(reason: string): ModelImageOutcome {
  return { kind: 'omitted', marker: `${OMISSION_PREFIX}${reason}]` };
}

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
      return omitted(
        `${describeMimeType(mimeType)} is not a supported image type`,
      );
    }
    if (typeof base64 !== 'string' || base64.length === 0) {
      return omitted('the image data was missing');
    }
    // Past the count limit, refuse before touching the bytes at all.
    if (this.attachments.length >= CHAT_ATTACHMENT_MAX_COUNT) {
      return omitted(
        `only ${CHAT_ATTACHMENT_MAX_COUNT} images can be shown per tool result`,
      );
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
    if (typeof url !== 'string') return omitted('the image data was missing');
    const match = /^data:([^;,]{1,128});base64,/iu.exec(url.slice(0, 160));
    if (!match) return omitted('only inline image data can be shown');
    return this.addBase64(match[1], url.slice(match[0].length), nameHint);
  }

  /** Bytes already in memory (a host file read), typed by their content. */
  addBytes(bytes: Buffer, nameHint?: string): ModelImageOutcome {
    if (bytes.length > CHAT_ATTACHMENT_MAX_BYTES) return this.tooLarge();
    const mimeType = sniffChatImageMimeType(bytes.subarray(0, 12));
    if (!mimeType) return omitted('the file is not a supported image type');
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
    return omitted(
      `larger than the ${CHAT_ATTACHMENT_MAX_BYTES / MIB} MB limit`,
    );
  }

  private accept(
    mimeType: ChatImageMimeType,
    base64: string,
    decodedBytes: number,
    nameHint: string | undefined,
  ): ModelImageOutcome {
    if (this.attachments.length >= CHAT_ATTACHMENT_MAX_COUNT) {
      return omitted(
        `only ${CHAT_ATTACHMENT_MAX_COUNT} images can be shown per tool result`,
      );
    }
    if (this.totalBytes + decodedBytes > CHAT_ATTACHMENT_MAX_TOTAL_BYTES) {
      return omitted(
        `images in this result exceed ${CHAT_ATTACHMENT_MAX_TOTAL_BYTES / MIB} MB combined`,
      );
    }
    // The declared type must be what the bytes are: HTML or SVG declared as
    // `image/png` is not stored and served under that type.
    if (
      sniffChatImageMimeType(Buffer.from(base64.slice(0, 24), 'base64')) !==
      mimeType
    ) {
      return omitted(`the data is not a ${mimeType} image`);
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
      return omitted('the image data was not valid');
    }
    this.attachments.push(attachment);
    this.totalBytes += decodedBytes;
    return { kind: 'attached', name, marker: `[image: ${name}]` };
  }
}

const MAX_OMISSION_LINES = 3;

/**
 * Omission markers folded into a bounded summary. One line per image let an
 * engine that returns thousands of rejected blocks push the tool's output past
 * EventStore's ingress ceiling, which rejected the terminal outright. Identical
 * reasons are counted (`[3 images not shown: …]`), at most
 * {@link MAX_OMISSION_LINES} distinct reasons are named, and the rest are
 * counted in one final line.
 */
export function summarizeImageOmissions(
  markers: readonly string[],
): string | undefined {
  if (markers.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const marker of markers) {
    const reason =
      marker.startsWith(OMISSION_PREFIX) && marker.endsWith(']')
        ? marker.slice(OMISSION_PREFIX.length, -1)
        : 'unknown reason';
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const lines: string[] = [];
  let rest = 0;
  for (const [reason, count] of counts) {
    if (lines.length < MAX_OMISSION_LINES) {
      lines.push(
        count === 1
          ? `${OMISSION_PREFIX}${reason}]`
          : `[${count} images not shown: ${reason}]`,
      );
    } else {
      rest += count;
    }
  }
  if (rest > 0) lines.push(`[${rest} more images not shown]`);
  return lines.join('\n');
}

/** The text that replaces inline image bytes found where text belongs. */
export const INLINE_IMAGE_DATA_PLACEHOLDER = '[inline image data omitted]';

/** A `data:…;base64,` URL: image bytes, however they are labelled. */
export function isInlineDataUrl(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\s*data:[^,]{0,256};base64,/iu.test(value.slice(0, 300))
  );
}

/**
 * Where bytes of an image an engine reported may be read from on this host.
 * Codex's `imageView` names a path; reading it is only legitimate inside the
 * session's own workspace, never anywhere the Station process can reach.
 */
export interface HostImageReadScope {
  /** Absolute workspace root(s). None known means nothing is readable. */
  roots: readonly string[];
}

function isInside(path: string, root: string): boolean {
  return (
    path === root || path.startsWith(root.endsWith(sep) ? root : root + sep)
  );
}

/**
 * Read an image an engine reports having viewed on this host, asynchronously
 * and bounded:
 * - the path must resolve (realpath) inside the realpath of a workspace root;
 * - the final component must not be a symbolic link, and the file is opened
 *   `O_NOFOLLOW`, then its device/inode must match the checked path, so a swap
 *   after the check reads nothing;
 * - it must be a regular file within the per-image limit whose leading bytes
 *   are one of the chat image types. The extension is never trusted.
 *
 * Anything else yields a marker naming why, never the file's contents.
 */
export async function addWorkspaceImageFile(
  collector: ModelImageCollector,
  path: unknown,
  scope: HostImageReadScope,
): Promise<ModelImageOutcome> {
  if (typeof path !== 'string' || path.length === 0 || path.length > 4096) {
    return omitted('no image path was reported');
  }
  const roots = scope.roots.filter((root) => isAbsolute(root));
  if (roots.length === 0) {
    return omitted('the session has no known workspace to read images from');
  }
  const requested = isAbsolute(path) ? path : resolve(roots[0]!, path);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const link = await lstat(requested);
    if (link.isSymbolicLink()) {
      return omitted('the viewed path is a symbolic link');
    }
    const real = await realpath(requested);
    const realRoots = (
      await Promise.all(roots.map((root) => realpath(root).catch(() => null)))
    ).filter((root): root is string => root !== null);
    if (!realRoots.some((root) => isInside(real, root))) {
      return omitted('the viewed file is outside the session workspace');
    }
    const checked = await lstat(real);
    handle = await open(
      real,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const stat = await handle.stat();
    if (stat.dev !== checked.dev || stat.ino !== checked.ino) {
      return omitted('the image file changed while it was read');
    }
    if (!stat.isFile()) return omitted('the viewed path is not a file');
    if (stat.size > CHAT_ATTACHMENT_MAX_BYTES) {
      return omitted(
        `larger than the ${CHAT_ATTACHMENT_MAX_BYTES / MIB} MB limit`,
      );
    }
    // One byte past the declared size, so a file that grew after the stat is
    // refused rather than silently truncated into a different image.
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length === 0 || length > stat.size) {
      return omitted('the image file changed while it was read');
    }
    return collector.addBytes(buffer.subarray(0, length), basename(real));
  } catch {
    return omitted('the viewed image could not be read');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
