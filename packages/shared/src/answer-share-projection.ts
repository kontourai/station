import type {
  AnswerShareChannelBinding,
  AnswerShareChannelStatus,
  AnswerShareChannelUnavailableReason,
  AnswerShareState,
  AnswerShareTextBlock,
} from '@kontourai/station-contracts/answer-share';
import { isPlainJsonObject } from '@kontourai/station-contracts/channel-assurance';
import type {
  ChannelCommitCoordinate,
  ChannelRecordRef,
} from '@kontourai/station-contracts/channel-log';
import type {
  TurnProvenanceEnvelope,
  TurnProvenanceRefSlot,
} from '@kontourai/station-contracts/turn-provenance';
import type { MessagePart } from './conversation-message.js';

/**
 * The read-side of a scoped answer share (station#1423): everything that
 * decides what a share holder actually sees, kept pure so it can be tested
 * and fault-injected without a server.
 *
 * The rule this module exists to hold: **every dereference re-applies
 * authorization** (#1410 R4). A share token proves possession of one
 * capability — read this answer — and confers no standing on the routes the
 * provenance envelope's references point at. So before an envelope leaves the
 * server for a share viewer, each reference the viewer cannot dereference is
 * replaced by an explicitly named restricted gap.
 *
 * Naming the restriction is the point. Reusing an existing reason
 * (`not-captured-by-station`) would tell the viewer something false — Station
 * DID capture it, they are simply not authorized — and passing the reference
 * through unchanged would leak a project slug and bundle id to someone with
 * no standing on that project, while offering a drill-down that can only
 * 403. A named gap is both the more honest answer and the smaller
 * disclosure; it is #1409 AC5's idiom ("a truthful restricted-source gap with
 * no excerpt leakage") applied to a share.
 */

/**
 * Which of the envelope's three reference slots this viewer may dereference.
 *
 * A record rather than a boolean because the three point at three different
 * owning surfaces with three different authorization questions, and v2
 * (Kontour-account identities, #1392) will answer them independently — a
 * viewer who is a member of the project may well open its trust report while
 * still having no standing on this Station's fleet receipts.
 */
export interface AnswerShareRefAuthorization {
  routingReceipt: boolean;
  sources: boolean;
  trustReport: boolean;
}

/**
 * What a v1 share token authorizes: the answer, and nothing it points at.
 *
 * Every entry is `false`, and each is a decision rather than a default:
 *
 *  - `trustReport` dereferences through
 *    `GET /api/projects/:slug/trust-bundles/:id`, which requires
 *    `orchestration:read` on this Station. A share holder has no pairing
 *    credential at all.
 *  - `routingReceipt` dereferences through `/monitoring/fleet-routing-receipts`,
 *    deliberately raised to `access:manage` (station#1398 slice 4) because it
 *    names other Stations the operator has paired with.
 *  - `sources` has no dereference route yet (#1409), so there is nothing a
 *    share holder could be authorized against even in principle.
 *
 * Kept as a named constant, and applied through
 * {@link projectEnvelopeForShareViewer} rather than hardcoded in it, so the
 * seam v2 extends is visible and so a test can prove the projection actually
 * consults it.
 */
export const ANSWER_SHARE_VIEWER_AUTHORIZATION: AnswerShareRefAuthorization = {
  routingReceipt: false,
  sources: false,
  trustReport: false,
};

/**
 * Resolves a share's lifecycle state from its own record plus the clock.
 *
 * Derived rather than stored: a share that has passed its expiry is expired
 * whether or not anything has swept the store, so there is no window in which
 * a stale `state` field could serve an answer the record no longer permits.
 * Revocation wins over expiry — an operator who revoked a share should see
 * that they revoked it, not that it happened to lapse first.
 */
export function resolveAnswerShareState(
  record: { revokedAt?: string | null; expiresAt: string },
  now: number,
): AnswerShareState {
  if (record.revokedAt) return 'revoked';
  const expiresAt = Date.parse(record.expiresAt);
  // An unparseable expiry is treated as already expired, never as live: a
  // corrupt or hand-edited timestamp must fail closed on a capability record.
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return 'expired';
  return 'active';
}

