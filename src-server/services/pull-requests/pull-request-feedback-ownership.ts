/**
 * Who receives a pull request's agent feedback, and what a person sees.
 *
 * One owning conversation per pull request (the claim, keyed by canonical
 * identity). A conversation may claim only a pull request it already holds
 * on a person's say-so: one a person linked to it (`explicit`, across its
 * Session lineage) or one a person kept on its Task (`task-declared`). An
 * agent's own declaration is never ownership. A reviewer conversation
 * (`review-…`) never holds a claim.
 *
 * A second conversation turning feedback on is refused with the owner named
 * (`conflict`) unless it asks to move it here, which bumps the claim's
 * generation so anything queued for the old owner is refused at placement.
 * A claim whose switches are all off holds nothing and is taken over freely.
 */
import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';
import {
  type ConversationPullRequestFeedback,
  PULL_REQUEST_FEEDBACK_OFF,
  type PullRequestFeedbackByPullRequest,
  type PullRequestFeedbackDelivery,
  type PullRequestFeedbackOwner,
  type PullRequestFeedbackSettings,
  type PullRequestFeedbackStatus,
  type PullRequestFeedbackView,
  type PullRequestHeadReview,
  type PullRequestHeadReviewWaiting,
  pullRequestFeedbackActive,
  pullRequestFeedbackKey,
  pullRequestFeedbackSends,
} from '@kontourai/station-contracts/pull-request-feedback';
import {
  type FeedbackSessionState,
  failingChecksHeld,
} from './pull-request-feedback-delivery.js';
import type {
  PullRequestFeedbackClaim,
  PullRequestFeedbackStore,
} from './pull-request-feedback-store.js';

const HISTORY_LIMIT = 20;

/**
 * #4508 hand-off: whether this claim sends a Task follow-up of this kind
 * itself (failing checks under "Fix failing checks", reviews under "Address
 * review comments"), so the Task's lead is not also woken for it. While the
 * claim is paused, unavailable or closed it sends nothing, and the Task
 * follow-up wake keeps waking.
 */
export function pullRequestFeedbackSendsKind(
  claim: Pick<PullRequestFeedbackClaim, 'settings' | 'condition'>,
  kind: string,
): boolean {
  if (claim.condition) return false;
  if (kind === 'check_run') return claim.settings.fixFailingChecks;
  if (kind === 'review' || kind === 'review_comment')
    return claim.settings.addressReviewComments;
  return false;
}
const REVIEWER_CONVERSATION = /^review-/;

export interface PullRequestFeedbackOwnershipPorts {
  /** Opened on first write. */
  store(): PullRequestFeedbackStore | undefined;
  /** Undefined until something was written. */
  readStore(): PullRequestFeedbackStore | undefined;
  /** The pull requests a person linked to or kept on this conversation. */
  linkedIdentities(
    conversationId: string,
  ): Promise<readonly PullRequestLinkIdentity[]>;
  session(conversationId: string): FeedbackSessionState;
  mayContinue(conversationId: string, userId: string): boolean;
  /** The conversation's title. */
  title(conversationId: string): string | undefined;
  /** Station's newest review of one of the pull request's heads. */
  headReview?(prKey: string): PullRequestHeadReview | undefined;
  /** Why the observed head has no review yet. */
  headReviewWaiting?(prKey: string): PullRequestHeadReviewWaiting | undefined;
  /** The head review preview: while off, `reviewEachHead` alone does nothing. */
  headReviewEnabled?(): boolean;
  now?(): number;
}

export type PullRequestFeedbackEnableResult =
  | { kind: 'ok'; view: PullRequestFeedbackView }
  | { kind: 'not-linked' }
  | { kind: 'reviewer' }
  | { kind: 'not-permitted' }
  | { kind: 'unavailable' }
  | { kind: 'conflict'; owner: PullRequestFeedbackOwner };

/** The person asking, and what they may read. */
export interface PullRequestFeedbackViewer {
  userId: string;
  canRead(conversationId: string): boolean;
}

