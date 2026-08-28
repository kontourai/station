/**
 * Provenance-bound UI blocks.
 *
 * Typed, exact references to what a block's rendered claim was derived
 * from. Every kind names a concrete, checkable thing (never a free-text
 * description) so a consumer can actually resolve it against the
 * conversation transcript, a file's content, or a live binding:
 *  - `toolCallId` — the exact tool call whose result produced the value.
 *  - `messageId` — the exact message the value was read from.
 *  - `fileDigest` — a file path plus the content digest read at that path,
 *    so a later edit invalidates the reference instead of silently
 *    re-pointing it.
 *  - `binding` — a live `bindingId` at an exact `revision` (archive#4079's
 *    pin/persistence model; the *generation* axis the design calls out is
 *    materialization-time and is stamped by the host at accept time, not
 *    supplied by the source ref).
 */
import { canonicalizeForDigest } from './fleet-routing-receipt.js';

export type UIBlockProvenanceSourceRef =
  | { kind: 'toolCallId'; toolCallId: string }
  | { kind: 'messageId'; messageId: string }
  | { kind: 'fileDigest'; path: string; digest: string }
  | { kind: 'binding'; bindingId: string; revision: number };

/**
 * Third visual state, distinct from both "attested" and "no data claimed":
 * a purely decorative block renders
 * plainly, a block making data claims WITH a checkable source renders
 * `attested`, and a block making data claims WITHOUT one renders
 * `unattested` — visibly, never as a quiet default.
 *
 * This is always HOST-DERIVED (see {@link deriveUIBlockAttestationState}).
 * A block or tool output may carry a same-shaped value on the wire, but no
 * reader in this codebase may treat that value as authoritative — it is
 * recomputed from the block's own data-bearing fields and `derivedFrom`
 * every time, which is what makes a self-declared `'decorative'` on a
 * data-bearing block a refusal rather than a trusted downgrade.
 *
 * **Precisely what `'attested'` means:** `'attested'` means the host
 * receipted this block's source DECLARATION and bound a digest to it at
 * acceptance time — it does NOT mean the named sources were verified to
 * exist or to actually contain the claimed value. Resolving a
 * `derivedFrom` reference against the real conversation
 * transcript/file/binding it names (the "unauthorized, missing, stale, or
 * unknown references" gaps) is future work, not something `'attested'`
 * claims.
 */
export type UIBlockAttestationState = 'attested' | 'unattested' | 'decorative';

export interface UIBlockBase {
  id?: string;
  title?: string;
  type: string;
  /**
   * Typed, exact source references this block's rendered data claims were
   * derived from. Required whenever {@link isUIBlockDataBearing} is true —
   * see {@link assertUIBlockProvenanceAccepted}, the refusal gate every
   * emission path calls before a data-bearing block is accepted.
   *
 * Stored as the normalized SOURCE LIST, not only its digest, so a later
 * consumer can compute narrowing (a re-render dropping sources) vs. adding
 * (a re-render claiming a new one) without re-deriving it from a hash.
   */
  derivedFrom?: UIBlockProvenanceSourceRef[];
  /**
   * SHA-256 hash over the normalized (deduped, order-independent)
   * `derivedFrom` set — see `src-server/runtime/conversation/ui-block-provenance.ts`
   * for the computation (kept out of this package: `@kontourai/station-contracts`
   * is consumed by `src-ui`, where a `node:crypto` import would not even
   * build — the same reason `channel-assurance.ts` declares its DSSE shape
   * structurally instead of importing a signer). Streaming and persisted
   * copies of a block MUST preserve this value verbatim rather than
   * recompute it — recomputation is a server-only, accept-time operation.
   */
  provenanceDigest?: string;
  /**
   * Host-derived attestation state for this block. Never write this field
   * from agent- or tool-authored input; always derive it with
   * {@link deriveUIBlockAttestationState}.
   */
  attestationState?: UIBlockAttestationState;
}

export interface UICardBlockField {
  label: string;
  value: string;
}

