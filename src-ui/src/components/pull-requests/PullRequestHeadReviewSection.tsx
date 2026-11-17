import type {
  PullRequestHeadReview,
  PullRequestHeadReviewFinding,
} from '@kontourai/station-contracts/pull-request-feedback';
import { pullRequestFeedbackKey } from '@kontourai/station-contracts/pull-request-feedback';
import { useId, useState } from 'react';
import { useCoarseNow } from '../../hooks/useCoarseNow';
import { ActionRow } from '../ActionRow';
import { Button } from '../Button';
import { DisclosureToggle } from '../DisclosureToggle';
import { SkeletonBlock } from '../Skeleton';
import type { usePullRequestFeedbackStrip } from './PullRequestFeedbackStrip';
import {
  PullRequestChip,
  type PullRequestChipValue,
} from './pull-request-chips';
import { RelativeTime } from './RelativeTime';
import './PullRequestHeadReviewSection.css';

/** Rows shown before the rest fold behind "N more". */
const FINDINGS_SHOWN = 8;

const short = (sha: string) => sha.slice(0, 7);
const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * The section's chip: the review's state, as a word and a tone, in the pull
 * request strip's own chip so the two lines read alike.
 */
function headReviewBadge(
  review: PullRequestHeadReview | undefined,
): PullRequestChipValue {
  switch (review?.state) {
    case 'reviewed':
      return {
        label: `Reviewed ${short(review.headSha)}`,
        tone: review.required ? 'pending' : 'success',
      };
    case 'reviewing':
      return { label: `Reviewing ${short(review.headSha)}`, tone: 'neutral' };
    case 'head-not-local':
      return { label: 'Head not local', tone: 'neutral' };
    case 'no-reviewer':
      return { label: 'No reviewer', tone: 'neutral' };
    case 'unknown':
      return { label: 'Result unknown', tone: 'pending' };
    case 'not-verified':
      return { label: 'Not reviewed', tone: 'neutral' };
    default:
      return { label: 'Waiting for a push', tone: 'neutral' };
  }
}

/** The line under the badge, when the state has more to say. */
function headReviewNote(
  review: PullRequestHeadReview | undefined,
): string | undefined {
  switch (review?.state) {
    case undefined:
      return 'Reviews each new head once it holds still.';
    case 'unknown':
      return 'Station restarted before this review finished.';
    case 'head-not-local':
    case 'no-reviewer':
    case 'not-verified':
      // The review's own words, as it gave them.
      return review.failureReason;
    default:
      return undefined;
  }
}

/** Characters of a path shown before its leading folders give way. */
const PATH_SHOWN = 40;

/**
 * The finding's place, short enough for one line of the narrow panel: a
 * long path keeps its file name ("…/delivery.ts:998"), with the whole path
 * on hover.
 */
function findingPlace(finding: PullRequestHeadReviewFinding) {
  const parts = finding.file.split('/');
  const short =
    finding.file.length > PATH_SHOWN && parts.length > 2
      ? `…/${parts.at(-1)}`
      : finding.file;
  return { text: `${short}:${finding.line}`, full: finding.file !== short };
}

function FindingRow({ finding }: { finding: PullRequestHeadReviewFinding }) {
  const place = findingPlace(finding);
  return (
    <li className="pr-head-review__finding" data-required={finding.required}>
      <code
        className="pr-head-review__where"
        {...(place.full ? { title: `${finding.file}:${finding.line}` } : {})}
      >
        {place.text}
      </code>
      <span className="pr-head-review__severity">[{finding.severity}]</span>
      <span className="pr-head-review__summary">{finding.summary}</span>
    </li>
  );
}

/**
 * "Station review" in the pull request panel, under the Agent feedback
 * strip: Station's newest review of one of the pull request's heads, its
 * findings (required first) and Review again. Only for a reader of the
 * chat that owns the pull request, and only while "Review each new head"
 * is on there or a review was kept.
 */
