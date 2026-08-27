import type {
  AnswerShareChannelBinding,
  AnswerShareTextBlock,
} from './answer-share.js';
import { isPlainJsonObject } from './channel-assurance.js';
import {
  CHANNEL_GENESIS_SEQ,
  type ChannelDiagnostic,
  type ChannelValidationResult,
  findChannelForbiddenKeys,
  validateChannelRecordRef,
} from './channel-log.js';
import { canonicalizeForDigest } from './fleet-routing-receipt.js';

/**
 * Validation and digest input for an answer share's channel binding
 * (station#1598).
 *
 * **Why this is a separate module from `answer-share.ts`.** The binding TYPES
 * belong next to the rest of the share contract and live there; they are
 * type-only, so they erase at compile time and the share viewer's bundle does
 * not change. This module holds the runtime half — the validator and the
 * digest input — and it takes value imports on `channel-log.ts` and
 * `fleet-routing-receipt.ts`. Only the server and the corpus test need those,
 * and `SharedAnswerView.tsx` imports `answer-share.ts` directly, so keeping
 * them apart means an unauthenticated share page does not ship a channel-log
 * validator it will never run.
 *
 * The validator reuses slice 1's own checks rather than restating them:
 * {@link validateChannelRecordRef} owns `parent-position-not-identity` and
 * {@link findChannelForbiddenKeys} owns `forbidden-key`. A second copy of
 * either list is the drift those lists exist to prevent, and a binding whose
 * ref is positional must refuse for exactly the reason a proposal's parent
 * would.
 */

/** Every key a `committed` binding may carry, and no others. */
const COMMITTED_BINDING_KEYS = Object.freeze([
  'binding',
  'ref',
  'coordinate',
  'checkpointDigest',
] as const);

/** Every key a `none` binding may carry, and no others. */
const NONE_BINDING_KEYS = Object.freeze(['binding'] as const);

/** Every key the commit coordinate may carry, and no others. */
const COORDINATE_KEYS = Object.freeze(['channelId', 'epoch', 'seq'] as const);

/**
 * The key VOCABULARY a binding is written in — every key any binding shape
 * recognises, which is the `committed` set because `none`'s is a subset.
 *
 * Exported for one caller and one purpose: a store re-mapping untrusted bytes
 * needs to know which keys this build recognises so it can drop the ones it
 * does not, and a second copy of this list in `answer-share-store.ts` is the
 * drift this module's own docblock refuses.
 *
 * **Vocabulary, not policy.** Which of these keys a given binding may
 * actually carry stays discriminant-specific and stays here: a `none` binding
 * carrying a `coordinate` is still refused, because that is a claim smuggled
 * into a record whose whole content is "there is no claim here" — a
 * recognised key in the wrong place, not an unrecognised one.
 */
export const ANSWER_SHARE_CHANNEL_BINDING_KEYS: readonly string[] =
  COMMITTED_BINDING_KEYS;

/** The commit coordinate's key vocabulary. See the note above. */
export const ANSWER_SHARE_CHANNEL_COORDINATE_KEYS: readonly string[] =
  COORDINATE_KEYS;

/**
 * The canonical plain-object predicate, aliased rather than re-implemented —
 * exactly as `channel-log.ts` and `channel-identity.ts` do.
 *
 * A private copy was the first cut and was wrong for this module above all
 * others: this file exists to hold ONE copy of slice 1's rules, and it reads
 * `channel.ref` through {@link validateChannelRecordRef} (which uses the
 * canonical predicate) while gating the binding root and the coordinate with
 * its own. A `[object Object]` tag test and a prototype test disagree in both
 * directions — a class instance passes the first and fails the second, a
 * `Symbol.toStringTag` carrier does the reverse — so one validation pass had
 * two different ideas of what an object is.
 */
const isPlainObject = isPlainJsonObject;

function invalid(message: string): ChannelDiagnostic {
  return { code: 'record-invalid', message };
}

/**
 * Refuses any key outside the allowlist.
 *
 * Deny-by-default rather than ignore-the-extras, and the reason is specific
 * to this record: a `none` binding carrying a stray `coordinate` would be a
 * claim smuggled inside a record whose whole content is "there is no claim
 * here". The share projection's own allow-by-spread hazard
 * (`docs/design/answer-share-permalinks.md` §8) is the cautionary case.
 */
function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  fieldPath: string,
  diagnostics: ChannelDiagnostic[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      diagnostics.push(
        invalid(
          `${fieldPath}${fieldPath ? '.' : ''}${key}: not a field of this record — a binding may carry only ${allowed.join(', ')}`,
        ),
      );
    }
  }
}

function validateCoordinate(
  value: unknown,
  diagnostics: ChannelDiagnostic[],
): void {
  if (!isPlainObject(value)) {
    diagnostics.push(invalid('coordinate: must be an object'));
    return;
  }
  rejectUnknownKeys(value, COORDINATE_KEYS, 'coordinate', diagnostics);
  if (typeof value.channelId !== 'string' || value.channelId.length === 0) {
    diagnostics.push(
      invalid('coordinate.channelId: must be a non-empty string'),
    );
  }
  if (
    typeof value.epoch !== 'number' ||
    !Number.isSafeInteger(value.epoch) ||
    value.epoch < 0
  ) {
    diagnostics.push(
      invalid('coordinate.epoch: must be a non-negative safe integer'),
    );
  }
  // Floored at the genesis seq rather than at zero: `CHANNEL_GENESIS_SEQ` is
  // the first committed sequence a channel can have, so a share claiming to
  // sit below it names a position no log ever assigned.
  if (
    typeof value.seq !== 'number' ||
    !Number.isSafeInteger(value.seq) ||
    value.seq < CHANNEL_GENESIS_SEQ
  ) {
    diagnostics.push(
      invalid(
        `coordinate.seq: must be a safe integer at or above the genesis seq (${CHANNEL_GENESIS_SEQ})`,
      ),
    );
  }
}

