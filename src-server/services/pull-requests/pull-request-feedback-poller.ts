/**
 * Detection for pull request agent feedback: one bounded forge read per
 * claimed pull request when it is due, riding the built-in scheduler's
 * existing minute tick (no timer of its own), on its own single flight so a
 * slow read never holds the scheduler's automation chain.
 *
 * Which pull requests: claimed, a switch that sends or review of each new
 * head is on (`pullRequestFeedbackActive`), not closed, and
 * the owning conversation's agent has not stopped. At most
 * `MAX_PER_TICK` per tick, oldest due first, inside a deadline; a read the
 * deadline cut is still marked read, so one slow pull request cannot sort
 * first forever.
 *
 * Cadence per pull request (`next_due_at`): every 2 minutes while its
 * agent had a turn in the last 2 hours or feedback is waiting; every 15
 * minutes once nothing changed for an hour; otherwise every 10. When the
 * owning agent's turn ends, that conversation's pull requests are read
 * again at once, at most once a minute each, so a push is seen before
 * anything stale is sent. A closed or merged pull request is read every six
 * hours, and watched again if it reopens. A claim whose pull request is no
 * longer linked to its conversation is released, not read.
 *
 * Not signed in to the forge: that host backs off 15 minutes (in memory)
 * and the claim reads `unavailable`; switches stay on. Rate limited: every
 * read backs off 15 minutes.
 */
import { createHash } from 'node:crypto';
import type { PullRequestLinkIdentity } from '@kontourai/station-contracts/conversation-pull-request-links';
import type {
  PullRequestFeedbackObservation,
  PullRequestFeedbackObservationResult,
} from '@kontourai/station-contracts/pull-request-feedback';
import {
  pullRequestFeedbackActive,
  pullRequestFeedbackKey,
} from '@kontourai/station-contracts/pull-request-feedback';
import type { IPullRequestProvider } from '@kontourai/station-contracts/pull-request-provider';
import { errorMessage } from '../../utils/error-message.js';
import type {
  FeedbackSessionState,
  PullRequestFeedbackDelivery,
} from './pull-request-feedback-delivery.js';
import type {
  PullRequestFeedbackClaim,
  PullRequestFeedbackStore,
} from './pull-request-feedback-store.js';

const MINUTE = 60_000;
export const MAX_PER_TICK = 20;
const TICK_DEADLINE_MS = 60_000;
const BACKOFF_MS = 15 * MINUTE;
const ACTIVE_WINDOW_MS = 2 * 60 * MINUTE;
const ACTIVE_INTERVAL_MS = 2 * MINUTE;
const QUIET_INTERVAL_MS = 15 * MINUTE;
const DEFAULT_INTERVAL_MS = 10 * MINUTE;
const QUIET_AFTER_MS = 60 * MINUTE;
const TURN_END_DEBOUNCE_MS = MINUTE;
/** A closed or merged pull request is read this rarely, in case it reopens. */
const CLOSED_INTERVAL_MS = 6 * 60 * MINUTE;

export interface PullRequestFeedbackPollerPorts {
  enabled(): boolean;
  store(): PullRequestFeedbackStore | undefined;
  providers(): IPullRequestProvider[];
  session(conversationId: string): FeedbackSessionState;
  /** When the owning conversation's newest turn started or ended. */
  lastTurnAt(conversationId: string): number | undefined;
  delivery(): PullRequestFeedbackDelivery | undefined;
  /**
   * Station's review of each new head, considered after delivery decided
   * (a message it queued keeps the agent busy, so no review starts under
   * it). Never throws.
   */
  headReview?():
    | { consider(conversationId: string): Promise<void> }
    | undefined;
  /** The head review preview: while off, `reviewEachHead` alone reads nothing. */
  headReviewEnabled?(): boolean;
  /** As the delivery's: a claim no longer linked is released, not read. */
  linked?(conversationId: string): readonly PullRequestLinkIdentity[];
  /**
   * Project defaults' Task-branch discovery, first on each tick, inside the
   * same deadline and backoff: `rate-limited` backs every read off.
   */
  discover?(input: {
    now: number;
    signal: AbortSignal;
  }): Promise<'ok' | 'rate-limited'>;
  readonly logger: {
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  now?(): number;
  deadlineMs?: number;
}

export interface PullRequestFeedbackPollSummary {
  outcome: 'disabled' | 'polled' | 'stopped' | 'backing-off';
  read: number;
}

/** What a read shows, minus when it was read: equal digests mean nothing changed. */
function observationDigest(observation: PullRequestFeedbackObservation) {
  const { observedAt: _observedAt, ...rest } = observation;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}

export class PullRequestFeedbackPoller {
  private inFlight: Promise<unknown> | undefined;
  private backoffUntil = 0;
  private readonly hostBackoff = new Map<string, number>();
  private readonly refreshing = new Set<string>();
  private readonly closing = new AbortController();

