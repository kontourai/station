import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { crc32 } from 'node:zlib';
import {
  WORKSPACE_FILE_PREVIEW_MAX_BYTES,
  WORKSPACE_FILE_PREVIEW_MAX_IMAGE_DECODED_BYTES,
  WORKSPACE_FILE_PREVIEW_MAX_IMAGE_DIMENSION,
  WORKSPACE_FILE_PREVIEW_MAX_IMAGE_FINAL_RASTER_BYTES,
  WORKSPACE_FILE_PREVIEW_MAX_IMAGE_PIXELS,
  type WorkspaceFilePreview,
  type WorkspaceFilePreviewLineRange,
  type WorkspaceFilePreviewRenderKind,
  type WorkspaceFilePreviewRequest,
} from '@kontourai/station-contracts/workspace-file-preview';
import { fileTreeOps } from '../../telemetry/metrics.js';

interface FileClassification {
  renderKind: WorkspaceFilePreviewRenderKind;
  mimeType: string;
}

/** Narrow filesystem port so descriptor/path race behavior is testable. */
export interface WorkspaceFilePreviewFsPort {
  realpath(path: string): string;
  lstat(path: string): Stats;
  open(path: string, flags: number): number;
  fstat(descriptor: number): Stats;
  read(
    descriptor: number,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): number;
  close(descriptor: number): void;
}

/**
 * A policy-valid handoff is deliberately a bounded attachment payload, never
 * a filesystem path or a URL a renderer can navigate to. HTML/PDF stay out of
 * Station's trusted origin and out of `file://` entirely.
 */
export interface WorkspaceFilePreviewDownload {
  path: string;
  filename: string;
  bytes: Uint8Array;
}

const DEFAULT_FILE_PREVIEW_FS: WorkspaceFilePreviewFsPort = {
  realpath: realpathSync,
  lstat: lstatSync,
  open: openSync,
  fstat: fstatSync,
  read: readSync,
  close: closeSync,
};

const SOURCE_EXTENSIONS = new Set([
  'c',
  'cc',
  'cpp',
  'cs',
  'css',
  'go',
  'java',
  'js',
  'jsx',
  'json',
  'kt',
  'mjs',
  'php',
  'py',
  'rb',
  'rs',
  'sh',
  'sql',
  'swift',
  'ts',
  'tsx',
  'vue',
]);
const TEXT_EXTENSIONS = new Set([
  'cfg',
  'conf',
  'csv',
  'env',
  'ini',
  'log',
  'text',
  'toml',
  'txt',
  'xml',
  'yaml',
  'yml',
]);
const IMAGE_MIME_TYPES: Record<string, string> = {
  gif: 'image/gif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  svg: 'image/svg+xml',
  webp: 'image/webp',
};
const DOTFILE_EXTENSIONS: Record<string, string> = {
  '.env': 'env',
  '.gitignore': 'txt',
};

function extensionFor(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (DOTFILE_EXTENSIONS[name]) return DOTFILE_EXTENSIONS[name];
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function classify(path: string): FileClassification {
  const extension = extensionFor(path);
  if (SOURCE_EXTENSIONS.has(extension)) {
    return { renderKind: 'source', mimeType: 'text/plain' };
  }
  if (TEXT_EXTENSIONS.has(extension)) {
    return { renderKind: 'text', mimeType: 'text/plain' };
  }
  if (extension === 'md' || extension === 'mdx') {
    return { renderKind: 'markdown', mimeType: 'text/markdown' };
  }
  if (extension === 'html' || extension === 'htm') {
    return { renderKind: 'html', mimeType: 'text/html' };
  }
  if (extension === 'pdf') {
    return { renderKind: 'pdf', mimeType: 'application/pdf' };
  }
  if (IMAGE_MIME_TYPES[extension]) {
    return { renderKind: 'image', mimeType: IMAGE_MIME_TYPES[extension] };
  }
  return { renderKind: 'unknown', mimeType: 'application/octet-stream' };
}

function normalizedRelativePath(input: string): string {
  const trimmed = input.trim();
  if (
    !trimmed ||
    isAbsolute(trimmed) ||
    /^[A-Za-z]:/.test(trimmed) ||
    trimmed.startsWith('\\\\') ||
    trimmed.split(/[\\/]+/).some((part) => part === '..')
  ) {
    throw new Error(
      'Preview path must be a workspace-relative non-traversal path',
    );
  }
  const normalized = trimmed
    .split(/[\\/]+/)
    .filter((part) => part && part !== '.')
    .join(sep);
  if (!normalized || normalized === '.') {
    throw new Error('Preview path must name a file');
  }
  return normalized;
}

function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target);
  return (
    rel !== '' &&
    !rel.startsWith(`..${sep}`) &&
    rel !== '..' &&
    !isAbsolute(rel)
  );
}

