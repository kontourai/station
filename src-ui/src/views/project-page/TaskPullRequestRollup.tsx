import {
  type ConversationPullRequestLinkObservation,
  linkedPullRequestMatches,
  type PullRequestLinkIdentity,
} from '@kontourai/station-contracts/conversation-pull-request-links';
import { pullRequestFeedbackKey } from '@kontourai/station-contracts/pull-request-feedback';
import type { TaskPullRequestFactsEntry } from '@kontourai/station-contracts/task-lane';
import { StatusBadge } from '@kontourai/ui/react';
import { Button } from '../../components/Button';
import { RowMenu } from '../../components/notifications/RowMenu';
import { toastStore } from '../../contexts/ToastContext';
import { useOpenPullRequestInRegion } from '../../contexts/useOpenInRegion';

function linkedTaskRequests(entry: TaskPullRequestFactsEntry) {
  const observations = new Map<
    string,
    {
      identity: PullRequestLinkIdentity;
      status: ConversationPullRequestLinkObservation['status'];
      observedAt: string;
    }
  >(
    entry.pullRequests.map((fact) => {
      const status = fact.status;
      return [
        pullRequestFeedbackKey(fact),
        {
          identity: fact,
          observedAt: fact.observedAt,
          status:
            status.state !== 'current'
              ? status
              : {
                  state: 'current',
                  title: status.title ?? `#${fact.ref}`,
                  pullRequestState: status.pullRequestState,
                  checks: status.checks,
                  isDraft: status.draft,
                  reviewDecision: status.reviewDecision,
                  mergeability: status.mergeability,
                  landing:
                    status.landing === 'auto-merge'
                      ? { state: 'armed' }
                      : status.landing === 'merge-queue'
                        ? { state: 'queued' }
                        : status.landing
                          ? { state: 'not-queued' }
                          : undefined,
                },
        },
      ];
    }),
  );
  for (const link of entry.linkedPullRequests ?? []) {
    const key = pullRequestFeedbackKey(link);
    const prior = observations.get(key);
    if (
      prior &&
      (link.status.state !== 'current' ||
        (prior.status.state === 'current' &&
          Date.parse(prior.observedAt) > Date.parse(link.observedAt)))
    )
      continue;
    observations.set(key, {
      identity: link,
      status: link.status,
      observedAt: link.observedAt,
    });
  }
  return [...observations.values()];
}

const labels = {
  failing: 'failing',
  changes: 'changes requested',
  review: 'awaiting review',
  ready: 'ready to land',
  armed: 'armed',
  queued: 'queued',
  pending: 'pending',
  approval: 'checks awaiting approval',
  draft: 'draft',
  passing: 'passing',
  merged: 'merged',
  closed: 'closed',
  unknown: 'unknown',
};

function tally(requests: ReturnType<typeof linkedTaskRequests>) {
  const counts = new Map<keyof typeof labels, number>();
  for (const { status } of requests) {
    let key: keyof typeof labels = 'unknown';
    if (status.state === 'current') {
      if (status.pullRequestState === 'MERGED') key = 'merged';
      else if (status.pullRequestState === 'CLOSED') key = 'closed';
      else if (linkedPullRequestMatches(status, 'failing')) key = 'failing';
      else if (status.reviewDecision === 'changes_requested') key = 'changes';
      else if (status.reviewDecision === 'review_required') key = 'review';
      else if (status.landing?.state === 'armed') key = 'armed';
      else if (status.landing?.state === 'queued') key = 'queued';
      else if (linkedPullRequestMatches(status, 'ready')) key = 'ready';
      else if (status.isDraft) key = 'draft';
      else if (status.checks === 'pending') key = 'pending';
      else if (status.checks === 'awaiting-approval') key = 'approval';
      else if (
        status.checks === 'passing' &&
        status.mergeability === 'mergeable' &&
        status.reviewDecision
      )
        key = 'passing';
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function rollupLabel(counts: ReturnType<typeof tally>, total: number) {
  return [
    `${total} PR${total === 1 ? '' : 's'}`,
    ...Object.entries(labels).flatMap(([key, label]) => {
      const count = counts.get(key as keyof typeof labels);
      return count ? [`${count} ${label}`] : [];
    }),
  ].join(' · ');
}

function tone(counts: ReturnType<typeof tally>) {
  if (counts.has('failing') || counts.has('changes')) return 'negative';
  if (counts.has('unknown') || counts.has('review') || counts.has('approval'))
    return 'caution';
  return 'neutral';
}

export function ProjectPullRequestRollup({
  entries,
}: {
  entries?: Record<string, TaskPullRequestFactsEntry>;
}) {
  if (!entries) return null;
  const requests = [
    ...new Map(
      Object.values(entries)
        .filter((entry) => entry.linkedPullRequests !== undefined)
        .flatMap(linkedTaskRequests)
        .map((request) => [pullRequestFeedbackKey(request.identity), request]),
    ).values(),
  ].filter(
    ({ status }) =>
      status.state !== 'current' || status.pullRequestState === 'OPEN',
  );
  if (!requests.length) return null;
  const counts = tally(requests);
  return (
    <StatusBadge
      tone={tone(counts)}
      status={rollupLabel(counts, requests.length)}
    />
  );
}

export function TaskPullRequestRollup({
  entry,
  projectId,
}: {
  entry?: TaskPullRequestFactsEntry;
  projectId?: string;
}) {
  const openPullRequest = useOpenPullRequestInRegion();
  if (!entry || entry.linkedPullRequests === undefined) return null;
  const requests = linkedTaskRequests(entry);
  if (!requests.length) return null;
  const counts = tally(requests);
  const text = rollupLabel(counts, requests.length);
  const open = ({ identity }: (typeof requests)[number]) => {
    const result = openPullRequest?.(
      {
        host: identity.host,
        owner: identity.repository.owner,
        repository: identity.repository.name,
        ref: identity.ref,
      },
      projectId ?? null,
    );
    if (!result?.ok) toastStore.show('This pull request can’t be opened here.');
  };
  const label = <StatusBadge tone={tone(counts)} status={text} />;
  return requests.length === 1 ? (
    <Button variant="ghost" size="sm" onClick={() => open(requests[0]!)}>
      {label}
    </Button>
  ) : (
    <RowMenu
      label="Open a Task pull request"
      triggerClassName="choice-trigger"
      triggerContent={label}
      items={requests.map((request) => ({
        id: pullRequestFeedbackKey(request.identity),
        label:
          request.status.state === 'current'
            ? `#${request.identity.ref} ${request.status.title}`
            : `${request.identity.repository.name} #${request.identity.ref}`,
        onSelect: () => open(request),
      }))}
    />
  );
}
