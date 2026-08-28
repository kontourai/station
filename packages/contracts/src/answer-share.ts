/**
 * Scoped answer share permalinks (station#1423) — Station's first sharing
 * primitive, and deliberately its smallest one.
 *
 * An **answer share** is one bearer capability bound to one completed
 * assistant turn. The operator mints it from a specific answer; the holder of
 * the minted token may read that answer and the turn-provenance card
 * (station#1410) that goes with it, and nothing else on this Station. It is
 * revocable, it expires, and it is enumerated and revoked from the operator's
 * own management surface exactly the way a paired device is.
 *
 * ## Why this is not a pairing scope
 *
 * The obvious-looking design — add a `share:read` token to `PAIRING_SCOPES`
 * and mint a pairing grant carrying it (station#1467's `inference:invoke`
 * shape) — was considered and rejected. A pairing scope answers *"which route
 * families may this credential reach"*: a station-wide, resource-blind
 * question. A share answers *"which single turn may this holder read"*, which
 * the scope vocabulary structurally cannot express. Shipping both would mean
 * the token authorizes the share ROUTE FAMILY while the record still carries
 * the only binding that matters — two mechanisms for one decision, with the
 * weaker one being the one a reader sees in a scope string. That is the same
 * "the lower tier is the effective one and the higher gate is decorative"
 * failure station#1398's security review named (M-4).
 *
 * Two more reasons the pairing machinery is the wrong host:
 *
 *  - A pairing grant is a **device relationship** — a registry entry, an
 *    offer/confirm handshake, push subscriptions, a name in the operator's
 *    paired-device list. A share recipient is not a device, and putting them
 *    in that list would misstate what the operator agreed to.
 *  - Every existing scope is granted to a credential that then reaches many
 *    routes. `PAIRING_SCOPE_PRESETS` is a vocabulary for *breadth*. A share
 *    is the opposite shape: maximum narrowness, one resource, one verb.
 *
 * So: **no new pairing scope token.** The share token is its own bearer
 * credential, stored only as a SHA-256 digest, bound at mint time to
 * `{sessionId, turnId}`. What DOES ride the pairing vocabulary is the
 * operator's management surface — {@link ANSWER_SHARE_ROUTE_PREFIX} is gated
 * at `access:manage`, the same ceiling `/api/pairing` uses, because minting a
 * share is an access-granting act and `access:manage` is the one scope no
 * pairing preset ever hands to a paired device.
 *
 * ## Where the token travels
 *
 * The permalink carries the token in the URL **fragment**
 * ({@link ANSWER_SHARE_PERMALINK_PATH} + `#` +
 * {@link ANSWER_SHARE_TOKEN_FRAGMENT_KEY}), never the path or the query. A
 * fragment is not sent to the server, so the token stays out of access logs,
 * out of `Referer` headers on any outbound click, and out of proxy logs. The
 * share view reads it client-side and presents it in the body of
 * {@link PUBLIC_ANSWER_SHARE_VIEW_PATH}.
 *
 * ## Enumeration posture (deliberate, see `docs/design/answer-share-permalinks.md`)
 *
 * Two requirements pull against each other here: an honest surface must say
 * "revoked" rather than 404 at a holder, and a public route must not become
 * an oracle for which shares exist. The discriminator is **possession of the
 * token**, and the record is keyed by the token's digest so the two are the
 * same lookup:
 *
 *  - No record for the presented token — whether it never existed, was
 *    mistyped, or is malformed — yields exactly one refusal,
 *    `share-not-found`, with identical status and identical bytes. There is
 *    no id/secret split to probe.
 *
 *    Stated precisely, because the obvious stronger claim is false: a
 *    malformed token IS rejected earlier, by
 *    {@link ANSWER_SHARE_TOKEN_PATTERN}, without hashing or reading the
 *    store. What that buys an observer is the ability to distinguish
 *    "syntactically not a token" from "syntactically a token" — which they
 *    already know, since the shape is public and visible in any permalink.
 *    It reveals nothing about which tokens EXIST, which is the only fact
 *    worth hiding here. The response bytes and status are identical either
 *    way.
 *  - A record found for the presented token means the caller has proven
 *    possession of a capability this operator minted, so they are told the
 *    truth about it: `share-revoked` (with when), `share-expired` (with
 *    when), or `answer-no-longer-available`.
 *
 * A 256-bit token is not guessable, so naming a state to its holder discloses
 * nothing to anyone else.
 */

