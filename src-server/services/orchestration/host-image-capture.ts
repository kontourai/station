import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, sep } from 'node:path';
import { crc32 } from 'node:zlib';
import {
  CHAT_ATTACHMENT_MAX_COUNT,
  type ChatAttachmentInput,
  type ChatImageMimeType,
  sniffChatImageMimeType,
} from '@kontourai/station-contracts/chat-attachment';
import {
  CHAT_HOST_IMAGE_MAX_PATH_LENGTH,
  type ChatHostImageRefusal,
  type ChatHostImageSource,
  hostImagePathFromDestination,
} from '@kontourai/station-contracts/chat-host-images';
import {
  WORKSPACE_FILE_PREVIEW_MAX_BYTES,
  WORKSPACE_FILE_PREVIEW_MAX_IMAGE_DIMENSION,
  WORKSPACE_FILE_PREVIEW_MAX_IMAGE_FINAL_RASTER_BYTES,
} from '@kontourai/station-contracts/workspace-file-preview';
import { seatbeltWorkspaceRefusal } from '../../security/confinement/seatbelt.js';
import { resolveHomeDir } from '../../utils/paths.js';
import { listVerifiedWorktrees } from '../projects/verified-worktrees.js';

/**
 * One turn keeps at most as many host images as one `tool.completed` or one
 * user message may carry: the EventStore validates the event's attachments
 * with the same chat-attachment count bound.
 */
export const HOST_IMAGE_MAX_PER_TURN = CHAT_ATTACHMENT_MAX_COUNT;

/** Same per-image byte bound as a workspace visual preview (512 KiB). */
export const HOST_IMAGE_MAX_BYTES = WORKSPACE_FILE_PREVIEW_MAX_BYTES;

/** How many distinct destinations one turn's reply is scanned for. */
const HOST_IMAGE_MAX_DESTINATIONS = 32;

/**
 * The image destinations a markdown reply names, in order, raw (as written).
 *
 * A small scanner rather than a markdown parser: it skips fenced code blocks
 * and inline code spans, reads inline images (`![alt](dest "title")`, with
 * `<dest>` and balanced parentheses) and reference images whose definition is
 * in the same text. Raw HTML is not read: the chat renderer does not render
 * it. A destination the renderer would not show as an image costs at most an
 * extra stored copy; one it shows that this misses falls back to the
 * client's "not available" chip.
 */
export function hostImageDestinations(markdown: string): string[] {
  const visible: string[] = [];
  let fence: { char: string; length: number } | undefined;
  for (const line of markdown.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence.char &&
        marker[1].length >= fence.length &&
        line.trim() === marker[1]
      )
        fence = undefined;
      visible.push('');
      continue;
    }
    if (marker) {
      fence = { char: marker[1][0], length: marker[1].length };
      visible.push('');
      continue;
    }
    visible.push(line);
  }
  const text = visible
    .join('\n')
    .replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, (span) =>
      ' '.repeat(span.length),
    );
  const definitions = new Map<string, string>();
  for (const match of text.matchAll(
    /^ {0,3}\[([^\]\n]+)\]:[ \t]*(<[^<>\n]*>|\S+)/gm,
  )) {
    const label = match[1].trim().toLowerCase();
    if (!definitions.has(label))
      definitions.set(label, unwrapDestination(match[2]));
  }
  const found: string[] = [];
  for (let index = text.indexOf('!['); index >= 0; ) {
    const image = readImageAt(text, index, definitions);
    if (image !== undefined) found.push(image.destination);
    index = text.indexOf('![', image ? image.end : index + 2);
  }
  return found;
}

function unwrapDestination(raw: string): string {
  const inner =
    raw.startsWith('<') && raw.endsWith('>') ? raw.slice(1, -1) : raw;
  return inner.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}