export interface UICardBlock extends UIBlockBase {
  type: 'card';
  body: string;
  fields?: UICardBlockField[];
  tone?: 'default' | 'success' | 'warning' | 'danger';
}

export interface UITableBlock extends UIBlockBase {
  type: 'table';
  caption?: string;
  columns: string[];
  rows: Array<Array<string | number | boolean | null>>;
}

export interface UICodeBlock extends UIBlockBase {
  type: 'code';
  /** Source to display. Rendered as inert, syntax-highlighted text — never executed. */
  code: string;
  /** Highlighting hint (e.g. 'ts', 'json', 'bash'). Unknown/absent → plain text. */
  language?: string;
  /** Optional one-line caption shown above the code (e.g. a file path). */
  caption?: string;
}

export type UIFormFieldType = 'text' | 'textarea' | 'select' | 'checkbox';

export interface UIFormField {
  /** Stable machine name; becomes the key in the submitted payload. */
  name: string;
  /** Human-facing label. */
  label: string;
  type: UIFormFieldType;
  required?: boolean;
  placeholder?: string;
  /** Initial value (string for text/textarea/select, boolean-ish for checkbox). */
  defaultValue?: string;
  /** Choices for `select` (ignored otherwise). */
  options?: string[];
}

export interface UIFormBlock extends UIBlockBase {
  type: 'form';
  fields: UIFormField[];
  /** Submit button label. Defaults to "Submit". */
  submitLabel?: string;
  /** Optional explanatory text rendered above the fields. */
  description?: string;
}

export type UIBlock = UICardBlock | UITableBlock | UICodeBlock | UIFormBlock;

/**
 * The decorative/claiming boundary, derived — not declared: "Unattested
 * must never be the quiet default" — a label the code doesn't derive is a
 * defect.
 *
 * The concrete mechanic: a block is CLAIMING when it carries a structured
 * set of separately-addressable data values that could each be traced to a
 * source and checked — `card.fields` (label/value pairs) and `table.rows`
 * (the table's entire reason to exist). It is DECORATIVE otherwise:
 *  - `card.body` / `code.code` are single opaque prose/text blobs the model
 *    writes directly. There is no sub-value inside them a `derivedFrom`
 *    entry could point at, so requiring provenance on them would only
 *    produce a reference nobody could ever check — the same failure mode
 *    `channel-assurance.ts` calls out for a signature nobody verified.
 *  - `form.fields` are INPUT field definitions (what the user is being
 *    asked to supply), not asserted facts about the world; a form requests
 *    data rather than claiming it.
 *
 * If a later consumer needs a form's `defaultValue` or a code block's
 * content to carry a claim, that is a contract change to make explicitly
 * (a new data-bearing shape), not a silent reinterpretation of this
 * predicate.
 *
 * **Scope, stated precisely:** this predicate attests only structured
 * `card.fields` and `table.rows`. Titles, captions, column headers, form
 * labels/defaults, code, and prose can still carry an unattested claim and
 * are outside this derivation's reach — nothing here inspects them, and no
 * visible state describes them as checked.
 */
export function isUIBlockDataBearing(block: UIBlock): boolean {
  return isRawUIBlockDataBearing(block);
}

/**
 * The same predicate as {@link isUIBlockDataBearing}, operating on an
 * UNTYPED/untrusted candidate rather than an already-validated `UIBlock` —
 * `isUIBlockDataBearing` delegates to this so the two can never drift.
 * Exists for the server-side sanitizer (`ui-block-provenance.ts`'s
 * `sanitizeUIBlockEventProvenance`), which must classify a raw
 * `event.output` object BEFORE any per-type shape validation has run.
 */
export function isRawUIBlockDataBearing(raw: {
  type?: unknown;
  fields?: unknown;
  rows?: unknown;
}): boolean {
  if (raw.type === 'card') {
    return Array.isArray(raw.fields) && raw.fields.length > 0;
  }
  if (raw.type === 'table') {
    return Array.isArray(raw.rows) && raw.rows.length > 0;
  }
  return false;
}

