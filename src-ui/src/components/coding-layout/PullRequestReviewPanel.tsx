import type {
  PullRequest,
  PullRequestCheck,
  PullRequestCheckState,
  PullRequestChecksObservation,
  PullRequestMergeMethod,
  PullRequestMergeResult,
  PullRequestReviewComment,
  PullRequestReviewCommentsObservation,
  PullRequestReviewInput,
  PullRequestReviewOutcome,
} from '@kontourai/station-contracts/pull-request-provider';
import {
  getPullRequestReview,
  mergeReviewedPullRequest,
  type PullRequestReviewTarget,
  submitPullRequestReview,
} from '@kontourai/station-sdk/pull-request-review';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  activeChatsStore,
  useActiveChatActions,
} from '../../contexts/ActiveChatsContext';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { openExternalLink } from '../../platform/openExternalLink';
import { relativeTimeAgo } from '../../utils/relativeTime';
// The Browser pane's round icon control, until the shared `IconButton` (a
// sibling change) lands; this import moves there with it.
import { BrowserIconButton } from '../../workspace-panes/browser-pane/BrowserIconButton';
import { Button } from '../Button';
import {
  ArrowLeftGlyph,
  ArrowRightGlyph,
  ExternalLinkGlyph,
  RefreshGlyph,
} from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';
import { ConfirmModal } from '../modals/ConfirmModal';
import { ResponsiveSurfaceActions } from '../ResponsiveDialogSurface';
import { ErrorState, SkeletonBlock } from '../state';
import './PullRequestReviewPanel.css';

type Intent =
  | PullRequestReviewInput
  | {
      action: 'merge';
      expectedHeadSha: string;
      method: PullRequestMergeMethod;
      autoMerge: boolean;
    };
/**
 * What the "open elsewhere" action is called for a pull request's URL: the
 * forge by name where Station knows it, else the browser. Derived from the
 * URL the provider supplied, so the label names where the click goes.
 */
export function pullRequestExternalLabel(url: string): string {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return 'Open in browser';
  }
  if (hostname === 'github.com' || hostname.endsWith('.github.com'))
    return 'Open on GitHub';
  // gitlab.com only: any `gitlab.*` host is a name anyone can register, and
  // a self-managed instance is not "GitLab" to the reader either way.
  if (hostname === 'gitlab.com' || hostname === 'www.gitlab.com')
    return 'Open on GitLab';
  return 'Open in browser';
}

const MERGEABILITY_COPY: Record<PullRequest['mergeability'], string> = {
  mergeable: 'Merges cleanly into',
  conflicting: 'Has conflicts with',
  unknown: 'The provider has not yet reported whether it merges cleanly into',
};

const CHECK_STATE_LABEL: Record<PullRequestCheckState, string> = {
  failure: 'Failed',
  pending: 'Pending',
  cancelled: 'Cancelled',
  success: 'Passed',
  neutral: 'Neutral',
  skipped: 'Skipped',
};
/** Failures first: the reader's next action is there. */
const CHECK_STATE_ORDER: PullRequestCheckState[] = [
  'failure',
  'pending',
  'cancelled',
  'success',
  'neutral',
  'skipped',
];

const ATTENTION_STATES = new Set<PullRequestCheckState>([
  'failure',
  'pending',
  'cancelled',
]);

type Tone = 'success' | 'failure' | 'pending' | 'neutral';
const CHECK_STATE_TONE: Record<PullRequestCheckState, Tone> = {
  failure: 'failure',
  pending: 'pending',
  cancelled: 'neutral',
  success: 'success',
  neutral: 'neutral',
  skipped: 'neutral',
};

/**
 * The pull request's state as a word people use, from the forge's enum
 * (GitHub `OPEN`/`CLOSED`/`MERGED`, GitLab `opened`/`closed`/`merged`/
 * `locked`). An enum this pane does not know is written as a word too, never
 * raw.
 */