/**
 * The reason string a restricted reference carries. Declared here rather than
 * inlined so the server, the card's copy table, and the tests all name the
 * same literal.
 */
export const ANSWER_SHARE_RESTRICTED_REASON = 'restricted-for-this-viewer';

function restrictIfUnauthorized<TRef>(
  slot: TurnProvenanceRefSlot<TRef>,
  authorized: boolean,
): TurnProvenanceRefSlot<TRef> {
  // An already-unavailable slot keeps its own reason. It discloses nothing,
  // and its reason ("this engine never reported it") is a more specific truth
  // than "you may not see it" — overwriting it would replace a fact with a
  // policy statement.
  if (slot.state === 'unavailable') return slot;
  if (authorized) return slot;
  return { state: 'unavailable', reason: ANSWER_SHARE_RESTRICTED_REASON };
}

/**
 * Every field of a {@link TurnProvenanceEnvelope} a share viewer may be told
 * about, named one by one.
 *
 * Exported so a test can assert the enumeration below is the WHOLE of it, and
 * declared as data rather than left implicit in the projection because the
 * closure claim ("nothing outside this list reaches an unauthenticated
 * reader") is the security property, and a property nobody can read is a
 * property nobody can check.
 */
export const ANSWER_SHARE_ENVELOPE_FIELDS = Object.freeze([
  'envelopeVersion',
  'sessionId',
  'turnId',
  'outcome',
  'observedAt',
  'engine',
  'requestedModel',
  'reportedModel',
  'tools',
  'usage',
  'routingReceipt',
  'sources',
  'trustReport',
  'contextInjection',
] as const satisfies readonly (keyof TurnProvenanceEnvelope)[]);

/**
 * Re-applies authorization to every reference in an envelope for one viewer.
 *
 * **Deny by default, and that is a correction rather than a style choice**
 * (station#1598, closing the residual `docs/design/answer-share-permalinks.md`
 * §8 recorded at station#1423). This used to be `{ ...envelope, <three refs> }`.
 * A spread forwards whatever it is given, so the disclosure boundary was
 * "everything the type happens to hold today" — a field added to
 * `TurnProvenanceEnvelope` by some later slice would have shipped to an
 * unauthenticated share holder by DEFAULT, with the review of the field's
 * OWN change being the only thing standing between it and the public. That is
 * the wrong default for the one projection in this codebase whose reader has
 * proven nothing but possession of a token.
 *
 * Enumerated, the shape closes in both directions and neither depends on
 * anyone remembering this file:
 *
 *  - a **required** field added to the envelope stops compiling here, because
 *    the object literal below no longer satisfies the declared return type.
 *    The author is named by the compiler at the exact seam where the
 *    disclosure decision lives;
 *  - an **optional** field added to the envelope, or any key riding on a
 *    runtime value the type does not describe (an envelope parsed from
 *    somewhere, an object with extra keys assigned to the parameter — TypeScript's
 *    excess-property check fires on literals, not on assigned variables), is
 *    silently DROPPED rather than silently forwarded. Fail-closed in the
 *    direction that cannot leak.
 *
 * Value slots (engine, requested/reported model, tools, usage) are forwarded
 * by reference: they are `observed` facts already inside the envelope, which
 * is secret-free by construction (#1410 R3/AC3), and they are precisely what a
 * shared answer's receipt is for. Only the three REFERENCE slots point
 * outside the envelope, and only those need re-authorization — anyone adding
 * one must add it to {@link AnswerShareRefAuthorization} and to the three
 * `restrictIfUnauthorized` calls, and the compiler now makes that the only
 * way past this function.
 *
 * Returns a new envelope; the input is never mutated, because the caller's
 * copy is the projection the operator's own surfaces render.
 */