/**
 * The exact digest shape this codebase produces — 64 lowercase hex
 * characters, `computeUIBlockProvenanceDigest`'s and `receipt-chain.ts`'s
 * `computeChainedReceiptId`'s own `createHash('sha256').digest('hex')`
 * output. A `fileDigest` source ref's `digest` field is required to match
 * this shape so it is at minimum digest-shaped, even though it is not
 * (yet) recomputed against the named file's actual bytes — that resolution
 * is future work.
 */
const HEX_SHA256 = /^[0-9a-f]{64}$/;

/** Non-empty after trimming — rejects `''`/whitespace-only identifiers. */
function isNonEmptyIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Parses an arbitrary (untrusted, agent/tool-authored) value into typed
 * source refs, dropping any entry that doesn't match one of the four known
 * shapes OR fails semantic validation (an empty `toolCallId`/`messageId`/
 * `path`, a `digest` that isn't digest-shaped, or a negative/non-integer
 * `revision` is treated as absent, not as a source — `''` and `-1` are not
 * references to anything checkable). Shared by every
 * acceptance path — the server-side `render_component` validator
 * (`src-server/runtime/tools/vended-tool-compat.ts`), the server-side
 * event-provenance sanitizer (`src-server/runtime/conversation/ui-block-provenance.ts`),
 * and the client-side extraction path that normalizes ANY tool's output
 * (`packages/sdk/src/query-domains/uiBlocks.ts`) — so all three never define
 * "what counts as a source ref" differently. An unrecognized/invalid entry
 * doesn't fail the whole block; it just doesn't count as a source, which is
 * correct for the refusal/unattested paths downstream: a data-bearing block
 * whose only "sources" were unrecognized or invalid ends up with an empty
 * list.
 */
export function parseUIBlockSourceRefs(
  input: unknown,
): UIBlockProvenanceSourceRef[] {
  if (!Array.isArray(input)) {
    return [];
  }
  const refs: UIBlockProvenanceSourceRef[] = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const r = entry as Record<string, unknown>;
    if (r.kind === 'toolCallId' && isNonEmptyIdentifier(r.toolCallId)) {
      refs.push({ kind: 'toolCallId', toolCallId: r.toolCallId });
    } else if (r.kind === 'messageId' && isNonEmptyIdentifier(r.messageId)) {
      refs.push({ kind: 'messageId', messageId: r.messageId });
    } else if (
      r.kind === 'fileDigest' &&
      isNonEmptyIdentifier(r.path) &&
      typeof r.digest === 'string' &&
      HEX_SHA256.test(r.digest)
    ) {
      refs.push({ kind: 'fileDigest', path: r.path, digest: r.digest });
    } else if (
      r.kind === 'binding' &&
      isNonEmptyIdentifier(r.bindingId) &&
      typeof r.revision === 'number' &&
      Number.isInteger(r.revision) &&
      r.revision >= 0
    ) {
      refs.push({
        kind: 'binding',
        bindingId: r.bindingId,
        revision: r.revision,
      });
    }
  }
  return refs;
}

/**
 * Sort/dedupe key for one source ref — used only to derive a stable key,
 * this is NOT a digest and must not be used as one.
 *
 * A hand-joined string (`` `fileDigest ${path} ${digest}` ``) is
 * ambiguous — a delimiter that can also appear INSIDE a field value
 * collides two different refs onto the same key: `{ path: 'a', digest:
 * 'b c' }` and `{ path: 'a b', digest: 'c' }` both join to
 * `"fileDigest a b c"`, so normalizing `[refA, refB]` would silently drop
 * one as a "duplicate". `canonicalizeForDigest` + `JSON.stringify`
 * is a real serialization with string-escaping, so two structurally
 * different refs cannot collide onto the same bytes.
 */
function sourceRefSortKey(ref: UIBlockProvenanceSourceRef): string {
  return JSON.stringify(canonicalizeForDigest(ref));
}

