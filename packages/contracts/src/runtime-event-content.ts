/**
 * Out-of-line runtime event content (docs/design/event-content-spill.md).
 *
 * EventStore keeps every stored and live runtime event small. A large value in
 * an allowlisted content field is stored once, per thread, and the event keeps
 * a {@link RuntimeEventContentRef} in its place. The reference carries a short
 * preview that is never the full value, so a reader must resolve it, or say
 * that it shows a preview.
 *
 * Inbound engine data that happens to use one of the reserved keys is wrapped
 * in a {@link RuntimeEventContentLiteral}, so a bare `$stationContent` object
 * in a stored payload can only have been written by EventStore. Resolution is
 * single-level: a stored body is the original value and is never interpreted.
 *
 * Every helper here is pure; callers supply the content lookup.
 */

export const RUNTIME_EVENT_CONTENT_KEY = '$stationContent';
export const RUNTIME_EVENT_CONTENT_LITERAL_KEY = '$stationLiteral';

/** `sha256-` plus 64 lowercase hex characters. */
const CONTENT_DIGEST_PATTERN = /^sha256-[0-9a-f]{64}$/;

export type RuntimeEventContentKind = 'string' | 'json';

export interface RuntimeEventContentRef {
  readonly $stationContent: 1;
  readonly ref: string;
  readonly kind: RuntimeEventContentKind;
  /** UTF-8 bytes of the full value (the string, or its compact JSON). */
  readonly bytes: number;
  /** For strings: UTF-16 length of the full value. */
  readonly length?: number;
  /** For json: container type and its item or key count. */
  readonly shape?: {
    readonly type: 'array' | 'object';
    readonly size: number;
  };
  /** A head of the value whose JSON encoding is at most 512 bytes. */
  readonly preview: string;
}

/**
 * A value Station could not keep: over the per-event ceiling, or (on read) a
 * reference whose stored body is missing.
 */
export interface RuntimeEventContentUnavailable {
  readonly $stationContent: 1;
  readonly unavailable: 'exceeds-ceiling' | 'missing';
  readonly bytes?: number;
}

/** An inbound object that used a reserved key, kept verbatim. */
export interface RuntimeEventContentLiteral {
  readonly $stationLiteral: Record<string, unknown>;
}

/** Set on an event by EventStore when it spilled any value. */
export interface RuntimeEventSpilledContent {
  /** Planner version; part of the stored event's replay identity. */
  readonly v: 1;
  readonly count: number;
  readonly bytes: number;
}

/** A stored body as the content table holds it. */
export interface RuntimeEventContentBody {
  readonly kind: RuntimeEventContentKind;
  readonly body: string;
}

export type RuntimeEventContentLookup = (
  ref: string,
) => RuntimeEventContentBody | undefined;

/** A content field: the full value, or a reference to it. */
export type SpillableText = string | RuntimeEventContentRef;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRuntimeEventContentDigest(value: unknown): value is string {
  return typeof value === 'string' && CONTENT_DIGEST_PATTERN.test(value);
}

export function isRuntimeEventContentRef(
  value: unknown,
): value is RuntimeEventContentRef {
  return (
    isPlainRecord(value) &&
    value[RUNTIME_EVENT_CONTENT_KEY] === 1 &&
    isRuntimeEventContentDigest(value.ref) &&
    (value.kind === 'string' || value.kind === 'json') &&
    typeof value.preview === 'string' &&
    typeof value.bytes === 'number'
  );
}

export function isRuntimeEventContentUnavailable(
  value: unknown,
): value is RuntimeEventContentUnavailable {
  return (
    isPlainRecord(value) &&
    value[RUNTIME_EVENT_CONTENT_KEY] === 1 &&
    typeof value.unavailable === 'string'
  );
}

export function isRuntimeEventContentLiteral(
  value: unknown,
): value is RuntimeEventContentLiteral {
  return (
    isPlainRecord(value) &&
    Object.keys(value).length === 1 &&
    isPlainRecord(value[RUNTIME_EVENT_CONTENT_LITERAL_KEY])
  );
}

/** True when an inbound object must be wrapped as a literal at ingress. */
export function usesReservedContentKey(
  value: Record<string, unknown>,
): boolean {
  return (
    Object.hasOwn(value, RUNTIME_EVENT_CONTENT_KEY) ||
    Object.hasOwn(value, RUNTIME_EVENT_CONTENT_LITERAL_KEY)
  );
}