import type {
  ChannelCommitCoordinate,
  ChannelRecordRef,
} from './channel-log.js';

/**
 * The version this build MINTS for a payload that makes no claim about a
 * channel log. Bumped when the viewer payload's meaning changes in a way an
 * older reader would misread. A reader that does not recognize the version
 * must say so rather than best-effort parse it — same rule as
 * `TURN_PROVENANCE_ENVELOPE_VERSION`.
 *
 * **This is what this build EMITS, not what it can READ.** The two were the
 * same number until station#1598 and are now deliberately different concepts:
 * see {@link ANSWER_SHARE_READABLE_SCHEMA_VERSIONS}. A reader that checks the
 * wire version for equality against this constant would refuse every payload
 * that carries a channel status, and a reader that checks it against the
 * newest version alone would refuse every payload that does not.
 */
export const ANSWER_SHARE_SCHEMA_VERSION = 1;

/**
 * The version a payload declares when it carries a channel status a v1 reader
 * would silently drop (station#1598).
 *
 * The bump is not "this build is newer". It is: this payload says where the
 * answer sits in a channel log, and a reader that renders the answer while
 * omitting that says less than the server said. An answer minus its channel
 * status reads as an answer with no channel status, which is a different
 * claim. See {@link answerShareSchemaVersionFor} for exactly which statuses
 * trigger it — a payload whose status is "there is no channel here" is NOT
 * channel-bearing and stays at v1, because dropping it loses nothing.
 */
export const ANSWER_SHARE_CHANNEL_SCHEMA_VERSION = 2;

/**
 * Every payload version this build can render, as a SET.
 *
 * Membership, never equality (station#1598). The viewer's check was
 * `schemaVersion === ANSWER_SHARE_SCHEMA_VERSION`, which is correct only
 * while a build mints exactly one version — the moment a second exists,
 * equality against either constant refuses half of the payloads this build
 * understands perfectly well. A build that can read two versions has to say
 * two versions.
 */
export const ANSWER_SHARE_READABLE_SCHEMA_VERSIONS = Object.freeze([
  ANSWER_SHARE_SCHEMA_VERSION,
  ANSWER_SHARE_CHANNEL_SCHEMA_VERSION,
] as const);

/** Whether this build can render a payload declaring `value`. */
export function isReadableAnswerShareSchemaVersion(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    (ANSWER_SHARE_READABLE_SCHEMA_VERSIONS as readonly number[]).includes(value)
  );
}

/** Operator-facing management family. Gated at `access:manage`. */
export const ANSWER_SHARE_ROUTE_PREFIX = '/api/shares' as const;

/**
 * The one public route a share holder calls. Exact-path (not a prefix) so it
 * can join `PUBLIC_ROUTES` in `src-server/security/runtime-request-security.ts`
 * without loosening that set's exact-match classification, and `POST` so the
 * token travels in a body rather than a logged URL.
 */
export const PUBLIC_ANSWER_SHARE_VIEW_PATH =
  '/.well-known/station/v1/share/view' as const;

/** SPA path a permalink points at. The token lives in the fragment. */
export const ANSWER_SHARE_PERMALINK_PATH = '/share' as const;

/** Fragment parameter carrying the token: `/share#t=<token>`. */
export const ANSWER_SHARE_TOKEN_FRAGMENT_KEY = 't' as const;

/** 32 random bytes, base64url — the same shape a pairing credential uses. */
export const ANSWER_SHARE_TOKEN_BYTES = 32;

/**
 * Shape a well-formed token has. Used only to bound work before hashing —
 * NEVER to answer the caller differently, because a shape-specific refusal
 * would be a (small) oracle. A malformed token takes the same
 * `share-not-found` path as an unknown one.
 */