/** Index just past the `]` closing the bracket opened at `open`, or -1. */
function closeBracket(text: string, open: number): number {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function readImageAt(
  text: string,
  start: number,
  definitions: ReadonlyMap<string, string>,
): { destination: string; end: number } | undefined {
  const altEnd = closeBracket(text, start + 1);
  if (altEnd < 0) return undefined;
  const alt = text.slice(start + 2, altEnd - 1);
  if (text[altEnd] === '(') {
    let index = altEnd + 1;
    while (text[index] === ' ' || text[index] === '\t' || text[index] === '\n')
      index += 1;
    let raw = '';
    if (text[index] === '<') {
      const close = text.indexOf('>', index);
      if (close < 0 || text.slice(index, close).includes('\n'))
        return undefined;
      raw = text.slice(index, close + 1);
      index = close + 1;
    } else {
      let depth = 0;
      const from = index;
      for (; index < text.length; index += 1) {
        const char = text[index];
        if (char === '\\') {
          index += 1;
          continue;
        }
        if (/\s/.test(char)) break;
        if (char === '(') depth += 1;
        if (char === ')') {
          if (depth === 0) break;
          depth -= 1;
        }
      }
      raw = text.slice(from, index);
    }
    const close = text.indexOf(')', index);
    if (close < 0 || !raw) return undefined;
    return { destination: unwrapDestination(raw), end: close + 1 };
  }
  // `![alt][label]`, `![alt][]` or `![alt]`.
  let label = alt;
  let end = altEnd;
  if (text[altEnd] === '[') {
    const labelEnd = closeBracket(text, altEnd);
    if (labelEnd < 0) return undefined;
    const explicit = text.slice(altEnd + 1, labelEnd - 1);
    if (explicit.trim()) label = explicit;
    end = labelEnd;
  }
  const destination = definitions.get(label.trim().toLowerCase());
  return destination === undefined ? undefined : { destination, end };
}

/** The normalized host paths a turn's text blocks name, deduplicated, in order. */
export function hostImagePaths(texts: readonly string[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    for (const destination of hostImageDestinations(text)) {
      const path = hostImagePathFromDestination(destination);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
      if (paths.length >= HOST_IMAGE_MAX_DESTINATIONS) return paths;
    }
  }
  return paths;
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return (
    rel !== '' &&
    rel !== '..' &&
    !rel.startsWith(`..${sep}`) &&
    !isAbsolute(rel)
  );
}

type Refused = { refused: ChatHostImageRefusal };

/** Test seam: runs after admission and before the file is opened. */
export interface HostImageCaptureHooks {
  beforeOpen?: (path: string) => Promise<void> | void;
}

/**
 * Read an admitted file without following a link at open time, and refuse it
 * if the path no longer names the same inode inside the same root after the
 * read. `realPath` is already fully resolved, so a link appearing anywhere in
 * it afterwards either changes the realpath or the inode identity.
 */
async function readAdmittedFile(
  realPath: string,
  root: string,
  hooks: HostImageCaptureHooks | undefined,
): Promise<{ bytes: Buffer } | Refused> {
  let before: Awaited<ReturnType<typeof lstat>>;
  try {
    before = await lstat(realPath);
  } catch {
    return { refused: 'unreadable' };
  }
  if (before.isSymbolicLink()) return { refused: 'unreadable' };
  if (!before.isFile()) return { refused: 'not-a-file' };
  if (before.size > HOST_IMAGE_MAX_BYTES) return { refused: 'too-large' };
  await hooks?.beforeOpen?.(realPath);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // O_NONBLOCK: a FIFO swapped in after the lstat must not hang the read.
    handle = await open(
      realPath,
      fsConstants.O_RDONLY |
        (fsConstants.O_NOFOLLOW ?? 0) |
        (fsConstants.O_NONBLOCK ?? 0),
    );
  } catch {
    return { refused: 'unreadable' };
  }
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    )
      return { refused: 'unreadable' };
    // A second hard link can make an inode inside a root carry a file that
    // also lives elsewhere; such a file is not read at all.
    if (opened.nlink > 1) return { refused: 'hard-linked' };
    if (opened.size > HOST_IMAGE_MAX_BYTES) return { refused: 'too-large' };
    // One byte past the bound detects a file that grew since the stat.
    const buffer = Buffer.alloc(
      Math.min(opened.size, HOST_IMAGE_MAX_BYTES) + 1,
    );
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > HOST_IMAGE_MAX_BYTES) return { refused: 'too-large' };
    let after: Awaited<ReturnType<typeof lstat>>;
    let resolvedAfter: string;
    try {
      after = await lstat(realPath);
      resolvedAfter = await realpath(realPath);
    } catch {
      return { refused: 'unreadable' };
    }
    if (
      after.isSymbolicLink() ||
      after.dev !== opened.dev ||
      after.ino !== opened.ino ||
      resolvedAfter !== realPath ||
      !isWithin(root, resolvedAfter)
    )
      return { refused: 'unreadable' };
    return { bytes: buffer.subarray(0, length) };
  } finally {
    await handle.close();
  }
}

