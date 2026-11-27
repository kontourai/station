import type {
  PullRequestHeadReview,
  PullRequestHeadReviewFinding,
  PullRequestHeadReviewWaiting,
} from '@kontourai/station-contracts/pull-request-feedback';
import { pullRequestFeedbackKey } from '@kontourai/station-contracts/pull-request-feedback';
import { type ReactNode, useId, useState } from 'react';
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

/** Required rows shown before the rest fold behind "N more". */
const FINDINGS_SHOWN = 8;

const short = (sha: string) => sha.slice(0, 7);
const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** Why the newest head has no review yet, as the end of a sentence. */
const WAITING_WORDS: Record<PullRequestHeadReviewWaiting['reason'], string> = {
  settling: 'waiting for the push to settle',
  'agent-busy': 'the agent is working',
  'agent-waiting': 'the agent is waiting on you',
  'agent-stopped': 'the agent has stopped',
  'feedback-waiting': 'feedback is waiting for the agent',
  'project-busy': 'reviewing another pull request in this Project',
  'daily-limit': '10 reviews ran in this Project today',
  draft: 'the pull request is a draft',
  closed: 'the pull request is closed',
  starting: 'starting soon',
};

/**
 * The section's chip: the review's state, as a word and a tone, in the pull
 * request strip's own chip so the two lines read alike.
 */
function headReviewBadge(review: PullRequestHeadReview): PullRequestChipValue {
  switch (review.state) {
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
    default:
      return { label: 'Not reviewed', tone: 'neutral' };
  }
}