function selectedContent(
  content: string,
  lineRange: WorkspaceFilePreviewLineRange | undefined,
): string {
  if (!lineRange) return content;
  return content
    .split('\n')
    .slice(lineRange.start - 1, lineRange.end)
    .join('\n');
}

function containsBinaryControlBytes(bytes: Uint8Array): boolean {
  return bytes.some(
    (byte) => byte === 0 || byte < 0x08 || (byte > 0x0d && byte < 0x20),
  );
}

type PreviewTargetResolution =
  | { status: 'missing' | 'unreadable' }
  | { target: string; expectedIdentity: Stats };

function resolvePreviewTarget(
  fs: WorkspaceFilePreviewFsPort,
  workingDirectory: string,
  path: string,
): PreviewTargetResolution {
  let root: string;
  try {
    root = fs.realpath(workingDirectory);
  } catch {
    return { status: 'unreadable' };
  }
  const candidate = resolve(root, path);
  if (!isWithin(root, candidate)) {
    throw new Error('Preview path escapes workspace');
  }
  let expectedIdentity: Stats;
  try {
    expectedIdentity = fs.lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing' };
    }
    throw error;
  }
  if (expectedIdentity.isSymbolicLink()) {
    throw new Error('Preview symlinks are not allowed');
  }
  const target = fs.realpath(candidate);
  if (!isWithin(root, target)) {
    throw new Error('Preview path escapes workspace');
  }
  return { target, expectedIdentity };
}

function readDescriptorWindow(
  fs: WorkspaceFilePreviewFsPort,
  descriptor: number,
  size: number,
): Buffer {
  const bytes = Buffer.alloc(size);
  let bytesRead = 0;
  while (bytesRead < bytes.length) {
    const count = fs.read(
      descriptor,
      bytes,
      bytesRead,
      bytes.length - bytesRead,
      bytesRead,
    );
    if (count === 0) break;
    bytesRead += count;
  }
  return bytes.subarray(0, bytesRead);
}

function decodePreviewBytes(
  bytes: Buffer,
): Pick<
  WorkspaceFilePreview,
  'status' | 'sizeBytes' | 'lineCount' | 'content'
> {
  if (containsBinaryControlBytes(bytes)) {
    return { status: 'binary', sizeBytes: bytes.length };
  }
  try {
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return {
      status: 'ready',
      sizeBytes: bytes.length,
      lineCount:
        content.length === 0
          ? 0
          : 1 + [...content].filter((character) => character === '\n').length,
      content,
    };
  } catch {
    return { status: 'binary', sizeBytes: bytes.length };
  }
}

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const PNG_CRITICAL_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND']);
const PNG_ANIMATION_CHUNKS = new Set(['acTL', 'fcTL', 'fdAT']);
const PNG_ALLOWED_ANCILLARY_MAX_BYTES: Readonly<Record<string, number>> = {
  cHRM: 32,
  gAMA: 4,
  sBIT: 4,
  sRGB: 1,
  bKGD: 6,
  pHYs: 9,
  tRNS: 256,
};
const PNG_MAX_CHUNKS = 64;

function hasValidPngHeaderFields(bytes: Buffer): boolean {
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const validBitDepths: Record<number, readonly number[]> = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  return (
    bitDepth !== undefined &&
    colorType !== undefined &&
    (validBitDepths[colorType]?.includes(bitDepth) ?? false) &&
    bytes[26] === 0 &&
    bytes[27] === 0 &&
    (bytes[28] === 0 || bytes[28] === 1)
  );
}

/**
 * Bounds the uncompressed scanline allocation before handing a PNG to a
 * browser. A tiny IDAT stream can otherwise expand to hundreds of MiB,
 * especially with 16-bit RGBA samples. One filter byte per row accounts for
 * the PNG scanline overhead in addition to pixel samples.
 */
function isWithinPngDecodedByteBudget(bytes: Buffer): boolean {
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  const channels: Record<number, number> = {
    0: 1,
    2: 3,
    3: 1,
    4: 2,
    6: 4,
  };
  const channelCount = channels[colorType] ?? 0;
  // Sub-byte PNG samples are conservatively budgeted as a full byte. This
  // avoids a special packed-bit path while only rejecting a few small images.
  const bytesPerSample = bitDepth === 16 ? 2 : 1;
  const decodedBytes = width * height * channelCount * bytesPerSample + height;
  return (
    Number.isSafeInteger(decodedBytes) &&
    decodedBytes <= WORKSPACE_FILE_PREVIEW_MAX_IMAGE_DECODED_BYTES
  );
}