function rasterDimensions(
  bytes: Buffer,
  mimeType: ChatImageMimeType,
): { width: number; height: number } | undefined {
  if (mimeType === 'image/png') {
    return bytes.length >= 24 && bytes.toString('ascii', 12, 16) === 'IHDR'
      ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
      : undefined;
  }
  if (mimeType === 'image/gif') {
    return bytes.length >= 10
      ? { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) }
      : undefined;
  }
  if (mimeType === 'image/webp') {
    if (bytes.length < 30 || bytes.readUInt32LE(4) + 8 > bytes.length)
      return undefined;
    const chunk = bytes.toString('ascii', 12, 16);
    if (
      chunk === 'VP8 ' &&
      bytes[23] === 0x9d &&
      bytes[24] === 0x01 &&
      bytes[25] === 0x2a
    )
      return {
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
    if (chunk === 'VP8L' && bytes[20] === 0x2f) {
      const bits = bytes.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >>> 14) & 0x3fff) + 1,
      };
    }
    if (chunk === 'VP8X')
      return {
        width: bytes.readUIntLE(24, 3) + 1,
        height: bytes.readUIntLE(27, 3) + 1,
      };
    return undefined;
  }
  // JPEG: the first start-of-frame segment before the scan.
  for (let offset = 2; offset + 9 < bytes.length; ) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1];
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const size = bytes.readUInt16BE(offset + 2);
    if (size < 2 || offset + 2 + size > bytes.length) return undefined;
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    )
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    offset += 2 + size;
  }
  return undefined;
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_CRITICAL_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);
const PNG_MAX_CHUNKS = 1024;

/**
 * A whole, well-formed PNG: `IHDR` first with valid header fields, every
 * chunk inside the file with a correct CRC, image data present, and `IEND`
 * exactly at the end. Unlike the workspace preview's `isBoundedSafePng`, an
 * ancillary chunk is allowed: the images agents save carry them (macOS
 * `sips` writes `eXIf`, matplotlib `tEXt`, ImageMagick `tIME`), and a
 * stored copy is only ever decoded by an `<img>`, never parsed for its
 * metadata. An unknown critical chunk is still refused, as a decoder must.
 * The decode budget is the shared dimension check in the caller.
 */
function isStructurallyValidPng(bytes: Buffer): boolean {
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE))
    return false;
  let offset = 8;
  let sawData = false;
  for (let index = 0; offset + 12 <= bytes.length; index += 1) {
    if (index >= PNG_MAX_CHUNKS) return false;
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) return false;
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    if (
      crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)
    )
      return false;
    if ((index === 0) !== (type === 'IHDR')) return false;
    if (type === 'IHDR') {
      const bitDepth = bytes[offset + 16];
      const colorType = bytes[offset + 17];
      const depths: Record<number, readonly number[]> = {
        0: [1, 2, 4, 8, 16],
        2: [8, 16],
        3: [1, 2, 4, 8],
        4: [8, 16],
        6: [8, 16],
      };
      if (
        length !== 13 ||
        !(depths[colorType]?.includes(bitDepth) ?? false) ||
        bytes[offset + 18] !== 0 ||
        bytes[offset + 19] !== 0 ||
        bytes[offset + 20] > 1
      )
        return false;
    }
    const critical = type[0] === type[0].toUpperCase();
    if (critical && !PNG_CRITICAL_CHUNKS.has(type)) return false;
    if (type === 'IDAT') sawData = true;
    if (type === 'IEND') return sawData && length === 0 && end === bytes.length;
    offset = end;
  }
  return false;
}