/** Just the pull request: a link carries its source and status too. */
const identityOf = (
  link: PullRequestLinkIdentity,
): PullRequestLinkIdentity => ({
  provider: link.provider,
  host: link.host,
  repository: { owner: link.repository.owner, name: link.repository.name },
  ref: link.ref,
});

const sameIdentity = (a: PullRequestLinkIdentity, b: PullRequestLinkIdentity) =>
  pullRequestFeedbackKey(a) === pullRequestFeedbackKey(b);

export class PullRequestFeedbackOwnership {
  constructor(private readonly ports: PullRequestFeedbackOwnershipPorts) {}

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  private headReviewOn(): boolean {
    return this.ports.headReviewEnabled?.() ?? false;
  }

  private async linked(
    conversationId: string,
    identity: PullRequestLinkIdentity,
  ): Promise<PullRequestLinkIdentity | undefined> {
    return (await this.ports.linkedIdentities(conversationId)).find((link) =>
      sameIdentity(link, identity),
    );
  }

  /**
   * Turn switches on or off for a pull request in this conversation. A
   * write that leaves `reviewEachHead` out keeps this chat's stored value
   * (a client that knows only the two sending switches must not turn
   * review off); a new claim or a move starts it off.
   */
  async write(input: {
    conversationId: string;
    identity: PullRequestLinkIdentity;
    settings: Omit<PullRequestFeedbackSettings, 'reviewEachHead'> & {
      reviewEachHead?: boolean;
    };
    viewer: PullRequestFeedbackViewer;
    move?: boolean;
  }): Promise<PullRequestFeedbackEnableResult> {
    if (REVIEWER_CONVERSATION.test(input.conversationId))
      return { kind: 'reviewer' };
    const linked = await this.linked(input.conversationId, input.identity);
    if (!linked) return { kind: 'not-linked' };
    if (!this.ports.mayContinue(input.conversationId, input.viewer.userId))
      return { kind: 'not-permitted' };
    const prKey = pullRequestFeedbackKey(linked);
    const existing = this.ports.readStore()?.claim(prKey);
    if (
      existing &&
      existing.conversationId !== input.conversationId &&
      pullRequestFeedbackActive(existing.settings, this.headReviewOn()) &&
      !input.move
    ) {
      return {
        kind: 'conflict',
        owner: this.ownerFor(existing.conversationId, input.viewer),
      };
    }
    const store = this.ports.store();
    if (!store) return { kind: 'unavailable' };
    const settings: PullRequestFeedbackSettings = {
      fixFailingChecks: input.settings.fixFailingChecks,
      addressReviewComments: input.settings.addressReviewComments,
      reviewEachHead:
        input.settings.reviewEachHead ??
        (existing?.conversationId === input.conversationId
          ? existing.settings.reviewEachHead
          : false),
    };
    if (
      !pullRequestFeedbackActive(settings, this.headReviewOn()) &&
      existing?.conversationId === input.conversationId
    ) {
      // Every switch off is turning it off: what waited is dropped, as `off`.
      store.releaseClaim(prKey, new Date(this.now()).toISOString());
      // A person turned it off here: a watching Task does not turn it on
      // again (as `off`).
      if (existing?.watch) store.setWatch(prKey, null);
      return {
        kind: 'ok',
        view: this.viewOf(
          store,
          identityOf(linked),
          input.conversationId,
          input.viewer,
        ),
      };
    }
    store.writeClaim({
      prKey,
      identity: {
        provider: linked.provider,
        host: linked.host.toLowerCase(),
        repository: { ...linked.repository },
        ref: linked.ref,
      },
      conversationId: input.conversationId,
      settings,
      enabledBy: input.viewer.userId,
      now: new Date(this.now()).toISOString(),
      ...(existing?.conversationId === input.conversationId &&
      pullRequestFeedbackSends(settings) &&
      existing.watch
        ? { watch: existing.watch }
        : {}),
    });
    return {
      kind: 'ok',
      view: this.viewOf(
        store,
        identityOf(linked),
        input.conversationId,
        input.viewer,
      ),
    };
  }