export function projectEnvelopeForShareViewer(
  envelope: TurnProvenanceEnvelope,
  authorization: AnswerShareRefAuthorization,
): TurnProvenanceEnvelope {
  return {
    envelopeVersion: envelope.envelopeVersion,
    sessionId: envelope.sessionId,
    turnId: envelope.turnId,
    outcome: envelope.outcome,
    observedAt: envelope.observedAt,
    engine: envelope.engine,
    requestedModel: envelope.requestedModel,
    reportedModel: envelope.reportedModel,
    tools: envelope.tools,
    usage: envelope.usage,
    routingReceipt: restrictIfUnauthorized(
      envelope.routingReceipt,
      authorization.routingReceipt,
    ),
    sources: restrictIfUnauthorized(envelope.sources, authorization.sources),
    trustReport: restrictIfUnauthorized(
      envelope.trustReport,
      authorization.trustReport,
    ),
    // station#2649: a VALUE slot, restricted unconditionally rather than
    // authorized per-viewer. Unlike tools/usage (pure counts), an observed
    // context record names project-internal knowledge-source FILENAMES, and
    // a share token proves nothing about standing on that project. The
    // restricted reason is the honest one — the record exists, this share
    // may not open it — where dropping the field entirely would render as
    // "not captured by Station", which is false. An already-unavailable
    // slot keeps its own more specific truth (same rule as
    // `restrictIfUnauthorized`); an ABSENT field (pre-#2649 envelope) stays
    // absent rather than gaining a fabricated restriction over a record
    // that never existed.
    ...(envelope.contextInjection
      ? {
          contextInjection:
            envelope.contextInjection.state === 'observed'
              ? {
                  state: 'unavailable' as const,
                  reason: ANSWER_SHARE_RESTRICTED_REASON,
                }
              : envelope.contextInjection,
        }
      : {}),
  };
}

/**
 * Hard cap on the shared answer's rendered size. A share is a permalink to
 * one answer, not a bulk export route, and the public view endpoint must have
 * a bounded response for a caller who is by definition unauthenticated
 * against everything else.
 */
export const ANSWER_SHARE_MAX_BLOCKS = 40;
export const ANSWER_SHARE_MAX_BLOCK_LENGTH = 20_000;

/**
 * Projects an assistant message's parts into the blocks a share renders.
 *
 * Text parts only, and that is a disclosure decision rather than a
 * simplification: tool arguments, tool results, and attachment URLs are the
 * exact material the provenance envelope's secret-free rule keeps out of a
 * card, and a share is a *wider* audience than the card. What the turn did
 * with tools is still reported — by the envelope's tool summary, which names
 * tools without their payloads.
 *
 * Truncation is disclosed by the caller rather than silently applied here:
 * this returns what fits, and `omitted` says how many blocks it dropped, so
 * the view can render "N further blocks are not shown" instead of ending
 * mid-answer as if the answer ended there.
 */
export function projectAnswerBlocks(parts: readonly MessagePart[]): {
  blocks: AnswerShareTextBlock[];
  omitted: number;
} {
  const text = parts.filter(
    (part): part is MessagePart & { text: string } =>
      part.type === 'text' &&
      typeof part.text === 'string' &&
      part.text.length > 0,
  );
  const blocks = text.slice(0, ANSWER_SHARE_MAX_BLOCKS).map(
    (part): AnswerShareTextBlock => ({
      type: 'text',
      text: part.text.slice(0, ANSWER_SHARE_MAX_BLOCK_LENGTH),
    }),
  );
  return { blocks, omitted: Math.max(0, text.length - blocks.length) };
}

/**
 * ## The channel binding's READ side (station#1598)
 *
 * Everything below turns a RECORDED observation into a SHOWN status, and the
 * separation is the point. The stored
 * {@link AnswerShareChannelBinding} says what mint time saw. Nothing here
 * echoes it: {@link deriveAnswerShareChannelView} reaches a `reported` status
 * only by way of a resolution that came back from a channel-log read, and the
 * function that builds that status cannot even be handed the binding.
 *
 * The defect class this shape exists to refuse has a name in this codebase:
 * slice 1's review found `authorized` rendered from the mere presence of an
 * `authorizationId` — a check reported without being run. "Committed at
 * (epoch, seq)" rendered from the stored field alone is the same defect.
 */