/**
 * The image type the BYTES are, within the preview's decode bounds, or why
 * not. The name a reply gave the file decides nothing: `.png` text is refused
 * and SVG/HTML are never one of the sniffed types.
 */
export function validateHostImageBytes(
  bytes: Buffer,
): { mimeType: ChatImageMimeType } | Refused {
  const mimeType = sniffChatImageMimeType(bytes.subarray(0, 16));
  if (!mimeType) return { refused: 'unsupported-image' };
  const size = rasterDimensions(bytes, mimeType);
  if (!size || size.width < 1 || size.height < 1)
    return { refused: 'unsupported-image' };
  // Every type is held to the bound the browser's 4-byte-per-pixel raster
  // needs, the same final-raster budget a workspace PNG preview uses.
  if (
    size.width > WORKSPACE_FILE_PREVIEW_MAX_IMAGE_DIMENSION ||
    size.height > WORKSPACE_FILE_PREVIEW_MAX_IMAGE_DIMENSION ||
    size.width * size.height * 4 >
      WORKSPACE_FILE_PREVIEW_MAX_IMAGE_FINAL_RASTER_BYTES
  )
    return { refused: 'too-many-pixels' };
  if (mimeType === 'image/png' && !isStructurallyValidPng(bytes))
    return { refused: 'unsupported-image' };
  return { mimeType };
}

function attachmentName(path: string): string {
  const name = (path.split(/[\\/]/).pop() ?? '')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips them
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 160)
    .trim();
  return name && name !== '.' && name !== '..' ? name : 'image';
}

export interface HostImageCapture {
  attachments: ChatAttachmentInput[];
  sources: ChatHostImageSource[];
}

/**
 * Admit, read and validate the images `paths` name.
 *
 * A path is admitted only when, after resolving every symlink, it is inside
 * one of `roots` (each itself resolved). Containment is decided on resolved
 * paths only: a lexical comparison refused `/tmp/x.png` for a root recorded as
 * `/private/tmp` (macOS) while admitting nothing a resolved check would not.
 * A path that does not resolve is decided by its resolved parent, so a reply
 * cannot learn whether a file outside the roots exists: missing and present
 * outside files are both `outside-allowed-roots`.
 */
export async function captureHostImages(input: {
  paths: readonly string[];
  roots: readonly string[];
  hooks?: HostImageCaptureHooks;
}): Promise<HostImageCapture> {
  const realRoots: string[] = [];
  for (const root of input.roots) {
    if (!root || !isAbsolute(root)) continue;
    try {
      const resolved = await realpath(root);
      if (!realRoots.includes(resolved)) realRoots.push(resolved);
    } catch {
      // A missing root admits nothing.
    }
  }
  const attachments: ChatAttachmentInput[] = [];
  const sources: ChatHostImageSource[] = [];
  for (const path of input.paths) {
    const outcome = await captureOne(
      path,
      realRoots,
      attachments.length >= HOST_IMAGE_MAX_PER_TURN,
      input.hooks,
    );
    if ('refused' in outcome) {
      sources.push({ path, refused: outcome.refused });
      continue;
    }
    sources.push({ path, attachmentIndex: attachments.length });
    attachments.push({
      kind: 'image',
      name: attachmentName(path),
      mimeType: outcome.mimeType,
      size: outcome.bytes.length,
      dataUrl: `data:${outcome.mimeType};base64,${outcome.bytes.toString('base64')}`,
    });
  }
  return { attachments, sources };
}

