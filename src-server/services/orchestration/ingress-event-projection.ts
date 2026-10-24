import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { truncateJsonString } from '../../providers/tool-output-projection.js';
import {
  REQUEST_OPENED_SNAPSHOT_MAX_BYTES,
  SNAPSHOT_EVENT_MAX_SERIALIZED_BYTES,
} from './event-store.js';

/**
 * Room kept under each window-read budget below: lifecycle normalization
 * stamps a few fields on the event (again on a contention retry), and a
 * request's receipt is added after its strings are cut.
 */
const BUDGET_HEADROOM_BYTES = 4 * 1024;
/**
 * The compact-JSON size a `request.opened` is projected under. Below the
 * window read's `request.opened` allowance, so a reload or a second device
 * can rebuild the approval card, and so far below EventStore's 64 KiB ingress
 * ceiling.
 */
export const REQUEST_OPENED_PROJECTION_BUDGET_BYTES =
  REQUEST_OPENED_SNAPSHOT_MAX_BYTES - BUDGET_HEADROOM_BYTES;
/**
 * The compact-JSON size a `tool.started` is projected under: below the window
 * read's ordinary per-event ceiling, so the tool row survives a reload.
 */
export const TOOL_STARTED_PROJECTION_BUDGET_BYTES =
  SNAPSHOT_EVENT_MAX_SERIALIZED_BYTES - BUDGET_HEADROOM_BYTES;
/** Room kept for the {@link REQUEST_TRUNCATION_KEY} receipt. */
const RECEIPT_RESERVE_BYTES = 2 * 1024;
/**
 * A string at or below this many JSON bytes is never cut. Identifiers, tool
 * names, paths, enum-like kinds and short reasons stay exact, so the fields
 * surfaces, grant derivations and stored-path queries read survive.
 */
const MIN_RETAINED_STRING_BYTES = 256;
/** Receipt bounds: 16 paths of at most 96 characters fit the reserve. */
const MAX_RECEIPT_FIELDS = 16;
const MAX_RECEIPT_FIELD_CHARS = 96;
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
 * Bound the engine-supplied text an admitted event carries, so it can be
 * stored (EventStore refuses anything over its 64 KiB ingress ceiling) and
 * read back whole by a window read. Adapters publish engine material
 * verbatim: a Codex MCP tool approval embedding ~38 KB of HTML arguments
 * was refused at ingress, so the person never saw it and the engine waited
 * forever, and the `tool.started` that followed it was lost the same way.
 *
 * - `request.opened`: `title`, `description` and `payload`, except
 *   `payload.inputRequest`, which is never cut: answers are validated
 *   against the stored form, so a person must be shown the exact form the
 *   engine asked. A cut request carries a `payload.stationTruncation`
 *   receipt. No adapter answers the engine or mints a grant from the
 *   stored copy (each keeps its raw request).
 * - `tool.started`: `arguments`. The contract has no receipt field, so the
 *   marker in each cut string is the record. Flow policy and command
 *   evidence read the unprojected event (`consumeAdapterEvents`).
 *
 * An event within budget is returned as the same object. Otherwise the
 * longest strings are cut to one shared byte cap (head kept, explicit marker
 * appended); short strings are untouched. An event that still cannot fit (a
 * huge form, or structure rather than text) is returned best-effort and
 * EventStore refuses it; the caller owns that outcome.
 */
export function projectEventForIngress(
  event: CanonicalRuntimeEvent,
): CanonicalRuntimeEvent {
  if (event.method === 'request.opened')
    return project(event, REQUEST_OPENED_PROJECTION_BUDGET_BYTES, true);
  if (event.method === 'tool.started')
    return project(event, TOOL_STARTED_PROJECTION_BUDGET_BYTES, false);
  return event;
}

function project<T extends CanonicalRuntimeEvent>(
  event: T,
  budget: number,
  isRequest: boolean,
): T {
  let size: number;
  try {
    size = jsonBytes(event);
  } catch {
    // Cyclic or non-JSON data: EventStore's own projector names the refusal.
    return event;
  }
  if (size <= budget) return event;

  const projected = JSON.parse(JSON.stringify(event)) as T &
    Record<string, unknown>;
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
      if (
        isRequest &&
        path.length === 1 &&
        path[0] === 'payload' &&
        key === 'inputRequest'
      )
        continue;
      collect(item, [...path, key]);
    }
  };
  for (const root of isRequest
    ? ['title', 'description', 'payload']
    : ['arguments'])
    collect(projected[root], [root]);
  if (candidates.length === 0) return event;

  // Each cut string is at most `cap` JSON bytes, marker included. Find the
  // largest cap whose result fits the target.
  const target = budget - (isRequest ? RECEIPT_RESERVE_BYTES : 0);
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
      fields.push(candidate.path.join('.').slice(0, MAX_RECEIPT_FIELD_CHARS));
  }
  if (isRequest) {
    const payload = projected.payload as Record<string, unknown> | undefined;
    projected.payload = {
      ...(payload ?? {}),
      [REQUEST_TRUNCATION_KEY]: {
        truncated: true,
        reason: 'event-size',
        omittedBytesAtLeast,
        fields,
      },
    };
  }
  return projected;
}

function setAt(root: unknown, path: Path, value: string): void {
  let node = root as Record<string | number, unknown>;
  for (const key of path.slice(0, -1))
    node = node[key] as Record<string | number, unknown>;
  node[path[path.length - 1] as string | number] = value;
}