/**
 * Every distinct reference in a stored value, in first-seen order. Does not
 * descend into a reference; does descend into a literal's object.
 */
export function collectRuntimeEventContentRefs(
  value: unknown,
): RuntimeEventContentRef[] {
  const seen = new Map<string, RuntimeEventContentRef>();
  const visit = (node: unknown): void => {
    if (isRuntimeEventContentRef(node)) {
      if (!seen.has(node.ref)) seen.set(node.ref, node);
      return;
    }
    if (isRuntimeEventContentUnavailable(node)) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isPlainRecord(node)) return;
    if (isRuntimeEventContentLiteral(node)) {
      for (const child of Object.values(node.$stationLiteral)) visit(child);
      return;
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return [...seen.values()];
}

/** True when the value holds any reference or unavailable marker. */
export function hasRuntimeEventContentRefs(value: unknown): boolean {
  return collectRuntimeEventContentRefs(value).length > 0;
}

function parseBody(body: RuntimeEventContentBody): unknown {
  return body.kind === 'string' ? body.body : JSON.parse(body.body);
}

/**
 * Replace each reference with its stored value and unwrap literals. A missing
 * body becomes an `unavailable: 'missing'` marker, never the preview.
 */
export function resolveRuntimeEventContent<T>(
  value: T,
  lookup: RuntimeEventContentLookup,
): T {
  const visit = (node: unknown): unknown => {
    if (isRuntimeEventContentRef(node)) {
      const body = lookup(node.ref);
      if (!body || body.kind !== node.kind) {
        return {
          $stationContent: 1,
          unavailable: 'missing',
          bytes: node.bytes,
        } satisfies RuntimeEventContentUnavailable;
      }
      // Single-level: a stored body is the original value, never re-read.
      return parseBody(body);
    }
    if (isRuntimeEventContentUnavailable(node)) return node;
    if (Array.isArray(node)) return node.map(visit);
    if (!isPlainRecord(node)) return node;
    if (isRuntimeEventContentLiteral(node)) {
      return mapRecord(node.$stationLiteral, visit);
    }
    return mapRecord(node, visit);
  };
  return visit(value) as T;
}

/** Unwrap literals only, leaving references in place (display of stored form). */
export function unescapeRuntimeEventContent<T>(value: T): T {
  const visit = (node: unknown): unknown => {
    if (
      isRuntimeEventContentRef(node) ||
      isRuntimeEventContentUnavailable(node)
    )
      return node;
    if (Array.isArray(node)) return node.map(visit);
    if (!isPlainRecord(node)) return node;
    if (isRuntimeEventContentLiteral(node))
      return mapRecord(node.$stationLiteral, visit);
    return mapRecord(node, visit);
  };
  return visit(value) as T;
}

function mapRecord(
  record: Record<string, unknown>,
  visit: (node: unknown) => unknown,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    // defineProperty: a `__proto__` key must stay an own data property.
    Object.defineProperty(out, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: visit(child),
    });
  }
  return out;
}

/** The full string, or `undefined` when the value is a reference or absent. */
export function fullRuntimeEventText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Display text for a content field: the string itself, or a reference's
 * preview. `complete` says whether the text is the whole value.
 */
export function runtimeEventContentText(
  value: unknown,
): { text: string; complete: boolean; bytes?: number } | undefined {
  if (typeof value === 'string') return { text: value, complete: true };
  if (isRuntimeEventContentRef(value))
    return { text: value.preview, complete: false, bytes: value.bytes };
  if (isRuntimeEventContentUnavailable(value))
    return { text: '', complete: false, bytes: value.bytes };
  return undefined;
}

/**
 * Display text for a content field: the value itself, or a reference's
 * preview followed by an explicit omission note, so a reader of an
 * unresolved event never mistakes the preview for the whole value.
 */
export function runtimeEventContentDisplayText(
  value: unknown,
): string | undefined {
  const text = runtimeEventContentText(value);
  if (!text) return undefined;
  if (text.complete) return text.text;
  const note = runtimeEventContentOmissionNote(text.bytes);
  return text.text ? `${text.text}\n${note}` : note;
}

/** Marker appended where a reader shows a preview instead of a value. */
export function runtimeEventContentOmissionNote(
  bytes: number | undefined,
): string {
  return bytes === undefined
    ? '[content not inlined]'
    : `[${bytes} bytes of content not inlined]`;
}
