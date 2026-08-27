import {
  appendFileSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { WORKSPACE_FILE_PREVIEW_MAX_BYTES } from '@kontourai/station-contracts/workspace-file-preview';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { WorkspaceFilePreviewFsPort } from '../workspace-file-preview-service.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  fileTreeOps: { add: vi.fn() },
}));

const { WorkspaceFilePreviewService } = await import(
  '../workspace-file-preview-service.js'
);

function realFsPort(): WorkspaceFilePreviewFsPort {
  return {
    realpath: realpathSync,
    lstat: lstatSync,
    open: openSync,
    fstat: fstatSync,
    read: readSync,
    close: closeSync,
  };
}

function pngChunk(type: string, data = Buffer.alloc(0)): Buffer {
  const typeBytes = Buffer.from(type, 'ascii');
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function structuralPng(
  width: number,
  height: number,
  extraChunks: readonly Buffer[] = [],
  bitDepth = 8,
  colorType = 6,
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([bitDepth, colorType, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    ...extraChunks,
    pngChunk('IDAT'),
    pngChunk('IEND'),
  ]);
}

describe('WorkspaceFilePreviewService', () => {
  let workspace: string;
  let service: InstanceType<typeof WorkspaceFilePreviewService>;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'station-file-preview-'));
    service = new WorkspaceFilePreviewService();
  });

  afterEach(() => rmSync(workspace, { recursive: true, force: true }));

  test('returns bounded UTF-8 source content from a normalized relative path', () => {
    writeFileSync(join(workspace, 'app.ts'), 'one\ntwo\nthree\n');

    expect(
      service.preview(workspace, {
        path: './app.ts',
        lineRange: { start: 2, end: 3 },
      }),
    ).toEqual({
      path: 'app.ts',
      status: 'ready',
      lineCount: 4,
      renderKind: 'source',
      mimeType: 'text/plain',
      sizeBytes: 14,
      lineRange: { start: 2, end: 3 },
      content: 'two\nthree',
    });
  });

  test('recognizes known text dotfiles as text previews', () => {
    writeFileSync(join(workspace, '.env'), 'SAFE=true\n');

    expect(service.preview(workspace, { path: '.env' })).toMatchObject({
      status: 'ready',
      renderKind: 'text',
      content: 'SAFE=true\n',
    });
  });

  test('returns Markdown as bounded inert source for renderer selection', () => {
    writeFileSync(
      join(workspace, 'README.md'),
      '# Title\n<script>x</script>\n',
    );

    expect(service.preview(workspace, { path: 'README.md' })).toMatchObject({
      status: 'ready',
      renderKind: 'markdown',
      mimeType: 'text/markdown',
      content: '# Title\n<script>x</script>\n',
    });
  });

  test('returns only a bounded, dimension-checked PNG data URL', () => {
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );
    writeFileSync(join(workspace, 'image.png'), bytes);

    expect(service.preview(workspace, { path: 'image.png' })).toEqual({
      path: 'image.png',
      status: 'ready',
      renderKind: 'image',
      mimeType: 'image/png',
      sizeBytes: bytes.length,
      dataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
    });
  });

  test.each([
    ['spoofed PNG content', 'spoof.png', Buffer.from('<svg></svg>')],
    ['excessive PNG dimensions', 'huge.png', structuralPng(8_192, 8_192)],
    [
      '16-bit RGBA image exceeding the decoded byte budget',
      'large-16-bit.png',
      structuralPng(4_096, 512, [], 16, 6),
    ],
    [
      'low-bit-depth image exceeding the browser final-raster budget',
      'large-1-bit.png',
      structuralPng(4_096, 4_095, [], 1, 0),
    ],
    [
      'malformed 16-bit indexed-color header',
      'malformed-16-bit.png',
      structuralPng(16, 16, [], 16, 3),
    ],
    ['active SVG content', 'active.svg', Buffer.from('<svg></svg>')],
    [
      'animated PNG content',
      'animated.png',
      structuralPng(16, 16, [pngChunk('acTL', Buffer.alloc(8))]),
    ],
    [
      'compressed PNG metadata',
      'metadata.png',
      structuralPng(16, 16, [pngChunk('zTXt', Buffer.from('profile\0\0x'))]),
    ],
    [
      'excessive PNG chunk count',
      'chunks.png',
      structuralPng(
        16,
        16,
        Array.from({ length: 64 }, () => pngChunk('gAMA', Buffer.alloc(4))),
      ),
    ],
  ])('fails closed for %s', (_, path, bytes) => {
    writeFileSync(join(workspace, path), bytes);
    expect(service.preview(workspace, { path })).toMatchObject({
      status: 'unsupported',
      renderKind: 'image',
    });
  });

  test('does not apply source line ranges to image payloads', () => {
    writeFileSync(join(workspace, 'image.png'), structuralPng(16, 16));
    const preview = service.preview(workspace, {
      path: 'image.png',
      lineRange: { start: 1, end: 2 },
    });

    expect(preview.status).toBe('ready');
    expect(preview).not.toHaveProperty('lineRange');
    expect(preview).not.toHaveProperty('content');
  });

  test.each([
    ['missing', 'missing.ts', { status: 'missing' }],
    [
      'unsupported HTML',
      'page.html',
      { status: 'unsupported', renderKind: 'html' },
    ],
    ['oversized', 'large.txt', { status: 'oversized' }],
    ['binary UTF-8', 'raw.txt', { status: 'binary' }],
  ])('returns a truthful %s state', (_, path, expected) => {
    if (path === 'page.html')
      writeFileSync(join(workspace, path), '<b>no execution</b>');
    if (path === 'large.txt')
      writeFileSync(
        join(workspace, path),
        Buffer.alloc(WORKSPACE_FILE_PREVIEW_MAX_BYTES + 1),
      );
    if (path === 'raw.txt')
      writeFileSync(join(workspace, path), Buffer.from([0xff]));

    expect(service.preview(workspace, { path })).toMatchObject(expected);
  });

  test('returns only a bounded HTML/PDF attachment handoff without a host path', () => {
    writeFileSync(join(workspace, 'guide.html'), '<h1>Download only</h1>');
    writeFileSync(join(workspace, 'guide.pdf'), '%PDF-1.7 download only');

    expect(service.download(workspace, { path: 'guide.html' })).toEqual({
      path: 'guide.html',
      filename: 'guide.html',
      bytes: Buffer.from('<h1>Download only</h1>'),
    });
    expect(service.download(workspace, { path: 'guide.pdf' })).toEqual({
      path: 'guide.pdf',
      filename: 'guide.pdf',
      bytes: Buffer.from('%PDF-1.7 download only'),
    });
    expect(service.download(workspace, { path: '../secret.html' })).toBeNull();
    expect(service.download(workspace, { path: 'guide.txt' })).toBeNull();
  });

  test.each([
    ['NUL', Buffer.from([0x61, 0x00, 0x62])],
    ['C0 control', Buffer.from([0x61, 0x1b, 0x62])],
  ])('classifies valid UTF-8 containing %s bytes as binary', (_, content) => {
    writeFileSync(join(workspace, 'control.txt'), content);

    expect(service.preview(workspace, { path: 'control.txt' })).toMatchObject({
      status: 'binary',
      renderKind: 'text',
      sizeBytes: 3,
    });
  });

  test('returns unreadable when the authoritative workspace cannot be opened', () => {
    expect(
      service.preview(join(workspace, 'gone'), { path: 'app.ts' }),
    ).toMatchObject({
      path: 'app.ts',
      status: 'unreadable',
    });
  });

  test.each([
    '/etc/passwd',
    '../secret.txt',
    'nested/../../secret.txt',
    'C:\\workspace\\secret.txt',
    '\\\\host\\share\\secret.txt',
  ])('rejects untrusted path %s before reading it', (path) => {
    expect(() => service.preview(workspace, { path })).toThrow(
      'workspace-relative',
    );
  });

  test('rejects final and intermediate symlinks rather than exposing another path', () => {
    const outside = mkdtempSync(
      join(tmpdir(), 'station-file-preview-outside-'),
    );
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    symlinkSync(join(outside, 'secret.txt'), join(workspace, 'link.txt'));
    symlinkSync(outside, join(workspace, 'linked-directory'));

    expect(() => service.preview(workspace, { path: 'link.txt' })).toThrow(
      'symlinks',
    );
    expect(() =>
      service.preview(workspace, { path: 'linked-directory/secret.txt' }),
    ).toThrow('workspace');
    rmSync(outside, { recursive: true, force: true });
  });

  test('refuses an opened inode that differs after an ancestor-path swap', () => {
    const outside = mkdtempSync(
      join(tmpdir(), 'station-file-preview-race-outside-'),
    );
    const insidePath = join(workspace, 'safe.txt');
    const outsidePath = join(outside, 'secret.txt');
    writeFileSync(insidePath, 'safe');
    writeFileSync(outsidePath, 'secret');
    const realFs = realFsPort();
    const racedService = new WorkspaceFilePreviewService({
      ...realFs,
      // Simulates an ancestor redirect after lstat/realpath but before open.
      open: (_path, flags) => openSync(outsidePath, flags),
    });

    expect(racedService.preview(workspace, { path: 'safe.txt' })).toMatchObject(
      { status: 'unreadable' },
    );
    rmSync(outside, { recursive: true, force: true });
  });

  test('keeps the read bounded when the opened file grows after fstat', () => {
    const file = join(workspace, 'growing.txt');
    writeFileSync(file, 'one');
    const realFs = realFsPort();
    let appended = false;
    let largestRequestedRead = 0;
    const growingService = new WorkspaceFilePreviewService({
      ...realFs,
      read: (descriptor, buffer, offset, length, position) => {
        largestRequestedRead = Math.max(largestRequestedRead, length);
        if (!appended) {
          appendFileSync(file, Buffer.alloc(WORKSPACE_FILE_PREVIEW_MAX_BYTES));
          appended = true;
        }
        return readSync(descriptor, buffer, offset, length, position);
      },
    });

    expect(growingService.preview(workspace, { path: 'growing.txt' })).toEqual({
      path: 'growing.txt',
      status: 'ready',
      lineCount: 1,
      renderKind: 'text',
      mimeType: 'text/plain',
      sizeBytes: 3,
      content: 'one',
    });
    expect(largestRequestedRead).toBe(3);
  });
});