/** The line under the chip, when the state has more to say. */
function headReviewNote(review: PullRequestHeadReview): string | undefined {
  switch (review.state) {
    case 'unknown':
      return "Station doesn't know how this review ended.";
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
 * One review's findings: the required ones (already most severe first)
 * folded past 8, then the others folded until asked for.
 */
function Findings({ review }: { review: PullRequestHeadReview }) {
  const [moreRequired, setMoreRequired] = useState(false);
  const [othersOpen, setOthersOpen] = useState(false);
  const requiredId = useId();
  const othersId = useId();
  const findings = review.findings ?? [];
  const required = findings.filter((finding) => finding.required);
  const others = findings.filter((finding) => !finding.required);
  const shown = moreRequired ? required : required.slice(0, FINDINGS_SHOWN);
  return (
    <>
      {required.length > 0 && (
        <ul id={requiredId} className="pr-head-review__findings">
          {shown.map((finding, index) => (
            <FindingRow
              // Rows are a fixed snapshot of one review.
              key={`${finding.file}:${finding.line}:${index}`}
              finding={finding}
            />
          ))}
        </ul>
      )}
      {required.length > FINDINGS_SHOWN && (
        // An __actions row: the shared touch floor sizes it on phones.
        <div className="pr-head-review__more-actions">
          <DisclosureToggle
            expanded={moreRequired}
            controls={requiredId}
            onToggle={() => setMoreRequired((open) => !open)}
          >
            {moreRequired
              ? 'Fewer findings'
              : `${required.length - FINDINGS_SHOWN} more required`}
          </DisclosureToggle>
        </div>
      )}
      {others.length > 0 && (
        <div className="pr-head-review__more-actions">
          <DisclosureToggle
            expanded={othersOpen}
            controls={othersId}
            onToggle={() => setOthersOpen((open) => !open)}
          >
            {plural(others.length, 'other', 'others')}
          </DisclosureToggle>
        </div>
      )}
      {othersOpen && (
        <ul id={othersId} className="pr-head-review__findings">
          {others.map((finding, index) => (
            <FindingRow
              key={`${finding.file}:${finding.line}:${index}`}
              finding={finding}
            />
          ))}
        </ul>
      )}
    </>
  );
}

/**
 * "Station review" in the pull request panel, under the Agent feedback
 * strip: Station's newest review of one of the pull request's heads, its
 * findings (required first), and why the newest head is not reviewed yet
 * when it is not. Only for a reader of the chat that owns the pull
 * request, and only while "Review each new head" is on there or a review
 * was kept.
 */
export function PullRequestHeadReviewSection({
  strip,
  empty = null,
}: {
  strip: ReturnType<typeof usePullRequestFeedbackStrip>;
  empty?: ReactNode;
}) {
  const { identity, byPullRequest, chat } = strip;
  const now = useCoarseNow();
  if (!chat.headReview) return empty;
  if (byPullRequest.isPending)
    return byPullRequest.fetchStatus === 'fetching' ? (
      <SkeletonBlock
        count={1}
        label="Loading Station review"
        className="pr-head-review__loading"
      />
    ) : (
      empty
    );
  const data = byPullRequest.data;
  if (!data || byPullRequest.error || !data.owner?.readable) return empty;
  const review = data.headReview;
  const waiting = data.headReviewWaiting;
  if (!review && !waiting && !data.settings?.reviewEachHead) return empty;
  const key = pullRequestFeedbackKey(identity);
  const pending = chat.pending === key;
  const error = chat.error?.key === key ? chat.error.text : undefined;
  // The newest head's own review, or an earlier push's while it waits.
  const current = review?.current ? review : undefined;
  const earlier = review && !review.current ? review : undefined;
  const required = current?.required ?? 0;
  const others = current?.others ?? 0;
  const delivery = current?.delivery;
  const canSend =
    current?.state === 'reviewed' && required > 0 && delivery === undefined;
  // A failed press may mean the server knows more (a busy Project, the
  // daily limit): read again either way.
  const refetch = () => void byPullRequest.refetch();
  const badge: PullRequestChipValue = current
    ? headReviewBadge(current)
    : waiting
      ? { label: 'Not reviewed yet', tone: 'neutral' }
      : { label: 'Waiting for a push', tone: 'neutral' };
  const note = current
    ? headReviewNote(current)
    : waiting
      ? `Head ${short(waiting.headSha)} · ${WAITING_WORDS[waiting.reason]}`
      : 'Reviews each new head once it holds still.';
  return (
    <section className="pr-head-review" aria-label="Station review">
      <div className="pr-head-review__head">
        <span className="pr-head-review__label">Station review</span>
        <PullRequestChip {...badge} />
      </div>
      {current?.state === 'reviewed' && (
        <p className="pr-head-review__line">
          {required
            ? plural(required, 'required finding', 'required findings')
            : 'No required findings'}
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
          {others > 0 && required === 0 && (
            <>
              <span aria-hidden="true"> · </span>
              {plural(others, 'other', 'others')}
            </>
          )}
        </p>
      )}
      {note && <p className="pr-head-review__line">{note}</p>}
      {current?.state === 'reviewed' && <Findings review={current} />}
      {earlier && (
        <div className="pr-head-review__earlier">
          <p className="pr-head-review__line">
            {earlier.state === 'reviewed'
              ? `Reviewed ${short(earlier.headSha)} · an earlier push · ${plural(earlier.required ?? 0, 'required finding', 'required findings')}`
              : `${headReviewBadge(earlier).label} · an earlier push`}
          </p>
          {earlier.state === 'reviewed' && <Findings review={earlier} />}
        </div>
      )}
      {/* A closed pull request is not reviewed again. */}
      {data.status?.state !== 'closed' && (
        <ActionRow
          className="pr-head-review__actions"
          overflowLabel="More Station review actions"
          // Send is the one primary when there is something to send;
          // otherwise Review again stays quiet beside the panel's own tabs.
          primary={
            canSend ? (
              <Button
                size="sm"
                variant="primary"
                pending={pending}
                onClick={() =>
                  void chat.sendFindings(identity).then(() => refetch())
                }
              >
                Send to agent
              </Button>
            ) : undefined
          }
          secondary={
            <Button
              size="sm"
              pending={pending}
              disabled={current?.state === 'reviewing'}
              onClick={() =>
                void chat.reviewAgain(identity).then(() => refetch())
              }
            >
              Review again
            </Button>
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
