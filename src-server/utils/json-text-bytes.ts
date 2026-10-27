/**
 * Linear counting and splitting of text by the UTF-8 bytes of its JSON
 * string body (escapes included), shared by EventStore's spill planner,
 * delta splitting and transcript chunking. One counting rule, one pass.
 */

/** UTF-8 bytes `JSON.stringify` emits for one UTF-16 code unit sequence. */
export function jsonStringBodyBytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    bytes += jsonCodeUnitBytes(value, index);
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
    }
  }
  return bytes;
}

/**
 * Bytes for the code unit at `index` (a whole pair counts 4 at its high
 * half). The single counting rule shared by sizing, previews and chunking.
 */
export function jsonCodeUnitBytes(value: string, index: number): number {
  const code = value.charCodeAt(index);
  if (code === 0x22 || code === 0x5c) return 2;
  if (
    code === 0x08 ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0c ||
    code === 0x0d
  )
    return 2;
  if (code < 0x20) return 6;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code >= 0xd800 && code <= 0xdbff) {
    const next = value.charCodeAt(index + 1);
    return next >= 0xdc00 && next <= 0xdfff ? 4 : 6;
  }
  if (code >= 0xdc00 && code <= 0xdfff) return 6;
  return 3;
}

/**
 * Split text into chunks whose JSON string body is at most `maxBytes`,
 * in one linear pass, never inside a surrogate pair. Reassembles exactly.
 */
export function splitJsonTextByEscapedBytes(
  value: string,
  maxBytes: number,
): string[] {
  if (maxBytes < 6) throw new RangeError('maxBytes must be at least 6');
  const chunks: string[] = [];
  let start = 0;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = jsonCodeUnitBytes(value, index);
    const code = value.charCodeAt(index);
    const pair =
      code >= 0xd800 &&
      code <= 0xdbff &&
      value.charCodeAt(index + 1) >= 0xdc00 &&
      value.charCodeAt(index + 1) <= 0xdfff;
    if (bytes + unit > maxBytes && index > start) {
      chunks.push(value.slice(start, index));
      start = index;
      bytes = 0;
    }
    bytes += unit;
    if (pair) index += 1;
  }
  if (start < value.length) chunks.push(value.slice(start));
  return chunks;
}
