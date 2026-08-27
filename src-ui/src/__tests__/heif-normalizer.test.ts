// @vitest-environment jsdom

import { describe, expect, test, vi } from 'vitest';
import {
  HEIF_MAX_BOXES,
  HEIF_MAX_EDGE,
  HEIF_MAX_PIXELS,
  type HeifWorker,
  inspectHeifFile,
  isHeifCandidate,
  normalizeHeifFile,
} from '../utils/heif-normalizer';

const text = new TextEncoder();

function u16(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value);
  return bytes;
}

function u32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value);
  return bytes;
}

function join(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(
    parts.reduce((total, part) => total + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

function blobParts(parts: readonly Uint8Array[]): BlobPart[] {
  return parts.map((part) => new Uint8Array(part).buffer);
}

function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const payload = join(...parts);
  return join(u32(payload.length + 8), text.encode(type), payload);
}

function fullBox(version = 0): Uint8Array {
  return new Uint8Array([version, 0, 0, 0]);
}

function heif(
  options: {
    brand?: string;
    width?: number;
    height?: number;
    entries?: number;
    mdatBeforeMeta?: boolean;
    unrelatedWidth?: number;
    unrelatedHeight?: number;
    name?: string;
  } = {},
): File {
  const width = options.width ?? 4000;
  const height = options.height ?? 3000;
  const itemId = 7;
  const ispe = box('ispe', fullBox(), u32(width), u32(height));
  const unrelated =
    options.unrelatedWidth && options.unrelatedHeight
      ? box(
          'ispe',
          fullBox(),
          u32(options.unrelatedWidth),
          u32(options.unrelatedHeight),
        )
      : undefined;
  const propertyIndex = unrelated ? 2 : 1;
  const ipma = box(
    'ipma',
    fullBox(),
    u32(1),
    u16(itemId),
    new Uint8Array([1, propertyIndex]),
  );
  const iprp = box(
    'iprp',
    box('ipco', ...(unrelated ? [unrelated, ispe] : [ispe])),
    ipma,
  );
  const infe = box(
    'infe',
    fullBox(2),
    u16(itemId),
    u16(0),
    text.encode('hvc1'),
  );
  const iinf = box('iinf', fullBox(), u16(options.entries ?? 1), infe);
  const meta = box(
    'meta',
    fullBox(),
    box('pitm', fullBox(), u16(itemId)),
    iinf,
    iprp,
  );
  const ftyp = box(
    'ftyp',
    text.encode(options.brand ?? 'heic'),
    u32(0),
    text.encode('mif1'),
  );
  const pieces = options.mdatBeforeMeta
    ? [ftyp, box('mdat', new Uint8Array(64)), meta]
    : [ftyp, meta];
  return new File(blobParts(pieces), options.name ?? 'PHOTO.HEIC', {
    type: '',
  });
}

function worker(
  post: (message: { id: string }, target: HeifWorker) => void,
): HeifWorker & { terminated: boolean; lastMessageId?: string } {
  const target: HeifWorker & { terminated: boolean; lastMessageId?: string } = {
    onmessage: null,
    onerror: null,
    terminated: false,
    terminate() {
      target.terminated = true;
    },
    postMessage(message) {
      target.lastMessageId = (message as { id: string }).id;
      post(message as { id: string }, target);
    },
  };
  return target;
}

describe('HEIF intake inspector', () => {
  test('recognizes only image HEIF MIME types and unknown/octet-stream HEIF names', () => {
    expect(isHeifCandidate({ name: 'photo.heic', type: '' })).toBe(true);
    expect(
      isHeifCandidate({ name: 'photo.HEIF', type: 'application/octet-stream' }),
    ).toBe(true);
    expect(isHeifCandidate({ name: 'photo.heic', type: 'image/jpeg' })).toBe(
      false,
    );
    expect(
      isHeifCandidate({ name: 'photo.heic', type: 'image/heic-sequence' }),
    ).toBe(false);
  });

  test('finds bounded metadata after mdat and proves a primary still image', async () => {
    await expect(
      inspectHeifFile(heif({ mdatBeforeMeta: true })),
    ).resolves.toEqual({
      width: 4000,
      height: 3000,
      primaryItemId: 7,
    });
  });

  test('admits a magic-identified HEIF without a HEIF extension only at the magic-first seam', async () => {
    const generic = heif({ name: 'camera' });
    await expect(inspectHeifFile(generic)).resolves.toBeNull();
    await expect(
      inspectHeifFile(generic, undefined, { acceptMagic: true }),
    ).resolves.toMatchObject({ width: 4000, height: 3000 });
  });

  test('rejects AVIF brands, multi-image metadata, and malformed containers', async () => {
    await expect(inspectHeifFile(heif({ brand: 'avif' }))).resolves.toBeNull();
    await expect(inspectHeifFile(heif({ brand: 'hevc' }))).resolves.toBeNull();
    await expect(inspectHeifFile(heif({ entries: 2 }))).resolves.toBeNull();
    await expect(
      inspectHeifFile(
        new File([new Uint8Array([0, 1, 2])], 'bad.heic', {
          type: 'image/heic',
        }),
      ),
    ).resolves.toBeNull();
  });

  test('rejects dimensions beyond both edge and pixel bounds before decode', async () => {
    await expect(
      inspectHeifFile(heif({ width: HEIF_MAX_EDGE + 1, height: 1 })),
    ).resolves.toBeNull();
    await expect(
      inspectHeifFile(
        heif({
          width: HEIF_MAX_EDGE,
          height: Math.floor(HEIF_MAX_PIXELS / HEIF_MAX_EDGE) + 1,
        }),
      ),
    ).resolves.toBeNull();
  });

  test('binds primary item dimensions through ipma rather than an unrelated ispe', async () => {
    await expect(
      inspectHeifFile(
        heif({
          width: HEIF_MAX_EDGE + 1,
          height: 1,
          unrelatedWidth: 1,
          unrelatedHeight: 1,
        }),
      ),
    ).resolves.toBeNull();
  });

  test('caps the top-level box walk', async () => {
    const boxes = Array.from({ length: HEIF_MAX_BOXES + 1 }, () => box('free'));
    const file = new File(
      blobParts([box('ftyp', text.encode('heic'), u32(0)), ...boxes]),
      'too-many.heic',
      { type: 'image/heic' },
    );
    await expect(inspectHeifFile(file)).resolves.toBeNull();
  });

  test('does not claim a decoder when the host supplies none', async () => {
    await expect(normalizeHeifFile(heif())).resolves.toEqual({
      ok: false,
      reason: 'decoder-unavailable',
    });
  });

  test('releases the global decoder slot after constructor and postMessage failures', async () => {
    const source = heif();
    await expect(
      normalizeHeifFile(source, undefined, {
        createWorker: () => {
          throw new Error('CSP worker failure');
        },
      }),
    ).resolves.toEqual({ ok: false, reason: 'decoder-failed' });

    const broken = worker(() => {
      throw new Error('post failed');
    });
    await expect(
      normalizeHeifFile(source, undefined, { createWorker: () => broken }),
    ).resolves.toEqual({ ok: false, reason: 'decoder-unavailable' });
    expect(broken.terminated).toBe(true);

    await expect(
      normalizeHeifFile(source, undefined, {
        createWorker: () =>
          worker((message, target) => {
            queueMicrotask(() =>
              target.onmessage?.({
                data: {
                  id: message.id,
                  ok: true,
                  bytes: new Uint8Array([0xff, 0xd8, 0xff]).buffer,
                },
              } as MessageEvent),
            );
          }),
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  test('terminates timeout and abort workers, ignores late replies, and serializes decodes', async () => {
    const source = heif();
    const timedOut = worker(() => undefined);
    await expect(
      normalizeHeifFile(source, undefined, {
        createWorker: () => timedOut,
        timeoutMs: 1,
      }),
    ).resolves.toEqual({ ok: false, reason: 'timed-out' });
    expect(timedOut.terminated).toBe(true);
    timedOut.onmessage?.({ data: { id: 'late', ok: true } } as MessageEvent);

    const controller = new AbortController();
    const aborted = worker(() => controller.abort());
    await expect(
      normalizeHeifFile(source, controller.signal, {
        createWorker: () => aborted,
      }),
    ).resolves.toEqual({ ok: false, reason: 'cancelled' });
    expect(aborted.terminated).toBe(true);

    const workers: Array<ReturnType<typeof worker>> = [];
    const first = normalizeHeifFile(source, undefined, {
      createWorker: () => {
        const next = worker(() => undefined);
        workers.push(next);
        return next;
      },
    });
    const second = normalizeHeifFile(source, undefined, {
      createWorker: () => {
        const next = worker((message, target) =>
          target.onmessage?.({
            data: {
              id: message.id,
              ok: true,
              bytes: new Uint8Array([0xff, 0xd8, 0xff]).buffer,
            },
          } as MessageEvent),
        );
        workers.push(next);
        return next;
      },
    });
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    workers[0].onmessage?.({
      data: {
        id: workers[0].lastMessageId,
        ok: true,
        bytes: new Uint8Array([0xff, 0xd8, 0xff]).buffer,
      },
    } as MessageEvent);
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
  });
});
