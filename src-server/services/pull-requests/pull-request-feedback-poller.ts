/**
 * Detection for pull request agent feedback: one bounded forge read per
 * claimed pull request when it is due, riding the built-in scheduler's
 * existing minute tick (no timer of its own), on its own single flight so a
 * slow read never holds the scheduler's automation chain.
 *
 * Which pull requests: claimed, a switch that sends is on, not closed, and
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
 * anything stale is sent. A closed or merged pull request is read no more.
 *
 * Not signed in to the forge: that host backs off 15 minutes (in memory)
 * and the claim reads `unavailable`; switches stay on. Rate limited: every
 * read backs off 15 minutes.
 */
import { createHash } from 'node:crypto';
import type {
  PullRequestFeedbackObservation,
  PullRequestFeedbackObservationResult,
} from '@kontourai/station-contracts/pull-request-feedback';
import { pullRequestFeedbackSends } from '@kontourai/station-contracts/pull-request-feedback';
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
/** Never read again (a closed pull request). */
const NEVER = Number.MAX_SAFE_INTEGER;

export interface PullRequestFeedbackPollerPorts {
  enabled(): boolean;
  store(): PullRequestFeedbackStore | undefined;
  providers(): IPullRequestProvider[];
  session(conversationId: string): FeedbackSessionState;
  /** When the owning conversation's newest turn started or ended. */
  lastTurnAt(conversationId: string): number | undefined;
  delivery(): PullRequestFeedbackDelivery | undefined;
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

  private polled(claim: PullRequestFeedbackClaim): boolean {
    return (
      pullRequestFeedbackSends(claim.settings) &&
      claim.condition?.state !== 'closed' &&
      this.ports.session(claim.conversationId).state !== 'stopped'
    );
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
    const due = store
      .allClaims()
      .filter((claim) => this.polled(claim))
      .map((claim) => ({ claim, at: store.nextDueAt(claim.prKey) }))
      .filter(({ at }) => at <= input.now)
      .sort((a, b) => a.at - b.at)
      .slice(0, MAX_PER_TICK);
    const touched = new Set<string>();
    let read = 0;
    for (const { claim } of due) {
      if (signal.aborted) break;
      const outcome = await this.read(store, claim, input.now, signal);
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
    for (const conversationId of touched)
      await this.ports.delivery()?.deliver(conversationId);
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
      for (const claim of store.claimsForConversation(conversationId)) {
        if (!this.polled(claim) || this.refreshing.has(claim.prKey)) continue;
        const last = store.observation(claim.prKey);
        if (last && now - Date.parse(last.observedAt) < TURN_END_DEBOUNCE_MS)
          continue;
        this.refreshing.add(claim.prKey);
        try {
          await this.read(
            store,
            claim,
            now,
            AbortSignal.any([
              this.closing.signal,
              AbortSignal.timeout(this.ports.deadlineMs ?? TICK_DEADLINE_MS),
            ]),
          );
        } finally {
          this.refreshing.delete(claim.prKey);
        }
      }
      await this.ports.delivery()?.deliver(conversationId);
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
    if (claim.condition?.state === 'unavailable')
      store.setCondition(claim.prKey, null);
    if (observation.state !== 'OPEN')
      store.setCondition(claim.prKey, { state: 'closed', at: observedAt });
    const lastTurn = this.ports.lastTurnAt(claim.conversationId);
    const waiting =
      store
        .pendingDeliveries(claim.conversationId)
        .some((delivery) => delivery.prKey === claim.prKey) ||
      !!store.openBatch(claim.conversationId);
    const interval =
      observation.state !== 'OPEN'
        ? NEVER - now
        : waiting ||
            (lastTurn !== undefined && now - lastTurn < ACTIVE_WINDOW_MS)
          ? ACTIVE_INTERVAL_MS
          : now - Date.parse(unchangedSince) >= QUIET_AFTER_MS
            ? QUIET_INTERVAL_MS
            : DEFAULT_INTERVAL_MS;
    store.writeObservation(claim.prKey, {
      observation,
      observedAt,
      unchangedSince,
      digest,
    });
    markDue(now + interval);
    return 'observed';
  }
}
