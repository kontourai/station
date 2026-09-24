/**
 * Byte-level parsers for the device hub's video wire formats (#1970).
 *
 * - `MjpegMultipartParser`: the iOS helper's `stream.mjpeg`, a
 *   `multipart/x-mixed-replace` body of JPEG parts.
 * - `JpegStreamSplitter`: a bare concatenation of JPEG images (ffmpeg's
 *   `image2pipe` output when decoding Android's H.264 into frames).
 * - `parseSemuPacket`: serve-emu's per-access-unit "SEMU" frame-meta header.
 * - `jpegSize` / `pngSize`: an image's pixel size from its own header.
 *
 * Every parser is incremental (chunk boundaries are arbitrary) and BOUNDED:
 * a part or image larger than its cap is a protocol error, never an
 * unbounded buffer.
 *
 * The SEMU layout is adapted from t3code
 * (packages/client-runtime/src/device/stream.ts, `parseSemuPacket`) and the
 * hub's own `shared/frame-meta.js` (v2 adds an 8-byte send time).
 * t3code: MIT License, Copyright (c) 2026 T3 Tools Inc.
 */

export class DeviceFrameProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceFrameProtocolError';
  }
}

/** One part's bytes cap: the live-surface record body bound. */
const DEVICE_FRAME_MAX_BYTES = 8 * 1024 * 1024;
const MAX_PART_HEADER_BYTES = 8 * 1024;

/** Growable byte buffer with O(1) amortized append and front consumption. */
class ByteQueue {
  private buffer = new Uint8Array(64 * 1024);
  private start = 0;
  private end = 0;

  get length(): number {
    return this.end - this.start;
  }

  push(chunk: Uint8Array): void {
    if (this.end + chunk.byteLength > this.buffer.byteLength) {
      const needed = this.length + chunk.byteLength;
      if (needed <= this.buffer.byteLength && this.start > 0) {
        this.buffer.copyWithin(0, this.start, this.end);
      } else {
        let capacity = this.buffer.byteLength;
        while (capacity < needed) capacity *= 2;
        const grown = new Uint8Array(capacity);
        grown.set(this.buffer.subarray(this.start, this.end));
        this.buffer = grown;
      }
      this.end -= this.start;
      this.start = 0;
    }
    this.buffer.set(chunk, this.end);
    this.end += chunk.byteLength;
  }

  view(): Uint8Array {
    return this.buffer.subarray(this.start, this.end);
  }

  /** Remove and return (a copy of) the first `count` bytes. */
  take(count: number): Uint8Array {
    const out = this.buffer.slice(this.start, this.start + count);
    this.start += count;
    if (this.start === this.end) this.start = this.end = 0;
    return out;
  }

  drop(count: number): void {
    this.start += count;
    if (this.start === this.end) this.start = this.end = 0;
  }
}

function indexOf(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i <= haystack.length - needle.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1)
      if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const ascii = new TextEncoder();
const latin1 = new TextDecoder('latin1');

/** The `boundary` parameter of a multipart Content-Type, or null. */
export function multipartBoundary(contentType: string | null): string | null {
  if (!contentType) return null;
  const [type, ...params] = contentType.split(';');
  if (!type?.trim().toLowerCase().startsWith('multipart/')) return null;
  for (const param of params) {
    const [key, ...rest] = param.split('=');
    if (key?.trim().toLowerCase() !== 'boundary') continue;
    const value = rest
      .join('=')
      .trim()
      .replace(/^"(.*)"$/, '$1');
    if (/^[\x21-\x7e]{1,70}$/.test(value)) return value.replace(/^--/, '');
  }
  return null;
}

/**
 * Incremental `multipart/x-mixed-replace` reader. Yields each part's body.
 * A part with `Content-Length` is read by length; one without is read up to
 * the next boundary delimiter. Part headers are case-insensitive.
 */
export class MjpegMultipartParser {
  private readonly queue = new ByteQueue();
  private readonly delimiter: Uint8Array;
  private readonly headerEnd = ascii.encode('\r\n\r\n');
  /** Awaiting a delimiter, a part's headers, or a part's body. */
  private phase: 'delimiter' | 'headers' | 'body' = 'delimiter';
  private bodyLength: number | null = null;
  /**
   * How far a length-less body has already been searched for the next
   * delimiter, so each chunk scans only what is new (plus a delimiter's
   * overlap): linear, not quadratic, in the part's size.
   */
  private scanned = 0;