/**
 * What a channel log gives back for one committed record.
 *
 * `blocks` is the channel's own copy of the served text, and it is a
 * CANDIDATE, not an authority: it earns the right to be shown only by
 * matching the mint-time content digest, exactly like the session store's
 * copy. See {@link arbitrateAnswerShareContent}.
 */
export interface AnswerShareChannelResolution {
  /** Where the resolved record actually sits, per the log that served it. */
  coordinate: ChannelCommitCoordinate;
  /** The anchor the serving log hangs that coordinate off. */
  checkpointDigest: string;
  supersession: 'current' | 'superseded';
  blocks?: readonly AnswerShareTextBlock[];
  /**
   * How many blocks the channel's own projection dropped. Only the store that
   * supplied the text can say, so it travels with the text rather than being
   * inherited from the session's count — which describes a different copy.
   */
  omittedBlocks?: number;
}

/**
 * The narrow port a share read needs from a channel log.
 *
 * **Resolution is BY IDENTITY.** There is deliberately no
 * `resolveByCoordinate`, because the coordinate is verification metadata —
 * a position names a different record after a recovery, so dereferencing one
 * is how a permalink silently starts serving somebody else's message. The
 * recorded coordinate and checkpoint digest are checked against what comes
 * back and never used to go and get it.
 *
 * **This port has no production implementation, and that is the current
 * truth rather than an omission.** Station has no channel log: only the
 * slice-1 contracts exist (station#1589), `src-server/services/` has no
 * channel directory, and the log itself is slice 2. So in production the port
 * is absent, a `committed` binding computes
 * `unavailable: 'history-not-served'`, and `reported` is *structurally*
 * unreachable — which is the cleanest available proof that it is never echoed
 * from the record. A stub implementation would have destroyed exactly that
 * proof, so there is none.
 */
export interface AnswerShareChannelLogPort {
  resolveCommittedRecord(
    ref: ChannelRecordRef,
  ): AnswerShareChannelResolution | undefined;
}

/**
 * Whether a resolution is shaped well enough to be compared and reported.
 *
 * The port is an INTERFACE, not a validator: {@link AnswerShareChannelLogPort}
 * is implemented by whatever channel log slice 2 lands, its return value is
 * typed and never checked at runtime, and TypeScript's excess-property check
 * fires on object literals rather than on an assigned variable. So the two
 * things this gate stops are both real and neither is caught by the compiler:
 *
 *  - a resolution with **no usable coordinate** — a plausible shape for a
 *    genesis or unsequenced entry — would make {@link corroborates} throw a
 *    `TypeError` on `resolution.coordinate.channelId`. The public view route
 *    does not catch it, so the design's `history-not-served` would reach an
 *    unauthenticated caller as a 500;
 *  - a coordinate carrying **more than the three declared fields** — a
 *    locator hint, a home URL, an authoring member id — would ride the alias
 *    through {@link AnswerShareChannelStatus} and onto the wire, unread by
 *    the comparison and unnoticed by the type system.
 *
 * A resolution this build cannot read is not a resolution, so it lands on the
 * same rung an unclassifiable `supersession` does: nothing was compared, so
 * `coordinate-mismatch` would be a claim about a comparison that never ran.
 */
function isReportableResolution(
  resolution: AnswerShareChannelResolution,
): boolean {
  const coordinate: unknown = resolution.coordinate;
  if (!isPlainJsonObject(coordinate)) return false;
  const { channelId, epoch, seq } = coordinate;
  return (
    typeof channelId === 'string' &&
    channelId.length > 0 &&
    Number.isSafeInteger(epoch) &&
    Number.isSafeInteger(seq) &&
    typeof resolution.checkpointDigest === 'string' &&
    resolution.checkpointDigest.length > 0
  );
}