  constructor(private readonly ports: PullRequestFeedbackPollerPorts) {}

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  /** Start a poll on its own single flight; never waits for it. */
  tick(input: { now: number; signal: AbortSignal }): void {
    if (this.inFlight || this.closing.signal.aborted) return;
    this.inFlight = this.poll({
      now: input.now,
      signal: AbortSignal.any([input.signal, this.closing.signal]),
    })
      .catch((error) =>
        this.ports.logger.warn('Pull request feedback poll failed', {
          error: errorMessage(error),
        }),
      )
      .finally(() => {
        this.inFlight = undefined;
      });
  }

  settled(): Promise<unknown> {
    return this.inFlight ?? Promise.resolve();
  }

  async close(): Promise<void> {
    this.closing.abort(new Error('Pull request feedback is stopping'));
    await this.settled();
  }

  private headReviewOn(): boolean {
    return this.ports.headReviewEnabled?.() ?? false;
  }

  /** Whether a claim is read at all; the lifecycle read is last (it costs most). */
  private polled(claim: PullRequestFeedbackClaim): boolean {
    return (
      pullRequestFeedbackActive(claim.settings, this.headReviewOn()) &&
      this.ports.session(claim.conversationId).state !== 'stopped'
    );
  }

  /** Whether the claim's pull request is still linked to its conversation. */
  private async stillLinked(
    store: PullRequestFeedbackStore,
    claim: PullRequestFeedbackClaim,
    cache: Map<string, Set<string>>,
    now: number,
  ): Promise<boolean> {
    if (!this.ports.linked) return true;
    let keys = cache.get(claim.conversationId);
    if (!keys) {
      keys = new Set(
        this.ports.linked(claim.conversationId).map(pullRequestFeedbackKey),
      );
      cache.set(claim.conversationId, keys);
    }
    if (keys.has(claim.prKey)) return true;
    store.releaseClaim(claim.prKey, new Date(now).toISOString());
    return false;
  }

  /** One read, unless another read of the same pull request is running. */
  private async readOnce(
    store: PullRequestFeedbackStore,
    claim: PullRequestFeedbackClaim,
    now: number,
    signal: AbortSignal,
  ): Promise<'observed' | 'unavailable' | 'rate-limited' | 'busy'> {
    if (this.refreshing.has(claim.prKey)) return 'busy';
    this.refreshing.add(claim.prKey);
    try {
      return await this.read(store, claim, now, signal);
    } finally {
      this.refreshing.delete(claim.prKey);
    }
  }

  async poll(input: {
    now: number;
    signal: AbortSignal;
  }): Promise<PullRequestFeedbackPollSummary> {
    if (!this.ports.enabled()) return { outcome: 'disabled', read: 0 };
    if (input.now < this.backoffUntil)
      return { outcome: 'backing-off', read: 0 };
    const store = this.ports.store();
    if (!store) return { outcome: 'stopped', read: 0 };
    store.prune(input.now);
    const deadline = AbortSignal.timeout(
      this.ports.deadlineMs ?? TICK_DEADLINE_MS,
    );
    const signal = AbortSignal.any([input.signal, deadline]);
    // Before the reads: a pull request claimed now is read this tick.
    if (
      (await this.ports.discover?.({ now: input.now, signal })) ===
      'rate-limited'
    ) {
      this.backoffUntil = input.now + BACKOFF_MS;
      return { outcome: 'backing-off', read: 0 };
    }
    const due = store
      .allClaims()
      .filter((claim) =>
        pullRequestFeedbackActive(claim.settings, this.headReviewOn()),
      )
      .map((claim) => ({ claim, at: store.nextDueAt(claim.prKey) }))
      .filter(({ at }) => at <= input.now)
      .sort((a, b) => a.at - b.at)
      .filter(({ claim }) => this.polled(claim))
      .slice(0, MAX_PER_TICK);
    const touched = new Set<string>();
    const linked = new Map<string, Set<string>>();
    let read = 0;
    for (const { claim } of due) {
      if (signal.aborted) break;
      if (!(await this.stillLinked(store, claim, linked, input.now))) continue;
      const outcome = await this.readOnce(store, claim, input.now, signal);
      if (outcome === 'busy') continue;
      read += 1;
      touched.add(claim.conversationId);
      if (outcome === 'rate-limited') {
        this.backoffUntil = input.now + BACKOFF_MS;
        this.ports.logger.warn('Pull request feedback paused: rate limited', {
          until: new Date(this.backoffUntil).toISOString(),
        });
        break;
      }
    }
    for (const conversationId of touched) {
      await this.ports.delivery()?.deliver(conversationId);
      await this.ports.headReview?.()?.consider(conversationId);
    }
    return {
      outcome: signal.aborted
        ? 'stopped'
        : input.now < this.backoffUntil
          ? 'backing-off'
          : 'polled',
      read,
    };
  }

