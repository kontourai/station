/**
 * Bounds measured on the JSON-serialized form, shared by the station-control
 * reads that promise a byte cap (`read_conversation`, `get_session_digest`).
 * Measuring the serialized form matters because escaping inflates a control
 * character to six bytes (`\u001b`), so a raw length would let a page past
 * its cap.
 */

/** Bytes `value` occupies once serialized as JSON (escapes included). */
export function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/**
 * The longest prefix of `text`, by whole code points, whose JSON-serialized
 * form fits `maxBytes`.
 */
export function clipSerialized(text: string, maxBytes: number): string {
  if (serializedBytes(text) <= maxBytes) return text;
  const points = Array.from(text);
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (serializedBytes(points.slice(0, middle).join('')) <= maxBytes)
      low = middle;
    else high = middle - 1;
  }
  return points.slice(0, low).join('');
}
