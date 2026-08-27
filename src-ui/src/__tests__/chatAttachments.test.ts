// @vitest-environment jsdom

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { readChatAttachmentFiles } from '../utils/chatAttachments';
import type { DownscaleOutcome } from '../utils/downscaleImage';

/**
 * jsdom has no canvas, so the real ladder (covered in downscaleImage.test.ts
 * against its own encoder seam) cannot run here. What this file has to answer
 * is when the composer reaches for it at all, and what it records about the
 * bytes it got back.
 */
let downscaleOutcome: DownscaleOutcome = { status: 'too-large' };
let downscaleThrows = false;
const downscaleImageToFit = vi.fn(async (): Promise<DownscaleOutcome> => {
  if (downscaleThrows) throw new Error('canvas is unavailable');
  return downscaleOutcome;
});
const canResizeFormat = vi.fn((mimeType: string) => mimeType !== 'image/gif');
const prepareHeifAttachment = vi.fn();
vi.mock('../utils/downscaleImage', () => ({
  downscaleImageToFit: (...args: unknown[]) =>
    (downscaleImageToFit as (...a: unknown[]) => unknown)(...args),
  canResizeFormat: (mimeType: string) => canResizeFormat(mimeType),
  formatNotResizableReason: () =>
    'An animated image cannot be resized without flattening it to a single frame. Convert it to PNG or JPEG, or attach a smaller file.',
}));
vi.mock('../utils/heif-attachment', () => ({
  prepareHeifAttachment: (...args: unknown[]) =>
    (prepareHeifAttachment as (...a: unknown[]) => unknown)(...args),
}));

/** A base64 data URL whose decoded length is exactly `bytes`. */
function dataUrlOf(bytes: number, mimeType: string): string {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(bytes)));
  return `data:${mimeType};base64,${base64}`;
}

function oversizedPng(name = 'screenshot.png') {
  return new File([new Uint8Array(5 * 1024 * 1024 + 1)], name, {
    type: 'image/png',
  });
}

function bmffBytes(): Uint8Array {
  return new Uint8Array([
    0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
  ]);
}

function blobBytes(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}