export const ANSWER_SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export const ANSWER_SHARE_DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ANSWER_SHARE_MAX_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Ceiling on shares an operator can hold at once. Not a security boundary —
 * a bound on unbounded growth of a file that is read on every share view.
 *
 * Revoked and expired records count against it, because they are still
 * stored: a revoked share must keep answering "revoked" to its holder rather
 * than decaying into the ambiguous "never existed". There is deliberately no
 * delete verb in v1, so the refusal copy must NOT tell an operator to prune
 * — that would name an action no surface offers. See
 * {@link ANSWER_SHARE_CAPACITY_MESSAGE}.
 */
export const ANSWER_SHARE_MAX_RECORDS = 500;

/**
 * What an operator is told when the ceiling is reached. Declared here rather
 * than inlined at the throw site so the copy and the ceiling stay in one
 * place, and so the "no action we don't offer" rule above is checkable.
 */
export const ANSWER_SHARE_CAPACITY_MESSAGE =
  `This Station is already holding ${ANSWER_SHARE_MAX_RECORDS} answer shares, ` +
  'the most it keeps. Revoked and expired shares still count, because they ' +
  'keep telling their holders what happened rather than going silent.';

export const ANSWER_SHARE_LABEL_MAX_LENGTH = 120;

/**
 * A share's lifecycle state. `expired` is derived from the clock at read time
 * rather than stored, so a share does not need a sweeper to become honest.
 */
export type AnswerShareState = 'active' | 'revoked' | 'expired';

/**
 * The operator-facing projection of a share. Carries neither the token nor
 * its digest: the token is shown exactly once, at mint time, and a digest in
 * a list response would be an offline-guessable handle to a live capability.
 */
export interface AnswerShareSummary {
  id: string;
  sessionId: string;
  turnId: string;
  /** Operator's own note. Absent when they did not write one. */
  label?: string;
  createdAt: string;
  expiresAt: string;
  /** Present only once revoked. */
  revokedAt?: string;
  state: AnswerShareState;
}

/**
 * The mint response. `token` appears here and nowhere else, ever — the store
 * keeps only its digest, so a lost permalink is re-minted, never recovered.
 *
 * **There is deliberately no `permalink` field, and no server-derived origin
 * of any kind.** The first cut had the route compose one from
 * `new URL(c.req.url).origin`, which is the `Host` header — and in Station's
 * shipped topology the browser talks to the UI port, whose proxy REWRITES
 * `Host` to the backend before forwarding. The backend serves no static
 * assets and has no `/share` route (the SPA route handler lives only in the UI
 * server), so every minted link pointed at a port that could not serve it:
 * dead on arrival, before any question of remote reachability.
 *
 * That is not fixable server-side. Behind a rewriting proxy the server cannot
 * know the origin the user's browser is actually on, and guessing produces a
 * link that looks right and is not. The caller composes the permalink with
 * {@link answerSharePermalink} from `window.location.origin` — the one place
 * that value is known to be true.
 */
export interface AnswerShareMintResult {
  share: AnswerShareSummary;
  token: string;
}

export interface AnswerShareMintRequest {
  sessionId: string;
  turnId: string;
  label?: string;
  /** Clamped to {@link ANSWER_SHARE_MAX_TTL_MS}. Defaults to the 7-day TTL. */
  ttlMs?: number;
}

/**
 * Every way a share view can fail to render an answer. Each is a distinct,
 * checkable claim; `share-not-found` is deliberately the ONLY one reachable
 * without possessing a real token.
 */
export type AnswerShareRefusalReason =
  /** No record matches the presented token: never existed, mistyped, or malformed. */
  | 'share-not-found'
  /** The operator revoked this share. */
  | 'share-revoked'
  /** The share's own expiry has passed. */
  | 'share-expired'
  /**
   * The share is live but the turn it names can no longer be read on this
   * Station — the session was deleted, or the sharer themself lost access to
   * it. A share never outlives the sharer's own authority over the answer.
   */
  | 'answer-no-longer-available';

