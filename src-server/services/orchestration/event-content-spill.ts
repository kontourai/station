/**
 * The spill planner for runtime events (docs/design/event-content-spill.md).
 *
 * Input is a data-only JSON copy of a canonical event (EventStore's bounded
 * ingress projector has already refused getters, proxies, cycles and
 * non-JSON data). Output is the stored form: every inbound object that used a
 * reserved key is wrapped as a literal, and large values inside a per-method
 * allowlist of content fields are replaced by references whose bodies the
 * caller writes to `orchestration_event_content` in the append savepoint.
 *
 * The planner is deterministic: the same event always produces the same
 * stored bytes, because EventStore's exact-replay check compares them.
 */
import { createHash } from 'node:crypto';
import {
  RUNTIME_EVENT_CONTENT_KEY,
  RUNTIME_EVENT_CONTENT_LITERAL_KEY,
  type RuntimeEventContentKind,
  type RuntimeEventContentRef,
  type RuntimeEventSpilledContent,
  unescapeRuntimeEventContent,
  usesReservedContentKey,
} from '@kontourai/station-contracts/runtime-event-content';

/** Target size of a stored event; keeps it whole in every window read. */
export const EVENT_STORED_TARGET_BYTES = 16 * 1024;
/**
 * A `tool.completed` an MCP App renders keeps its output inline up to the
 * window per-event ceiling (`SNAPSHOT_EVENT_MAX_SERIALIZED_BYTES`), so the
 * snapshot's App passthrough keeps working.
 */
export const MCP_APP_STORED_TARGET_BYTES = 24_576;
/** A smaller value is never spilled: a reference costs about 600 bytes. */
export const SPILL_MIN_VALUE_BYTES = 1024;
/** Stored-form structure, below the ingress backstop's 32 / 512. */
export const SPILL_MAX_STORED_DEPTH = 24;
export const SPILL_MAX_STORED_ENTRIES = 256;
/** Per-event raw ceiling for engine content (owner decision, 16 MiB). */
export const MAX_EVENT_CONTENT_BYTES = 16 * 1024 * 1024;
export const MAX_EVENT_CONTENT_DEPTH = 256;
export const MAX_EVENT_CONTENT_CONTAINER_ENTRIES = 200_000;
/** Bytes of JSON encoding a preview may take. */
export const SPILL_PREVIEW_MAX_JSON_BYTES = 512;
export const SPILL_PLANNER_VERSION = 1 as const;

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type JsonRecord = { [key: string]: Json };

/**
 * The only roots a planner may spill, per method. Everything else stays
 * inline, including every field that decides what a person is offered
 * (`inputRequest`, `suggestions`, grant fields, `title`), so a form can never
 * turn into a one-click Allow because its questions were moved out.
 */
const SPILLABLE_ROOTS: Readonly<
  Record<string, readonly (readonly string[])[]>
> = {
  'request.opened': [
    ['description'],
    ['payload', 'toolInput'],
    ['payload', 'toolArgs'],
    ['payload', 'rawInput'],
    ['payload', 'arguments'],
    ['payload', 'args'],
    // Codex sends its raw app-server params as the payload.
    ['payload', 'changes'],
    ['payload', 'command'],
    ['payload', 'message'],
    ['payload', '_meta'],
  ],
  'turn.started': [['prompt'], ['ambientContext']],
  'turn.completed': [['outputText']],
  'tool.started': [['arguments']],
  'tool.progress': [['output']],
  'tool.completed': [['output'], ['error']],
  'plan.updated': [['entries']],
  'extension.notification': [['payload']],
};

export function spillableRootsFor(
  method: string,
): readonly (readonly string[])[] {
  return SPILLABLE_ROOTS[method] ?? [];
}

export interface PlannedSpill {
  digest: string;
  kind: RuntimeEventContentKind;
  body: string;
  bytes: number;
}

export interface SpillPlan {
  payload: JsonRecord;
  spills: PlannedSpill[];
  /** Raw `output`/`error` of a `tool.completed` whose value was spilled. */
  spilledToolResult?: { output?: unknown; error?: unknown };
}

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
function jsonCodeUnitBytes(value: string, index: number): number {
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

function previewOf(text: string): string {
  let bytes = 2; // quotes
  let end = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = jsonCodeUnitBytes(text, index);
    if (bytes + unit > SPILL_PREVIEW_MAX_JSON_BYTES) break;
    bytes += unit;
    const code = text.charCodeAt(index);
    const pair =
      code >= 0xd800 &&
      code <= 0xdbff &&
      text.charCodeAt(index + 1) >= 0xdc00 &&
      text.charCodeAt(index + 1) <= 0xdfff;
    if (pair) index += 1;
    end = index + 1;
  }
  return text.slice(0, end);
}