describe('readChatAttachmentFiles', () => {
  beforeEach(() => {
    downscaleOutcome = { status: 'too-large' };
    downscaleThrows = false;
    downscaleImageToFit.mockClear();
    canResizeFormat.mockClear();
    prepareHeifAttachment.mockReset();
  });

  test('reads supported mobile-picker images and removes path-shaped names', async () => {
    const result = await readChatAttachmentFiles(
      [new File(['abc'], '../camera.png', { type: 'image/png' })],
      [],
      { images: true, files: false },
    );

    expect(result.errors).toEqual([]);
    expect(result.attachments).toEqual([
      expect.objectContaining({
        name: 'camera.png',
        type: 'image/png',
        size: 3,
        data: 'data:image/png;base64,YWJj',
      }),
    ]);
    expect(result.attachments[0].resized).toBeUndefined();
    expect(downscaleImageToFit).not.toHaveBeenCalled();
  });

  test('reports unsupported documents without silently dropping valid images', async () => {
    const result = await readChatAttachmentFiles(
      [
        new File(['notes'], 'notes.txt', { type: 'text/plain' }),
        new File(['abc'], 'screen.png', { type: 'image/png' }),
      ],
      [],
      { images: true, files: false },
    );

    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].name).toBe('screen.png');
    expect(result.errors).toContain(
      'This agent does not support document attachments.',
    );
  });

  test('normalizes a recognized HEIF source before it reaches the shared data-url and staging path', async () => {
    const jpeg = new File(['jpeg'], 'camera.jpg', { type: 'image/jpeg' });
    prepareHeifAttachment.mockResolvedValue({
      kind: 'ready',
      file: jpeg,
      receipt: {
        kind: 'heif-to-jpeg',
        adapter: 'browser-native',
        source: { mimeType: 'image/heic', bytes: 4, sha256: 'a'.repeat(64) },
        output: {
          name: 'camera.jpg',
          mimeType: 'image/jpeg',
          bytes: 4,
          sha256: 'b'.repeat(64),
        },
      },
      sourceBytes: 4,
    });
    const result = await readChatAttachmentFiles(
      [new File([blobBytes(bmffBytes())], 'camera.HEIC', { type: '' })],
      [],
      { images: true, files: false },
    );

    expect(prepareHeifAttachment).toHaveBeenCalledOnce();
    expect(result.errors).toEqual([]);
    expect(result.attachments[0]).toEqual(
      expect.objectContaining({
        name: 'camera.jpg',
        type: 'image/jpeg',
        data: 'data:image/jpeg;base64,anBlZw==',
        transformation: expect.objectContaining({ kind: 'heif-to-jpeg' }),
      }),
    );
  });

  test('refuses HEIF when local decoding is unavailable, before any data URL is created', async () => {
    prepareHeifAttachment.mockResolvedValue({
      kind: 'rejected',
      error:
        'camera.heic was inspected locally, but this browser cannot safely convert HEIF. Convert it to JPEG and choose it again.',
    });
    const result = await readChatAttachmentFiles(
      [
        new File([blobBytes(bmffBytes())], 'camera.heic', {
          type: 'image/heic',
        }),
      ],
      [],
      { images: true, files: false },
    );
    expect(result.attachments).toEqual([]);
    expect(result.errors).toEqual([
      'camera.heic was inspected locally, but this browser cannot safely convert HEIF. Convert it to JPEG and choose it again.',
    ]);
  });

  test('refuses HEIF container bytes claimed as JPEG before data-url or upload intake', async () => {
    const result = await readChatAttachmentFiles(
      [
        new File([blobBytes(bmffBytes())], 'camera.jpg', {
          type: 'image/jpeg',
        }),
      ],
      [],
      { images: true, files: false },
    );
    expect(prepareHeifAttachment).not.toHaveBeenCalled();
    expect(result.attachments).toEqual([]);
    expect(result.errors).toEqual([
      'camera.jpg declares image/jpeg but contains an ISO-BMFF image container.',
    ]);
  });

  test('refuses a declared HEIF file without BMFF bytes before data-url intake', async () => {
    const result = await readChatAttachmentFiles(
      [new File(['not-heif'], 'camera.heic', { type: 'image/heic' })],
      [],
      { images: true, files: false },
    );
    expect(prepareHeifAttachment).not.toHaveBeenCalled();
    expect(result.attachments).toEqual([]);
    expect(result.errors).toEqual([
      'camera.heic is declared as HEIF but does not contain HEIF container bytes.',
    ]);
  });

  test('routes magic-only BMFF through HEIF preparation rather than raw data-url intake', async () => {
    prepareHeifAttachment.mockResolvedValue({
      kind: 'rejected',
      error:
        'photo is not a supported single-image HEIF photo. Convert it to JPEG and choose it again.',
    });
    const result = await readChatAttachmentFiles(
      [new File([blobBytes(bmffBytes())], 'photo', { type: '' })],
      [],
      { images: true, files: false },
    );
    expect(prepareHeifAttachment).toHaveBeenCalledWith(
      expect.any(File),
      'photo',
      0,
      { magicSaysBmff: true },
    );
    expect(result.attachments).toEqual([]);
  });

  test('settles a HEIF receipt against the final downscaled output', async () => {
    const jpeg = new File([new Uint8Array(6 * 1024 * 1024)], 'camera.jpg', {
      type: 'image/jpeg',
    });
    prepareHeifAttachment.mockResolvedValue({
      kind: 'ready',
      file: jpeg,
      receipt: {
        kind: 'heif-to-jpeg',
        adapter: 'browser-native',
        source: { mimeType: 'image/heic', bytes: 20, sha256: 'a'.repeat(64) },
        output: {
          name: 'camera.jpg',
          mimeType: 'image/jpeg',
          bytes: jpeg.size,
          sha256: 'b'.repeat(64),
        },
      },
      sourceBytes: 20,
    });
    downscaleOutcome = {
      status: 'resized',
      image: {
        dataUrl: dataUrlOf(1200, 'image/webp'),
        mimeType: 'image/webp',
        bytes: 1200,
        width: 1024,
        height: 768,
      },
    };
    const result = await readChatAttachmentFiles(
      [new File([blobBytes(bmffBytes())], 'camera.heic', { type: '' })],
      [],
      { images: true, files: false },
    );
    expect(result.attachments[0].transformation?.output).toEqual({
      name: 'camera.webp',
      mimeType: 'image/webp',
      bytes: 1200,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  describe('oversized images are shrunk to fit (#3375)', () => {
    test('sends the resized bytes, and records what they are', async () => {
      downscaleOutcome = {
        status: 'resized',
        image: {
          dataUrl: dataUrlOf(1_200, 'image/webp'),
          mimeType: 'image/webp',
          bytes: 1_200,
          width: 2048,
          height: 1152,
        },
      };

      const result = await readChatAttachmentFiles([oversizedPng()], [], {
        images: true,
        files: false,
      });

      expect(result.errors).toEqual([]);
      expect(result.attachments).toHaveLength(1);
      const [attachment] = result.attachments;
      // The declared size is the resized decoded length, not the original and
      // not the data URL's own length — the server re-derives exactly this.
      expect(attachment.size).toBe(1_200);
      expect(attachment.data).toBe(
        downscaleOutcome.status === 'resized'
          ? downscaleOutcome.image.dataUrl
          : null,
      );
      expect(attachment.type).toBe('image/webp');
      // A `.png` carrying WebP bytes is a lie nothing downstream corrects.
      expect(attachment.name).toBe('screenshot.webp');
      expect(attachment.resized).toEqual({
        fromBytes: 5 * 1024 * 1024 + 1,
        fromMimeType: 'image/png',
        width: 2048,
        height: 1152,
      });
    });

    test('leaves an image that already fits completely alone', async () => {
      const result = await readChatAttachmentFiles(
        [
          new File([new Uint8Array(5 * 1024 * 1024)], 'exactly-at-cap.png', {
            type: 'image/png',
          }),
        ],
        [],
        { images: true, files: false },
      );

      expect(downscaleImageToFit).not.toHaveBeenCalled();
      expect(result.attachments[0].size).toBe(5 * 1024 * 1024);
      expect(result.attachments[0].resized).toBeUndefined();
    });

    test('still refuses an image nothing could shrink far enough', async () => {
      downscaleOutcome = { status: 'too-large' };

      const result = await readChatAttachmentFiles([oversizedPng()], [], {
        images: true,
        files: false,
      });

      expect(downscaleImageToFit).toHaveBeenCalledTimes(1);
      expect(result.attachments).toEqual([]);
      expect(result.errors).toEqual([
        'screenshot.png is larger than 5 MB and could not be resized small enough.',
      ]);
    });

    test('a format nothing attempts says so, not "could not be resized"', async () => {
      const result = await readChatAttachmentFiles(
        [
          new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'loop.gif', {
            type: 'image/gif',
          }),
        ],
        [],
        { images: true, files: false },
      );

      expect(downscaleImageToFit).not.toHaveBeenCalled();
      expect(result.errors).toEqual([
        'loop.gif is larger than 5 MB. An animated image cannot be resized without flattening it to a single frame. Convert it to PNG or JPEG, or attach a smaller file.',
      ]);
    });

    test('says the bytes were unreadable, not that resizing fell short', async () => {
      downscaleOutcome = { status: 'undecodable' };

      const result = await readChatAttachmentFiles([oversizedPng()], [], {
        images: true,
        files: false,
      });

      // "Could not be resized small enough" would describe a ladder that never
      // ran — the source never became an image.
      expect(result.errors).toEqual([
        'screenshot.png could not be read as an image on this device.',
      ]);
    });

    test('a throwing re-encode refuses rather than rejecting the whole read', async () => {
      downscaleThrows = true;

      // Before #3375 this same paste got a size error. A rejection here would
      // reach `void handleAttachmentFiles(...)` and be dropped, leaving the
      // user with no image and no explanation.
      const result = await readChatAttachmentFiles([oversizedPng()], [], {
        images: true,
        files: false,
      });

      expect(result.attachments).toEqual([]);
      expect(result.errors).toEqual([
        'screenshot.png is larger than 5 MB and could not be resized on this device.',
      ]);
    });

    test('keeps reading the rest of the paste after one image fails', async () => {
      downscaleThrows = true;

      const result = await readChatAttachmentFiles(
        [oversizedPng(), new File(['abc'], 'small.png', { type: 'image/png' })],
        [],
        { images: true, files: false },
      );

      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0].name).toBe('small.png');
      expect(result.errors).toHaveLength(1);
    });

    test('never offers to shrink a document', async () => {
      const result = await readChatAttachmentFiles(
        [
          new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'report.pdf', {
            type: 'application/pdf',
          }),
        ],
        [],
        { images: false, files: true },
      );

      expect(downscaleImageToFit).not.toHaveBeenCalled();
      expect(result.errors).toEqual(['report.pdf must be smaller than 5 MB.']);
    });

    test('charges the combined cap the resized size, not the original', async () => {
      downscaleOutcome = {
        status: 'resized',
        image: {
          dataUrl: dataUrlOf(1_200, 'image/webp'),
          mimeType: 'image/webp',
          bytes: 1_200,
          width: 2048,
          height: 1152,
        },
      };
      const existing = [
        {
          id: 'a',
          name: 'earlier.png',
          type: 'image/png',
          size: 14 * 1024 * 1024,
          data: 'data:image/png;base64,YWJj',
        },
      ];

      const result = await readChatAttachmentFiles([oversizedPng()], existing, {
        images: true,
        files: false,
      });

      // 14 MB + 1.2 KB is under the 15 MB combined cap; 14 MB + 5 MB is not.
      expect(result.errors).toEqual([]);
      expect(result.attachments).toHaveLength(1);
    });
  });
});

/**
 * The mock above can make the CALL throw; only a real module-registry reset can
 * make the `await import('./downscaleImage')` itself reject. That is the
 * reachable production case: `station upgrade` rebuilds `dist-ui` under open
 * tabs, and this is the composer's one dynamic import with no LazyBoundary
 * around it.
 */
describe('readChatAttachmentFiles with an unloadable downscale chunk', () => {
  test('refuses with a message instead of rejecting (#3375 review)', async () => {
    vi.resetModules();
    vi.doMock('../utils/downscaleImage', () => {
      throw new Error('Failed to fetch dynamically imported module');
    });
    try {
      const { readChatAttachmentFiles: read } = await import(
        '../utils/chatAttachments'
      );

      const result = await read([oversizedPng()], [], {
        images: true,
        files: false,
      });

      expect(result.attachments).toEqual([]);
      expect(result.errors).toEqual([
        'screenshot.png is larger than 5 MB and could not be resized on this device.',
      ]);
    } finally {
      vi.doUnmock('../utils/downscaleImage');
      vi.resetModules();
    }
  });
});
