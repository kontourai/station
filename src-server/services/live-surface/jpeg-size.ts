/**
 * Pixel size of a baseline or progressive JPEG, read from the first
 * Start-of-Frame marker before the scan data; undefined when the bytes are
 * not a JPEG whose header we can read. Shared by the browser screencast and
 * the device video producers, which both stamp frame sizes from it.
 */
export function jpegSize(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    return undefined;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    // Fill bytes between markers.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // A scan (SOS) or end of image (EOI) before any frame header: no size.
    if (marker === 0xda || marker === 0xd9) return undefined;
    // Standalone markers carry no length.
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    // SOF0..SOF15, except DHT (C4), JPG (C8) and DAC (CC).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      if (offset + 9 > bytes.length) return undefined;
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    offset += 2 + length;
  }
  return undefined;
}
