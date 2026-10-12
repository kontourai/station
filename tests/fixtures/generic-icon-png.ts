import { deflateSync } from 'node:zlib';

/**
 * A generic, brand-free project icon for browser journeys: a square PNG of a
 * light diamond on a solid field, encoded here so no binary fixture (and no
 * real product's artwork) is checked in. Real PNG bytes, so the browser
 * decodes and paints it, and the server's signature check reads the true
 * header the picker uploads.
 */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

export function genericIconPng(
  size = 32,
  field: [number, number, number] = [37, 99, 235],
  mark: [number, number, number] = [255, 255, 255],
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour RGB
  const rows: Buffer[] = [];
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3); // filter byte 0 = none
    for (let x = 0; x < size; x += 1) {
      const inDiamond =
        Math.abs(x - centre) + Math.abs(y - centre) <= size * 0.32;
      row.set(inDiamond ? mark : field, 1 + x * 3);
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