async function captureOne(
  path: string,
  realRoots: readonly string[],
  full: boolean,
  hooks: HostImageCaptureHooks | undefined,
): Promise<{ bytes: Buffer; mimeType: ChatImageMimeType } | Refused> {
  if (
    path.length > CHAT_HOST_IMAGE_MAX_PATH_LENGTH ||
    path.includes('\0') ||
    !isAbsolute(path) ||
    path.split(/[\\/]/).includes('..')
  )
    return { refused: 'invalid-path' };
  const inRoot = (resolved: string) =>
    realRoots.find((candidate) => isWithin(candidate, resolved));
  let real: string;
  try {
    real = await realpath(path);
  } catch (error) {
    // Something is at the path but does not resolve: a dangling or
    // unreadable link. Its target may be outside, and saying "missing" for it
    // would tell a reply whether that target exists, so it is outside.
    try {
      await lstat(path);
      return { refused: 'outside-allowed-roots' };
    } catch {
      // Nothing at the path itself: judged by its resolved parent below.
    }
    // Only a path whose resolved parent is inside a root may say "missing".
    let parent: string | undefined;
    try {
      parent = await realpath(dirname(path));
    } catch {
      parent = undefined;
    }
    if (!parent || !(inRoot(parent) || realRoots.includes(parent)))
      return { refused: 'outside-allowed-roots' };
    const code = (error as NodeJS.ErrnoException).code;
    return {
      refused:
        code === 'ENOENT' || code === 'ENOTDIR' ? 'not-found' : 'unreadable',
    };
  }
  // A symlink inside a root that resolves elsewhere is refused here.
  const root = inRoot(real);
  if (!root) return { refused: 'outside-allowed-roots' };
  if (await inSharedFolder(real, root)) return { refused: 'shared-folder' };
  if (full) return { refused: 'limit-reached' };
  const read = await readAdmittedFile(real, root, hooks);
  if ('refused' in read) return read;
  const valid = validateHostImageBytes(read.bytes);
  if ('refused' in valid) return valid;
  return { bytes: read.bytes, mimeType: valid.mimeType };
}

async function resolvedOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/**
 * The directories one session's images may come from: its working directory
 * and that checkout's verified worktrees, plus its own temp directory.
 *
 * A working directory that is or contains the home folder or Station's data
 * (a session with no project defaults to the home folder), the filesystem
 * root, or a hidden folder under home is not a root: admitting it would make
 * every picture in `~` readable to a reply. The same rule decides whether a
 * workspace can be a confined write grant (`seatbeltWorkspaceRefusal`).
 *
 * A shared temporary directory is refused the same way: a working folder
 * that is, or contains, the system temp directory (`os.tmpdir()`, `/tmp`,
 * `/var/tmp`, `/dev/shm`), or any world-writable directory, would admit
 * files every user and process on the host can write there. A Project
 * folder inside `/tmp` is still a root; `/tmp` itself is not.
 */
const SHARED_TEMP_DIRS = ['/tmp', '/var/tmp', '/dev/shm'];

/** The host's shared temp directories, resolved (the default refusal list). */
export async function defaultSharedTempDirs(): Promise<string[]> {
  return Promise.all([tmpdir(), ...SHARED_TEMP_DIRS].map(resolvedOrSelf));
}

/** Whether `directory` is, or contains, one of the shared temp directories. */
export function containsSharedTemp(
  directory: string,
  sharedTemp: readonly string[],
): boolean {
  return sharedTemp.some((shared) => {
    const rel = relative(directory, shared);
    return !rel.startsWith('..') && !isAbsolute(rel);
  });
}

async function sharedTempRefusal(
  directory: string,
  sharedTemp: readonly string[],
): Promise<boolean> {
  if (containsSharedTemp(directory, sharedTemp)) return true;
  try {
    if (((await lstat(directory)).mode & 0o002) !== 0) return true;
  } catch {
    return true;
  }
  return false;
}

/**
 * A directory someone else could rename or replace an entry of: owned by
 * neither this user nor root, or writable by others (or by a group that is
 * not this user's primary group) without the sticky bit.
 */
