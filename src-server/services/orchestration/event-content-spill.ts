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
  runtimeEventStoredText,
  unescapeRuntimeEventContent,
  usesReservedContentKey,
} from '@kontourai/station-contracts/runtime-event-content';
import {
  jsonCodeUnitBytes,
  jsonStringBodyBytes,
} from '../../utils/json-text-bytes.js';

export {
  jsonStringBodyBytes,
  splitJsonTextByEscapedBytes,
} from '../../utils/json-text-bytes.js';

/** Target size of a stored event; keeps it whole in every window read. */
export const EVENT_STORED_TARGET_BYTES = 16 * 1024;
/**
 * A `tool.completed` an MCP App renders keeps its output inline up to the
 * window per-event ceiling (`SNAPSHOT_EVENT_MAX_SERIALIZED_BYTES`), so the
 * snapshot's App passthrough keeps working.
 */
const MCP_APP_STORED_TARGET_BYTES = 24_576;
/** A smaller value is never spilled: a reference costs about 600 bytes. */
const SPILL_MIN_VALUE_BYTES = 1024;
/** Stored-form structure, below the ingress backstop's 32 / 512. */
const SPILL_MAX_STORED_DEPTH = 24;
const SPILL_MAX_STORED_ENTRIES = 256;
/** Per-event raw ceiling for engine content (owner decision, 16 MiB). */
export const MAX_EVENT_CONTENT_BYTES = 16 * 1024 * 1024;
export const MAX_EVENT_CONTENT_DEPTH = 256;
export const MAX_EVENT_CONTENT_CONTAINER_ENTRIES = 200_000;
/** Bytes of JSON encoding a preview may take. */
const SPILL_PREVIEW_MAX_JSON_BYTES = 512;
const SPILL_PLANNER_VERSION = 1 as const;

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
  // request.opened's roots are computed per event: see requestOpenedRoots.
  'turn.started': [['prompt'], ['ambientContext']],
  'turn.completed': [['outputText']],
  'tool.started': [['arguments']],
  'tool.progress': [['output']],
  'tool.completed': [['output'], ['error']],
  'plan.updated': [['entries']],
  'extension.notification': [['payload']],
};

/**
 * Payload fields a surface reads from the STORED request, before it has
 * loaded anything: whether it is a form and what the form asks, the tool it
 * names and the call it binds to, and the grant options. They are never
 * spilled. Everything else in an approval payload (tool arguments, Codex's
 * `command`, `commandActions`, `changes`, `permissions`, elicitation `_meta`
 * including `tool_params` and `tool_params_display`, ACP `rawInput` and
 * `content`, and any field a future engine adds) may be, because no surface
 * offers Allow before it has loaded the whole request.
 */
const REQUEST_DECISION_FIELDS = new Set([
  'inputRequest',
  'mcpElicitation',
  'questionnaire',
  'requestedSchema',
  'toolName',
  'tool',
  'toolCallId',
  'suggestions',
  'claudeAsk',
  'permissionMode',
  'options',
  'agentId',
  // Codex: what kind of approval this is and the amendments a grant applies.
  'kind',
  'networkApprovalContext',
  'proposedExecpolicyAmendment',
  'proposedNetworkPolicyAmendments',
]);

function requestOpenedRoots(event: JsonRecord): string[][] {
  const payload = event.payload;
  return [
    ['description'],
    ...(isRecord(payload)
      ? Object.keys(payload)
          .filter((key) => !REQUEST_DECISION_FIELDS.has(key))
          .sort()
          .map((key) => ['payload', key])
      : []),
  ];
}

function spillableRootsFor(
  method: string,
  event?: JsonRecord,
): readonly (readonly string[])[] {
  if (method === 'request.opened')
    return event ? requestOpenedRoots(event) : [];
  return SPILLABLE_ROOTS[method] ?? [];
}

/**
 * The residual case (docs/design/event-content-spill.md#residual-refusal):
 * the event with every present spillable root replaced by an
 * `exceeds-ceiling` marker, so it can still be stored. Undefined when the
 * method has no spillable root present (nothing to mark).
 */
export function withUnavailableContent<T extends { method: string }>(
  event: T,
): T | undefined {
  let changed = false;
  const copy = { ...(event as Record<string, unknown>) };
  for (const path of spillableRootsFor(
    event.method,
    isRecord(event) ? event : undefined,
  )) {
    let node: Record<string, unknown> = copy;
    for (let index = 0; index < path.length - 1; index += 1) {
      const next = node[path[index]!];
      if (!next || typeof next !== 'object' || Array.isArray(next)) {
        node = undefined as never;
        break;
      }
      const cloned = { ...(next as Record<string, unknown>) };
      node[path[index]!] = cloned;
      node = cloned;
    }
    const key = path[path.length - 1]!;
    if (!node || !Object.hasOwn(node, key)) continue;
    node[key] = {
      [RUNTIME_EVENT_CONTENT_KEY]: 1,
      unavailable: 'exceeds-ceiling',
    };
    changed = true;
  }
  return changed ? (copy as T) : undefined;
}

export interface PlannedSpill {
  digest: string;
  kind: RuntimeEventContentKind;
  body: string;
  bytes: number;
}