function pullRequestStateChip(state: string): {
  label: string;
  tone: Tone;
} {
  const key = state.trim().toUpperCase();
  if (key === 'OPEN' || key === 'OPENED')
    return { label: 'Open', tone: 'success' };
  if (key === 'DRAFT') return { label: 'Draft', tone: 'neutral' };
  if (key === 'MERGED') return { label: 'Merged', tone: 'neutral' };
  if (key === 'CLOSED') return { label: 'Closed', tone: 'failure' };
  return { label: humanise(state), tone: 'neutral' };
}

/**
 * The review decision as a chip, or none when the forge reports no review
 * yet. GitHub reports the latest review's state; GitLab's `reviewStatus` is
 * its detailed merge status, read the same way.
 */
function reviewDecisionChip(
  status: string,
): { label: string; tone: Tone } | null {
  const key = status.trim().toUpperCase();
  // GitLab's `mergeable`/`checking`/`unchecked` say nothing about review;
  // the mergeability sentence already covers them.
  if (
    !key ||
    key === 'NONE' ||
    key === 'MERGEABLE' ||
    key === 'CHECKING' ||
    key === 'UNCHECKED'
  )
    return null;
  if (key === 'APPROVED') return { label: 'Approved', tone: 'success' };
  if (key === 'CHANGES_REQUESTED' || key === 'REQUESTED_CHANGES')
    return { label: 'Changes requested', tone: 'failure' };
  if (key === 'REVIEW_REQUIRED' || key === 'NOT_APPROVED')
    return { label: 'Review required', tone: 'pending' };
  // GitHub `PENDING` is the viewer's own review, not yet submitted.
  if (key === 'PENDING') return { label: 'Review pending', tone: 'neutral' };
  if (key === 'COMMENTED') return { label: 'Commented', tone: 'neutral' };
  if (key === 'DISMISSED')
    return { label: 'Review dismissed', tone: 'neutral' };
  return { label: humanise(status), tone: 'neutral' };
}