  /** Turn every switch off; history stays. Only the owner's chat may. */
  async off(input: {
    conversationId: string;
    identity: PullRequestLinkIdentity;
    viewer: PullRequestFeedbackViewer;
  }): Promise<PullRequestFeedbackEnableResult> {
    // Found by its key, not through the chat's links: a pull request
    // unlinked since must still be possible to turn off.
    const prKey = pullRequestFeedbackKey(input.identity);
    const store = this.ports.store();
    const claim = store?.claim(prKey);
    if (!store || !claim || claim.conversationId !== input.conversationId)
      return { kind: 'not-linked' };
    if (!this.ports.mayContinue(input.conversationId, input.viewer.userId))
      return { kind: 'not-permitted' };
    store.releaseClaim(prKey, new Date(this.now()).toISOString());
    // A person turned it off here: a watching Task does not turn it on again.
    if (claim.watch) store.setWatch(prKey, null);
    return {
      kind: 'ok',
      view: this.viewOf(
        store,
        claim.identity,
        input.conversationId,
        input.viewer,
      ),
    };
  }

  /** Every linked pull request's feedback, as this conversation's reader sees it. */
  async view(
    conversationId: string,
    viewer: PullRequestFeedbackViewer,
  ): Promise<ConversationPullRequestFeedback> {
    const identities = await this.ports.linkedIdentities(conversationId);
    const store = this.ports.readStore();
    const seen = new Set<string>();
    const pullRequests: PullRequestFeedbackView[] = [];
    for (const linked of identities) {
      const identity = identityOf(linked);
      const key = pullRequestFeedbackKey(identity);
      if (seen.has(key)) continue;
      seen.add(key);
      pullRequests.push(this.viewOf(store, identity, conversationId, viewer));
    }
    return { conversationId, pullRequests };
  }

  /** Whether this conversation owns the pull request, for Send again. */
  ownedClaim(
    conversationId: string,
    identity: PullRequestLinkIdentity,
  ): PullRequestFeedbackClaim | undefined {
    const claim = this.ports
      .readStore()
      ?.claim(pullRequestFeedbackKey(identity));
    return claim?.conversationId === conversationId ? claim : undefined;
  }

  private viewOf(
    store: PullRequestFeedbackStore | undefined,
    identity: PullRequestLinkIdentity,
    conversationId: string,
    viewer: PullRequestFeedbackViewer,
  ): PullRequestFeedbackView {
    const prKey = pullRequestFeedbackKey(identity);
    const claim = store?.claim(prKey);
    if (!store || !claim)
      return {
        identity,
        ownedHere: false,
        owner: null,
        settings: { ...PULL_REQUEST_FEEDBACK_OFF },
        status: { state: 'off' },
        history: [],
      };
    const ownedHere = claim.conversationId === conversationId;
    const history = ownedHere ? this.history(store, claim) : [];
    const owner = pullRequestFeedbackActive(claim.settings, this.headReviewOn())
      ? ownedHere
        ? { conversationId }
        : this.ownerFor(claim.conversationId, viewer)
      : null;
    // The by-pull-request read's rule: a reader who may not read the owning
    // chat learns only that another chat owns it, never its switches or
    // status (a pause's head and time, a stopped agent).
    const hidden = !ownedHere && owner !== null && !owner.conversationId;
    const headReview = ownedHere ? this.ports.headReview?.(prKey) : undefined;
    const headReviewWaiting = ownedHere
      ? this.ports.headReviewWaiting?.(prKey)
      : undefined;
    return {
      identity,
      ownedHere,
      owner,
      settings: hidden ? { ...PULL_REQUEST_FEEDBACK_OFF } : claim.settings,
      status: hidden ? { state: 'off' } : this.status(store, claim),
      ...(history[0] ? { last: history[0] } : {}),
      history,
      ...(headReview ? { headReview } : {}),
      ...(headReviewWaiting ? { headReviewWaiting } : {}),
    };
  }

  /**
   * The owning chat as this reader may know it: its id and title only when
   * the reader may read it, otherwise nothing but that another chat owns it.
   */
  private ownerFor(
    conversationId: string,
    viewer: PullRequestFeedbackViewer,
  ): PullRequestFeedbackOwner {
    const title = this.readableTitle(conversationId, viewer);
    return title === undefined ? {} : { conversationId, title };
  }

