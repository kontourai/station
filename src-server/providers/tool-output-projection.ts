import type { ToolOutputReceipt } from '@kontourai/station-contracts/runtime-events';
import {
  INLINE_IMAGE_DATA_PLACEHOLDER,
  redactInlineData,
} from './model-image-attachments.js';

/**
 * Shared bounded-mapping helpers for attached-session transcript sources.
 *
 * A transcript record is engine-written data of unbounded size, and every
 * canonical event must survive EventStore's 64 KiB ingress ceiling — one
 * oversized field used to wedge its source's poll cursor permanently and
 * fail ingestion on every poll (station#2210). Codex and Claude transcript
 * sources therefore map through the SAME byte-safe bounds; the codex source
 * had them first and they moved here verbatim when the claude source needed
 * the identical discipline.
 */

/**
 * Structural projection of engine-supplied tool material: keeps the TAIL of
 * long strings (where command failures and exit summaries usually appear)
 * under a shared byte budget, bounds structure depth and property counts,
 * and reports what was dropped as a {@link ToolOutputReceipt}.
 */
export function projectBoundedToolOutput(input: unknown): {
  value: unknown;
  receipt?: ToolOutputReceipt;
} {
  const reasons = new Set<ToolOutputReceipt['reasons'][number]>();
  const seen = new WeakSet<object>();
  let remaining = 24 * 1024;
  let properties = 128;
  let omittedBytesAtLeast = 0;
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  const walk = (input: unknown, depth: number): unknown => {
    // Image bytes are not text. Every data-URL span in a string is replaced,
    // before the tail below could keep a slice of its base64.
    const value = typeof input === 'string' ? redactInlineData(input) : input;
    if (value !== input) reasons.add('unsupported');
    if (typeof value === 'string') {
      // Count JSON escaping, not only the source's UTF-8 bytes. Keep the tail
      // (where command failures and exit summaries usually appear).
      const budget = Math.min(8192, remaining);
      let low = 0;
      let high = Math.min(value.length, budget);
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (bytes(value.slice(value.length - mid)) <= budget) low = mid;
        else high = mid - 1;
      }
      let start = value.length - low;
      if (start > 0 && /[\uDC00-\uDFFF]/u.test(value[start] ?? '')) start++;
      const result = value.slice(start);
      remaining -= bytes(result);
      if (start > 0) {
        reasons.add('bytes');
        omittedBytesAtLeast +=
          Buffer.byteLength(value) - Buffer.byteLength(result);
      }
      return result;
    }
    if (
      value === null ||
      typeof value === 'boolean' ||
      typeof value === 'number'
    ) {
      remaining -= bytes(value);
      return value;
    }
    if (typeof value !== 'object') {
      reasons.add('unsupported');
      return null;
    }
    if (seen.has(value) || depth >= 6) {
      reasons.add(seen.has(value) ? 'cycle' : 'depth');
      return null;
    }
    seen.add(value);
    const result: Record<string, unknown> | unknown[] = Array.isArray(value)
      ? []
      : {};
    remaining -= 2;
    for (const key of Object.keys(value)) {
      if (properties-- <= 0 || remaining < 128) {
        reasons.add(properties < 0 ? 'properties' : 'bytes');
        break;
      }
      const keyBytes = bytes(key) + 2;
      if (keyBytes > remaining - 128) {
        reasons.add('bytes');
        break;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor)) {
        reasons.add('getter');
        continue;
      }
      remaining -= keyBytes;
      // An image-shaped payload (`{type: 'image', data: <base64>}`) keeps its
      // shape and loses its bytes, wherever in the result it sits.
      const imageBytes =
        key === 'data' &&
        typeof descriptor.value === 'string' &&
        Object.getOwnPropertyDescriptor(value, 'type')?.value === 'image';
      if (imageBytes) reasons.add('unsupported');
      const projected = imageBytes
        ? INLINE_IMAGE_DATA_PLACEHOLDER
        : walk(descriptor.value, depth + 1);
      Object.defineProperty(result, key, {
        value: projected,
        enumerable: true,
        configurable: true,
      });
    }
    return result;
  };
  if (input === undefined) return { value: undefined };
  const value = walk(input, 0);
  return {
    value,
    ...(reasons.size > 0
      ? {
          receipt: {
            truncated: true as const,
            reasons: [...reasons],
            retainedBytes: bytes(value),
            omittedBytesAtLeast,
            omittedUpdates: 0,
            strategy: reasons.has('bytes')
              ? ('utf8-tail' as const)
              : ('structural-omission' as const),
            fullOutput: 'unavailable' as const,
          },
        }
      : {}),
  };
}