const ACRONYMS = new Set(['ci', 'api', 'url', 'id']);
/** `ci_must_pass` → "CI must pass": words, the first capitalised, acronyms kept. */
function humanise(value: string): string {
  const words = value
    .trim()
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase())
    .map((word) => (ACRONYMS.has(word) ? word.toUpperCase() : word));
  const [first = '', ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
}

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? '' : 's'}`;
/** "passed", "passed or skipped", "passed, neutral or skipped". */
const listWords = (words: readonly string[]) =>
  words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;

/**
 * A native disclosure's summary with a visible caret: `display: flex` on a
 * summary drops the browser's marker, so the affordance is drawn here and
 * turns when the details opens (CSS). Expanded state stays native.
 */
function DisclosureSummary({ children }: { children: React.ReactNode }) {
  return (
    <summary className="pull-request-review__summary">
      <ArrowRightGlyph className="pull-request-review__caret" />
      <span>{children}</span>
    </summary>
  );
}

function CheckList({ checks }: { checks: readonly PullRequestCheck[] }) {
  if (checks.length === 0) return null;
  return (
    <ul className="pull-request-review__checks">
      {checks.map((check, index) => (
        <li
          // Names repeat across workflows; position disambiguates.
          key={`${check.group ?? ''}:${check.name}:${index}`}
          data-check-state={check.state}
        >
          <span
            className={`pull-request-review__check-state pull-request-review__check-state--${check.state}`}
          >
            <span
              className="pull-request-review__check-dot"
              aria-hidden="true"
            />
            {CHECK_STATE_LABEL[check.state]}
          </span>
          <span className="pull-request-review__check-name">
            {check.name}
            {check.group ? (
              <span className="pull-request-review__muted">
                {' '}
                · {check.group}
              </span>
            ) : null}
          </span>
          {check.url ? (
            <BrowserIconButton
              className="pull-request-review__icon"
              aria-label={`Open ${check.name} details`}
              title={`Open ${check.name} details`}
              onClick={() => void openExternalLink(check.url!)}
            >
              <ExternalLinkGlyph />
            </BrowserIconButton>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The provider's checks for the observed head. Counts come from the list
 * itself, and each state is written in words, not colour alone. Absent
 * means this server did not observe checks, which is said as such.
 */
function PullRequestChecks({
  checks,
}: {
  checks: PullRequestChecksObservation | undefined;
}) {
  if (!checks)
    return (
      <p className="pull-request-review__muted">
        This Station did not report checks for this pull request.
      </p>
    );
  if (checks.state === 'unavailable')
    return <p className="pull-request-review__muted">{checks.reason}</p>;
  if (checks.checks.length === 0)
    return (
      <p className="pull-request-review__muted">
        The provider reports no checks for this head.
      </p>
    );
  const counts = CHECK_STATE_ORDER.map(
    (state) =>
      [state, checks.checks.filter((c) => c.state === state).length] as const,
  ).filter(([, count]) => count > 0);
  const sorted = [...checks.checks].sort(
    (a, b) =>
      CHECK_STATE_ORDER.indexOf(a.state) - CHECK_STATE_ORDER.indexOf(b.state),
  );
  // What needs the reader stays open; settled checks fold away, counted.
  const needsAttention = sorted.filter((check) =>
    ATTENTION_STATES.has(check.state),
  );
  const settled = sorted.filter((check) => !ATTENTION_STATES.has(check.state));
  const allPassed =
    counts.length === 1 && counts[0][0] === 'success' && !checks.partial;
  // The disclosure names only the states it holds: "passed", or "passed or
  // skipped", never a list of states that are not there.
  const settledStates = counts
    .filter(([state]) => !ATTENTION_STATES.has(state))
    .map(([state]) => CHECK_STATE_LABEL[state].toLowerCase());
  return (
    <>
      <p className="pull-request-review__checks-summary">
        {allPassed ? (
          <span
            className="pull-request-review__count"
            data-tone="success"
          >{`${plural(settled.length, 'check')} passed`}</span>
        ) : (
          counts.map(([state, count]) => (
            <span
              key={state}
              className="pull-request-review__count"
              data-tone={CHECK_STATE_TONE[state]}
            >
              {count} {CHECK_STATE_LABEL[state].toLowerCase()}
            </span>
          ))
        )}
        {checks.partial && (
          <span className="pull-request-review__muted">
            Only part of the checks could be read; open the forge for the rest.
          </span>
        )}
      </p>
      <CheckList checks={needsAttention} />
      {settled.length > 0 && (
        <details className="pull-request-review__settled">
          <DisclosureSummary>
            {needsAttention.length === 0 ? 'Show' : 'Show the other'}{' '}
            {settled.length} {listWords(settledStates)}{' '}
            {plural(settled.length, 'check').replace(/^\d+ /, '')}
          </DisclosureSummary>
          <CheckList checks={settled} />
        </details>
      )}
    </>
  );
}

/**
 * Inline comments the diff cannot place: outdated, on a file it omits, or on
 * a line outside the hunks it shows.
 */
function UnplacedReviewComments({
  comments,
  placed,
}: {
  comments: PullRequestReviewCommentsObservation | undefined;
  placed: PlacedLines;
}) {
  if (!comments) return null;
  if (comments.state === 'unavailable')
    return (
      <>
        <h3>Inline comments</h3>
        <p className="pull-request-review__muted">{comments.reason}</p>
      </>
    );
  const unplaced = comments.comments.filter(
    (comment) =>
      comment.line === null ||
      !placed.get(comment.path)?.[comment.side].has(comment.line),
  );
  if (unplaced.length === 0 && !comments.partial) return null;
  return (
    <>
      <h3>Inline comments</h3>
      {comments.partial && (
        <p className="pull-request-review__muted">
          Only part of the inline review comments could be read. Open the forge
          for the rest.
        </p>
      )}
      {unplaced.length > 0 && (
        <details className="pull-request-review__unplaced">
          <DisclosureSummary>
            {plural(unplaced.length, 'comment')} not on the current diff
          </DisclosureSummary>
          <ol className="pull-request-review__forge-comments">
            {unplaced.map((comment) => (
              <li key={comment.id}>
                <ForgeComment comment={comment} />
              </li>
            ))}
          </ol>
        </details>
      )}
    </>
  );
}

/**
 * One forge comment the diff could not place, as a named article so it
 * reads apart from a local Station comment. A file-level comment is a
 * comment on the file; only a line comment the forge no longer maps is
 * "outdated".
 */
function ForgeComment({ comment }: { comment: PullRequestReviewComment }) {
  const where =
    comment.subject === 'file'
      ? 'the file'
      : comment.line === null
        ? 'an outdated line'
        : `line ${comment.line}`;
  return (
    <article
      className="pull-request-review__forge-comment"
      aria-label={`Forge comment by ${comment.author} on ${where} of ${comment.path}`}
    >
      <div className="pull-request-review__forge-comment-meta">
        <strong>{comment.author}</strong>
        <span className="pull-request-review__muted">
          on {where} of <code>{comment.path}</code>
        </span>
        {comment.url ? (
          <BrowserIconButton
            className="pull-request-review__icon"
            aria-label="Open this comment on the forge"
            title="Open this comment on the forge"
            onClick={() => void openExternalLink(comment.url!)}
          >
            <ExternalLinkGlyph />
          </BrowserIconButton>
        ) : null}
      </div>
      <div className="pull-request-review__body">{comment.body}</div>
    </article>
  );
}

/** The lines of each file a unified patch shows, per diff side. */
type PlacedLines = ReadonlyMap<
  string,
  {
    readonly additions: ReadonlySet<number>;
    readonly deletions: ReadonlySet<number>;
  }
>;
const NO_PLACED_LINES: PlacedLines = new Map();

/**
 * Which (path, side, line) the diff surface can anchor a comment to: the
 * lines inside the patch's hunks, numbered as each side numbers them. A
 * comment on a changed file but outside every hunk is as unplaceable as one
 * on a file the patch omits, and must be listed rather than lost.
 *
 * A deleted file (`+++ /dev/null`) keeps its old name from `--- a/x`, so a
 * comment on its deletions side still places. File headers are read only
 * between hunks: inside one, `+++ x` is an added line whose text starts
 * with `++ `, and the hunk's own line counts say where it ends.
 */
function placedLines(patch: string): PlacedLines {
  const files = new Map<
    string,
    { additions: Set<number>; deletions: Set<number> }
  >();
  const open = (path: string) => {
    const lines = files.get(path) ?? {
      additions: new Set<number>(),
      deletions: new Set<number>(),
    };
    files.set(path, lines);
    return lines;
  };
  let current: { additions: Set<number>; deletions: Set<number> } | undefined;
  let oldPath: string | undefined;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of patch.split('\n')) {
    // CRLF patches: the `\r` would otherwise end up in every path.
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    // A new file section ends any open hunk, even one whose counts never
    // ran out (a malformed patch must not lend one file's lines to the next).
    if (line.startsWith('diff --git ')) {
      oldLeft = 0;
      newLeft = 0;
      current = undefined;
      oldPath = undefined;
      continue;
    }
    const inHunk = oldLeft > 0 || newLeft > 0;
    if (!inHunk) {
      const old = /^--- (?:a\/)?(.+)$/.exec(line);
      if (old) {
        oldPath = old[1] === '/dev/null' ? undefined : old[1];
        continue;
      }
      const header = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
      if (header) {
        const path = header[1] === '/dev/null' ? oldPath : header[1];
        current = path ? open(path) : undefined;
        oldPath = undefined;
        continue;
      }
    }
    // A hunk's content lines start with ' ', '+', '-' or '\', so `@@` is
    // unambiguous wherever it appears.
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLine = Number(hunk[3]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      continue;
    }
    if (!current || !inHunk || line.startsWith('\\')) continue;
    if (line.startsWith('+')) {
      current.additions.add(newLine);
      newLine += 1;
      newLeft -= 1;
    } else if (line.startsWith('-')) {
      current.deletions.add(oldLine);
      oldLine += 1;
      oldLeft -= 1;
    } else {
      // Context carries both numbers; an empty line is blank context.
      current.additions.add(newLine);
      current.deletions.add(oldLine);
      newLine += 1;
      oldLine += 1;
      newLeft -= 1;
      oldLeft -= 1;
    }
  }
  return files;
}

const OBSERVED_TICK_MS = 30_000;
/**
 * Two scannable lines under the title: the state and review decision as
 * chips, the branches in monospace, the author and commit count; then the
 * repository, a short commit id (full value in its title) and when this was
 * observed, relative, with the absolute time in its title.
 */
function ReviewHeader({
  pullRequest,
  headSha,
  observedAt,
}: {
  pullRequest: PullRequest;
  headSha: string;
  observedAt: string;
}) {
  const state = pullRequestStateChip(pullRequest.state);
  const decision = reviewDecisionChip(pullRequest.reviewStatus);
  const observed = Date.parse(observedAt);
  // "observed 6m ago" must keep up with the clock while the pane stays open.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), OBSERVED_TICK_MS);
    return () => clearInterval(tick);
  }, []);
  return (
    <div className="pull-request-review__head">
      <div className="pull-request-review__meta">
        <span className="pull-request-review__chip" data-tone={state.tone}>
          {state.label}
        </span>
        {decision && (
          <span className="pull-request-review__chip" data-tone={decision.tone}>
            {decision.label}
          </span>
        )}
        <span className="pull-request-review__branches">
          <code>{pullRequest.sourceBranch}</code>
          <span aria-hidden="true"> → </span>
          <span className="sr-only"> into </span>
          <code>{pullRequest.targetBranch}</code>
        </span>
        <span>{pullRequest.author.login}</span>
        <span>{plural(pullRequest.commits, 'commit')}</span>
      </div>
      <div className="pull-request-review__meta pull-request-review__meta--secondary">
        <span title={pullRequest.host}>
          {pullRequest.repository.owner}/{pullRequest.repository.name} #
          {pullRequest.ref}
        </span>
        <code title={`Head ${headSha}`}>{headSha.slice(0, 7)}</code>
        {Number.isNaN(observed) ? null : (
          <time
            dateTime={observedAt}
            title={new Date(observed).toLocaleString()}
          >
            observed {relativeTimeAgo(observed, now)}
          </time>
        )}
      </div>
    </div>
  );
}

const loadDiff = () =>
  import('./DiffPanel').then((module) => ({
    default: module.ObservedDiffPanel,
  }));

/**
 * One pull request's review surface.
 *
 * `onBack` is the Diff pane's list: this panel is reached from
 * `PullRequestsPanel`, and Back returns to it. It is OPTIONAL because #2049
 * places the same panel as a dock tab of its own, where there is no list to
 * go back to — a "Back to pull requests" button there would name a
 * destination the placement does not have. Without it the button is not
 * rendered; Refresh, and the tab's own close, are what that placement offers.
 */
export function PullRequestReviewPanel({
  target,
  onBack,
}: {
  target: PullRequestReviewTarget;
  onBack?: () => void;
}) {
  const scope = useHostRequestAuthorityScope();
  const identity = JSON.stringify([
    scope?.apiBase,
    scope?.authorityKey,
    target,
  ]);
  // Remount the draft owner when its authority/target changes, so one host's
  // in-flight outcome can never reappear as another host's successful review.
  return (
    <ReviewOwner
      key={identity}
      target={target}
      onBack={onBack}
      scope={scope}
      identity={identity}
    />
  );
}
function ReviewOwner({
  target,
  onBack,
  scope,
  identity,
}: {
  target: PullRequestReviewTarget;
  onBack?: () => void;
  scope: ReturnType<typeof useHostRequestAuthorityScope>;
  identity: string;
}) {
  const activeChat = useNavigation((state) => state.activeChat);
  const { getDraft, setDraft, updateChat } = useActiveChatActions();
  const [body, setBody] = useState('');
  const outcomeRef = useRef<HTMLParagraphElement>(null);
  const [intent, setIntent] = useState<Intent | null>(null);
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [outcome, setOutcome] = useState<
    PullRequestReviewOutcome | PullRequestMergeResult | null
  >(null);
  useEffect(() => {
    if (outcome) outcomeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [outcome]);
  const [uncertain, setUncertain] = useState(false);
  const [uncertainReadAt, setUncertainReadAt] = useState(0);
  const [handoffStatus, setHandoffStatus] = useState<string | null>(null);
  const [method, setMethod] = useState<PullRequestMergeMethod>('merge');
  const { guard, DiscardModal } = useUnsavedGuard(Boolean(body) || pending);
  const review = useQuery({
    queryKey: ['pull-request-review', identity],
    queryFn: ({ signal }) =>
      getPullRequestReview(scope!.apiBase, target, {
        signal,
        requestScope: scope!,
      }),
    enabled: !!scope?.isCurrent(),
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  });
  const data = review.data?.available ? review.data.data : undefined;
  const caps = review.data?.effectiveCapabilities;
  const writable =
    !!scope?.isCurrent() &&
    !!data &&
    !review.isFetching &&
    !review.error &&
    !pending &&
    !uncertain;
  const methods = review.data?.effectiveMergeMethods ?? [];
  const selectedMethod = methods.includes(method) ? method : methods[0];
  const open = ['OPEN', 'OPENED'].includes(
    data?.pullRequest.state.toUpperCase() ?? '',
  );
  // Placement is a function of the patch alone; the comment box re-renders
  // this owner on every keystroke and must not re-parse the diff each time.
  const patch = data?.diff.state === 'available' ? data.diff.patch : undefined;
  const placed = useMemo(
    () => (patch === undefined ? NO_PLACED_LINES : placedLines(patch)),
    [patch],
  );
  const submit = async () => {
    if (!intent || !scope?.isCurrent() || submitting.current) return;
    submitting.current = true;
    setPending(true);
    try {
      const result =
        intent.action === 'merge'
          ? await mergeReviewedPullRequest(
              scope.apiBase,
              target,
              {
                method: intent.method,
                autoMerge: intent.autoMerge,
                expectedHeadSha: intent.expectedHeadSha,
              },
              { requestScope: scope },
            )
          : await submitPullRequestReview(scope.apiBase, target, intent, {
              requestScope: scope,
            });
      if (!scope.isCurrent()) return;
      const received =
        result.available && result.data
          ? result.data
          : {
              status: 'refused' as const,
              reason:
                result.reason ?? 'This provider cannot accept the review.',
            };
      setOutcome(received);
      setUncertain(received.status === 'indeterminate');
      if (received.status === 'indeterminate')
        setUncertainReadAt(review.dataUpdatedAt);
      if (
        ['confirmed', 'merged', 'queued-auto-merge'].includes(received.status)
      ) {
        if (intent.action === 'comment') setBody('');
        void review.refetch();
      }
    } catch {
      if (scope.isCurrent()) {
        setUncertain(true);
        setUncertainReadAt(review.dataUpdatedAt);
        setOutcome({
          status: 'indeterminate',
          reason:
            'The acknowledgement was lost. Refresh and inspect the provider discussion before another submission.',
        });
      }
    } finally {
      submitting.current = false;
      setPending(false);
      setIntent(null);
    }
  };
  const addReviewContextToChat = () => {
    if (!activeChat || !data) {
      setHandoffStatus(
        'Open the destination chat before adding review context.',
      );
      return;
    }
    const exact = activeChatsStore.getSnapshot()[activeChat];
    if (!exact) {
      setHandoffStatus('The selected destination chat is no longer available.');
      return;
    }
    const context = [
      `Review ${target.host}/${target.owner}/${target.repository} #${target.ref}`,
      `Head: ${data.headSha}`,
      `Source: ${data.pullRequest.url}`,
    ].join('\n');
    const existing = exact.input ?? getDraft(activeChat);
    const next = existing ? `${existing}\n\n${context}` : context;
    setDraft(activeChat, next);
    updateChat(activeChat, { input: getDraft(activeChat) });
    setHandoffStatus(`Added review context to the open chat without sending.`);
  };
  return (
    <section className="pull-request-review" aria-label="Pull request review">
      <div className="pull-request-review__bar">
        {onBack && (
          <BrowserIconButton
            className="pull-request-review__icon"
            aria-label="Back to pull requests"
            title="Back to pull requests"
            onClick={() => guard(onBack)}
          >
            <ArrowLeftGlyph />
          </BrowserIconButton>
        )}
        <h2 className="pull-request-review__title">
          {data?.pullRequest.title ?? `#${target.ref}`}
        </h2>
        {/* The actions wrap under the title as one unit when the bar is
            narrow, so the title keeps its width. */}
        <div className="pull-request-review__bar-actions">
          {data && (
            // The pane's one labelled action: it acts on the whole review.
            <Button
              size="sm"
              variant="ghost"
              className="pull-request-review__handoff"
              title="Add this review's reference to the open chat's draft"
              onClick={addReviewContextToChat}
              disabled={!activeChat}
            >
              Add to chat
            </Button>
          )}
          <BrowserIconButton
            className="pull-request-review__icon"
            aria-label="Refresh"
            title="Refresh the review from the provider"
            disabled={review.isFetching || pending || !scope?.isCurrent()}
            onClick={() => void review.refetch()}
          >
            <RefreshGlyph />
          </BrowserIconButton>
          {data?.pullRequest.url ? (
            // The way to the forge stays on the bar. In the Station app the
            // host opens what its policy admits (#2480), and any refusal shows
            // the link with a Copy action rather than nothing.
            <BrowserIconButton
              className="pull-request-review__icon"
              aria-label={pullRequestExternalLabel(data.pullRequest.url)}
              title={pullRequestExternalLabel(data.pullRequest.url)}
              onClick={() => void openExternalLink(data.pullRequest.url)}
            >
              <ExternalLinkGlyph />
            </BrowserIconButton>
          ) : null}
        </div>
      </div>
      {!scope?.isCurrent() ? (
        <ErrorState
          variant="compact"
          title="Station access changed"
          description="Reconnect to inspect this pull request."
        />
      ) : review.isPending ? (
        <SkeletonBlock label="Reading pull request review" />
      ) : review.error ? (
        <ErrorState
          variant="compact"
          title="Review unavailable"
          description={review.error.message}
        />
      ) : !data ? (
        <ErrorState
          variant="compact"
          title="Review unavailable"
          description={
            review.data?.reason ??
            'The provider did not supply a current review.'
          }
        />
      ) : (
        <>
          <ReviewHeader
            pullRequest={data.pullRequest}
            headSha={data.headSha}
            observedAt={data.observedAt}
          />
          {handoffStatus && <p role="status">{handoffStatus}</p>}
          <h3>Status</h3>
          <p
            className="pull-request-review__mergeability"
            data-mergeability={data.pullRequest.mergeability}
          >
            {MERGEABILITY_COPY[data.pullRequest.mergeability]}{' '}
            <code>{data.pullRequest.targetBranch}</code>.
          </p>
          <PullRequestChecks checks={data.checks} />
          {data.pullRequest.body?.trim() ? (
            <>
              <h3>Description</h3>
              <div className="pull-request-review__body">
                {data.pullRequest.body}
              </div>
            </>
          ) : null}
          <h3>Changed files</h3>
          {data.diff.state === 'available' ? (
            <>
              <p>
                Diff supplied by the provider. Check the forge for omitted or
                binary content.
              </p>
              <div
                className="pull-request-review__diff"
                style={{
                  height: Math.min(
                    480,
                    Math.max(160, data.diff.patch.split('\n').length * 22 + 64),
                  ),
                }}
              >
                <LazyBoundary
                  load={loadDiff}
                  componentProps={{
                    diff: data.diff.patch,
                    observationKey: identity,
                    ...(data.reviewComments?.state === 'available'
                      ? { providerComments: data.reviewComments.comments }
                      : {}),
                  }}
                  pending={<SkeletonBlock label="Preparing changed files" />}
                />
              </div>
            </>
          ) : (
            <ErrorState
              variant="compact"
              title="Diff unavailable"
              description={data.diff.reason}
            />
          )}
          <UnplacedReviewComments
            comments={data.reviewComments}
            placed={placed}
          />
          <h3>Discussion</h3>
          {data.discussionPartial && (
            <p>
              Only part of the discussion is available here. Open the forge for
              the full history.
            </p>
          )}
          <ol className="pull-request-review__discussion">
            {data.discussion.map((item) => (
              <li key={`${item.kind}:${item.id}`}>
                <strong>{item.author}</strong>{' '}
                <span className="pull-request-review__muted">
                  {item.state
                    ? (reviewDecisionChip(item.state)?.label ??
                      humanise(item.state))
                    : item.kind}
                </span>
                <div className="pull-request-review__body">{item.body}</div>
              </li>
            ))}
          </ol>
          <label className="pull-request-review__comment">
            Comment
            <textarea
              className="editor-textarea"
              value={body}
              maxLength={16_384}
              disabled={pending}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
          {!caps?.comment && (
            <p>This provider does not currently permit comments.</p>
          )}
          {!caps?.approve && (
            <p>This provider does not currently permit approvals.</p>
          )}
          <ResponsiveSurfaceActions className="pull-request-review__actions">
            <Button
              disabled={!writable || !caps?.comment || !body.trim()}
              onClick={() =>
                setIntent({
                  action: 'comment',
                  expectedHeadSha: data.headSha,
                  body,
                })
              }
            >
              Post comment
            </Button>
            <Button
              disabled={
                !writable ||
                !open ||
                !caps?.approve ||
                data.diff.state !== 'available'
              }
              onClick={() =>
                setIntent({ action: 'approve', expectedHeadSha: data.headSha })
              }
            >
              Approve this head
            </Button>
          </ResponsiveSurfaceActions>
          <label className="pull-request-review__method">
            Merge method
            <select
              className="editor-select"
              aria-label="Reviewed merge method"
              value={selectedMethod ?? ''}
              disabled={!writable || !open}
              onChange={(event) =>
                setMethod(event.target.value as PullRequestMergeMethod)
              }
            >
              {methods.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          {!caps?.merge && (
            <p>This provider does not currently permit merging.</p>
          )}
          <ResponsiveSurfaceActions className="pull-request-review__actions">
            <Button
              disabled={
                !writable ||
                !open ||
                !caps?.merge ||
                !selectedMethod ||
                data.diff.state !== 'available'
              }
              onClick={() =>
                setIntent({
                  action: 'merge',
                  expectedHeadSha: data.headSha,
                  method: selectedMethod!,
                  autoMerge: false,
                })
              }
            >
              Merge inspected head
            </Button>
            <Button
              disabled={
                !writable ||
                !open ||
                !caps?.autoMerge ||
                !selectedMethod ||
                data.diff.state !== 'available'
              }
              onClick={() =>
                setIntent({
                  action: 'merge',
                  expectedHeadSha: data.headSha,
                  method: selectedMethod!,
                  autoMerge: true,
                })
              }
            >
              Queue inspected head
            </Button>
          </ResponsiveSurfaceActions>
          {outcome && (
            <p ref={outcomeRef} role="status">
              {outcome.status === 'confirmed'
                ? `Confirmed by ${outcome.actor}${outcome.headSha ? ` for ${outcome.headSha}` : ''}.`
                : outcome.status === 'merged'
                  ? 'The provider reports this pull request merged.'
                  : outcome.status === 'queued-auto-merge'
                    ? 'The provider reports auto-merge is queued.'
                    : outcome.reason}
            </p>
          )}
          {uncertain && (
            <Button
              disabled={
                review.isFetching ||
                !!review.error ||
                review.dataUpdatedAt <= uncertainReadAt
              }
              onClick={() => {
                setUncertain(false);
                setOutcome(null);
              }}
            >
              Prepare another submission
            </Button>
          )}
        </>
      )}
      <ConfirmModal
        isOpen={!!intent}
        title={
          intent?.action === 'merge'
            ? 'Merge inspected head'
            : intent?.action === 'approve'
              ? 'Approve inspected head'
              : 'Post review comment'
        }
        message={`Submit as the currently authenticated forge operator for ${target.host}/${target.owner}/${target.repository} #${target.ref}, head ${intent?.expectedHeadSha ?? ''}${intent?.action === 'merge' ? `, using ${intent.method}${intent.autoMerge ? ' with auto-merge' : ''}` : ''}?`}
        confirmLabel={
          intent?.action === 'merge'
            ? intent.autoMerge
              ? 'Queue auto-merge'
              : 'Merge'
            : intent?.action === 'approve'
              ? 'Approve'
              : 'Post comment'
        }
        onConfirm={() => void submit()}
        onCancel={() => {
          if (!pending) setIntent(null);
        }}
        pending={pending}
      />
      <DiscardModal />
    </section>
  );
}