export interface AnswerShareRefusal {
  state: 'refused';
  reason: AnswerShareRefusalReason;
  /** Present for `share-revoked`. */
  revokedAt?: string;
  /** Present for `share-expired`. */
  expiresAt?: string;
}

/**
 * The HTTP status each refusal answers with, declared once so the route and
 * every consumer agree (station#1467's `FLEET_INFERENCE_REFUSAL_STATUS`
 * idiom).
 *
 * `answer-no-longer-available` deliberately SHARES 404 with
 * `share-not-found`. That is not laziness: an observer without the token can
 * only ever reach `share-not-found`, so a distinct status for the other
 * would add a signal nobody entitled to it needs, while the token holder —
 * who is entitled — reads the difference in the body. The two states that do
 * get their own status (`403` revoked, `410` expired) are likewise only
 * reachable by proving possession.
 */
export const ANSWER_SHARE_REFUSAL_STATUS: Readonly<
  Record<AnswerShareRefusalReason, number>
> = {
  'share-not-found': 404,
  'share-revoked': 403,
  'share-expired': 410,
  'answer-no-longer-available': 404,
};

/**
 * One rendered block of the shared answer. Deliberately not the full
 * `MessagePart` union: a share renders the assistant's prose, and tool
 * arguments, tool results, and attachment URLs are exactly the material the
 * provenance envelope's own secret-free rule keeps out. What the turn DID
 * with tools is reported by the envelope's tool summary, which names tools
 * without their payloads.
 */
export interface AnswerShareTextBlock {
  type: 'text';
  text: string;
}

/**
 * ## The channel binding (station#1598)
 *
 * A share keeps its `{sessionId, turnId}` binding: that is the CAPABILITY's
 * binding, the thing the operator pointed at. What this adds is a second
 * coordinate for the same answer — where it sits in a channel log — recorded
 * as a discriminated field INSIDE the same record. One record, not two peer
 * addresses, because two addresses can disagree and nothing would say which
 * one the operator meant.
 *
 * Three rulings hold this shape together, and each is a decision that was
 * available to go the other way:
 *
 * 1. **The stored states are mint-time FACTS ONLY.** `committed` and `none`
 *    are both observations mint time can make. "It is in a channel and I
 *    could not resolve it" is NOT a stored state — it is an outcome a READ
 *    computes, and it lives in {@link AnswerShareChannelStatus}. So "not in a
 *    channel" (a fact; the session view is complete; there is no remedy
 *    because nothing is missing) and "in a channel and unresolvable" (a
 *    derived failure; the remedy is to retry or to disclose the gap) can
 *    never share a label, because they never share a layer.
 * 2. **Identity names the message; the coordinate names the history it was
 *    read from.** `ChannelRecordRef` refuses `seq`/`epoch` (§3.2) because a
 *    position names a different message after a recovery. §8.1 separately
 *    requires that every read a client will cache or cite name its epoch and
 *    checkpoint. A permalink is a cached, cited read, so it carries BOTH —
 *    and resolution goes through the `ref` ONLY. The coordinate and
 *    `checkpointDigest` are VERIFIED, never DEREFERENCED. A post-recovery
 *    disagreement is a disclosed `coordinate-mismatch`, never a silent
 *    re-resolution by position.
 * 3. **Recorded at mint, not derived at read.** Derivation's failure mode —
 *    the session-to-channel mapping changes and the derived address silently
 *    changes meaning — is undetectable by construction. Recording's failure
 *    mode is drift, which the digest detects. Detectable-and-disclosed beats
 *    invisible.
 *
 * **An ABSENT `channel` field is "unknown", not `none`.** It means the record
 * was minted before this Station recorded channel bindings at all. There is
 * no backfill and there must never be one: a retroactive binding is a derived
 * claim wearing a recorded claim's name.
 */
