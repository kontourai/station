import { describe, expect, test } from 'vitest';
import {
  annexBHasIdr,
  DeviceFrameProtocolError,
  JpegStreamSplitter,
  jpegSize,
  MjpegMultipartParser,
  multipartBoundary,
  parseSemuPacket,
  pngSize,
} from '../device-frame-codecs.js';

/**
 * A structurally real baseline JPEG: SOI, an APP0, a SOF0 carrying the size,
 * an SOS, entropy data (with a stuffed FF00 and a restart marker, the two
 * things a naive FFD9 scan gets wrong) and EOI.
 */
function jpeg(width: number, height: number, fill = 0x11): Uint8Array {
  const bytes = [
    0xff,
    0xd8,
    // APP0 (JFIF), length 16
    0xff,
    0xe0,
    0x00,
    0x10,
    0x4a,
    0x46,
    0x49,
    0x46,
    0x00,
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
    // SOF0, length 11: precision 8, height, width, 1 component
    0xff,
    0xc0,
    0x00,
    0x0b,
    0x08,
    height >> 8,
    height & 0xff,
    width >> 8,
    width & 0xff,
    0x01,
    0x01,
    0x11,
    0x00,
    // SOS, length 8
    0xff,
    0xda,
    0x00,
    0x08,
    0x01,
    0x01,
    0x00,
    0x00,
    0x3f,
    0x00,
    // entropy-coded data
    fill,
    0xff,
    0x00,
    fill,
    0xff,
    0xd3,
    fill,
    fill,
    0xff,
    0xd9,
  ];
  return new Uint8Array(bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const text = (value: string) => new TextEncoder().encode(value);

/** Feed `bytes` in chunks of `size` and collect everything emitted. */
function feed<T>(
  push: (chunk: Uint8Array) => T[],
  bytes: Uint8Array,
  size: number,
): T[] {
  const out: T[] = [];
  for (let i = 0; i < bytes.length; i += size)
    out.push(...push(bytes.subarray(i, i + size)));
  return out;
}

function multipart(boundary: string, parts: Uint8Array[], withLength: boolean) {
  const chunks: Uint8Array[] = [];
  for (const part of parts)
    chunks.push(
      text(
        `--${boundary}\r\nContent-Type: image/jpeg\r\n${withLength ? `Content-Length: ${part.length}\r\n` : ''}\r\n`,
      ),
      part,
      text('\r\n'),
    );
  chunks.push(text(`--${boundary}--\r\n`));
  return concat(...chunks);
}

describe('MJPEG multipart parser', () => {
  const frames = [jpeg(390, 844, 1), jpeg(844, 390, 2), jpeg(10, 20, 3)];

  test.each([1, 2, 3, 7, 64, 4096])(
    'yields every part intact at chunk size %i (with Content-Length)',
    (size) => {
      const parser = new MjpegMultipartParser('frame');
      const parts = feed(
        (c) => parser.push(c),
        multipart('frame', frames, true),
        size,
      );
      expect(parts).toEqual(frames);
    },
  );

  test.each([1, 5, 33])(
    'yields every part intact at chunk size %i (no Content-Length)',
    (size) => {
      const parser = new MjpegMultipartParser('frame');
      const parts = feed(
        (c) => parser.push(c),
        multipart('frame', frames, false),
        size,
      );
      expect(parts).toEqual(frames);
    },
  );

  test('a large length-less part in small chunks parses in linear time', () => {
    // 4 MB of body bytes with no delimiter inside, in 1 KB chunks: a
    // rescan from the start on every chunk is ~8 G byte comparisons.
    const big = new Uint8Array(4 * 1024 * 1024).fill(0x61);
    const stream = multipart('frame', [big], false);
    const parser = new MjpegMultipartParser('frame');
    const started = performance.now();
    const parts = feed((c) => parser.push(c), stream, 1024);
    const elapsed = performance.now() - started;
    expect(parts).toHaveLength(1);
    expect(parts[0]!.length).toBe(big.length);
    // Linear takes milliseconds; quadratic rescanning takes many seconds.
    expect(elapsed).toBeLessThan(2_000);
  });

  test('refuses a part larger than its bound instead of buffering it', () => {
    const parser = new MjpegMultipartParser('frame', 8);
    expect(() => parser.push(multipart('frame', [jpeg(1, 1)], true))).toThrow(
      DeviceFrameProtocolError,
    );
  });

  test('reads the boundary from the Content-Type', () => {
    expect(multipartBoundary('multipart/x-mixed-replace; boundary=frame')).toBe(
      'frame',
    );
    expect(multipartBoundary('multipart/x-mixed-replace;boundary="--ab"')).toBe(
      'ab',
    );
    expect(multipartBoundary('image/jpeg')).toBeNull();
    expect(multipartBoundary(null)).toBeNull();
  });
});

describe('JPEG stream splitter (ffmpeg image2pipe output)', () => {
  const images = [jpeg(100, 200, 4), jpeg(300, 150, 5)];

  test.each([1, 3, 11, 1024])(
    'splits concatenated JPEGs exactly at chunk size %i',
    (size) => {
      const splitter = new JpegStreamSplitter();
      expect(feed((c) => splitter.push(c), concat(...images), size)).toEqual(
        images,
      );
    },
  );

  test('a stuffed FF00 and a restart marker do not end an image early', () => {
    const splitter = new JpegStreamSplitter();
    const [only] = splitter.push(images[0]!);
    expect(only).toEqual(images[0]);
  });

  test('resyncs past leading noise', () => {
    const splitter = new JpegStreamSplitter();
    expect(splitter.push(concat(text('noise'), images[1]!))).toEqual([
      images[1],
    ]);
  });
});

describe('image sizes', () => {
  test('jpegSize reads the Start-of-Frame', () => {
    expect(jpegSize(jpeg(1179, 2556))).toEqual({ width: 1179, height: 2556 });
    expect(jpegSize(text('not a jpeg'))).toBeNull();
  });

  test('pngSize reads the IHDR', () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDWQAAAAASUVORK5CYII=',
      'base64',
    );
    expect(pngSize(new Uint8Array(png))).toEqual({ width: 1, height: 1 });
    expect(pngSize(text('nope'))).toBeNull();
  });
});

describe('SEMU packets', () => {
  function semu(version: number, key: boolean, payload: number[]) {
    const header = version === 2 ? 24 : 16;
    const out = new Uint8Array(header + payload.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, 0x53454d55);
    view.setUint8(4, version);
    view.setUint8(5, key ? 1 : 0);
    out.set(payload, header);
    return out;
  }

  test('v1 and v2 headers are stripped and the key flag read', () => {
    expect(parseSemuPacket(semu(1, true, [0, 0, 0, 1, 0x65]))).toEqual({
      data: new Uint8Array([0, 0, 0, 1, 0x65]),
      isKey: true,
    });
    expect(parseSemuPacket(semu(2, false, [0, 0, 1, 0x41]))).toEqual({
      data: new Uint8Array([0, 0, 1, 0x41]),
      isKey: false,
    });
  });

  test('anything else is raw Annex-B with an unknown key flag', () => {
    const raw = new Uint8Array([0, 0, 0, 1, 0x65, 1, 2]);
    expect(parseSemuPacket(raw)).toEqual({ data: raw, isKey: null });
  });

  test('annexBHasIdr finds an IDR slice', () => {
    expect(
      annexBHasIdr(new Uint8Array([0, 0, 0, 1, 0x67, 0, 0, 1, 0x65])),
    ).toBe(true);
    expect(annexBHasIdr(new Uint8Array([0, 0, 0, 1, 0x41, 9]))).toBe(false);
  });
});