/**
 * Head-keep byte-safe truncation for a JSON string value: the retained head
 * never splits a surrogate pair, and escaping is counted, so the result is
 * always valid JSON whose UTF-8 size is within `maxBytes`.
 */
export function truncateJsonString(
  value: string,
  maxBytes: number,
): { value: string; omittedBytes: number } {
  const totalBytes = Buffer.byteLength(value);
  if (Buffer.byteLength(JSON.stringify(value)) <= maxBytes) {
    return { value, omittedBytes: 0 };
  }
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(value.slice(0, middle))) <= maxBytes) {
      low = middle;
    } else high = middle - 1;
  }
  let end = low;
  if (end > 0 && /[\uD800-\uDBFF]/u.test(value[end - 1] ?? '')) end -= 1;
  const retained = value.slice(0, end);
  return {
    value: retained,
    omittedBytes: totalBytes - Buffer.byteLength(retained),
  };
}

/** Split a string into byte-bounded chunks that reassemble to the original. */
export function utf8Chunks(value: string, maxChunkBytes: number): string[] {
  const chunks: string[] = [];
  let remaining = value;
  while (remaining) {
    const chunk = truncateJsonString(remaining, maxChunkBytes).value;
    if (!chunk) break;
    chunks.push(chunk);
    remaining = remaining.slice(chunk.length);
  }
  return chunks;
}

/**
 * A transcript user prompt is the turn's record, so it is bounded with a
 * marker in the event's `metadata` rather than dropped or silently sliced.
 */
export function boundedPrompt(
  value: string,
  options: { maxBytes: number; source: string },
): { value: string; metadata?: Record<string, unknown> } {
  const result = truncateJsonString(value, options.maxBytes);
  return result.omittedBytes > 0
    ? {
        value: result.value,
        metadata: {
          sourceTextTruncated: true,
          omittedUtf8Bytes: result.omittedBytes,
          source: options.source,
        },
      }
    : { value: result.value };
}

/** The key a note takes on an object-shaped output with no `content` list. */
const TOOL_OUTPUT_NOTE_KEY = 'stationNote';

/**
 * Append a note to a tool's output so it appears wherever the output renders.
 * The tool row shows a string as text and anything else as its JSON, so each
 * shape gets the note where that rendering reaches it: appended to a string, a
 * `{type:'text'}` entry on an array or on an MCP-style `content` list, a
 * {@link TOOL_OUTPUT_NOTE_KEY} property on any other object, and the note
 * itself for an absent output. A scalar becomes its text plus the note.
 */
export function appendToolOutputNote(output: unknown, note: string): unknown {
  if (output === undefined || output === null) return note;
  if (typeof output === 'string') return output ? `${output}\n${note}` : note;
  if (Array.isArray(output)) return [...output, { type: 'text', text: note }];
  if (typeof output === 'object') {
    const record = output as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      return {
        ...record,
        content: [...record.content, { type: 'text', text: note }],
      };
    }
    const existing = record[TOOL_OUTPUT_NOTE_KEY];
    return {
      ...record,
      [TOOL_OUTPUT_NOTE_KEY]:
        typeof existing === 'string' && existing
          ? `${existing}\n${note}`
          : note,
    };
  }
  return `${JSON.stringify(output) ?? String(output)}\n${note}`;
}
