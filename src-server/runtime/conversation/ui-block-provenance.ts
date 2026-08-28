/**
 * archive#1399 — server-only digest computation for provenance-bound
 * UI blocks.
 *
 * Kept out of `packages/contracts/src/ui-block.ts` on purpose:
 * `@kontourai/station-contracts` is consumed by `src-ui`, where a
 * `node:crypto` import would not even build (`channel-assurance.ts`
 * declares its DSSE shape structurally for the identical reason). So the
 * PURE parts — the source-ref type, the data-bearing predicate, the
 * order-independent normalization, and the derivation of
 * `UIBlockAttestationState` — live in the contract and are browser-safe;
 * only the actual SHA-256 hashing lives here, server-side, reusing the same
 * hashing idiom `receipt-chain.ts` already established for this repo's
 * "receipted, not signed" discipline: `createHash('sha256')` over a
 * canonicalized (sorted-key) JSON projection.
 *
 * The client (`packages/sdk/src/query-domains/uiBlocks.ts`) never
 * recomputes this digest — it only ever passes an already-computed
 * `provenanceDigest` through verbatim, which is what keeps a streamed copy
 * and a persisted/reloaded copy of the same block provenance-identical
 * (archive#1399 Core Contract bullet 2 / R2).
 */

import { createHash } from 'node:crypto';
import { canonicalizeForDigest } from '@kontourai/station-contracts/fleet-routing-receipt';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import {
  assertUIBlockProvenanceAccepted,
  deriveUIBlockAttestationState,
  isRawUIBlockDataBearing,
  isUIBlockDataBearing,
  normalizeUIBlockSourceRefs,
  parseUIBlockSourceRefs,
  type UIBlock,
  type UIBlockProvenanceSourceRef,
} from '@kontourai/station-contracts/ui-block';
import type {
  ConversationMessage,
  MessagePart,
} from '@kontourai/station-shared/conversation-message';

/** Every seam below reports failures through this shape; never required. */
export type UIBlockProvenanceWarn = (
  message: string,
  meta: Record<string, unknown>,
) => void;

/** A warning callback must never itself be the reason sanitization throws. */
function warnSafely(
  onWarn: UIBlockProvenanceWarn | undefined,
  message: string,
  meta: Record<string, unknown>,
): void {
  try {
    onWarn?.(message, meta);
  } catch {
    // Logging failed. The caller already has a safe fallback in hand; a
    // logging bug must not turn into an unsanitized publish.
  }
}

/**
 * SHA-256 hash (hex) over the normalized `derivedFrom` set. Normalizing
 * BEFORE canonicalizing/hashing is what makes the digest stable under
 * source-order permutation (`normalizeUIBlockSourceRefs` sorts on a stable
 * per-ref key and dedupes) while still changing whenever the actual source
 * SET changes — an added, removed, or altered ref changes at least one
 * entry of the sorted list, which changes the canonicalized bytes.
 */
export function computeUIBlockProvenanceDigest(
  sources: readonly UIBlockProvenanceSourceRef[],
): string {
  const normalized = normalizeUIBlockSourceRefs(sources);
  return createHash('sha256')
    .update(JSON.stringify(canonicalizeForDigest(normalized)))
    .digest('hex');
}

/**
 * The host-owned provenance ACCEPT step (archive#1399, promoted here
 * archive#4079 so a second refusal-capable, agent/tool-facing
 * emission boundary can reuse it instead of re-deriving its own copy of
 * "what counts as accepted"). Originally private to
 * `vended-tool-compat.ts#validateUIBlock` (`render_component`); now also
 * called by the board pin boundary (`routes/board.ts`, before `BoardStore`
 * is ever touched) per the archive#4079 design comment: "Pinning a claiming
 * block requires its provenance to be present (the archive#1399 refusal applies at
 * pin, not just at render)". Both callers hand it a raw, per-type-shape-
 * validated block plus the caller's raw (untrusted)
 * `derivedFrom`/`attestationState` input; neither is ever trusted verbatim.
 *
 * Throws {@link UIBlockProvenanceRefusedError} (re-exported from the
 * contract, unchanged) for a data-bearing block with no `derivedFrom`, or one
 * whose raw input self-declares `'decorative'` attestation. A block that
 * clears the gate gets the NORMALIZED source list, a freshly-derived
 * `provenanceDigest`, and `attestationState` stamped on — all computed here,
 * never trusted from input.
 *
 * `surfaceName` (fix round, C6) names the refusing surface in the thrown
 * message — defaults to `'render_component'` (byte-identical for the
 * original caller); `board_pin` passes its own name.
 */