/**
 * Normalizes a `derivedFrom` set into a deduped, order-independent list:
 * sorted by a stable per-ref key and de-duplicated on that same key. This
 * is what makes the digest (computed over this normalized list — see
 * `src-server/runtime/conversation/ui-block-provenance.ts`) stable under
 * source-order permutation, and is pure/browser-safe so both the
 * server-side accept path and any future client-side check can share it.
 */
export function normalizeUIBlockSourceRefs(
  refs: readonly UIBlockProvenanceSourceRef[],
): UIBlockProvenanceSourceRef[] {
  const seen = new Map<string, UIBlockProvenanceSourceRef>();
  for (const ref of refs) {
    seen.set(sourceRefSortKey(ref), ref);
  }
  return Array.from(seen.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, ref]) => ref);
}

/**
 * Pure derivation — ALWAYS recomputed, NEVER read off a pre-existing
 * `attestationState` on the input (that field, if present, is agent/tool
 * output and untrusted; see {@link assertUIBlockProvenanceAccepted} for the
 * refusal this asymmetry backs).
 */
export function deriveUIBlockAttestationState(
  block: UIBlock,
): UIBlockAttestationState {
  if (!isUIBlockDataBearing(block)) {
    return 'decorative';
  }
  return block.derivedFrom && block.derivedFrom.length > 0
    ? 'attested'
    : 'unattested';
}

/**
 * Named refusal error for the provenance-claiming boundary — the same
 * refusal STYLE `vended-tool-compat.ts#validateUIBlock` already uses for a
 * malformed block (a descriptive `Error` the agent tool-call surfaces as a
 * correctable failure), but typed and named so a caller can distinguish
 * "you lied about provenance" from "you sent bad shape" if it needs to.
 */
export class UIBlockProvenanceRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UIBlockProvenanceRefusedError';
  }
}

/**
 * The synchronous, agent-facing refusal gate ("A block emission without
 * provenance is refused at the contract layer, the same way a malformed
 * block is refused"). Called by the
 * emission path that CAN reject a call and let the caller retry
 * (`render_component`) — not by the passive extraction path that has
 * nothing to reject a call on (`extractUIBlocks`/`normalizeUIBlock`, which
 * instead renders a claiming-without-provenance block `unattested` rather
 * than dropping it silently; see `packages/sdk/src/query-domains/uiBlocks.ts`).
 *
 * Two refusals, both named in the thrown message so the agent can act on
 * it the same way it acts on a shape error:
 *  1. The block is data-bearing and carries no `derivedFrom` at all — a
 *     fabricated-value-no-source emission.
 *  2. The block is data-bearing and the RAW INPUT self-declares
 *     `'decorative'` attestation — attestation is host-derived, never
 *     block-declared, and a data-bearing block claiming to be decorative is
 *     treated as a lie, not a trusted downgrade.
 *
 * `declaredAttestation` is read only to detect case 2; it is discarded
 * afterward and never assigned onto the returned block.
 *
 * `surfaceName` names the emission surface in
 * the thrown message — defaults to `'render_component'` so the original
 * caller (`vended-tool-compat.ts`) is byte-identical, while a second
 * refusal-capable boundary (`board_pin`) passes its own name
 * rather than lying about which surface refused the call.
 */
export function assertUIBlockProvenanceAccepted(
  block: UIBlock,
  declaredAttestation: unknown,
  surfaceName = 'render_component',
): void {
  if (!isUIBlockDataBearing(block)) {
    return;
  }
  if (declaredAttestation === 'decorative') {
    throw new UIBlockProvenanceRefusedError(
      `${surfaceName}: a '${block.type}' block with data-bearing fields cannot declare itself 'decorative' — attestation is derived by the host, never declared by the block.`,
    );
  }
  if (!block.derivedFrom || block.derivedFrom.length === 0) {
    throw new UIBlockProvenanceRefusedError(
      `${surfaceName}: a '${block.type}' block claiming data values requires 'derivedFrom' source references; emission without them is refused.`,
    );
  }
}
