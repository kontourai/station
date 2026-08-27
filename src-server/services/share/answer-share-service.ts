import { createHash } from 'node:crypto';
import {
  type AnswerShareChannelBinding,
  type AnswerShareChannelStatus,
  type AnswerShareMintResult,
  type AnswerShareSummary,
  type AnswerShareTextBlock,
  type AnswerShareViewResult,
  answerShareSchemaVersionFor,
} from '@kontourai/station-contracts/answer-share';
import { answerShareContentDigestInput } from '@kontourai/station-contracts/answer-share-channel';
import {
  isHostedSessionReadAuthority,
  type SessionReadAuthority,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import { isSupportedTurnProvenanceEnvelope } from '@kontourai/station-contracts/turn-provenance';
import {
  ANSWER_SHARE_VIEWER_AUTHORIZATION,
  type AnswerShareChannelLogPort,
  arbitrateAnswerShareContent,
  deriveAnswerShareChannelView,
  projectAnswerBlocks,
  projectEnvelopeForShareViewer,
  resolveAnswerShareState,
} from '@kontourai/station-shared/answer-share-projection';
import type { ConversationMessage } from '@kontourai/station-shared/conversation-message';
import {
  answerShareChannelStatuses,
  answerSharesMinted,
  answerSharesRevoked,
  answerShareViews,
} from '../../telemetry/metrics.js';
import {
  AnswerShareStore,
  AnswerShareStoreError,
  type StoredAnswerShare,
  toSummary,
} from './answer-share-store.js';

/**
 * Answer-share read/write service (station#1423).
 *
 * Sits between the store (which knows nothing about turns) and the routes
 * (which must not contain policy). Everything that decides *what a share
 * holder is told* lives here or in
 * `packages/shared/src/answer-share-projection.ts`, so both the honest-state
 * enumeration and the re-applied authorization are provable without an HTTP
 * layer.
 */

/**
 * The one thing this service needs from orchestration, declared structurally
 * so it never imports `OrchestrationService` (and so a test can hand it two
 * messages instead of an event store).
 *
 * `userId` is threaded through deliberately: the share carries the minting
 * operator's identity, and the answer is re-read as that user on every view.
 * A share therefore cannot outlive the sharer's own standing on the session
 * — the read is re-authorized at dereference time exactly like every other
 * reference in the envelope (#1410 R4).
 */
export interface AnswerShareSessionReader {
  readSessionMessages(
    threadId: string,
    authority: SessionReadAuthority,
  ): readonly ConversationMessage[];
  /** The central session policy used by hosted share management. */
  canUserReadSession?(
    threadId: string,
    authority: SessionReadAuthority,
  ): boolean;
}

/**
 * What mint time asks about a turn's place in a channel log (station#1598).
 *
 * Total by contract: it returns a binding or it throws. There is deliberately
 * no "I could not tell" return value, because there is no stored state for
 * one — the record's three states are `committed`, `none`, and absent, and
 * absent means "this build predates bindings", which would be a lie on a
 * record minted today. A mint that cannot observe must FAIL, loudly, so the
 * operator re-mints rather than receiving a link whose provenance quietly
 * reads as older than it is.
 *
 * **No production implementation exists**, because there is no channel log
 * to ask (slice 2). Production wires {@link NO_CHANNEL_LOG_OBSERVER}, which
 * records `{ binding: 'none' }` — a fact on this build and not a
 * placeholder: a Station with no channel log commits no answer to one.
 */
export interface AnswerShareChannelObserver {
  observeBinding(input: {
    sessionId: string;
    turnId: string;
  }): AnswerShareChannelBinding;
}

/**
 * The observation a Station with no channel log makes: **this Station has no
 * channel log, so no answer it mints has a channel coordinate.**
 *
 * A named symbol passed explicitly at the wiring site, rather than a default
 * inside the service, and the difference is the whole value of the recorded
 * binding. `{ binding: 'none' }` is defined as an affirmative mint-time
 * observation, and the slice rests on it never colliding with "unknown". A
 * `?? { binding: 'none' }` default cannot tell "this Station has no channel
 * log" from "nobody wired the observer" — so the day slice 2 lands a channel
 * log and forgets one line in `runtime-routes.ts`, every share minted
 * afterwards records the affirmative claim "this answer is not in a channel"
 * about answers that ARE in one. Nothing fails, no test reds, no counter
 * moves: the recorded-not-derived guarantee stays intact and the recorded
 * value is false.
 *
 * With `channelObserver` REQUIRED, that claim lives at the wiring site where
 * it can be read and challenged, and slice 2 must delete this symbol to
 * compile — a trip-wire rather than a documented hope. Station has a
 * validated precedent for exactly this shape: the intent-binding mirror that
 * tripped as designed and was retired the day upstream shipped the export.
 *
 * **Delete this when a channel log exists.** Its assertion is false the
 * moment one does.
 */
export const NO_CHANNEL_LOG_OBSERVER: AnswerShareChannelObserver = {
  observeBinding: () => ({ binding: 'none' }),
};

export interface AnswerShareServiceDeps {
  store: AnswerShareStore;
  sessions: AnswerShareSessionReader;
  now?: () => number;
  /**
   * station#1598. Required, and required on purpose — see
   * {@link NO_CHANNEL_LOG_OBSERVER} for why a default here would record a
   * false affirmative claim the first time somebody forgets to wire one.
   */
  channelObserver: AnswerShareChannelObserver;
  /** station#1598. Absent in production — see {@link AnswerShareChannelLogPort}. */
  channelLog?: AnswerShareChannelLogPort;
}

/**
 * The wire reason vocabulary is kebab-case and the metrics vocabulary is
 * snake_case (`answerShareViews` already emits `share_not_found`). Mapped
 * deliberately rather than passed through, so a wire rename cannot silently
 * fork a metric series — and so the enum below is the complete, reviewable
 * list of everything this counter can ever emit.
 */
const CHANNEL_STATUS_ATTRIBUTE: Readonly<Record<string, string>> = {
  'reported:current': 'reported_current',
  'reported:superseded': 'reported_superseded',
  'unavailable:not-in-channel': 'not_in_channel',
  'unavailable:predates-channel-addressing': 'predates_channel_addressing',
  'unavailable:history-not-served': 'history_not_served',
  'unavailable:coordinate-mismatch': 'coordinate_mismatch',
};

/**
 * The counter's ONLY attribute is the status, and that is the same privacy
 * rule the sibling answer-share instruments state: a `channelId`, `epoch`,
 * `seq`, digest, or share id here would put an identifier for a shared answer
 * into a metrics pipeline exported far more widely than the answer itself.
 * `channelId` is precisely that class.
 */
function recordChannelStatus(channel: AnswerShareChannelStatus): void {
  const key =
    channel.status === 'reported'
      ? `reported:${channel.supersession}`
      : `unavailable:${channel.reason}`;
  answerShareChannelStatuses.add(1, {
    status: Object.hasOwn(CHANNEL_STATUS_ATTRIBUTE, key)
      ? CHANNEL_STATUS_ATTRIBUTE[key]
      : 'unclassified',
  });
}

/**
 * A dropped-block count that can be rendered as a number of blocks, or zero.
 *
 * Zero for anything else, including a count a port reports as `NaN`, negative,
 * or fractional: "some unreadable quantity of further blocks is not shown" is
 * not a sentence, and the honest floor is the claim that nothing is known to
 * be missing.
 */
function clampOmittedBlocks(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : 0;
}

/**
 * SHA-256 over the canonicalized SERVED blocks. Lives here because
 * `packages/contracts` imports no node builtins; the contract owns the bytes
 * that are hashed, this owns the hashing.
 */
function answerShareContentDigest(
  blocks: readonly AnswerShareTextBlock[],
): string {
  return createHash('sha256')
    .update(answerShareContentDigestInput(blocks), 'utf8')
    .digest('hex');
}

export class AnswerShareService {
  readonly #deps: AnswerShareServiceDeps;

  constructor(deps: AnswerShareServiceDeps) {
    this.#deps = deps;
  }

  #now(): number {
    return this.#deps.now?.() ?? Date.now();
  }

  /**
   * Mints a share for one turn.
   *
   * The turn is resolved BEFORE the record is written: minting a permalink to
   * an answer that does not exist would hand the operator a link that can
   * only ever refuse, and they would have no way to tell that from a link
   * that stopped working later.
   *
   * Returns the token, never a composed permalink. See
   * {@link AnswerShareMintResult} for why an origin cannot be derived here.
   */
  async mint(
    input: {
      sessionId: string;
      turnId: string;
      label?: string;
      ttlMs?: number;
      ownerUserId?: string | null;
    },
    authority?: SessionReadAuthority,
  ): Promise<AnswerShareMintResult | { error: 'answer-not-found' }> {
    const message = this.#findTurnMessage(
      input.sessionId,
      input.turnId,
      authority ?? this.defaultReadAuthority(input.ownerUserId),
    );
    if (!message) {
      answerSharesMinted.add(1, { outcome: 'answer_not_found' });
      return { error: 'answer-not-found' };
    }
    // Recorded at mint, never derived at read (station#1598). Derivation's
    // failure mode — the session-to-channel mapping changes and the derived
    // address silently changes meaning — is undetectable by construction;
    // recording's failure mode is drift, and the digest detects that.
    //
    // The digest covers the blocks as they will be SERVED, which is why
    // `projectAnswerBlocks` runs here rather than the raw parts being hashed:
    // the view digests the same truncated projection, so a long answer
    // verifies instead of failing on its own size bound.
    const { blocks } = projectAnswerBlocks(message.parts);
    const { record, token } = await this.#deps.store.mint({
      ...input,
      channel: this.#observeChannelBinding(input.sessionId, input.turnId),
      contentDigest: answerShareContentDigest(blocks),
    });
    answerSharesMinted.add(1, { outcome: 'minted' });
    // No permalink, and no origin of any kind: the server cannot know the
    // origin the operator's browser is on (the UI proxy rewrites `Host`), so
    // composing one here produces a link that looks right and is dead. The
    // caller composes it from `window.location.origin` — see
    // `AnswerShareMintResult`.
    return { share: toSummary(record, this.#now()), token };
  }

  list(authority?: SessionReadAuthority): AnswerShareSummary[] {
    const readAuthority = authority ?? this.defaultReadAuthority();
    // The store is global, but each share names its backing session. Filter
    // through the same central predicate before exposing a summary.
    return this.#deps.store
      .list()
      .filter((share) =>
        this.#canManageSession(share.sessionId, readAuthority),
      );
  }

  async revoke(
    id: string,
    authority?: SessionReadAuthority,
  ): Promise<AnswerShareSummary> {
    const readAuthority = authority ?? this.defaultReadAuthority();
    // Locate and authorize before the mutating store call. Unauthorized and
    // missing ids deliberately share the store's not-found outcome.
    const existing = this.#deps.store.list().find((share) => share.id === id);
    if (
      !existing ||
      !this.#canManageSession(existing.sessionId, readAuthority)
    ) {
      throw new AnswerShareStoreError('share_not_found', 'Share not found');
    }
    const summary = await this.#deps.store.revoke(id);
    answerSharesRevoked.add(1, { outcome: 'revoked' });
    return summary;
  }

  /**
   * Resolves a presented token into what its holder may see.
   *
   * The state ladder, in the order it must be evaluated:
   *
   *  1. **No record** — one refusal, `share-not-found`, covering never
   *     existed / mistyped / malformed. This is the only outcome reachable
   *     without possessing a real token, which is what keeps the route from
   *     being an enumeration oracle.
   *  2. **Revoked / expired** — named, with the timestamp, because the caller
   *     has proven possession of a capability this operator minted and is
   *     entitled to know what happened to it.
   *  3. **Answer gone** — the share is live but the turn can no longer be
   *     read as the sharer. Distinct from the two above: nothing was revoked
   *     and nothing lapsed, the underlying answer moved out from under it.
   *  4. **Ok** — the answer, plus the envelope re-projected for this viewer.
   */
  view(token: string, authority?: SessionReadAuthority): AnswerShareViewResult {
    const record = this.#deps.store.resolveByToken(token);
    if (!record) {
      answerShareViews.add(1, { outcome: 'share_not_found' });
      return { state: 'refused', reason: 'share-not-found' };
    }
    const now = this.#now();
    const state = resolveAnswerShareState(record, now);
    if (state === 'revoked') {
      answerShareViews.add(1, { outcome: 'share_revoked' });
      return {
        state: 'refused',
        reason: 'share-revoked',
        // Non-null by construction: `resolveAnswerShareState` returns
        // 'revoked' only when `revokedAt` is set.
        revokedAt: record.revokedAt ?? undefined,
      };
    }
    if (state === 'expired') {
      answerShareViews.add(1, { outcome: 'share_expired' });
      return {
        state: 'refused',
        reason: 'share-expired',
        expiresAt: record.expiresAt,
      };
    }

    const message = this.#findTurnMessage(
      record.sessionId,
      record.turnId,
      authority ?? this.defaultReadAuthority(record.ownerUserId),
    );
    if (!message) {
      answerShareViews.add(1, { outcome: 'answer_unavailable' });
      return { state: 'refused', reason: 'answer-no-longer-available' };
    }

    // Status first, because whether the channel's copy of the text is even a
    // CANDIDATE depends on whether the channel record corroborated. An
    // unverified resolution is not an authority for words any more than it is
    // for a coordinate — which is what keeps a corrupted coordinate from
    // serving adjacent content.
    const channelView = deriveAnswerShareChannelView({
      binding: record.channel,
      channelLog: this.#deps.channelLog,
    });
    const { blocks, omitted } = projectAnswerBlocks(message.parts);
    const arbitration = arbitrateAnswerShareContent({
      recordedDigest: record.contentDigest,
      sessionBlocks: blocks,
      channelBlocks: channelView.corroborated?.blocks,
      digest: answerShareContentDigest,
    });
    if (arbitration.outcome === 'unavailable') {
      // The words on this Station are no longer the words the operator
      // shared, and no store offered a copy that is. Same refusal as a turn
      // that vanished, because the honest claim is the same: this link can no
      // longer show what it was minted for — and the RESPONSE must stay
      // byte-identical to that one, because a share holder who can tell "the
      // words drifted" from "the message is gone" has learned something about
      // a Station they hold one capability on.
      //
      // The METRIC is where the two separate, and they have to: digest drift
      // has a systemic cause (any change to the projection the digest covers
      // invalidates every recorded digest at once — see
      // `answerShareContentDigestInput`) and its symptom is a total outage
      // that looks exactly like ordinary turn attrition on the counter. An
      // operator watching one series could not see the difference, which is
      // what makes the "loud" failure this trade assumes actually quiet.
      answerShareViews.add(1, { outcome: 'content_digest_mismatch' });
      return { state: 'refused', reason: 'answer-no-longer-available' };
    }
    recordChannelStatus(channelView.status);
    answerShareViews.add(1, { outcome: 'served' });
    return {
      state: 'ok',
      // Derived from the COMPUTED status, so the version an old reader keys
      // on cannot outrun what this read actually managed to say.
      schemaVersion: answerShareSchemaVersionFor(channelView.status),
      channel: channelView.status,
      share: {
        id: record.id,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
        ...(record.label === null ? {} : { label: record.label }),
      },
      answer: {
        sessionId: record.sessionId,
        turnId: record.turnId,
        // The arbitrated copy, never `blocks` directly: whichever store
        // supplied text that matches the mint-time digest is the one that
        // serves, and if that was the channel's copy then the session's is
        // simply not what the operator shared.
        blocks: [...arbitration.blocks],
        omittedBlocks:
          arbitration.source === 'channel'
            ? // Only the store that supplied the text can say how much of it
              // it dropped. A channel resolution that does not say reports
              // zero, which is what "it handed over everything it had" means
              // for a copy it projected itself.
              //
              // Clamped rather than `??`-defaulted: this number participates
              // in a decision the viewer renders as a sentence ("N further
              // blocks are not shown"), and it arrives from a port whose
              // return value is typed but never checked. `??` screens absence
              // and nothing else — not `NaN`, not a negative, not a
              // fractional count — so the same unread-port hazard the channel
              // status is gated against applies here at a smaller scale.
              clampOmittedBlocks(channelView.corroborated?.omittedBlocks)
            : omitted,
      },
      provenance: projectProvenanceForShare(message),
    };
  }

  /**
   * The mint-time channel observation (station#1598).
   *
   * There is no fallback here, and the absence is the point: every binding
   * this service records is something an observer AFFIRMATIVELY said, and
   * the observer is supplied by the caller (production supplies
   * {@link NO_CHANNEL_LOG_OBSERVER}). Recording an observation rather than a
   * default is what lets a viewer later distinguish "this Station says the
   * answer is not in a channel" from "this share is older than the
   * question", which are different claims with different remedies and must
   * never share a label.
   *
   * An observer that throws is NOT absorbed. Mint fails, the operator sees
   * it, and no record is written — because the alternative is a record whose
   * absent binding reads forever as "predates channel addressing", which
   * would be false about a share minted today.
   */
  #observeChannelBinding(
    sessionId: string,
    turnId: string,
  ): AnswerShareChannelBinding {
    return this.#deps.channelObserver.observeBinding({ sessionId, turnId });
  }

  /**
   * The turn's assistant message, matched on the message's own `turnId`.
   *
   * Exact match only. Position in the transcript, adjacency to a user turn,
   * and "the newest assistant message" are all ways to return a DIFFERENT
   * answer than the one the operator shared, and a share that silently
   * re-points at another answer is the worst failure this surface has.
   */
  private defaultReadAuthority(
    ownerUserId?: string | null,
  ): SessionReadAuthority {
    // Public callers cannot manufacture a branded scope. A hosted session
    // reader rejects this personal compatibility fallback, failing closed.
    return sessionReadAuthorityFromRequest(
      ownerUserId ?? '',
      undefined,
      undefined,
    );
  }

  #canManageSession(
    sessionId: string,
    authority: SessionReadAuthority,
  ): boolean {
    // Existing personal callers retain their one-user store behavior. Hosted
    // callers must provide tenant context and traverse the central policy; a
    // partially wired hosted reader cannot silently authorize a share.
    if (isHostedSessionReadAuthority(authority)) {
      return Boolean(
        authority.tenantExecutionContext &&
          this.#deps.sessions.canUserReadSession?.(sessionId, authority),
      );
    }
    return (
      this.#deps.sessions.canUserReadSession?.(sessionId, authority) ?? true
    );
  }

  #findTurnMessage(
    sessionId: string,
    turnId: string,
    authority: SessionReadAuthority,
  ): ConversationMessage | undefined {
    let messages: readonly ConversationMessage[];
    try {
      messages = this.#deps.sessions.readSessionMessages(sessionId, authority);
    } catch {
      // A session the reader cannot open is indistinguishable from one that
      // is gone, and both are honestly "no longer available" to the holder.
      return undefined;
    }
    return messages.find(
      (message) =>
        message.role === 'assistant' && message.metadata?.turnId === turnId,
    );
  }
}

/**
 * The envelope a share holder receives: re-authorized, or an explicit absence.
 *
 * `undefined` when the turn carries no envelope at all, and `undefined` again
 * when the stored envelope is not one this build understands. The second case
 * is deliberately not passed through raw: the card would render its own
 * unreadable state either way, and forwarding an unparsed payload to an
 * unauthenticated viewer would mean shipping bytes nothing on this server has
 * validated.
 */
function projectProvenanceForShare(
  message: ConversationMessage,
): unknown | undefined {
  const envelope = message.metadata?.provenance;
  if (!isSupportedTurnProvenanceEnvelope(envelope)) return undefined;
  return projectEnvelopeForShareViewer(
    envelope,
    ANSWER_SHARE_VIEWER_AUTHORIZATION,
  );
}

export type { StoredAnswerShare };