/**
 * Fail-closed validator for a stored channel binding. Never throws, never
 * casts an unverified value into the type, accumulates every violation.
 *
 * An ABSENT binding is not this function's business: absence means "minted
 * before channel addressing existed" and is handled by the caller, because
 * `undefined` is a legitimate state of the record and an illegitimate
 * argument here.
 *
 * `checkpointDigest` is required to be a non-empty string and no more.
 * Pinning it to lowercase sha-256 hex was the first cut and is wrong: slice 1
 * types every log digest as a non-empty string
 * (`ChannelCheckpoint.headEnvelopeDigest`), and a validator stricter than the
 * producer refuses records the producer is entitled to emit.
 */
export function validateAnswerShareChannelBinding(
  value: unknown,
): ChannelValidationResult<AnswerShareChannelBinding> {
  const diagnostics: ChannelDiagnostic[] = [];
  if (!isPlainObject(value)) {
    diagnostics.push(invalid('channel: must be an object'));
    return failure(diagnostics);
  }

  diagnostics.push(...findChannelForbiddenKeys(value, 'channel'));

  if (value.binding === 'none') {
    rejectUnknownKeys(value, NONE_BINDING_KEYS, 'channel', diagnostics);
    if (diagnostics.length > 0) return failure(diagnostics);
    return { ok: true, record: value as unknown as AnswerShareChannelBinding };
  }

  if (value.binding !== 'committed') {
    diagnostics.push(
      invalid(
        `channel.binding: must be "committed" or "none" (got ${JSON.stringify(value.binding)})`,
      ),
    );
    return failure(diagnostics);
  }

  rejectUnknownKeys(value, COMMITTED_BINDING_KEYS, 'channel', diagnostics);

  const ref = validateChannelRecordRef(value.ref, 'channel.ref');
  if (!ref.ok) {
    diagnostics.push(...ref.diagnostics);
  } else if (ref.record.refKind !== 'committed-message') {
    // A proposal is what a member ASKED for, not what happened (§5.1). A
    // share that bound to one would cite a request as a position in history.
    diagnostics.push(
      invalid(
        'channel.ref.refKind: a share binds to a committed message, never to a proposal — a proposal is what was asked for, not what happened',
      ),
    );
  }

  validateCoordinate(value.coordinate, diagnostics);

  if (
    typeof value.checkpointDigest !== 'string' ||
    value.checkpointDigest.length === 0
  ) {
    diagnostics.push(
      invalid('channel.checkpointDigest: must be a non-empty string'),
    );
  }

  if (diagnostics.length > 0) return failure(diagnostics);
  return { ok: true, record: value as unknown as AnswerShareChannelBinding };
}

function failure(
  diagnostics: ChannelDiagnostic[],
): ChannelValidationResult<AnswerShareChannelBinding> {
  return {
    ok: false,
    errors: diagnostics.map((diagnostic) => diagnostic.message),
    diagnostics,
  };
}

/**
 * The bytes an answer share's `contentDigest` is taken over: the SERVED
 * blocks, canonicalized.
 *
 * Returns the digest INPUT rather than the digest, the way
 * `channelProposalDigestInput` does, because `packages/contracts` imports no
 * node builtins — it is loaded in the browser — and the hash belongs to the
 * caller that already has `node:crypto`.
 *
 * Two properties of "served", both load-bearing:
 *
 *  - The blocks are the TRUNCATED ones `projectAnswerBlocks` returns, not the
 *    message's source parts. Digesting the source would fail verification on
 *    every answer long enough to be truncated, which is precisely the class of
 *    answer most worth pinning.
 *  - The blocks are digested as they are, not re-mapped field by field.
 *    Enumerating fields would let a field added to `AnswerShareTextBlock`
 *    escape the digest, so the digest would stop being an authority over the
 *    words actually shown.
 *
 * The consequence, stated so nobody discovers it by accident: **every digest
 * already recorded is invalidated by a change to any input of the projection
 * it covers.** Those inputs are, in full:
 *
 *  - `ANSWER_SHARE_MAX_BLOCKS` and `ANSWER_SHARE_MAX_BLOCK_LENGTH`, the two
 *    truncation bounds;
 *  - the shape of {@link AnswerShareTextBlock}, since the blocks are digested
 *    as they are rather than re-mapped field by field;
 *  - `projectAnswerBlocks` itself — which parts it keeps, in what order, and
 *    with what text;
 *  - and, one layer further out and easiest to miss, **the message projection
 *    that produces those parts**:
 *    `OrchestrationService.readSessionMessages` →
 *    `projectRuntimeEventsToMessages`. That is an actively developed
 *    surface, and a change there to how text parts are coalesced, trimmed, or
 *    ordered invalidates every recorded digest without touching this file or
 *    anything named above it.
 *
 * The failure mode is a refusal rather than unverified words — the
 * arbitration returns `answer-no-longer-available` — which is the trade this
 * makes deliberately: a silent digest that no longer covers what is displayed
 * would be worse than a share that stops serving. It is not, however,
 * self-announcing: a mass invalidation and ordinary turn attrition produce
 * the same HTTP response by design, so the drift branch carries its own
 * metric attribute (`content_digest_mismatch` on `station.answer_share.views`)
 * to keep the class distinguishable to an operator without making it
 * distinguishable to a share holder.
 */
export function answerShareContentDigestInput(
  blocks: readonly AnswerShareTextBlock[],
): string {
  return JSON.stringify(canonicalizeForDigest(blocks));
}