export type AnswerShareChannelBinding =
  | {
      binding: 'committed';
      /** IDENTITY. The only field resolution is allowed to go through. */
      ref: ChannelRecordRef;
      /** §8.1's consistency binding. Verified, never dereferenced. */
      coordinate: ChannelCommitCoordinate;
      /** Integrity anchor for {@link AnswerShareChannelBinding.coordinate}. */
      checkpointDigest: string;
    }
  /** Affirmatively observed at mint: this answer has no channel coordinate. */
  | { binding: 'none' };

/**
 * Why a viewer is being told nothing about this answer's place in a channel
 * log. A closed set, and the members deliberately do not collapse:
 *
 *  - `not-in-channel` — a mint-time FACT. Nothing is missing; the session
 *    view is the whole story. There is no remedy because there is no gap.
 *  - `predates-channel-addressing` — the record carries no binding at all,
 *    because it was minted before bindings existed. Honestly "unknown", and
 *    emphatically not `not-in-channel`: this Station never looked.
 *  - `history-not-served` — a binding exists and this Station is not serving
 *    the channel history that would corroborate it here.
 *  - `coordinate-mismatch` — the ref resolved, and what came back does not
 *    sit where the record says it sits, or does not hang off the anchor the
 *    record names. Disclosed rather than re-resolved by position.
 */
export type AnswerShareChannelUnavailableReason =
  | 'not-in-channel'
  | 'predates-channel-addressing'
  | 'history-not-served'
  | 'coordinate-mismatch';

/**
 * What a viewer is shown about the channel binding — **a derivation computed
 * at read time from a verification, never a stored label echoed back.**
 *
 * This is the anti-defect requirement of the channel binding's read side
 * (archive#1598), and it names a real
 * defect class: `authorized` rendered from the
 * mere PRESENCE of an `authorizationId` reports a check that never
 * ran. Presenting "committed at (epoch, seq)" from
 * {@link AnswerShareChannelBinding} alone is the same defect with different
 * nouns. The stored binding is an observation; this is the checked result,
 * and `reported` is reachable only from a resolution that came back from a
 * channel-log read.
 *
 * `reported` is the design's word for the good state, and it is not
 * `verified`: nothing here is signed. This Station is attesting its own log,
 * which is L0 in `assurance.md`'s vocabulary — producer-asserted, checkable
 * only from inside. The copy says so and the type name says so.
 */
export type AnswerShareChannelStatus =
  | {
      status: 'reported';
      /**
       * The coordinate that was CORROBORATED, echoed from the resolution
       * rather than from the record, so a mismatch cannot be rendered as an
       * agreement.
       */
      coordinate: ChannelCommitCoordinate;
      /**
       * Whether a later record supersedes this one. Disclosed as STATUS and
       * never as content: serving the superseding text would share words the
       * operator never reviewed.
       */
      supersession: 'current' | 'superseded';
    }
  | { status: 'unavailable'; reason: AnswerShareChannelUnavailableReason };

/**
 * Whether a reason positively asserts that a channel binding EXISTS, declared
 * once so the service, the version rule, and the tests agree — the
 * {@link ANSWER_SHARE_REFUSAL_STATUS} idiom.
 *
 * Only the two `true` entries can arise from a stored `committed` binding, so
 * this is also the boundary of {@link ANSWER_SHARE_CHANNEL_SCHEMA_VERSION}: a
 * payload a v1 reader would misread is exactly a payload that says a binding
 * exists.
 */
export const ANSWER_SHARE_CHANNEL_REASON_ASSERTS_BINDING: Readonly<
  Record<AnswerShareChannelUnavailableReason, boolean>
> = {
  'not-in-channel': false,
  'predates-channel-addressing': false,
  'history-not-served': true,
  'coordinate-mismatch': true,
};

/**
 * The version a payload carrying `channel` must declare.
 *
 * Derived from the COMPUTED status rather than from the stored binding, so
 * the one number an old reader keys on cannot outrun what the server actually
 * managed to say.
 */
