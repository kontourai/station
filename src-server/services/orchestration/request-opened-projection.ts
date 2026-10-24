import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { truncateJsonString } from '../../providers/tool-output-projection.js';
import { MAX_EVENT_STORE_INGRESS_BYTES } from './event-store.js';

/**
 * The compact-JSON size a `request.opened` is projected under. Kept well
 * below EventStore's ingress ceiling: lifecycle normalization stamps a few
 * fields after admission (and again on a contention retry), and the
 * truncation receipt is added after the strings are cut.
 */
export const REQUEST_OPENED_INGRESS_BUDGET_BYTES =
  MAX_EVENT_STORE_INGRESS_BYTES - 16 * 1024;
/** Room kept for the {@link REQUEST_TRUNCATION_KEY} receipt. */
const RECEIPT_RESERVE_BYTES = 2 * 1024;
/**
 * A string at or below this many JSON bytes is never cut. Identifiers, tool
 * names, enum-like kinds and short reasons stay exact, so the fields surfaces
 * and grant derivations read survive any projection.
 */
const MIN_RETAINED_STRING_BYTES = 256;
const MAX_RECEIPT_FIELDS = 16;
/**
 * The payload key a projected request carries. A receipt inside the payload
 * rather than a contract field: every reader already tolerates unknown
 * payload keys, and the visible marker in each cut string is what a person
 * reads.
 */
export const REQUEST_TRUNCATION_KEY = 'stationTruncation';

type Path = (string | number)[];
type Candidate = { path: Path; value: string; bytes: number };

const jsonBytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value) ?? '');

function marker(omittedBytes: number): string {
  return `\n…[Station shortened this value: ${omittedBytes} more bytes not shown]`;
}

/**
 * Make a `request.opened` fit EventStore's ingress ceiling. A Codex MCP tool
 * approval whose params embedded ~38 KB of HTML arguments was refused at
 * ingress, so the person never saw it and the engine waited forever.
 *
 * Every adapter publishes its engine's request arguments verbatim (Codex the
 * raw server-request params, Claude `toolInput`, ACP `rawInput`), and no
 * adapter answers the engine from the persisted copy: each keeps its own raw
 * request for the response and session grant. So the persisted event is a
 * display and inspection record, and may be abbreviated visibly.
 *
 * An event within budget is returned as the same object. Otherwise the
 * longest strings in `title`, `description` and `payload` are cut to one
 * shared byte cap (head kept, explicit marker appended), smallest strings
 * untouched. `payload.inputRequest` is never cut: answers are validated
 * against the stored form, so a person must be shown the exact form the
 * engine asked. A request that still cannot fit (a huge form, or structure
 * rather than text) is returned best-effort, and EventStore refuses it;
 * the caller owns that outcome.
 */
export function projectRequestOpenedForIngress(
  event: CanonicalRuntimeEvent,
): CanonicalRuntimeEvent {
  if (event.method !== 'request.opened') return event;
  let size: number;
  try {
    size = jsonBytes(event);
  } catch {
    // Cyclic or non-JSON data: EventStore's own projector names the refusal.
    return event;
  }
  if (size <= REQUEST_OPENED_INGRESS_BUDGET_BYTES) return event;

  const projected = JSON.parse(JSON.stringify(event)) as typeof event;
  const candidates: Candidate[] = [];
  const collect = (value: unknown, path: Path) => {
    if (typeof value === 'string') {
      const bytes = jsonBytes(value);
      if (bytes > MIN_RETAINED_STRING_BYTES)
        candidates.push({ path, value, bytes });
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => collect(item, [...path, index]));
      return;
    }
    for (const [key, item] of Object.entries(value)) {
      if (path.length === 1 && path[0] === 'payload' && key === 'inputRequest')
        continue;
      collect(item, [...path, key]);
    }
  };
  collect(projected.title, ['title']);
  collect(projected.description, ['description']);
  collect(projected.payload, ['payload']);
  if (candidates.length === 0) return event;

  // Each cut string is at most `cap` JSON bytes, marker included. Find the
  // largest cap whose result fits the target.
  const target = REQUEST_OPENED_INGRESS_BUDGET_BYTES - RECEIPT_RESERVE_BYTES;
  const sizeAt = (cap: number) =>
    candidates.reduce(
      (total, candidate) => total - Math.max(0, candidate.bytes - cap),
      size,
    );
  let low = MIN_RETAINED_STRING_BYTES;
  let high = candidates.reduce(
    (largest, candidate) => Math.max(largest, candidate.bytes),
    MIN_RETAINED_STRING_BYTES,
  );
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (sizeAt(middle) <= target) low = middle;
    else high = middle - 1;
  }
  const cap = low;

  let omittedBytesAtLeast = 0;
  const fields: string[] = [];
  for (const candidate of candidates) {
    if (candidate.bytes <= cap) continue;
    const totalBytes = Buffer.byteLength(candidate.value);
    // The marker's digits never exceed the whole value's; reserve for them.
    const markerBytes = jsonBytes(marker(totalBytes)) - 2;
    const head = truncateJsonString(
      candidate.value,
      Math.max(2, cap - markerBytes),
    ).value;
    const omitted = totalBytes - Buffer.byteLength(head);
    omittedBytesAtLeast += omitted;
    setAt(projected, candidate.path, `${head}${marker(omitted)}`);
    if (fields.length < MAX_RECEIPT_FIELDS)
      fields.push(candidate.path.join('.'));
  }
  projected.payload = {
    ...(projected.payload ?? {}),
    [REQUEST_TRUNCATION_KEY]: {
      truncated: true,
      reason: 'event-store-ingress-ceiling',
      omittedBytesAtLeast,
      fields,
    },
  };
  return projected;
}

function setAt(root: unknown, path: Path, value: string): void {
  let node = root as Record<string | number, unknown>;
  for (const key of path.slice(0, -1))
    node = node[key] as Record<string | number, unknown>;
  node[path[path.length - 1] as string | number] = value;
}