export function contentDigest(
  kind: RuntimeEventContentKind,
  body: string,
): string {
  // The kind is in the preimage: the string `{"a":1}` and the object
  // `{"a":1}` have the same body and must not share a digest.
  return `sha256-${createHash('sha256').update(kind).update('\0').update(body, 'utf8').digest('hex')}`;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep copy with every reserved-key object wrapped as a literal. */
function escapeReserved(value: Json): Json {
  if (Array.isArray(value)) return value.map(escapeReserved);
  if (!isRecord(value)) return value;
  const copy: JsonRecord = {};
  for (const [key, child] of Object.entries(value)) {
    Object.defineProperty(copy, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: escapeReserved(child),
    });
  }
  return usesReservedContentKey(value)
    ? { [RUNTIME_EVENT_CONTENT_LITERAL_KEY]: copy }
    : copy;
}

function jsonBytes(value: Json): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

interface Candidate {
  /** The container holding the value and its key there. */
  parent: JsonRecord | Json[];
  key: string | number;
  path: string;
  value: Json;
  bytes: number;
  depth: number;
}

function buildRef(original: Json): {
  ref: RuntimeEventContentRef;
  spill: PlannedSpill;
} {
  const kind: RuntimeEventContentKind =
    typeof original === 'string' ? 'string' : 'json';
  const body =
    typeof original === 'string' ? original : JSON.stringify(original);
  const bytes = Buffer.byteLength(body, 'utf8');
  const digest = contentDigest(kind, body);
  const ref: RuntimeEventContentRef = {
    [RUNTIME_EVENT_CONTENT_KEY]: 1,
    ref: digest,
    kind,
    bytes,
    ...(typeof original === 'string' ? { length: original.length } : {}),
    ...(Array.isArray(original)
      ? { shape: { type: 'array' as const, size: original.length } }
      : isRecord(original)
        ? {
            shape: {
              type: 'object' as const,
              size: Object.keys(original).length,
            },
          }
        : {}),
    preview: previewOf(body),
  };
  return { ref, spill: { digest, kind, body, bytes } };
}

function resolveRoot(
  payload: JsonRecord,
  path: readonly string[],
): { parent: JsonRecord; key: string } | undefined {
  let node: Json = payload;
  for (let index = 0; index < path.length - 1; index += 1) {
    if (!isRecord(node)) return undefined;
    const next: Json | undefined = node[path[index]!];
    if (next === undefined) return undefined;
    node = next;
  }
  if (!isRecord(node)) return undefined;
  const key = path[path.length - 1]!;
  return Object.hasOwn(node, key) ? { parent: node, key } : undefined;
}

/**
 * Walk a spillable root: spill structurally oversized containers whole and
 * collect every string at least {@link SPILL_MIN_VALUE_BYTES} long.
 */
function walkRoot(
  start: Candidate,
  spillNow: (candidate: Candidate) => void,
  strings: Candidate[],
): void {
  const visit = (candidate: Candidate): void => {
    const { value, depth } = candidate;
    if (typeof value === 'string') {
      const bytes = jsonStringBodyBytes(value) + 2;
      if (bytes >= SPILL_MIN_VALUE_BYTES) strings.push({ ...candidate, bytes });
      return;
    }
    if (!Array.isArray(value) && !isRecord(value)) return;
    // A literal wrapper is part of the stored shape, not engine structure,
    // but it still counts toward depth.
    const entries = Array.isArray(value)
      ? value.length
      : Object.keys(value).length;
    if (entries > SPILL_MAX_STORED_ENTRIES || depth >= SPILL_MAX_STORED_DEPTH) {
      spillNow(candidate);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) =>
        visit({
          parent: value,
          key: index,
          path: `${candidate.path}[${index}]`,
          value: child,
          bytes: 0,
          depth: depth + 1,
        }),
      );
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      visit({
        parent: value,
        key,
        path: `${candidate.path}.${JSON.stringify(key)}`,
        value: child,
        bytes: 0,
        depth: depth + 1,
      });
    }
  };
  visit(start);
}

