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
  type PullRequestFeedbackDelivery,
  type PullRequestFeedbackSettings,
  type PullRequestFeedbackStatus,
  type PullRequestFeedbackView,
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
  now?(): number;
}

export type PullRequestFeedbackEnableResult =
  | { kind: 'ok'; view: PullRequestFeedbackView }
  | { kind: 'not-linked' }
  | { kind: 'reviewer' }
  | { kind: 'not-permitted' }
  | { kind: 'unavailable' }
  | { kind: 'conflict'; owner: { conversationId: string; title?: string } };

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

  private async linked(
    conversationId: string,
    identity: PullRequestLinkIdentity,
  ): Promise<PullRequestLinkIdentity | undefined> {
    return (await this.ports.linkedIdentities(conversationId)).find((link) =>
      sameIdentity(link, identity),
    );
  }

  /** Turn switches on or off for a pull request in this conversation. */
  async write(input: {
    conversationId: string;
    identity: PullRequestLinkIdentity;
    settings: PullRequestFeedbackSettings;
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
      pullRequestFeedbackSends(existing.settings) &&
      !input.move
    ) {
      const title = this.titleFor(existing.conversationId, input.viewer);
      return {
        kind: 'conflict',
        owner: {
          conversationId: existing.conversationId,
          ...(title ? { title } : {}),
        },
      };
    }
    const store = this.ports.store();
    if (!store) return { kind: 'unavailable' };
    store.writeClaim({
      prKey,
      identity: {
        provider: linked.provider,
        host: linked.host.toLowerCase(),
        repository: { ...linked.repository },
        ref: linked.ref,
      },
      conversationId: input.conversationId,
      settings: input.settings,
      enabledBy: input.viewer.userId,
      now: new Date(this.now()).toISOString(),
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
    const title = ownedHere
      ? undefined
      : this.titleFor(claim.conversationId, viewer);
    const history = ownedHere ? this.history(store, claim) : [];
    return {
      identity,
      ownedHere,
      owner: pullRequestFeedbackSends(claim.settings)
        ? { conversationId: claim.conversationId, ...(title ? { title } : {}) }
        : null,
      settings: claim.settings,
      status: this.status(store, claim),
      ...(history[0] ? { last: history[0] } : {}),
      history,
    };
  }

  private titleFor(
    conversationId: string,
    viewer: PullRequestFeedbackViewer,
  ): string | undefined {
    try {
      return viewer.canRead(conversationId)
        ? (this.ports.title(conversationId) ?? 'Untitled chat')
        : undefined;
    } catch {
      return undefined;
    }
  }

  private status(
    store: PullRequestFeedbackStore,
    claim: PullRequestFeedbackClaim,
  ): PullRequestFeedbackStatus {
    if (!pullRequestFeedbackSends(claim.settings)) return { state: 'off' };
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
