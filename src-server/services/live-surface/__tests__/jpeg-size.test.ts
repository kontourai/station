import { describe, expect, test } from 'vitest';
import { jpegSize } from '../jpeg-size.js';

const SOI = [0xff, 0xd8];
const EOI = [0xff, 0xd9];
// APP0 (JFIF), length 16.
const APP0 = [
  0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
  0x01, 0x00, 0x01, 0x00, 0x00,
];
// DHT, length 4: a length-bearing C4 segment that is NOT a frame header.
const DHT = [0xff, 0xc4, 0x00, 0x04, 0x00, 0x00];
// SOS header, length 8. What follows it is entropy-coded data, not markers,
// even where those bytes happen to spell a frame header.
const SOS = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00];

/** SOF0 (C0) or SOF2 (C2), length 11: precision, height, width, 1 component. */
function sof(width: number, height: number, marker = 0xc0): number[] {
  return [
    0xff,
    marker,
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
  ];
}

const bytes = (...parts: number[][]) => new Uint8Array(parts.flat());

describe('jpegSize', () => {
  test.each([
    [
      'a baseline frame past an APP segment',
      [SOI, APP0, sof(640, 400), SOS],
      { width: 640, height: 400 },
    ],
    [
      'a progressive (SOF2) frame',
      [SOI, sof(1179, 2556, 0xc2), SOS],
      { width: 1179, height: 2556 },
    ],
    [
      'fill bytes between markers',
      [SOI, [0xff, 0xff], sof(320, 640)],
      { width: 320, height: 640 },
    ],
    [
      'a standalone restart marker',
      [SOI, [0xff, 0xd0], sof(320, 640)],
      { width: 320, height: 640 },
    ],
    [
      'a DHT segment before the frame',
      [SOI, DHT, sof(320, 640)],
      { width: 320, height: 640 },
    ],
  ])('reads the size from %s', (_label, parts, size) => {
    expect(jpegSize(bytes(...parts))).toEqual(size);
  });

  test.each([
    ['bytes that are not a JPEG', [[0x89, 0x50, 0x4e, 0x47]]],
    ['a scan that starts before any frame header', [SOI, APP0, SOS, sof(9, 9)]],
    [
      'an image that ends before any frame header',
      [SOI, EOI, [0x00, 0x02], sof(9, 9)],
    ],
    ['a zero-width frame', [SOI, sof(0, 400)]],
    [
      'a frame header cut off inside its width',
      [SOI, sof(640, 400).slice(0, 8)],
    ],
  ])('reads no size from %s', (_label, parts) => {
    expect(jpegSize(bytes(...parts))).toBeUndefined();
  });
});