export function acceptUIBlockProvenance<T extends UIBlock>(
  block: T,
  rawDerivedFrom: unknown,
  declaredAttestation: unknown,
  surfaceName = 'render_component',
): T {
  const sources = normalizeUIBlockSourceRefs(
    parseUIBlockSourceRefs(rawDerivedFrom),
  );
  const withSources: T = isUIBlockDataBearing(block)
    ? { ...block, derivedFrom: sources }
    : block;

  assertUIBlockProvenanceAccepted(
    withSources,
    declaredAttestation,
    surfaceName,
  );

  const attestationState = deriveUIBlockAttestationState(withSources);
  const provenanceDigest =
    attestationState === 'decorative' || sources.length === 0
      ? undefined
      : computeUIBlockProvenanceDigest(sources);

  return { ...withSources, provenanceDigest, attestationState };
}

const KNOWN_UI_BLOCK_TYPES = new Set(['card', 'table', 'code', 'form']);

/**
 * Recomputes `derivedFrom`/`provenanceDigest`/`attestationState` on ONE raw
 * (untrusted) block candidate, UNCONDITIONALLY discarding whatever the
 * candidate itself supplied for those three fields — archive#1399 fix
 * round, H1: minting `'attested'` from mere source PRESENCE, and trusting a
 * tool-supplied `provenanceDigest` string verbatim, let any tool (not just
 * the host-validated `render_component`) stamp its own output "attested"
 * with a digest that is not even a real hash of anything (proven live: an
 * arbitrary `'aaa...'` string survived as the displayed digest). This is
 * the single place that is allowed to produce `'attested'` — see
 * {@link sanitizeUIBlockEventProvenance} for why it runs exactly once, at
 * the one seam every tool-emitted UI block passes through before
 * persistence or delivery.
 *
 * Every other field on the candidate (title, body, fields' label/value
 * pairs, rows, etc.) passes through untouched — this is provenance
 * sanitization, not full block re-validation; `render_component`'s own
 * shape validator and the client's defensive `extractUIBlocks` still own
 * shape correctness.
 */
function sanitizeRawUIBlockCandidate(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const block = raw as Record<string, unknown>;
  if (!KNOWN_UI_BLOCK_TYPES.has(block.type as string)) return raw;

  if (!isRawUIBlockDataBearing(block)) {
    const { derivedFrom: _d, provenanceDigest: _p, ...rest } = block;
    return { ...rest, attestationState: 'decorative' };
  }

  const sources = normalizeUIBlockSourceRefs(
    parseUIBlockSourceRefs(block.derivedFrom),
  );
  if (sources.length === 0) {
    return {
      ...block,
      derivedFrom: undefined,
      provenanceDigest: undefined,
      attestationState: 'unattested',
    };
  }
  return {
    ...block,
    derivedFrom: sources,
    provenanceDigest: computeUIBlockProvenanceDigest(sources),
    attestationState: 'attested',
  };
}

/**
 * The `{uiBlock}`/`{uiBlocks}` carrier shape, optionally AI-SDK-json-wrapped.
 * Exported (archive#1399 fix round 2, B2) so the message-serving seam
 * (`sanitizeConversationMessagesUIBlockProvenance` below) can apply the
 * identical logic to a `MessagePart.output`, not only to a
 * `CanonicalRuntimeEvent.output` — the two writers must never define
 * "what counts as sanitized" differently.
 */
export function sanitizeUIBlockCarrierOutput(output: unknown): unknown {
  if (!output || typeof output !== 'object') return output;
  const root = output as { type?: unknown; value?: unknown };
  const wrapped =
    root.type === 'json' && root.value && typeof root.value === 'object';
  const carrier = (wrapped ? root.value : output) as {
    uiBlock?: unknown;
    uiBlocks?: unknown;
  };
  if (carrier.uiBlock === undefined && !Array.isArray(carrier.uiBlocks)) {
    // Nothing this function recognizes — every other field of a generic
    // tool's output rides through `publishCanonicalEvent` completely
    // untouched; this seam only ever looks at the ui-block carrier shape.
    return output;
  }
  const sanitizedCarrier = {
    ...carrier,
    ...(carrier.uiBlock !== undefined
      ? { uiBlock: sanitizeRawUIBlockCandidate(carrier.uiBlock) }
      : {}),
    ...(Array.isArray(carrier.uiBlocks)
      ? { uiBlocks: carrier.uiBlocks.map(sanitizeRawUIBlockCandidate) }
      : {}),
  };
  return wrapped ? { ...root, value: sanitizedCarrier } : sanitizedCarrier;
}