export interface SpillPlan<T extends object = JsonRecord> {
  payload: T;
  spills: PlannedSpill[];
  /** Raw `output`/`error` of a `tool.completed` whose value was spilled. */
  spilledToolResult?: { output?: unknown; error?: unknown };
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

/**
 * The viewed-content digest of a stored event (see `viewedContentDigest` on
 * the respond command): sha256 of its stored text.
 */
export function storedEventDigest(event: unknown): string {
  return `sha256-${createHash('sha256').update(runtimeEventStoredText(event), 'utf8').digest('hex')}`;
}

function contentDigest(kind: RuntimeEventContentKind, body: string): string {
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

/** A high surrogate not followed by a low one, or a low one not preceded by a high one. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function buildRef(original: Json): {
  ref: JsonRecord;
  spill: PlannedSpill;
} {
  // A string with a lone surrogate has no UTF-8 form: SQLite TEXT and the
  // digest would both turn it into U+FFFD. It is stored as JSON instead,
  // whose escapes keep it exactly; the body and digest preimage are then
  // ASCII-safe for those code units.
  const plainText =
    typeof original === 'string' && !LONE_SURROGATE.test(original);
  const kind: RuntimeEventContentKind = plainText ? 'string' : 'json';
  const body = plainText ? (original as string) : JSON.stringify(original);
  const bytes = Buffer.byteLength(body, 'utf8');
  const digest = contentDigest(kind, body);
  // Built as JSON data in the `RuntimeEventContentRef` shape (the contracts
  // guard `isRuntimeEventContentRef` is what readers check).
  const ref: JsonRecord = {
    [RUNTIME_EVENT_CONTENT_KEY]: 1,
    ref: digest,
    kind,
    bytes,
    ...(typeof original === 'string' ? { length: original.length } : {}),
    ...(Array.isArray(original)
      ? { shape: { type: 'array', size: original.length } }
      : isRecord(original)
        ? {
            shape: {
              type: 'object',
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
export function planEventContentSpill<T extends object>(
  input: T,
  options: { trustedUnavailableRoots?: boolean } = {},
): SpillPlan<T> {
  // A data-only copy (EventStore's bounded projector made it), read as JSON.
  const event = input as JsonRecord;
  const payload = escapeRoot(event);
  if (options.trustedUnavailableRoots) restoreUnavailableRoots(payload);
  const method = typeof event.method === 'string' ? event.method : '';
  const target =
    method === 'tool.completed' && typeof event.mcpAppResourceUri === 'string'
      ? MCP_APP_STORED_TARGET_BYTES
      : EVENT_STORED_TARGET_BYTES;
  // Each planned body with the stored paths that reference it, so a body
  // whose every reference was later swallowed by a whole-field spill is
  // dropped rather than written unreferenced.
  const spills = new Map<
    string,
    { planned: PlannedSpill; paths: Set<string> }
  >();
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
    setChild(candidate.parent, candidate.key, ref);
    for (const [digest, entry] of spills) {
      for (const path of entry.paths)
        if (
          path.startsWith(`${candidate.path}.`) ||
          path.startsWith(`${candidate.path}[`)
        )
          entry.paths.delete(path);
      if (entry.paths.size === 0) spills.delete(digest);
    }
    const entry = spills.get(planned.digest) ?? { planned, paths: new Set() };
    entry.paths.add(candidate.path);
    spills.set(planned.digest, entry);
    if (
      candidate.path.startsWith('$."output"') ||
      candidate.path.startsWith('$."error"')
    )
      spilledToolOutput = true;
    return before - jsonBytes(ref);
  };

  const roots = spillableRootsFor(method, event)
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
    // The `RuntimeEventSpilledContent` shape, as JSON data.
    payload.spilledContent = {
      v: SPILL_PLANNER_VERSION,
      count: spills.size,
      bytes: [...spills.values()].reduce(
        (sum, item) => sum + item.planned.bytes,
        0,
      ),
    };
  }
  return {
    // The stored form keeps the event's shape: only content values became
    // references and reserved-key objects became literals.
    payload: payload as T,
    spills: [...spills.values()].map((entry) => entry.planned),
    ...(spilledToolOutput && method === 'tool.completed'
      ? { spilledToolResult: { output: event.output, error: event.error } }
      : {}),
  };
}

/**
 * An event EventStore itself marked for the residual case carries
 * `exceeds-ceiling` markers at its spillable roots. Escaping wrapped them as
 * engine data; for that event only, they are restored as markers.
 */
function restoreUnavailableRoots(payload: JsonRecord): void {
  const method = typeof payload.method === 'string' ? payload.method : '';
  for (const path of spillableRootsFor(method, payload)) {
    const at = resolveRoot(payload, path);
    if (!at) continue;
    const value = at.parent[at.key];
    const inner =
      isRecord(value) && Object.keys(value).length === 1
        ? value[RUNTIME_EVENT_CONTENT_LITERAL_KEY]
        : undefined;
    if (
      isRecord(inner) &&
      inner[RUNTIME_EVENT_CONTENT_KEY] === 1 &&
      inner.unavailable === 'exceeds-ceiling' &&
      Object.keys(inner).length === 2
    )
      setChild(at.parent, at.key, inner);
  }
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