export function PullRequestHeadReviewSection({
  strip,
}: {
  strip: ReturnType<typeof usePullRequestFeedbackStrip>;
}) {
  const { identity, byPullRequest, chat } = strip;
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const now = useCoarseNow();
  if (!chat.headReview) return null;
  if (byPullRequest.isPending)
    return byPullRequest.fetchStatus === 'fetching' ? (
      <SkeletonBlock
        count={1}
        label="Loading Station review"
        className="pr-head-review__loading"
      />
    ) : null;
  const data = byPullRequest.data;
  if (!data || byPullRequest.error || !data.owner?.readable) return null;
  const review = data.headReview;
  if (!review && !data.settings?.reviewEachHead) return null;
  const key = pullRequestFeedbackKey(identity);
  const pending = chat.pending === key;
  const error = chat.error?.key === key ? chat.error.text : undefined;
  const badge = headReviewBadge(review);
  const note = headReviewNote(review);
  const findings = review?.state === 'reviewed' ? (review.findings ?? []) : [];
  const shown = expanded ? findings : findings.slice(0, FINDINGS_SHOWN);
  const required = review?.required ?? 0;
  const others = review?.others ?? 0;
  const delivery = review?.delivery;
  const refetch = () => void byPullRequest.refetch();
  return (
    <section className="pr-head-review" aria-label="Station review">
      <div className="pr-head-review__head">
        <span className="pr-head-review__label">Station review</span>
        <PullRequestChip {...badge} />
      </div>
      {review?.state === 'reviewed' && (
        <p className="pr-head-review__line">
          {required
            ? plural(required, 'required finding', 'required findings')
            : 'No required findings'}
          {others > 0 && (
            <>
              <span aria-hidden="true"> · </span>
              {plural(others, 'other', 'others')}
            </>
          )}
          {required > 0 && delivery && (
            <>
              <span aria-hidden="true"> · </span>
              {delivery.state === 'sent' ? (
                <>
                  Sent <RelativeTime iso={delivery.at} now={now} />
                </>
              ) : delivery.state === 'queued' ? (
                'Sending'
              ) : (
                'Held for the agent'
              )}
            </>
          )}
        </p>
      )}
      {note && <p className="pr-head-review__line">{note}</p>}
      {findings.length > 0 && (
        <>
          <ul id={listId} className="pr-head-review__findings">
            {shown.map((finding, index) => (
              <FindingRow
                // Rows are a fixed snapshot of one review.
                key={`${finding.file}:${finding.line}:${index}`}
                finding={finding}
              />
            ))}
          </ul>
          {findings.length > FINDINGS_SHOWN && (
            // An __actions row: the shared touch floor sizes it on phones.
            <div className="pr-head-review__more-actions">
              <DisclosureToggle
                expanded={expanded}
                controls={listId}
                onToggle={() => setExpanded((open) => !open)}
              >
                {expanded
                  ? 'Fewer findings'
                  : `${findings.length - FINDINGS_SHOWN} more`}
              </DisclosureToggle>
            </div>
          )}
        </>
      )}
      {/* A closed pull request is not reviewed again. */}
      {data.status?.state !== 'closed' && (
        <ActionRow
          className="pr-head-review__actions"
          overflowLabel="More Station review actions"
          primary={
            <Button
              size="sm"
              variant="primary"
              pending={pending}
              disabled={review?.state === 'reviewing'}
              onClick={() =>
                void chat.reviewAgain(identity).then((ok) => ok && refetch())
              }
            >
              Review again
            </Button>
          }
          secondary={
            review?.state === 'reviewed' && required > 0 && !delivery ? (
              <Button
                size="sm"
                pending={pending}
                onClick={() =>
                  void chat.sendFindings(identity).then((ok) => ok && refetch())
                }
              >
                Send to agent
              </Button>
            ) : undefined
          }
        />
      )}
      {error && (
        <p className="pr-head-review__error" role="status">
          {error}
        </p>
      )}
    </section>
  );
}