/**
 * archive#1399 fix round — a provenance-sanitizing writer, not THE single
 * writer (fix round 2, B1/B3 correction of the original docblock's
 * overclaim: `OrchestrationService#publishCanonicalEvent` is one of at
 * least two writers that persist/publish a `tool.completed` event —
 * `AttachedSessionFollowService#appendAndPublish`
 * (`src-server/services/orchestration/attached-session-follow-service.ts`)
 * is a second, independent one that imports Claude-transcript-sourced
 * events and writes them with its own `appendEventIfAbsent` + event-bus
 * emit. Every writer must call this — or its `safeSanitizeUIBlockEventProvenance`
 * wrapper — immediately before its own append+publish; see
 * `writer-inventory.test.ts` for the enumerated, ratcheted list.
 *
 * Sanitizing here — rather than trusting either the SDK's client-side
 * `extractUIBlocks` or the tool that produced the output — means:
 *
 *  - A generic (non-`render_component`) tool cannot mint its own `'attested'`
 *    state or display an arbitrary string as a "digest": every claiming
 *    block's `provenanceDigest` is a REAL `computeUIBlockProvenanceDigest`
 *    result over the block's own (parsed, semantically-validated, deduped)
 *    `derivedFrom`, or absent.
 *  - `render_component`'s OWN output (already sanitized once inside its
 *    `execute()`, archive#1399) is sanitized again here,
 *    idempotently — recomputing the identical digest over the identical
 *    normalized source list is a pure function of that list, so this is a
 *    safe no-op re-stamp, not a second, possibly-divergent source of truth.
 *  - A supplied `attestationState`/`provenanceDigest` in EITHER wrong
 *    direction is discarded — a data-bearing block that self-declares
 *    `'unattested'`/`'decorative'` despite carrying valid sources is
 *    corrected to `'attested'` here just as surely as a forged `'attested'`
 *    is corrected down (M6: the host-derived state wins in both
 *    directions, not just the one that looks like an attack).
 *  - At the `publishCanonicalEvent` writer, persistence and the live SSE
 *    frame are the SAME call, so a streamed and persisted/replayed copy of
 *    a block from THAT writer are provenance-identical by construction (R2).
 *
 * **What this function alone does NOT close (fix round 2, B2):** a message
 * served from the FileMemory/`ConversationMessage` store
 * (`src-server/adapters/file/memory-adapter-messages.ts`) never becomes a
 * `CanonicalRuntimeEvent` at all — it is read back and served directly by
 * `conversations.ts`'s `/messages` route. That path is sanitized separately,
 * at SERVE time, by {@link sanitizeConversationMessagesUIBlockProvenance}
 * below — see that function's docblock for why serve-time (not only
 * write-time) sanitization is required there.
 *
 * Non-`tool.completed` events, and `tool.completed` events whose `output`
 * carries no `uiBlock`/`uiBlocks`, pass through with the exact same object
 * reference (no allocation) — this is deliberately narrow, not a general
 * event transform.
 *
 * Throws on a malformed candidate that defeats even the lenient parsers
 * above (e.g. a poisoned getter). Production call sites MUST use
 * {@link safeSanitizeUIBlockEventProvenance} instead — B4 (fix round 2):
 * an adapter stream must never drop an event or die because of this.
 */
export function sanitizeUIBlockEventProvenance(
  event: CanonicalRuntimeEvent,
): CanonicalRuntimeEvent {
  if (event.method !== 'tool.completed') return event;
  if (event.output === undefined) return event;
  const sanitizedOutput = sanitizeUIBlockCarrierOutput(event.output);
  if (sanitizedOutput === event.output) return event;
  return { ...event, output: sanitizedOutput };
}

/**
 * Ultra-defensive, non-recomputing "blank it" fallback for ONE raw
 * candidate — archive#1399 fix round 2, B4. Deliberately does NOT call
 * {@link isRawUIBlockDataBearing}/`parseUIBlockSourceRefs`/
 * `computeUIBlockProvenanceDigest` (the functions a poisoned getter is
 * likely to have thrown from) — it only ever reads `.type` and spreads the
 * object once. If even that throws, the caller (an outer try/catch) drops
 * to the coarser "strip the whole output" fallback rather than propagate.
 */
function forceUIBlockCandidateUnattested(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const block = raw as Record<string, unknown>;
  if (!KNOWN_UI_BLOCK_TYPES.has(block.type as string)) return raw;
  return {
    ...block,
    derivedFrom: undefined,
    provenanceDigest: undefined,
    attestationState: 'unattested',
  };
}