/**
 * The only constructor of a `reported` status.
 *
 * It takes a RESOLUTION and nothing else. There is no overload, no optional
 * binding argument, and no path that reads the stored coordinate: what it
 * shows is what came back from the log, so a record that disagrees with the
 * log cannot be rendered as agreement.
 *
 * The coordinate is rebuilt field by field rather than forwarded, and that is
 * the same discipline `answer-share-store.ts` applies on the way in: this
 * status is assigned straight onto the view payload and serialized whole to
 * an unauthenticated share holder, so the port's own object must not be the
 * thing that ships. Enumerating the three fields is what makes
 * {@link AnswerShareChannelStatus}'s declared shape the actual disclosure
 * boundary instead of a description of it — the deny-by-default that
 * `projectEnvelopeForShareViewer`'s allow-by-spread residual
 * (`docs/design/answer-share-permalinks.md` §8) still owes.
 *
 * Callable only behind {@link isReportableResolution}, which is what makes
 * the three reads below total.
 */
function reportedFrom(
  resolution: AnswerShareChannelResolution,
): AnswerShareChannelStatus {
  return {
    status: 'reported',
    coordinate: {
      channelId: resolution.coordinate.channelId,
      epoch: resolution.coordinate.epoch,
      seq: resolution.coordinate.seq,
    },
    supersession: resolution.supersession,
  };
}

function unavailable(
  reason: AnswerShareChannelUnavailableReason,
): AnswerShareChannelStatus {
  return { status: 'unavailable', reason };
}

/**
 * Whether what the log served sits where the record says it sits, under the
 * anchor the record names.
 *
 * All four fields, and `checkpointDigest` is not optional to the check: the
 * coordinate says WHERE and the anchor says WHICH HISTORY, and §8.1 asks for
 * both precisely because a coordinate alone is stable across a recovery that
 * changed what lives there.
 *
 * `compareChannelCheckpoints` was considered for this and not used. It
 * answers a different question — do two checkpoints CONFLICT — and reaching
 * it would have meant fabricating two `station.channel-checkpoint/v1` records
 * that no home ever emitted, purely to borrow a comparison. A synthesized
 * record of a signed type is a bad habit to start.
 */
function corroborates(
  binding: Extract<AnswerShareChannelBinding, { binding: 'committed' }>,
  resolution: AnswerShareChannelResolution,
): boolean {
  return (
    binding.coordinate.channelId === resolution.coordinate.channelId &&
    binding.coordinate.epoch === resolution.coordinate.epoch &&
    binding.coordinate.seq === resolution.coordinate.seq &&
    binding.checkpointDigest === resolution.checkpointDigest
  );
}

/**
 * What this read can say about the answer's place in a channel log, plus the
 * resolution that earned it.
 *
 * `corroborated` is populated in exactly one branch — the same branch that
 * builds `reported` — so an unverified resolution can never leak into content
 * arbitration as a source of words.
 */
export interface AnswerShareChannelView {
  status: AnswerShareChannelStatus;
  corroborated?: AnswerShareChannelResolution;
}

/**
 * Computes the viewer-facing channel status.
 *
 * The ladder, and every rung is a distinct claim:
 *
 *  1. **No binding on the record** — minted before bindings existed.
 *     `predates-channel-addressing`, an honest "unknown". It is NOT
 *     `not-in-channel`: this Station never looked, and saying "not in a
 *     channel" would be a fact it does not have. There is no backfill.
 *  2. **`binding: 'none'`** — `not-in-channel`, a mint-time FACT. The session
 *     view is the whole story and there is nothing to remedy.
 *  3. **`binding: 'committed'`, no log served** — `history-not-served`. True
 *     of every production Station today. A log that threw, served nothing, or
 *     served something this build cannot read (an unclassifiable
 *     `supersession`, an unusable coordinate) lands on this same rung: in
 *     each case nothing was compared, so any more specific claim would be
 *     about a comparison that never ran.
 *  4. **Resolved, but disagrees** — `coordinate-mismatch`, disclosed. Never a
 *     silent re-resolution by position: the whole reason the ref refuses a
 *     `seq` is that a position means something else after a recovery.
 *  5. **Resolved and corroborated** — `reported`, built from the resolution.
 */
