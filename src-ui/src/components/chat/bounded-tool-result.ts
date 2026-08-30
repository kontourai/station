export const TOOL_RESULT_HEAD_CHARS = 3_000;
export const TOOL_RESULT_TAIL_CHARS = 512;

function endsOnHighSurrogate(value: string): boolean {
  const code = value.charCodeAt(value.length - 1);
  return code >= 0xd800 && code <= 0xdbff;
}

function startsOnLowSurrogate(value: string): boolean {
  const code = value.charCodeAt(0);
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Slice a fragment down BEFORE it is concatenated onto the retained tail.
 * A single fragment is routinely the whole payload (an unescaped run flushes
 * once; a top-level string appends whole), so concatenating it first would
 * materialize the very allocation this collector exists to avoid. Exported so
 * the bound is pinned directly rather than inferred from heap measurements.
 */
export function boundTailFragment(value: string): string {
  return value.length >= TOOL_RESULT_TAIL_CHARS
    ? value.slice(-TOOL_RESULT_TAIL_CHARS)
    : value;
}

export interface BoundedToolResultText {
  head: string;
  tail: string;
  withheldBytes: number;
  truncated: boolean;
}

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
      bytes += 4;
    } else bytes += 3;
  }
  return bytes;
}

class BoundedTextCollector {
  private totalBytes = 0;
  private totalChars = 0;
  private head = '';
  private tail = '';

  append(value: string): void {
    if (!value) return;
    this.totalBytes += utf8Bytes(value);
    this.totalChars += value.length;
    if (this.head.length < TOOL_RESULT_HEAD_CHARS) {
      const remaining = TOOL_RESULT_HEAD_CHARS - this.head.length;
      this.head += value.slice(0, remaining);
    }
    this.tail = (this.tail + boundTailFragment(value)).slice(
      -TOOL_RESULT_TAIL_CHARS,
    );
  }

  finish(): BoundedToolResultText {
    if (this.totalChars <= TOOL_RESULT_HEAD_CHARS) {
      return {
        head: this.head,
        tail: '',
        withheldBytes: 0,
        truncated: false,
      };
    }
    if (this.totalChars <= TOOL_RESULT_HEAD_CHARS + TOOL_RESULT_TAIL_CHARS) {
      const overlap =
        TOOL_RESULT_HEAD_CHARS + TOOL_RESULT_TAIL_CHARS - this.totalChars;
      return {
        head: this.head + this.tail.slice(overlap),
        tail: '',
        withheldBytes: 0,
        truncated: false,
      };
    }
    // Never end the head on a high surrogate or start the tail on a low one:
    // the boundary is exactly where the reader looks, and a split pair paints
    // a replacement glyph there.
    const head = endsOnHighSurrogate(this.head)
      ? this.head.slice(0, -1)
      : this.head;
    const tail = startsOnLowSurrogate(this.tail)
      ? this.tail.slice(1)
      : this.tail;
    const withheldBytes = Math.max(
      0,
      this.totalBytes - utf8Bytes(head) - utf8Bytes(tail),
    );
    return { head, tail, withheldBytes, truncated: true };
  }
}

function appendJsonString(
  collector: BoundedTextCollector,
  value: string,
): void {
  collector.append('"');
  let runStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let escaped: string | undefined;
    if (code === 0x22) escaped = '\\"';
    else if (code === 0x5c) escaped = '\\\\';
    else if (code === 0x08) escaped = '\\b';
    else if (code === 0x0c) escaped = '\\f';
    else if (code === 0x0a) escaped = '\\n';
    else if (code === 0x0d) escaped = '\\r';
    else if (code === 0x09) escaped = '\\t';
    else if (code < 0x20) escaped = `\\u${code.toString(16).padStart(4, '0')}`;
    if (escaped === undefined) continue;
    collector.append(value.slice(runStart, index));
    collector.append(escaped);
    runStart = index + 1;
  }
  collector.append(value.slice(runStart));
  collector.append('"');
}

function appendIndent(collector: BoundedTextCollector, depth: number): void {
  collector.append('  '.repeat(depth));
}

function appendJsonValue(
  collector: BoundedTextCollector,
  value: unknown,
  depth: number,
  ancestors: Set<object>,
): void {
  if (value === null) {
    collector.append('null');
    return;
  }
  if (typeof value === 'string') {
    appendJsonString(collector, value);
    return;
  }
  if (typeof value === 'number') {
    collector.append(Number.isFinite(value) ? String(value) : 'null');
    return;
  }
  if (typeof value === 'boolean') {
    collector.append(value ? 'true' : 'false');
    return;
  }
  if (typeof value !== 'object') {
    collector.append('null');
    return;
  }
  if (ancestors.has(value)) {
    appendJsonString(collector, '[Circular]');
    return;
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    collector.append('[');
    for (let index = 0; index < value.length; index += 1) {
      collector.append(index === 0 ? '\n' : ',\n');
      appendIndent(collector, depth + 1);
      appendJsonValue(collector, value[index], depth + 1, ancestors);
    }
    if (value.length > 0) {
      collector.append('\n');
      appendIndent(collector, depth);
    }
    collector.append(']');
  } else {
    const entries = Object.entries(value).filter(
      ([, entry]) =>
        entry !== undefined &&
        typeof entry !== 'function' &&
        typeof entry !== 'symbol',
    );
    collector.append('{');
    entries.forEach(([key, entry], index) => {
      collector.append(index === 0 ? '\n' : ',\n');
      appendIndent(collector, depth + 1);
      appendJsonString(collector, key);
      collector.append(': ');
      appendJsonValue(collector, entry, depth + 1, ancestors);
    });
    if (entries.length > 0) {
      collector.append('\n');
      appendIndent(collector, depth);
    }
    collector.append('}');
  }
  ancestors.delete(value);
}

/**
 * Build only the selectable head/tail projection used by the transcript.
 * Unlike JSON.stringify, this collector never allocates the complete encoded
 * object merely to discard almost all of it.
 */
export function boundedToolResultText(result: unknown): BoundedToolResultText {
  const collector = new BoundedTextCollector();
  if (typeof result === 'string') collector.append(result);
  else appendJsonValue(collector, result, 0, new Set());
  return collector.finish();
}

/**
 * Full encoding is deliberately reachable only from the explicit reveal.
 * The bounded walker tolerates shapes JSON.stringify refuses (cycles,
 * BigInt) — unreachable over the SSE wire today, but the reveal must not
 * throw mid-render where the preview succeeded, so it falls back to the
 * projection it is expanding.
 */
export function fullToolResultText(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result, null, 2) ?? '';
  } catch {
    const bounded = boundedToolResultText(result);
    return bounded.tail ? `${bounded.head}…${bounded.tail}` : bounded.head;
  }
}

export function formatWithheldBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`;
}