/**
 * The same ultra-defensive fallback, applied to a whole carrier output.
 * Two layers of defense: if blanking the recognized candidates throws too
 * (the poisoned property surviving into the `{...block}` spread above),
 * the outer catch here drops the ENTIRE output — the event/message itself
 * is still never dropped, but nothing from a carrier that fights back this
 * hard can be trusted at any granularity.
 */
function forceUIBlockCarrierOutputUnattested(output: unknown): unknown {
  try {
    if (!output || typeof output !== 'object') return output;
    const root = output as { type?: unknown; value?: unknown };
    const wrapped =
      root.type === 'json' && root.value && typeof root.value === 'object';
    const carrier = (wrapped ? root.value : output) as {
      uiBlock?: unknown;
      uiBlocks?: unknown;
    };
    if (carrier.uiBlock === undefined && !Array.isArray(carrier.uiBlocks)) {
      return output;
    }
    const forcedCarrier = {
      ...carrier,
      ...(carrier.uiBlock !== undefined
        ? { uiBlock: forceUIBlockCandidateUnattested(carrier.uiBlock) }
        : {}),
      ...(Array.isArray(carrier.uiBlocks)
        ? { uiBlocks: carrier.uiBlocks.map(forceUIBlockCandidateUnattested) }
        : {}),
    };
    return wrapped ? { ...root, value: forcedCarrier } : forcedCarrier;
  } catch {
    // Nothing about this output can be safely touched. Absence is the only
    // provably-safe answer left.
    return undefined;
  }
}

/**
 * B4 (fix round 2) — the failure-safe wrapper every production call site
 * must use instead of {@link sanitizeUIBlockEventProvenance}. On a throw
 * from the sanitizer (a poisoned getter, or any other exotic input the
 * lenient parsers didn't anticipate): logs a warning naming the event/block
 * via `onWarn` (never lets a logging failure escape either), then forces
 * every claiming block in the output unattested via the non-recomputing
 * fallback above — NEVER publishes the unsanitized input, NEVER drops the
 * event, NEVER lets the exception reach the adapter stream.
 */