function othersCanReplaceEntries(stats: {
  uid: number;
  gid: number;
  mode: number;
}): boolean {
  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid && stats.uid !== 0) return true;
  if ((stats.mode & 0o1000) !== 0) return false;
  if ((stats.mode & 0o002) !== 0) return true;
  return (stats.mode & 0o020) !== 0 && stats.gid !== process.getgid?.();
}

/**
 * Whether anyone else could swap the working folder for a link to somewhere
 * else, judged on the path AS GIVEN, component by component: a check on its
 * resolved form sees only the link's target, after the swap. Every directory
 * the path traverses must be one others cannot replace entries of; a link
 * met on the way is followed and its target's chain is checked the same way.
 * A path with `..` or one that cannot be walked is refused.
 */
export async function workingFolderSwappable(path: string): Promise<boolean> {
  if (process.platform === 'win32') return false;
  if (!isAbsolute(path) || path.split(/[\\/]/).includes('..')) return true;
  let pending = path.split(sep).filter(Boolean);
  let current: string = sep;
  for (let hops = 0; hops < 64; hops += 1) {
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(current);
    } catch {
      return true;
    }
    if (stats.isSymbolicLink()) {
      // Its own directory was checked already; walk its target from the top.
      let target: string;
      try {
        target = await realpath(current);
      } catch {
        return true;
      }
      pending = [...target.split(sep).filter(Boolean), ...pending];
      current = sep;
      continue;
    }
    if (!stats.isDirectory() || othersCanReplaceEntries(stats)) return true;
    const next = pending.shift();
    if (next === undefined) return false;
    current = current === sep ? `${sep}${next}` : `${current}${sep}${next}`;
  }
  return true;
}

/**
 * Whether a folder every user can write to lies between the file and its
 * root (inclusive): anyone on the host could have put the file there.
 */
async function inSharedFolder(real: string, root: string): Promise<boolean> {
  if (process.platform === 'win32') return false;
  for (let folder = dirname(real); ; folder = dirname(folder)) {
    try {
      if (((await lstat(folder)).mode & 0o002) !== 0) return true;
    } catch {
      return true;
    }
    if (folder === root || dirname(folder) === folder) return false;
  }
}

export async function hostImageCaptureRoots(input: {
  cwd?: string;
  sessionTmpDir?: string;
  home?: string;
  stationHome?: string;
  listWorktrees?: (root: string) => Promise<readonly string[]>;
  /** Test seam; defaults to the host's shared temp directories. */
  sharedTempDirs?: readonly string[];
}): Promise<string[]> {
  const roots: string[] = [];
  const sharedTemp = input.sharedTempDirs
    ? await Promise.all(input.sharedTempDirs.map(resolvedOrSelf))
    : await defaultSharedTempDirs();
  const bounds = {
    home: await resolvedOrSelf(input.home ?? homedir()),
    stationHome: await resolvedOrSelf(input.stationHome ?? resolveHomeDir()),
  };
  const admissible = async (directory: string) =>
    isAbsolute(directory) &&
    !seatbeltWorkspaceRefusal(directory, bounds) &&
    !(await sharedTempRefusal(directory, sharedTemp));
  if (
    input.cwd &&
    isAbsolute(input.cwd) &&
    !(await workingFolderSwappable(input.cwd))
  ) {
    const cwd = await resolvedOrSelf(input.cwd);
    if (await admissible(cwd)) {
      roots.push(cwd);
      const worktrees = await (
        input.listWorktrees ?? ((root) => listVerifiedWorktrees(root, 5000))
      )(cwd).catch(() => [] as readonly string[]);
      for (const worktree of worktrees)
        if (
          (await admissible(worktree)) &&
          !(await workingFolderSwappable(worktree)) &&
          !roots.includes(worktree)
        )
          roots.push(worktree);
    }
  }
  if (input.sessionTmpDir) roots.push(input.sessionTmpDir);
  return roots;
}
