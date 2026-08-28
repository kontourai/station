/**
 * The board face's persisted shape.
 *
 * Design intent (archive#4079): "A board is a face, not an
 * entity. Board state = pinned-widget rows + tab rows keyed on the durable
 * session/Task identity, stored server-side ... Board existence ⇔ rows
 * exist." A board is never a client cache: it is read from and written to
 * the server-side store in `src-server/services/board/board-store.ts`, keyed
 * on the owning {@link BoardReference}.
 *
 * Layout is ORDINAL, never geometric: each widget carries a dense `position`
 * among its tab's widgets (renormalized after every pin/unpin/move) and a
 * `size` preset — the agent's vocabulary is presets and `after: <name>`,
 * never pixels.
 *
 * Two versioning axes, both stored per widget ("replay
 * proofing ... same axes the UI-block contract already stores"):
 *  - `revision` — monotonic CONTENT revision. A pin
 *    creates content at revision 0 (update-in-place, which bumps it, is not
 *    implemented).
 *  - `generation` — a random id stamped at PUT time (materialization
 *    identity). It changes whenever a widget is newly created at an id —
 *    including a delete followed by a re-pin under the same `name` — so a
 *    stale acceptance keyed on an old generation can never be read as
 *    covering the newer bytes.
 */
import type { UIBlock } from './ui-block.js';
import type { WorkReference } from './work-reference.js';

export const BOARD_SCHEMA_VERSION = 1 as const;

/** A board's owner: a durable Task or a Session (design comment's "session/Task identity"). */
export type BoardReference = Extract<
  WorkReference,
  { kind: 'task' | 'session' }
>;

export const BOARD_WIDGET_SIZES = ['sm', 'md', 'lg', 'full'] as const;
export type BoardWidgetSize = (typeof BOARD_WIDGET_SIZES)[number];

export const MAX_BOARD_WIDGETS = 200;
export const MAX_BOARD_TABS = 50;
/** Bound for a widget `name` / tab `title` — mirrors `SpatialBoardStore`'s text bound. */
export const MAX_BOARD_TEXT_BYTES = 512;

export interface BoardTab {
  readonly id: string;
  readonly title: string;
  /** Dense ordinal among this board's tabs (0-based), renormalized after every op. */
  readonly position: number;
}

export interface BoardWidget {
  readonly id: string;
  /**
   * Agent/user-facing stable name. Stored verbatim; the
   * generated-identity collision diversion the design calls out for
   * update-in-place is not implemented.
   */
  readonly name: string;
  readonly tabId: string;
  /** Dense ordinal within its tab (0-based), renormalized after every op. */
  readonly position: number;
  readonly size: BoardWidgetSize;
  /**
   * The pinned provenance-bound UI block (station#1399). Always the
   * HOST-STAMPED block (derivedFrom/provenanceDigest/attestationState
   * already accepted) — never raw, unaccepted agent input.
   */
  readonly block: UIBlock;
  /** Monotonic content revision. */
  readonly revision: number;
  /** Random per put — the materialization identity. */
  readonly generation: string;
  readonly pinnedAt: string;
}

export interface Board {
  readonly schemaVersion: typeof BOARD_SCHEMA_VERSION;
  readonly reference: BoardReference;
  readonly tabs: readonly BoardTab[];
  readonly widgets: readonly BoardWidget[];
}

/**
 * `id`-derived directory segment bound. There is no strict
 * repo-wide slug/id format to allowlist against:
 *  - a Session/conversation id is a caller-supplied, free-form string up to
 *    512 bytes (`src-server/routes/orchestration/orchestration.ts`'s
 *    `conversationId: z.string().min(1).max(512)`), and a real DERIVED
 *    session id legitimately contains colons
 *    (`` `${conversationId}:session:${crypto.randomUUID()}` ``,
 *    `orchestration-service.ts`) — so a strict alnum-only allowlist would
 *    reject production ids, not just attacks.
 *  - a Task id is a `crypto.randomUUID()`-shaped string
 *    (`task-graph-service.ts#createTask`).
 *  - a Task's `projectId` is a Project SLUG (work-reference.ts's own doc:
 *    "a Station Project slug, never a project UUID"), normally
 *    `slugifyProjectName`'s `[a-z0-9-]+` output but NOT strictly enforced
 *    against a caller-supplied slug anywhere in this codebase today
 *    (`project-service.ts#createProject`'s `config.slug?.trim()`).
 *
 * Given that reality, this is a conservative DENYLIST of path-hazardous
 * shapes (empty, exactly `.`/`..`, a path separator, or a control
 * character) rather than a strict allowlist — the same posture
 * `attachments.ts`'s `isAttachmentBlobRef` takes for its own (stricter,
 * because content digests DO have a fixed shape) grammar check: "Shape-check
 * BEFORE the reference reaches anything that touches a path." This is
 * defense LAYER (a) of three (see `board-store.ts`'s `pathFor` for layers
 * (b) containment assert and (c) fixed per-segment prefix, which hold even
 * if this regex regresses).
 */
const MAX_BOARD_ID_BYTES = 512;

// `TextEncoder`, not `Buffer` (browser-safe — this contract is consumed by
// `src-ui`; see `ui-block.ts`'s doc comment for why this package avoids
// Node-only globals).
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function isSafeBoardIdComponent(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0) return false;
  if (utf8ByteLength(value) > MAX_BOARD_ID_BYTES) return false;
  // Exact-value rejection regardless of anything else about the string —
  // the two literal path-traversal tokens.
  if (value === '.' || value === '..') return false;
  // No path separator, and no control character (incl. NUL) anywhere.
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 32 || code === 127) return false;
  }
  return !value.includes('/') && !value.includes('\\');
}

export function isBoardReference(value: unknown): value is BoardReference {
  if (!value || typeof value !== 'object') return false;
  const ref = value as Record<string, unknown>;
  if (ref.kind === 'session') {
    return Object.keys(ref).length === 2 && isSafeBoardIdComponent(ref.id);
  }
  if (ref.kind === 'task') {
    return (
      Object.keys(ref).length === 3 &&
      isSafeBoardIdComponent(ref.id) &&
      isSafeBoardIdComponent(ref.projectId)
    );
  }
  return false;
}