  private readableTitle(
    conversationId: string,
    viewer: Pick<PullRequestFeedbackViewer, 'canRead'>,
  ): string | undefined {
    try {
      return viewer.canRead(conversationId)
        ? (this.ports.title(conversationId) ?? 'Untitled chat')
        : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * One pull request's feedback for anyone looking at the pull request.
   * A reader who may not read the owning chat learns only that another
   * chat owns it: no id, title, status, settings or history.
   */
  byPullRequest(
    identity: PullRequestLinkIdentity,
    viewer: Pick<PullRequestFeedbackViewer, 'canRead'>,
    /**
     * false: without `sentChecks` or the head review (the Task board reads
     * only the rest, once per card).
     */
    options: { sentChecks?: boolean; headReview?: boolean } = {},
  ): PullRequestFeedbackByPullRequest {
    const exact = identityOf(identity);
    const store = this.ports.readStore();
    const claim = store?.claim(pullRequestFeedbackKey(exact));
    if (
      !store ||
      !claim ||
      !pullRequestFeedbackActive(claim.settings, this.headReviewOn())
    )
      return { identity: exact, owner: null };
    const title = this.readableTitle(claim.conversationId, viewer);
    if (title === undefined)
      return { identity: exact, owner: { readable: false } };
    const head = store.observation(claim.prKey)?.observation.headSha;
    const last = head ? this.lastSentOnHead(store, claim, head) : undefined;
    const sentChecks =
      options.sentChecks === false
        ? undefined
        : this.sentChecks(store, claim.prKey);
    const withReview = options.headReview !== false;
    const headReview = withReview
      ? this.ports.headReview?.(claim.prKey)
      : undefined;
    const headReviewWaiting = withReview
      ? this.ports.headReviewWaiting?.(claim.prKey)
      : undefined;
    return {
      identity: exact,
      owner: { readable: true, conversationId: claim.conversationId, title },
      status: this.status(store, claim),
      settings: claim.settings,
      ...(last ? { last } : {}),
      ...(sentChecks ? { sentChecks } : {}),
      ...(headReview ? { headReview } : {}),
      ...(headReviewWaiting ? { headReviewWaiting } : {}),
    };
  }

  /**
   * The newest message sent about this head. A send about an earlier push
   * says nothing about the one on screen, so it is not "the last send".
   */
  private lastSentOnHead(
    store: PullRequestFeedbackStore,
    claim: PullRequestFeedbackClaim,
    headSha: string,
  ): PullRequestFeedbackDelivery | undefined {
    for (const batch of store.batchesForConversation(
      claim.conversationId,
      HISTORY_LIMIT * 2,
    )) {
      if (batch.state !== 'sent') continue;
      const entry = batch.summary.find((part) => part.prKey === claim.prKey);
      if (!entry || entry.headSha !== headSha) continue;
      return {
        id: batch.key,
        at: batch.settledAt ?? batch.createdAt,
        headSha,
        categories: entry.categories,
        state: 'sent',
      };
    }
    return undefined;
  }

  /**
   * The failing checks the agent was sent on the head Station last
   * observed, each at the newest time it went, with its link from that
   * observation. Nothing for an earlier head: a check sent about an old
   * push says nothing about the one on screen.
   */
  private sentChecks(
    store: PullRequestFeedbackStore,
    prKey: string,
  ): PullRequestFeedbackByPullRequest['sentChecks'] {
    const observation = store.observation(prKey)?.observation;
    if (!observation) return undefined;
    const headSha = observation.headSha;
    const urls = new Map(
      observation.checks.flatMap((check) =>
        check.url ? [[check.name, check.url] as const] : [],
      ),
    );
    const at = new Map<string, string>();
    for (const delivery of store.recentSentFailures(prKey, HISTORY_LIMIT)) {
      if (delivery.headSha !== headSha || !delivery.settledAt) continue;
      for (const name of delivery.summary.failing ?? [])
        if ((at.get(name) ?? '') < delivery.settledAt)
          at.set(name, delivery.settledAt);
    }
    if (!at.size) return undefined;
    return {
      headSha,
      checks: [...at].map(([name, sentAt]) => {
        const url = urls.get(name);
        return { name, ...(url ? { url } : {}), at: sentAt };
      }),
    };
  }

  private status(
    store: PullRequestFeedbackStore,
    claim: PullRequestFeedbackClaim,
  ): PullRequestFeedbackStatus {
    if (!pullRequestFeedbackActive(claim.settings, this.headReviewOn()))
      return { state: 'off' };
    const condition = claim.condition;
    if (condition?.state === 'closed') return { state: 'closed' };
    if (condition?.state === 'paused')
      return {
        state: 'paused',
        reason: condition.reason,
        ...(condition.cap ? { cap: condition.cap } : {}),
        headSha: condition.headSha,
        ...(condition.at ? { at: condition.at } : {}),
      };
    if (condition?.state === 'unavailable')
      return { state: 'unavailable', cause: condition.cause };
    const session = this.ports.session(claim.conversationId);
    if (session.state === 'stopped')
      return { state: 'held', reason: 'agent-stopped' };
    const waiting = store
      .pendingDeliveries(claim.conversationId)
      .some((delivery) => delivery.prKey === claim.prKey);
    if (!waiting) {
      const stored = store.observation(claim.prKey);
      if (
        claim.settings.fixFailingChecks &&
        stored?.observation.state === 'OPEN' &&
        failingChecksHeld(
          stored.observation,
          stored.incompleteSince,
          this.now(),
        )
      )
        return { state: 'held', reason: 'checks-running' };
      return { state: 'watching' };
    }
    if (!this.ports.mayContinue(claim.conversationId, claim.enabledBy))
      return { state: 'held', reason: 'owner-changed' };
    if (session.state === 'awaiting')
      return { state: 'held', reason: 'agent-waiting' };
    return { state: 'held', reason: 'agent-busy' };
  }

  /** Messages that carried this pull request, then what still waits. */
  private history(
    store: PullRequestFeedbackStore,
    claim: PullRequestFeedbackClaim,
  ): PullRequestFeedbackDelivery[] {
    const rows: PullRequestFeedbackDelivery[] = [];
    const waiting = store
      .pendingDeliveries(claim.conversationId)
      .filter((delivery) => delivery.prKey === claim.prKey);
    if (waiting.length)
      rows.push({
        id: `held:${claim.prKey}`,
        at: waiting.at(-1)!.createdAt,
        headSha: waiting.at(-1)!.headSha,
        categories: waiting.map((delivery) => ({
          category: delivery.category,
          count: delivery.summary.count,
        })),
        state: 'held',
      });
    for (const batch of store.batchesForConversation(
      claim.conversationId,
      HISTORY_LIMIT * 2,
    )) {
      const entry = batch.summary.find((part) => part.prKey === claim.prKey);
      if (!entry) continue;
      rows.push({
        id: batch.key,
        at: batch.settledAt ?? batch.createdAt,
        headSha: entry.headSha,
        categories: entry.categories,
        state:
          batch.state === 'sent'
            ? 'sent'
            : batch.state === 'refused'
              ? 'refused'
              : batch.state === 'cancelled'
                ? 'superseded'
                : 'queued',
        ...(batch.state === 'refused'
          ? { reason: refusalWords(batch.reasonCode) }
          : batch.state === 'cancelled'
            ? { reason: 'Withdrawn from the chat.' }
            : {}),
      });
    }
    return rows.slice(0, HISTORY_LIMIT);
  }
}

/** A refusal code in a person's words. */
function refusalWords(code: string | undefined): string {
  switch (code) {
    case 'pr_feedback_stale':
      return 'The pull request moved on first.';
    case 'pr_feedback_session_waiting':
      return 'The agent was waiting on a person.';
    case 'pr_feedback_owner_changed':
      return 'Feedback moved to another chat.';
    default:
      return 'Station could not send it.';
  }
}