function setChild(
  parent: JsonRecord | Json[],
  key: string | number,
  value: Json,
) {
  if (Array.isArray(parent)) parent[key as number] = value;
  else
    Object.defineProperty(parent, key as string, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
}

/**
 * Plan the stored form of a data-only canonical event. Never throws for
 * size: the caller's backstop decides whether the result can persist.
 */
export function planEventContentSpill(event: JsonRecord): SpillPlan {
  const payload = escapeRoot(event);
  const method = typeof event.method === 'string' ? event.method : '';
  const target =
    method === 'tool.completed' && typeof event.mcpAppResourceUri === 'string'
      ? MCP_APP_STORED_TARGET_BYTES
      : EVENT_STORED_TARGET_BYTES;
  const spills = new Map<string, PlannedSpill>();
  let total = jsonBytes(payload);
  let spilledToolOutput = false;
  const spill = (candidate: Candidate, original?: Json): number => {
    const before = candidate.bytes || jsonBytes(candidate.value);
    // Bodies hold the original value: literal wrappers exist only in the
    // stored event, never inside a body (resolution is single-level). A
    // candidate from the string or structure pass contains no reference
    // yet, so unescaping it restores the original exactly.
    const { ref, spill: planned } = buildRef(
      original ?? (unescapeRuntimeEventContent(candidate.value) as Json),
    );
    setChild(candidate.parent, candidate.key, ref as unknown as Json);
    if (!spills.has(planned.digest)) spills.set(planned.digest, planned);
    if (
      candidate.path.startsWith('$."output"') ||
      candidate.path.startsWith('$."error"')
    )
      spilledToolOutput = true;
    return before - jsonBytes(ref as unknown as Json);
  };

  const roots = spillableRootsFor(method)
    .map((path) => ({ path, at: resolveRoot(payload, path) }))
    .filter(
      (
        root,
      ): root is {
        path: readonly string[];
        at: { parent: JsonRecord; key: string };
      } => root.at !== undefined,
    );
  const strings: Candidate[] = [];
  for (const root of roots) {
    walkRoot(
      {
        parent: root.at.parent,
        key: root.at.key,
        path: `$.${root.path.map((segment) => JSON.stringify(segment)).join('.')}`,
        value: root.at.parent[root.at.key]!,
        bytes: 0,
        depth: root.path.length,
      },
      (candidate) => {
        total -= spill(candidate);
      },
      strings,
    );
  }
  // Largest strings first keep small sibling leaves (a sandbox flag, a file
  // path) inline; ties fall back to path order for determinism.
  strings.sort(
    (a, b) =>
      b.bytes - a.bytes || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  for (const candidate of strings) {
    if (total <= target) break;
    total -= spill(candidate);
  }
  if (total > target) {
    // Many small values: move whole roots, largest first. A root may
    // already hold references from the passes above, so its body is taken
    // from the raw event, never from the stored form.
    const remaining = roots
      .map((root) => ({
        candidate: {
          parent: root.at.parent as JsonRecord | Json[],
          key: root.at.key as string | number,
          path: `$.${root.path.map((segment) => JSON.stringify(segment)).join('.')}`,
          value: root.at.parent[root.at.key]!,
          bytes: jsonBytes(root.at.parent[root.at.key]!),
          depth: root.path.length,
        },
        original: resolveRoot(event, root.path),
      }))
      .filter(
        ({ candidate, original }) =>
          original !== undefined &&
          candidate.bytes >= SPILL_MIN_VALUE_BYTES &&
          !isSpilledRef(candidate.value),
      )
      .sort(
        (a, b) =>
          b.candidate.bytes - a.candidate.bytes ||
          (a.candidate.path < b.candidate.path ? -1 : 1),
      );
    for (const { candidate, original } of remaining) {
      if (total <= target) break;
      total -= spill(candidate, original!.parent[original!.key]!);
    }
  }
  if (spills.size > 0) {
    const summary: RuntimeEventSpilledContent = {
      v: SPILL_PLANNER_VERSION,
      count: spills.size,
      bytes: [...spills.values()].reduce((sum, item) => sum + item.bytes, 0),
    };
    payload.spilledContent = summary as unknown as Json;
  }
  return {
    payload,
    spills: [...spills.values()],
    ...(spilledToolOutput && method === 'tool.completed'
      ? { spilledToolResult: { output: event.output, error: event.error } }
      : {}),
  };
}

function isSpilledRef(value: Json): boolean {
  return isRecord(value) && value[RUNTIME_EVENT_CONTENT_KEY] === 1;
}

/**
 * The event root is never wrapped. A producer's claim to a reserved key or
 * to `spilledContent` at the root is dropped: both are EventStore's to set.
 */
function escapeRoot(event: JsonRecord): JsonRecord {
  const root: JsonRecord = {};
  for (const [key, child] of Object.entries(event)) {
    if (
      key === RUNTIME_EVENT_CONTENT_KEY ||
      key === RUNTIME_EVENT_CONTENT_LITERAL_KEY ||
      key === 'spilledContent'
    )
      continue;
    Object.defineProperty(root, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: escapeReserved(child),
    });
  }
  return root;
}