/**
 * Browsers commonly expand decoded PNGs into four bytes per pixel even when
 * the source is grayscale, indexed, or lower bit-depth. The source-sample
 * budget above therefore cannot bound the final mounted raster on its own.
 */
function isWithinPngFinalRasterBudget(bytes: Buffer): boolean {
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const finalRasterBytes = width * height * 4;
  return (
    Number.isSafeInteger(finalRasterBytes) &&
    finalRasterBytes <= WORKSPACE_FILE_PREVIEW_MAX_IMAGE_FINAL_RASTER_BYTES
  );
}

function encodeBoundedPng(
  bytes: Buffer,
): Pick<WorkspaceFilePreview, 'status' | 'sizeBytes' | 'dataUrl'> {
  if (
    bytes.length < 45 ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  )
    return { status: 'unsupported', sizeBytes: bytes.length };

  let offset = PNG_SIGNATURE.length;
  let chunkIndex = 0;
  let sawImageData = false;
  let sawEnd = false;
  while (offset + 12 <= bytes.length) {
    if (chunkIndex >= PNG_MAX_CHUNKS)
      return { status: 'unsupported', sizeBytes: bytes.length };
    const length = bytes.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > bytes.length)
      return { status: 'unsupported', sizeBytes: bytes.length };
    const typeStart = offset + 4;
    const typeEnd = typeStart + 4;
    const type = bytes.toString('ascii', typeStart, typeEnd);
    const expectedCrc = bytes.readUInt32BE(chunkEnd - 4);
    if (crc32(bytes.subarray(typeStart, chunkEnd - 4)) !== expectedCrc)
      return { status: 'unsupported', sizeBytes: bytes.length };
    if (chunkIndex === 0 && (type !== 'IHDR' || length !== 13))
      return { status: 'unsupported', sizeBytes: bytes.length };
    if (chunkIndex > 0 && type === 'IHDR')
      return { status: 'unsupported', sizeBytes: bytes.length };
    const critical = type[0] === type[0]?.toUpperCase();
    const allowedAncillaryBytes = PNG_ALLOWED_ANCILLARY_MAX_BYTES[type];
    if (
      PNG_ANIMATION_CHUNKS.has(type) ||
      (critical && !PNG_CRITICAL_CHUNKS.has(type)) ||
      (!critical &&
        (allowedAncillaryBytes === undefined || length > allowedAncillaryBytes))
    )
      return { status: 'unsupported', sizeBytes: bytes.length };
    if (type === 'IDAT') sawImageData = true;
    if (type === 'IEND') {
      sawEnd = length === 0 && chunkEnd === bytes.length;
      break;
    }
    chunkIndex += 1;
    offset = chunkEnd;
  }
  if (!sawImageData || !sawEnd || !hasValidPngHeaderFields(bytes))
    return { status: 'unsupported', sizeBytes: bytes.length };

  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const boundedDimensions =
    width > 0 &&
    height > 0 &&
    width <= WORKSPACE_FILE_PREVIEW_MAX_IMAGE_DIMENSION &&
    height <= WORKSPACE_FILE_PREVIEW_MAX_IMAGE_DIMENSION &&
    height <= Math.floor(WORKSPACE_FILE_PREVIEW_MAX_IMAGE_PIXELS / width);
  if (!boundedDimensions)
    return { status: 'unsupported', sizeBytes: bytes.length };
  if (!isWithinPngDecodedByteBudget(bytes))
    return { status: 'unsupported', sizeBytes: bytes.length };
  if (!isWithinPngFinalRasterBudget(bytes))
    return { status: 'unsupported', sizeBytes: bytes.length };

  return {
    status: 'ready',
    sizeBytes: bytes.length,
    dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
  };
}

/**
 * The exact structural/decode-budget gate used before a workspace PNG becomes
 * an inline preview. Other consumers may use the boolean only; they never
 * inherit a data URL or a caller-declared MIME as authority to render bytes.
 */
export function isBoundedSafePng(bytes: Buffer): boolean {
  return encodeBoundedPng(bytes).status === 'ready';
}