export function safeSanitizeUIBlockEventProvenance(
  event: CanonicalRuntimeEvent,
  onWarn?: UIBlockProvenanceWarn,
): CanonicalRuntimeEvent {
  try {
    return sanitizeUIBlockEventProvenance(event);
  } catch (error) {
    warnSafely(
      onWarn,
      'ui-block provenance sanitizer threw on a tool.completed event; forcing all claiming blocks unattested rather than publishing unsanitized output',
      {
        eventId: event.eventId,
        threadId: event.threadId,
        toolCallId: (event as { toolCallId?: unknown }).toolCallId,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    try {
      if (event.method !== 'tool.completed' || event.output === undefined) {
        return event;
      }
      return {
        ...event,
        output: forceUIBlockCarrierOutputUnattested(event.output),
      };
    } catch {
      // Even the fallback failed. The event itself is still never dropped —
      // its output is, which is the safe direction.
      return { ...event, output: undefined } as CanonicalRuntimeEvent;
    }
  }
}

/**
 * The same safe-wrapper discipline as {@link safeSanitizeUIBlockEventProvenance},
 * for a bare carrier `output` value rather than a whole event — used by
 * {@link sanitizeConversationMessagesUIBlockProvenance}'s per-part
 * sanitization.
 */
export function safeSanitizeUIBlockCarrierOutput(
  output: unknown,
  onWarn?: UIBlockProvenanceWarn,
  context?: Record<string, unknown>,
): unknown {
  try {
    return sanitizeUIBlockCarrierOutput(output);
  } catch (error) {
    warnSafely(
      onWarn,
      'ui-block provenance sanitizer threw on a message part output; forcing all claiming blocks unattested rather than serving unsanitized output',
      {
        ...context,
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return forceUIBlockCarrierOutputUnattested(output);
  }
}

/**
 * archive#1399 fix round 2, B2 (independent review) — sanitizes at the
 * SERVE boundary: `conversations.ts`'s `GET /:slug/conversations/:conversationId/messages`
 * route (and every other reader of `readConversationMessages`, its one
 * shared read seam) calls this on every `ConversationMessage[]` it is about
 * to return to a client, for BOTH sources (`'store'` — the FileMemory
 * adapter, `memory-adapter-messages.ts`'s `readStoredMessages`, which
 * serializes and reads back a message's `parts` VERBATIM, with no
 * equivalent write-time seam to `publishCanonicalEvent`'s — and
 * `'orchestration'` — already write-sanitized by
 * `safeSanitizeUIBlockEventProvenance`, so re-sanitizing here is a safe,
 * idempotent no-op, not a second source of truth).
 *
 * **Why serve-time, not (only) write-time (the ruling's reasoning):** a
 * write-time-only fix leaves every ALREADY-STORED historical forgery
 * intact — anything written before this fix round, or by a future writer
 * that forgets to sanitize, keeps serving unsanitized forever. Serve-time
 * sanitization covers the FULL stored corpus retroactively, on every read,
 * with the server's own authority — exactly the authority the client's
 * mirror-only `finalizeUIBlockProvenance` (`packages/sdk/src/query-domains/uiBlocks.ts`)
 * deliberately does NOT have (it can only downgrade an inconsistent claim,
 * never verify one). The client mirror stays as-is: it is defense in depth
 * for a path this function doesn't reach, not the primary control for the
 * paths it does.
 *
 * Never throws (B4): each part's sanitization is independently
 * fail-safe via {@link safeSanitizeUIBlockCarrierOutput}/
 * {@link forceUIBlockCandidateUnattested}, so one poisoned part cannot take
 * down the whole message list a user is trying to read.
 */
export function sanitizeConversationMessagesUIBlockProvenance(
  messages: ConversationMessage[],
  onWarn?: UIBlockProvenanceWarn,
): ConversationMessage[] {
  let anyChanged = false;
  const next = messages.map((message) => {
    if (!Array.isArray(message.parts) || message.parts.length === 0) {
      return message;
    }
    let changed = false;
    const parts = message.parts.map((part) => {
      const sanitized = sanitizeOneMessagePart(part, onWarn, {
        messageId: message.id,
      });
      if (sanitized !== part) changed = true;
      return sanitized;
    });
    if (changed) anyChanged = true;
    return changed ? { ...message, parts } : message;
  });
  // Same-reference passthrough (matches `sanitizeUIBlockEventProvenance`'s
  // discipline) when nothing needed sanitizing — a caller that diffs by
  // reference (or just wants to avoid an allocation on the hot read path)
  // sees no-op reads as true no-ops.
  return anyChanged ? next : messages;
}

function sanitizeOneMessagePart(
  part: MessagePart,
  onWarn: UIBlockProvenanceWarn | undefined,
  context: Record<string, unknown>,
): MessagePart {
  let next = part;
  if (part.output !== undefined) {
    const sanitizedOutput = safeSanitizeUIBlockCarrierOutput(
      part.output,
      onWarn,
      { ...context, toolCallId: part.toolCallId },
    );
    if (sanitizedOutput !== part.output) {
      next = { ...next, output: sanitizedOutput };
    }
  }
  // `MessagePart` does not declare `uiBlock` (only `output` is part of the
  // shared server shape) — but the client's `MessageApiPart` reads one
  // defensively (`chatRuntimeStream.ts`), so a part that carries one on the
  // wire (any past or future writer) is sanitized here too rather than
  // assumed absent.
  const rawUiBlock = (part as unknown as Record<string, unknown>).uiBlock;
  if (rawUiBlock !== undefined) {
    let sanitizedBlock: unknown;
    try {
      sanitizedBlock = sanitizeRawUIBlockCandidate(rawUiBlock);
    } catch (error) {
      warnSafely(
        onWarn,
        'ui-block provenance sanitizer threw on a message part uiBlock; forcing unattested rather than serving unsanitized output',
        {
          ...context,
          toolCallId: part.toolCallId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      // archive#1399 micro-round, M2 (independent review): the fallback
      // itself can throw — `forceUIBlockCandidateUnattested` spreads the
      // SAME raw object, so a poisoned getter that threw once throws again
      // here. Unlike the carrier-output path (whose own outer try/catch
      // already covers this exact re-throw), this direct-`uiBlock` branch
      // had no second layer, so an unhandled exception reached the caller
      // — a 500 on the serve path instead of a sanitized response. Wrap
      // the fallback in its OWN catch and, on a second failure, drop the
      // `uiBlock` field entirely (mirrors the carrier-output last-resort
      // tier's `output: undefined`) rather than let anything from this
      // object reach the response.
      try {
        sanitizedBlock = forceUIBlockCandidateUnattested(rawUiBlock);
      } catch (fallbackError) {
        warnSafely(
          onWarn,
          'ui-block provenance fallback also threw on a message part uiBlock; dropping the field entirely rather than risk an unhandled throw on the serve path',
          {
            ...context,
            toolCallId: part.toolCallId,
            error:
              fallbackError instanceof Error
                ? fallbackError.message
                : String(fallbackError),
          },
        );
        sanitizedBlock = undefined;
      }
    }
    if (sanitizedBlock !== rawUiBlock) {
      next = { ...next, uiBlock: sanitizedBlock } as MessagePart;
    }
  }
  return next;
}