  /**
   * Read a conversation's pull requests again now (at most once a minute
   * each), then decide: when its agent's turn ends, and when a person turns
   * feedback on. Never throws.
   */
  async refresh(conversationId: string): Promise<void> {
    try {
      const store = this.ports.store();
      if (!store || !this.ports.enabled()) return;
      const now = this.now();
      if (now < this.backoffUntil) {
        await this.ports.delivery()?.deliver(conversationId);
        return;
      }
      const linked = new Map<string, Set<string>>();
      for (const claim of store.claimsForConversation(conversationId)) {
        // A closed pull request is only read on its six-hourly re-read.
        if (claim.condition?.state === 'closed' || !this.polled(claim))
          continue;
        if (!(await this.stillLinked(store, claim, linked, now))) continue;
        const last = store.observation(claim.prKey);
        if (last && now - Date.parse(last.observedAt) < TURN_END_DEBOUNCE_MS)
          continue;
        await this.readOnce(
          store,
          claim,
          now,
          AbortSignal.any([
            this.closing.signal,
            AbortSignal.timeout(this.ports.deadlineMs ?? TICK_DEADLINE_MS),
          ]),
        );
      }
      await this.ports.delivery()?.deliver(conversationId);
      await this.ports.headReview?.()?.consider(conversationId);
    } catch (error) {
      this.ports.logger.warn('Pull request feedback refresh failed', {
        conversationId,
        error: errorMessage(error),
      });
    }
  }

  private async read(
    store: PullRequestFeedbackStore,
    claim: PullRequestFeedbackClaim,
    now: number,
    signal: AbortSignal,
  ): Promise<'observed' | 'unavailable' | 'rate-limited'> {
    const host = claim.identity.host.toLowerCase();
    const prior = store.observation(claim.prKey);
    const markDue = (at: number) => store.setNextDueAt(claim.prKey, at);
    if ((this.hostBackoff.get(host) ?? 0) > now) {
      markDue(this.hostBackoff.get(host)!);
      return 'unavailable';
    }
    const provider = this.ports
      .providers()
      .find(
        (candidate) =>
          candidate.id === claim.identity.provider &&
          candidate.canServeHost(host) &&
          candidate.getFeedbackObservation,
      );
    let result: PullRequestFeedbackObservationResult;
    if (!provider?.getFeedbackObservation)
      result = {
        state: 'unavailable',
        cause: 'unsupported',
        reason: 'This forge has no feedback read.',
      };
    else
      try {
        result = await provider.getFeedbackObservation(
          { host, repository: claim.identity.repository },
          claim.identity.ref,
          signal,
        );
      } catch (error) {
        result = {
          state: 'unavailable',
          cause: 'error',
          reason: errorMessage(error),
        };
      }
    if (result.state === 'unavailable') {
      if (result.cause === 'credentials')
        this.hostBackoff.set(host, now + BACKOFF_MS);
      if (result.cause !== 'rate-limited')
        store.setCondition(claim.prKey, {
          state: 'unavailable',
          cause: result.cause,
        });
      markDue(now + BACKOFF_MS);
      return result.cause === 'rate-limited' ? 'rate-limited' : 'unavailable';
    }
    const observation = result.observation;
    const digest = observationDigest(observation);
    const observedAt = new Date(now).toISOString();
    const unchangedSince =
      prior && prior.digest === digest ? prior.unchangedSince : observedAt;
    // A read that started earlier than one already stored says less.
    const latest = store.observation(claim.prKey);
    if (latest && Date.parse(latest.observedAt) > now) return 'observed';
    if (
      claim.condition?.state === 'unavailable' ||
      (claim.condition?.state === 'closed' && observation.state === 'OPEN')
    )
      store.setCondition(claim.prKey, null);
    if (observation.state !== 'OPEN' && claim.condition?.state !== 'closed')
      store.setCondition(claim.prKey, { state: 'closed', at: observedAt });
    const lastTurn = this.ports.lastTurnAt(claim.conversationId);
    const waiting =
      store
        .pendingDeliveries(claim.conversationId)
        .some((delivery) => delivery.prKey === claim.prKey) ||
      !!store.openBatch(claim.conversationId);
    const interval =
      observation.state !== 'OPEN'
        ? CLOSED_INTERVAL_MS
        : waiting ||
            (lastTurn !== undefined && now - lastTurn < ACTIVE_WINDOW_MS)
          ? ACTIVE_INTERVAL_MS
          : now - Date.parse(unchangedSince) >= QUIET_AFTER_MS
            ? QUIET_INTERVAL_MS
            : DEFAULT_INTERVAL_MS;
    // When each check was first seen incomplete on this head, so a check
    // that never finishes stops holding the rest (`checksStillRunning`).
    const priorSince =
      prior?.observation.headSha === observation.headSha
        ? (prior.incompleteSince ?? {})
        : {};
    const incompleteSince = Object.fromEntries(
      observation.checks
        .filter((check) => !check.completed)
        .map((check) => [check.name, priorSince[check.name] ?? observedAt]),
    );
    // When this head was first seen, so a head review waits for a second
    // read (or a finished turn) before it starts: a push often follows
    // another within the same turn.
    const headFirstSeenAt =
      prior?.observation.headSha === observation.headSha
        ? (prior.headFirstSeenAt ?? prior.observedAt)
        : observedAt;
    store.writeObservation(claim.prKey, {
      observation,
      observedAt,
      unchangedSince,
      ...(Object.keys(incompleteSince).length ? { incompleteSince } : {}),
      digest,
      headFirstSeenAt,
    });
    markDue(now + interval);
    return 'observed';
  }
}