function readPreviewTarget(
  fs: WorkspaceFilePreviewFsPort,
  target: string,
  expectedIdentity: Stats,
  classification: FileClassification,
): Pick<WorkspaceFilePreview, 'status' | 'sizeBytes' | 'content' | 'dataUrl'> {
  if (fsConstants.O_NOFOLLOW === undefined) return { status: 'unreadable' };
  let descriptor: number | undefined;
  try {
    descriptor = fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = fs.fstat(descriptor);
    if (
      stat.dev !== expectedIdentity.dev ||
      stat.ino !== expectedIdentity.ino
    ) {
      throw new Error('Preview path changed during secure open');
    }
    if (!stat.isFile()) return { status: 'unsupported', sizeBytes: stat.size };
    if (stat.size > WORKSPACE_FILE_PREVIEW_MAX_BYTES) {
      return { status: 'oversized', sizeBytes: stat.size };
    }
    if (classification.renderKind === 'image') {
      if (classification.mimeType !== 'image/png')
        return { status: 'unsupported', sizeBytes: stat.size };
      return encodeBoundedPng(readDescriptorWindow(fs, descriptor, stat.size));
    }
    if (!['source', 'text', 'markdown'].includes(classification.renderKind))
      return { status: 'unsupported', sizeBytes: stat.size };
    return decodePreviewBytes(readDescriptorWindow(fs, descriptor, stat.size));
  } finally {
    if (descriptor !== undefined) fs.close(descriptor);
  }
}

function readDownloadTarget(
  fs: WorkspaceFilePreviewFsPort,
  target: string,
  expectedIdentity: Stats,
): Uint8Array | null {
  if (fsConstants.O_NOFOLLOW === undefined) return null;
  let descriptor: number | undefined;
  try {
    descriptor = fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const stat = fs.fstat(descriptor);
    if (
      stat.dev !== expectedIdentity.dev ||
      stat.ino !== expectedIdentity.ino ||
      !stat.isFile() ||
      stat.size > WORKSPACE_FILE_PREVIEW_MAX_BYTES
    )
      return null;
    return readDescriptorWindow(fs, descriptor, stat.size);
  } finally {
    if (descriptor !== undefined) fs.close(descriptor);
  }
}

/**
 * Resolves and reads a bounded preview from the project-owned working
 * directory. The caller supplies only a relative path; no host root is part
 * of this contract, and all unsafe path input is rejected before filesystem
 * access.
 */
export class WorkspaceFilePreviewService {
  constructor(
    private readonly fs: WorkspaceFilePreviewFsPort = DEFAULT_FILE_PREVIEW_FS,
  ) {}

  preview(
    workingDirectory: string,
    request: WorkspaceFilePreviewRequest,
  ): WorkspaceFilePreview {
    const path = normalizedRelativePath(request.path).split(sep).join('/');
    const classification = classify(path);
    let outcome: WorkspaceFilePreview['status'] = 'unreadable';
    try {
      const resolved = resolvePreviewTarget(this.fs, workingDirectory, path);
      const result =
        'status' in resolved
          ? resolved
          : readPreviewTarget(
              this.fs,
              resolved.target,
              resolved.expectedIdentity,
              classification,
            );
      outcome = result.status;
      return {
        path,
        ...classification,
        ...result,
        ...(result.status === 'ready' &&
        result.content !== undefined &&
        request.lineRange
          ? {
              lineRange: request.lineRange,
              content: selectedContent(result.content ?? '', request.lineRange),
            }
          : {}),
      };
    } catch (error) {
      if (
        error instanceof Error &&
        /workspace|symlink|relative/.test(error.message)
      ) {
        throw error;
      }
      return { path, status: outcome, ...classification };
    } finally {
      fileTreeOps.add(1, { operation: 'workspace_file_preview', outcome });
    }
  }

  /**
   * The sole file-preview HTML/PDF handoff: an authenticated, bounded server
   * attachment. It performs the same project-root, anti-symlink, and
   * descriptor-identity checks as preview(), but returns no local pathname.
   */
  download(
    workingDirectory: string,
    request: Pick<WorkspaceFilePreviewRequest, 'path'>,
  ): WorkspaceFilePreviewDownload | null {
    try {
      const path = normalizedRelativePath(request.path).split(sep).join('/');
      const classification = classify(path);
      if (!['html', 'pdf'].includes(classification.renderKind)) return null;
      const resolved = resolvePreviewTarget(this.fs, workingDirectory, path);
      if ('status' in resolved) return null;
      const bytes = readDownloadTarget(
        this.fs,
        resolved.target,
        resolved.expectedIdentity,
      );
      if (!bytes) return null;
      return {
        path,
        filename: path.split('/').at(-1) ?? 'workspace-file',
        bytes,
      };
    } catch {
      return null;
    }
  }
}