  constructor(
    boundary: string,
    private readonly maxPartBytes = DEVICE_FRAME_MAX_BYTES,
  ) {
    this.delimiter = ascii.encode(`--${boundary}`);
  }

  push(chunk: Uint8Array): Uint8Array[] {
    this.queue.push(chunk);
    const parts: Uint8Array[] = [];
    for (;;) {
      const bytes = this.queue.view();
      if (this.phase === 'delimiter') {
        const at = indexOf(bytes, this.delimiter);
        if (at < 0) {
          // Keep only what could still be the start of a delimiter.
          const keep = this.delimiter.length - 1;
          if (bytes.length > keep) this.queue.drop(bytes.length - keep);
          return parts;
        }
        this.queue.drop(at + this.delimiter.length);
        this.phase = 'headers';
        continue;
      }
      if (this.phase === 'headers') {
        // Tolerate the CRLF that ends the delimiter line being part of the
        // header block: search for the blank line that ends the headers.
        const end = indexOf(bytes, this.headerEnd);
        if (end < 0) {
          if (bytes.length > MAX_PART_HEADER_BYTES)
            throw new DeviceFrameProtocolError('part headers exceed bound');
          return parts;
        }
        const headers = latin1.decode(bytes.subarray(0, end));
        this.queue.drop(end + this.headerEnd.length);
        if (/^--/.test(headers)) return parts; // closing delimiter
        const length =
          /(?:^|\r\n)content-length:\s*(\d{1,9})\s*(?:\r\n|$)/i.exec(headers);
        this.bodyLength = length ? Number(length[1]) : null;
        if (this.bodyLength !== null && this.bodyLength > this.maxPartBytes)
          throw new DeviceFrameProtocolError('part exceeds bound');
        this.phase = 'body';
        continue;
      }
      // body
      if (this.bodyLength !== null) {
        if (bytes.length < this.bodyLength) return parts;
        parts.push(this.queue.take(this.bodyLength));
      } else {
        const at = indexOf(
          bytes,
          this.delimiter,
          Math.max(0, this.scanned - this.delimiter.length + 1),
        );
        if (at < 0) {
          if (bytes.length > this.maxPartBytes + this.delimiter.length + 4)
            throw new DeviceFrameProtocolError('part exceeds bound');
          this.scanned = bytes.length;
          return parts;
        }
        // The body ends at the CRLF that precedes the delimiter.
        let bodyEnd = at;
        if (
          bodyEnd >= 2 &&
          bytes[bodyEnd - 2] === 13 &&
          bytes[bodyEnd - 1] === 10
        )
          bodyEnd -= 2;
        parts.push(this.queue.take(bodyEnd));
        this.queue.drop(at - bodyEnd);
      }
      this.bodyLength = null;
      this.scanned = 0;
      this.phase = 'delimiter';
    }
  }
}

/**
 * Splits a concatenation of baseline/progressive JPEGs into images by
 * walking their marker structure: segment lengths up to Start-of-Scan, then
 * entropy-coded data until a marker that is neither a stuffed `FF 00` nor a
 * restart marker. That is exact where scanning for `FF D9` is not (an
 * embedded thumbnail carries its own EOI).
 */
export class JpegStreamSplitter {
  private readonly queue = new ByteQueue();
  /** Offset (into the queue view) scanning has reached for the current image. */
  private scan = 0;
  /** Inside entropy-coded data after an SOS. */
  private inEntropy = false;

  constructor(private readonly maxImageBytes = DEVICE_FRAME_MAX_BYTES) {}

  push(chunk: Uint8Array): Uint8Array[] {
    this.queue.push(chunk);
    const images: Uint8Array[] = [];
    for (;;) {
      const bytes = this.queue.view();
      if (this.scan === 0) {
        // Resync to an SOI; anything before one is noise.
        let soi = -1;
        for (let i = 0; i + 1 < bytes.length; i += 1)
          if (bytes[i] === 0xff && bytes[i + 1] === 0xd8) {
            soi = i;
            break;
          }
        if (soi < 0) {
          if (bytes.length > 1) this.queue.drop(bytes.length - 1);
          return images;
        }
        if (soi > 0) this.queue.drop(soi);
        this.scan = 2;
        this.inEntropy = false;
        continue;
      }
      if (bytes.length > this.maxImageBytes)
        throw new DeviceFrameProtocolError('image exceeds bound');
      const end = this.advance(bytes);
      if (end === null) return images;
      images.push(this.queue.take(end));
      this.scan = 0;
    }
  }