export function answerShareSchemaVersionFor(
  channel: AnswerShareChannelStatus | undefined,
): number {
  if (channel === undefined) return ANSWER_SHARE_SCHEMA_VERSION;
  if (channel.status === 'reported') {
    return ANSWER_SHARE_CHANNEL_SCHEMA_VERSION;
  }
  // ONLY a literal `false` downgrades to v1, and that is the prototype-chain
  // guard rather than an absence of one. `reason` arrives off the wire, so it
  // is not necessarily a member of the union its type claims: a newer Station
  // sends a reason this build has never heard of (lookup yields `undefined`)
  // and a hostile response sends `constructor` (lookup finds a FUNCTION on the
  // prototype chain). Neither is `false`, so both are treated as
  // channel-bearing — refusing to render is the honest outcome for a claim
  // this build cannot classify, and the alternative silently downgrades an
  // unknown assertion to "nothing here".
  //
  // Written as an identity check against `false` rather than as an own-property
  // test because this module compiles under the SDK's older `lib`, where
  // `Object.hasOwn` does not exist — and Biome rewrites the long-hand form
  // back to it.
  return ANSWER_SHARE_CHANNEL_REASON_ASSERTS_BINDING[channel.reason] === false
    ? ANSWER_SHARE_SCHEMA_VERSION
    : ANSWER_SHARE_CHANNEL_SCHEMA_VERSION;
}

export interface AnswerSharePayload {
  state: 'ok';
  schemaVersion: number;
  share: {
    id: string;
    createdAt: string;
    expiresAt: string;
    label?: string;
  };
  answer: {
    sessionId: string;
    turnId: string;
    blocks: AnswerShareTextBlock[];
    /**
     * Blocks the size bound dropped. Disclosed rather than silently applied:
     * an answer that simply stops reads as an answer that ended there, which
     * is a claim about the turn Station has no business making.
     */
    omittedBlocks: number;
  };
  /**
   * The turn's provenance envelope, **re-projected for this viewer**: every
   * reference the share holder is not authorized to dereference is replaced
   * by an honest restricted gap before it leaves the server (see
   * `packages/shared/src/answer-share-projection.ts`). Typed `unknown` for
   * the same reason `TurnProvenanceCardProps.provenance` is — the card owns
   * the decision about whether it is readable at all — and `undefined` when
   * the turn carries no envelope, which the view renders as its own gap
   * rather than silently omitting.
   */
  provenance?: unknown;
  /**
   * Where this answer sits in a channel log, **as computed by this read**
   * (station#1598).
   *
   * Always present, and that is deliberate. The derivation is total — every
   * share has an answer to the question, including "this share is older than
   * the question" — and a field that sometimes vanishes invites a reader to
   * infer meaning from its absence, which is the ambiguity this whole slice
   * exists to remove. The cost is that a pre-#1598 record's payload gains one
   * additive field; it keeps declaring {@link ANSWER_SHARE_SCHEMA_VERSION},
   * because what it says is "nothing is being claimed here", which is exactly
   * what a v1 payload already meant.
   *
   * Never the stored {@link AnswerShareChannelBinding}. The record is an
   * observation; this is the checked result.
   */
  channel?: AnswerShareChannelStatus;
}

export type AnswerShareViewResult = AnswerSharePayload | AnswerShareRefusal;

/** Builds the copyable permalink for a minted token. */
export function answerSharePermalink(origin: string, token: string): string {
  const base = origin.endsWith('/') ? origin.slice(0, -1) : origin;
  return `${base}${ANSWER_SHARE_PERMALINK_PATH}#${ANSWER_SHARE_TOKEN_FRAGMENT_KEY}=${token}`;
}

/**
 * Reads a token out of a permalink fragment (`#t=<token>`, with or without
 * the leading `#`). Returns `undefined` for anything that is not a
 * well-formed token so the caller renders its own missing-token state instead
 * of round-tripping obvious garbage to the server.
 */
export function readAnswerShareTokenFromFragment(
  fragment: string,
): string | undefined {
  const raw = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (!raw) return undefined;
  const params = new URLSearchParams(raw);
  const token = params.get(ANSWER_SHARE_TOKEN_FRAGMENT_KEY);
  if (token === null || !ANSWER_SHARE_TOKEN_PATTERN.test(token)) {
    return undefined;
  }
  return token;
}
