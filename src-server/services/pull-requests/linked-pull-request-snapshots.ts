import type {
  LinkedPullRequestSnapshot,
  PullRequestLinkIdentity,
} from '@kontourai/station-contracts/conversation-pull-request-links';
import { pullRequestFeedbackKey } from '@kontourai/station-contracts/pull-request-feedback';
import type {
  IPullRequestProvider,
  PullRequest,
} from '@kontourai/station-contracts/pull-request-provider';
import { readPullRequestByIdentity } from './pull-request-identity-read.js';

export function linkedSnapshotFromStatus(
  pullRequest: PullRequest,
  observedAt: string,
): LinkedPullRequestSnapshot {
  const landing: LinkedPullRequestSnapshot['landing'] =
    pullRequest.state === 'MERGED'
      ? { state: 'merged' }
      : pullRequest.landing === 'merge-queue'
        ? { state: 'queued' }
        : pullRequest.landing === 'auto-merge'
          ? { state: 'armed' }
          : pullRequest.landing === 'not-queued'
            ? { state: 'not-queued' }
            : undefined;
  return {
    ...pullRequest.snapshot,
    title: pullRequest.title,
    pullRequestState: pullRequest.state,
    url: pullRequest.url,
    head: pullRequest.headSha,
    observedAt,
    isDraft: pullRequest.draft,
    mergeability: pullRequest.mergeability,
    reviewDecision: pullRequest.reviewDecision,
    ...(landing ? { landing } : {}),
  };
}

const CACHE_LIMIT = 600;
const READS_PER_TICK = 6;
const KEEP_MILLISECONDS = 15 * 60_000;
const FRESH_MILLISECONDS = 2 * 60_000;

export class LinkedPullRequestSnapshots {
  private readonly entries = new Map<
    string,
    {
      identity: PullRequestLinkIdentity;
      requestedAt: number;
      readAt?: number;
      snapshot?: LinkedPullRequestSnapshot;
    }
  >();
  private inFlight: Promise<void> | undefined;

  constructor(
    private readonly providers: () => IPullRequestProvider[],
    private readonly enabled: () => boolean,
    private readonly feedback: (
      identity: PullRequestLinkIdentity,
    ) => LinkedPullRequestSnapshot | undefined,
  ) {}

  get(
    identity: PullRequestLinkIdentity,
  ): LinkedPullRequestSnapshot | undefined {
    const key = pullRequestFeedbackKey(identity);
    const entry = this.entries.get(key);
    const now = Date.now();
    if (entry) {
      entry.requestedAt = now;
    } else {
      if (this.entries.size >= CACHE_LIMIT) {
        const oldest = [...this.entries].reduce((a, b) =>
          a[1].requestedAt < b[1].requestedAt ? a : b,
        );
        this.entries.delete(oldest[0]);
      }
      this.entries.set(key, { identity, requestedAt: now });
    }
    const feedback = this.feedback(identity);
    const cached = entry?.snapshot;
    // Keep the richer observation for the same head, as long as the narrow
    // read did not see a state transition.
    if (
      feedback &&
      (!cached ||
        Date.parse(feedback.observedAt ?? '') >=
          Date.parse(cached.observedAt ?? '') ||
        (feedback.head === cached.head &&
          feedback.pullRequestState === cached.pullRequestState &&
          (entry?.readAt ?? 0) - Date.parse(feedback.observedAt ?? '') <
            KEEP_MILLISECONDS))
    )
      return feedback;
    return cached;
  }

  tick(input: { now: number; signal: AbortSignal }): void {
    if (!this.enabled() || this.inFlight || input.signal.aborted) return;
    this.inFlight = this.refresh(input).finally(() => {
      this.inFlight = undefined;
    });
  }

  private async refresh({
    now,
    signal,
  }: {
    now: number;
    signal: AbortSignal;
  }): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (now - entry.requestedAt >= KEEP_MILLISECONDS)
        this.entries.delete(key);
    }
    const due = [...this.entries.values()]
      .filter((entry) => now - (entry.readAt ?? 0) >= FRESH_MILLISECONDS)
      .sort((a, b) => (a.readAt ?? 0) - (b.readAt ?? 0))
      .slice(0, READS_PER_TICK);
    for (const entry of due) {
      if (signal.aborted || !this.enabled()) break;
      entry.readAt = now;
      const feedback = this.feedback(entry.identity);
      if (
        feedback?.observedAt &&
        now - Date.parse(feedback.observedAt) < FRESH_MILLISECONDS
      )
        continue;
      const read = await readPullRequestByIdentity(
        this.providers,
        entry.identity,
        { status: true },
      );
      if (
        read.kind === 'current' &&
        read.pullRequest.ref === entry.identity.ref
      )
        entry.snapshot = linkedSnapshotFromStatus(
          read.pullRequest,
          read.observedAt ?? new Date().toISOString(),
        );
    }
  }
}