  /** Walk from `scan`; the image's end offset once its EOI is seen. */
  private advance(bytes: Uint8Array): number | null {
    let i = this.scan;
    for (;;) {
      if (this.inEntropy) {
        while (i + 1 < bytes.length) {
          if (bytes[i] !== 0xff) {
            i += 1;
            continue;
          }
          const next = bytes[i + 1]!;
          if (
            next === 0x00 ||
            (next >= 0xd0 && next <= 0xd7) ||
            next === 0xff
          ) {
            i += next === 0xff ? 1 : 2;
            continue;
          }
          this.inEntropy = false;
          break;
        }
        if (this.inEntropy) {
          this.scan = i;
          return null;
        }
      }
      if (i + 1 >= bytes.length) {
        this.scan = i;
        return null;
      }
      if (bytes[i] !== 0xff)
        throw new DeviceFrameProtocolError('expected a JPEG marker');
      const marker = bytes[i + 1]!;
      if (marker === 0xff) {
        i += 1; // fill byte
        continue;
      }
      if (marker === 0xd9) return i + 2;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
        i += 2; // standalone marker
        continue;
      }
      if (i + 3 >= bytes.length) {
        this.scan = i;
        return null;
      }
      const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
      if (length < 2) throw new DeviceFrameProtocolError('bad segment length');
      if (i + 2 + length > bytes.length) {
        this.scan = i;
        return null;
      }
      i += 2 + length;
      if (marker === 0xda) this.inEntropy = true;
    }
  }
}

/** Pixel size from a JPEG's Start-of-Frame segment, or null. */
export function jpegSize(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      if (i + 8 >= bytes.length) return null;
      const height = (bytes[i + 5]! << 8) | bytes[i + 6]!;
      const width = (bytes[i + 7]! << 8) | bytes[i + 8]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + length;
  }
  return null;
}

/** Pixel size from a PNG's IHDR, or null. */
export function pngSize(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 24 || signature.some((byte, i) => bytes[i] !== byte))
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (latin1.decode(bytes.subarray(12, 16)) !== 'IHDR') return null;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

const SEMU_MAGIC = 0x53454d55;
const SEMU_V1_BYTES = 16;
const SEMU_V2_BYTES = 24;
const SEMU_FLAG_KEY = 1;

/**
 * Split serve-emu's SEMU-framed video message into its keyframe flag and
 * Annex-B payload. v1 is 16 bytes (magic, version, flags, reserved, pts);
 * v2 appends an 8-byte server send time. Anything else is raw Annex-B with
 * an unknown key flag.
 */
export function parseSemuPacket(bytes: Uint8Array): {
  data: Uint8Array;
  isKey: boolean | null;
} {
  if (bytes.byteLength > SEMU_V1_BYTES) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(0, false) === SEMU_MAGIC) {
      const version = view.getUint8(4);
      const header =
        version === 1 ? SEMU_V1_BYTES : version === 2 ? SEMU_V2_BYTES : 0;
      if (header > 0 && bytes.byteLength > header)
        return {
          data: bytes.subarray(header),
          isKey: (view.getUint8(5) & SEMU_FLAG_KEY) !== 0,
        };
    }
  }
  return { data: bytes, isKey: null };
}

/** Whether an Annex-B access unit holds an IDR slice (a decodable start). */
export function annexBHasIdr(bytes: Uint8Array): boolean {
  return annexBNalTypes(bytes).has(5);
}

/** The NAL unit types in an Annex-B access unit (1 = non-IDR slice, 5 = IDR, 7/8 = SPS/PPS). */
export function annexBNalTypes(bytes: Uint8Array): Set<number> {
  const types = new Set<number>();
  for (let i = 0; i + 3 < bytes.length; i += 1) {
    if (bytes[i] !== 0 || bytes[i + 1] !== 0) continue;
    let start = -1;
    if (bytes[i + 2] === 1) start = i + 3;
    else if (bytes[i + 2] === 0 && bytes[i + 3] === 1) start = i + 4;
    if (start < 0 || start >= bytes.length) continue;
    types.add(bytes[start]! & 0x1f);
    i = start;
  }
  return types;
}