export function deriveAnswerShareChannelView(input: {
  binding: AnswerShareChannelBinding | undefined;
  channelLog?: AnswerShareChannelLogPort;
}): AnswerShareChannelView {
  const { binding, channelLog } = input;
  if (binding === undefined) {
    return { status: unavailable('predates-channel-addressing') };
  }
  if (binding.binding === 'none') {
    return { status: unavailable('not-in-channel') };
  }
  if (!channelLog) return { status: unavailable('history-not-served') };

  let resolution: AnswerShareChannelResolution | undefined;
  try {
    resolution = channelLog.resolveCommittedRecord(binding.ref);
  } catch {
    // A log that throws served nothing. Reporting the record's own coordinate
    // here would be the echo this whole module refuses.
    return { status: unavailable('history-not-served') };
  }
  if (!resolution) return { status: unavailable('history-not-served') };
  if (
    resolution.supersession !== 'current' &&
    resolution.supersession !== 'superseded'
  ) {
    // A resolution this build cannot classify is not a resolution. It is not
    // a `coordinate-mismatch` either — nothing was compared — so it stays in
    // the "no usable history was served" rung.
    return { status: unavailable('history-not-served') };
  }
  // Before the comparison, not after: `corroborates` dereferences the served
  // coordinate, so a resolution without one throws out of this function and
  // out of the public view route rather than refusing.
  if (!isReportableResolution(resolution)) {
    return { status: unavailable('history-not-served') };
  }
  if (!corroborates(binding, resolution)) {
    return { status: unavailable('coordinate-mismatch') };
  }
  return { status: reportedFrom(resolution), corroborated: resolution };
}

/**
 * Which store's copy of the answer may be shown.
 *
 * The mint-time `contentDigest` is the SOLE authority for the words. A
 * candidate from either store either matches it or is unusable; a match from
 * either one serves; a match from neither is the existing refusal
 * `answer-no-longer-available`.
 *
 * **Supersession never swaps displayed content.** A superseding record
 * carries edited text, which by construction cannot match the digest taken at
 * mint — so it can never be served. That an edit exists is disclosed as
 * STATUS. Showing the edit would share words the operator never reviewed
 * under a link they minted for the words they did.
 */
export type AnswerShareContentArbitration =
  | {
      outcome: 'served';
      source: 'session' | 'channel';
      blocks: readonly AnswerShareTextBlock[];
    }
  | { outcome: 'unavailable' };

export function arbitrateAnswerShareContent(input: {
  /** Absent on a record minted before content digests existed. */
  recordedDigest: string | undefined;
  sessionBlocks: readonly AnswerShareTextBlock[];
  /**
   * The channel's copy, and ONLY when the channel status corroborated. An
   * unverified resolution is not an authority for words any more than it is
   * for a coordinate.
   */
  channelBlocks?: readonly AnswerShareTextBlock[];
  digest: (blocks: readonly AnswerShareTextBlock[]) => string;
}): AnswerShareContentArbitration {
  // A record with no recorded digest is a pre-#1598 share. It resolves
  // exactly as it did before this slice existed: there is nothing to arbitrate
  // against, and inventing an authority for it retroactively would be the
  // backfill this design refuses.
  if (input.recordedDigest === undefined) {
    return {
      outcome: 'served',
      source: 'session',
      blocks: input.sessionBlocks,
    };
  }
  if (input.digest(input.sessionBlocks) === input.recordedDigest) {
    return {
      outcome: 'served',
      source: 'session',
      blocks: input.sessionBlocks,
    };
  }
  if (
    input.channelBlocks !== undefined &&
    input.digest(input.channelBlocks) === input.recordedDigest
  ) {
    return {
      outcome: 'served',
      source: 'channel',
      blocks: input.channelBlocks,
    };
  }
  return { outcome: 'unavailable' };
}
