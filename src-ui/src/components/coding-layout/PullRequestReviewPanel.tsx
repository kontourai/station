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
import { useTickingNow } from '../../hooks/useTickingNow';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { openExternalLink } from '../../platform/openExternalLink';
// The Browser pane's round icon control, until the shared `IconButton` (a
// sibling change) lands; this import moves there with it.
import { BrowserIconButton } from '../../workspace-panes/browser-pane/BrowserIconButton';
import { ActionRow, type OverflowAction } from '../ActionRow';
import { Button } from '../Button';
import {
  ArrowLeftGlyph,
  ArrowRightGlyph,
  ExternalLinkGlyph,
  MessageGlyph,
  RefreshGlyph,
} from '../icons/Glyph';
import { LazyBoundary } from '../LazyBoundary';
import { ConfirmModal } from '../modals/ConfirmModal';
import {
  humanise,
  PullRequestChip,
  type PullRequestChipTone,
  pullRequestStateChip,
  reviewDecisionChip,
} from '../pull-requests/pull-request-chips';
import {
  pullRequestExternalLabel,
  pullRequestHostName,
} from '../pull-requests/pull-request-external';
import { RelativeTime } from '../pull-requests/RelativeTime';
import { ResponsiveSurfaceActions } from '../ResponsiveDialogSurface';
import { ErrorState, SkeletonBlock } from '../state';
import './PullRequestReviewPanel.css';

export { pullRequestExternalLabel } from '../pull-requests/pull-request-external';

type Intent =
  | PullRequestReviewInput
  | {
      action: 'merge';
      expectedHeadSha: string;
      method: PullRequestMergeMethod;
      autoMerge: boolean;
    };

const MERGEABILITY_COPY: Record<PullRequest['mergeability'], string> = {
  mergeable: 'Merges cleanly into',
  conflicting: 'Has conflicts with',
  unknown: 'Mergeability not yet reported for',
};

/** The site's own names for its merge methods, as a choice reads them. */
const MERGE_METHOD_LABEL: Partial<Record<PullRequestMergeMethod, string>> = {
  merge: 'Merge commit',
  squash: 'Squash and merge',
  rebase: 'Rebase and merge',
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

const CHECK_STATE_TONE: Record<PullRequestCheckState, PullRequestChipTone> = {
  failure: 'failure',
  pending: 'pending',
  cancelled: 'neutral',
  success: 'success',
  neutral: 'neutral',
  skipped: 'neutral',
};

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? '' : 's'}`;
/** "passed", "passed or skipped", "passed, neutral or skipped". */
const listWords = (words: readonly string[]) =>
  words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;

/** "GitHub", "GitLab", or a plain noun where the host is neither. */
const hostWord = (url: string | undefined) =>
  (url && pullRequestHostName(url)) || 'the site';

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

/**
 * The check rows. Each carries two quiet icons: send THIS check to the open
 * chat (its name, state and link — the failing one is usually the next
 * thing to ask about), and open its details. Shown on hover and focus on a
 * fine pointer, always on a coarse one (CSS).
 */
function CheckList({
  checks,
  onAddToChat,
}: {
  checks: readonly PullRequestCheck[];
  onAddToChat?: (check: PullRequestCheck) => void;
}) {
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
          <span className="pull-request-review__check-tools">
            {onAddToChat ? (
              <BrowserIconButton
                className="pull-request-review__icon pull-request-review__check-tool"
                aria-label={`Add ${check.name} to chat`}
                title="Add to chat"
                onClick={() => onAddToChat(check)}
              >
                <MessageGlyph />
              </BrowserIconButton>
            ) : null}
            {check.url ? (
              <BrowserIconButton
                className="pull-request-review__icon pull-request-review__check-tool"
                aria-label={`Open ${check.name} details`}
                title={`Open ${check.name} details`}
                onClick={() => void openExternalLink(check.url!)}
              >
                <ExternalLinkGlyph />
              </BrowserIconButton>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The checks for the observed head. Counts come from the list itself, and
 * each state is written in words, not colour alone. Absent means this
 * server did not observe checks, which is said as such.
 */
function PullRequestChecks({
  checks,
  siteName,
  onAddToChat,
}: {
  checks: PullRequestChecksObservation | undefined;
  siteName: string;
  onAddToChat?: (check: PullRequestCheck) => void;
}) {
  if (!checks)
    return <p className="pull-request-review__muted">Checks not reported</p>;
  if (checks.state === 'unavailable')
    return <p className="pull-request-review__muted">{checks.reason}</p>;
  if (checks.checks.length === 0)
    return <p className="pull-request-review__muted">No checks</p>;
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
            Some checks not shown — see {siteName}
          </span>
        )}
      </p>
      <CheckList checks={needsAttention} onAddToChat={onAddToChat} />
      {settled.length > 0 && (
        <details className="pull-request-review__settled">
          <DisclosureSummary>
            {needsAttention.length === 0 ? 'Show' : 'Show the other'}{' '}
            {settled.length} {listWords(settledStates)}{' '}
            {plural(settled.length, 'check').replace(/^\d+ /, '')}
          </DisclosureSummary>
          <CheckList checks={settled} onAddToChat={onAddToChat} />
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
  siteName,
}: {
  comments: PullRequestReviewCommentsObservation | undefined;
  placed: PlacedLines;
  siteName: string;
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
          Some inline comments not shown — see {siteName}
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
                <ForgeComment comment={comment} siteName={siteName} />
              </li>
            ))}
          </ol>
        </details>
      )}
    </>
  );
}

/**
 * One review comment the diff could not place, as a named article so it
 * reads apart from a local Station comment. A file-level comment is a
 * comment on the file; only a line comment the site no longer maps is
 * "outdated".
 */
function ForgeComment({
  comment,
  siteName,
}: {
  comment: PullRequestReviewComment;
  siteName: string;
}) {
  const where =
    comment.subject === 'file'
      ? 'the file'
      : comment.line === null
        ? 'an outdated line'
        : `line ${comment.line}`;
  return (
    <article
      className="pull-request-review__forge-comment"
      aria-label={`Comment by ${comment.author} on ${where} of ${comment.path}`}
    >
      <div className="pull-request-review__forge-comment-meta">
        <strong>{comment.author}</strong>
        <span className="pull-request-review__muted">
          on {where} of <code>{comment.path}</code>
        </span>
        {comment.url ? (
          <BrowserIconButton
            className="pull-request-review__icon"
            aria-label={`Open on ${siteName}`}
            title={`Open on ${siteName}`}
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

/**
 * Two scannable lines under the title: the state and review decision as
 * chips, the branches in monospace, the author and commit count; then the
 * repository, a short commit id (full value in its title) and how long ago
 * this was read, compact, with the absolute time in its title. The relative
 * time keeps up with the clock while the pane stays open.
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
  const now = useTickingNow();
  return (
    <div className="pull-request-review__head">
      <div className="pull-request-review__meta">
        <PullRequestChip {...state} />
        {decision && <PullRequestChip {...decision} />}
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
        <RelativeTime iso={observedAt} now={now} />
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
  const siteName = hostWord(data?.pullRequest.url);
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
              reason: result.reason ?? 'This review was not accepted.',
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
          reason: `The acknowledgement was lost. Refresh and check the discussion on ${siteName} before submitting again.`,
        });
      }
    } finally {
      submitting.current = false;
      setPending(false);
      setIntent(null);
    }
  };
  /**
   * Append `text` to the open chat's draft without sending it.
   *
   * The navigation's `activeChat` is the chat's conversation or thread id;
   * the chats store keys its entries by SESSION id, which for a chat opened
   * from a conversation is a different string. A direct snapshot lookup by
   * the navigation id therefore missed the very chat open beside this pane
   * and answered "no longer available" (design audit D2). The store's own
   * resolver maps any of a chat's ids to its key — the same seam
   * `updateChat` uses — so the draft lands where the composer reads it.
   */
  const addToChat = (text: string) => {
    if (!activeChat || !data) {
      setHandoffStatus('Open a chat first');
      return;
    }
    const key = activeChatsStore.getChatKeyForExecutionSession(activeChat);
    const exact = key ? activeChatsStore.getSnapshot()[key] : undefined;
    if (!key || !exact) {
      setHandoffStatus('That chat is gone');
      return;
    }
    const existing = exact.input ?? getDraft(key);
    const next = existing ? `${existing}\n\n${text}` : text;
    setDraft(key, next);
    updateChat(key, { input: getDraft(key) });
    setHandoffStatus('Added to draft');
  };
  const addReviewContextToChat = () =>
    data &&
    addToChat(
      `Review ${target.owner}/${target.repository} #${target.ref} at ${data.headSha}: ${data.pullRequest.url}`,
    );
  const addCheckToChat = (check: PullRequestCheck) =>
    addToChat(
      `Check "${check.name}" ${CHECK_STATE_LABEL[check.state].toLowerCase()} on ${target.owner}/${target.repository} #${target.ref}${check.url ? `: ${check.url}` : ''}`,
    );
  // The merge menu: the method as a choice, then the two ways to merge. Each
  // command that cannot run yet says why in its row rather than vanishing.
  const mergeBlocked = !writable
    ? pending
      ? 'Waiting for the last submission'
      : uncertain
        ? 'Refresh first'
        : 'Reading the review'
    : !open
      ? 'Not open'
      : data?.diff.state !== 'available'
        ? 'Diff unavailable'
        : !selectedMethod
          ? 'No merge method allowed'
          : null;
  const mergeActions: OverflowAction[] = data
    ? [
        ...methods.map(
          (value): OverflowAction => ({
            key: `method:${value}`,
            label: MERGE_METHOD_LABEL[value] ?? humanise(value),
            checked: value === selectedMethod,
            onSelect: () => setMethod(value),
          }),
        ),
        {
          key: 'merge',
          label: 'Merge now',
          disabled: !!mergeBlocked || !caps?.merge,
          disabledReason: !caps?.merge
            ? 'Merging is not permitted here'
            : (mergeBlocked ?? undefined),
          onSelect: () =>
            setIntent({
              action: 'merge',
              expectedHeadSha: data.headSha,
              method: selectedMethod!,
              autoMerge: false,
            }),
        },
        {
          key: 'auto-merge',
          label: 'Enable auto-merge',
          disabled: !!mergeBlocked || !caps?.autoMerge,
          disabledReason: !caps?.autoMerge
            ? 'Auto-merge is not permitted here'
            : (mergeBlocked ?? undefined),
          onSelect: () =>
            setIntent({
              action: 'merge',
              expectedHeadSha: data.headSha,
              method: selectedMethod!,
              autoMerge: true,
            }),
        },
      ]
    : [];
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
              title="Add this review to the open chat's draft"
              onClick={addReviewContextToChat}
              disabled={!activeChat}
            >
              Add to chat
            </Button>
          )}
          <BrowserIconButton
            className="pull-request-review__icon"
            aria-label="Refresh"
            title="Refresh"
            disabled={review.isFetching || pending || !scope?.isCurrent()}
            onClick={() => void review.refetch()}
          >
            <RefreshGlyph />
          </BrowserIconButton>
          {data?.pullRequest.url ? (
            // The way to the site stays on the bar. In the Station app the
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
          description={review.data?.reason ?? 'No current review was supplied.'}
        />
      ) : (
        <>
          <ReviewHeader
            pullRequest={data.pullRequest}
            headSha={data.headSha}
            observedAt={data.observedAt}
          />
          {handoffStatus && (
            <p className="pull-request-review__status" role="status">
              {handoffStatus}
            </p>
          )}
          <h3>Status</h3>
          <p
            className="pull-request-review__mergeability"
            data-mergeability={data.pullRequest.mergeability}
          >
            {MERGEABILITY_COPY[data.pullRequest.mergeability]}{' '}
            <code>{data.pullRequest.targetBranch}</code>.
          </p>
          <PullRequestChecks
            checks={data.checks}
            siteName={siteName}
            onAddToChat={activeChat ? addCheckToChat : undefined}
          />
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
            siteName={siteName}
          />
          <h3>Discussion</h3>
          {data.discussionPartial && (
            <p className="pull-request-review__muted">
              Older comments on {siteName}
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
            <p className="pull-request-review__muted">
              Comments are not permitted here.
            </p>
          )}
          {!caps?.approve && (
            <p className="pull-request-review__muted">
              Approvals are not permitted here.
            </p>
          )}
          {/* Two labelled actions, then Merge as one menu: the method is a
              choice inside it and the two merge commands follow. */}
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
              Approve
            </Button>
          </ResponsiveSurfaceActions>
          {open && (caps?.merge || caps?.autoMerge) && (
            <ActionRow
              className="pull-request-review__merge"
              overflow={mergeActions}
              overflowLabel="Merge options"
            />
          )}
          {outcome && (
            <p
              ref={outcomeRef}
              className="pull-request-review__status"
              role="status"
            >
              {outcome.status === 'confirmed'
                ? `Confirmed by ${outcome.actor}${outcome.headSha ? ` for ${outcome.headSha}` : ''}.`
                : outcome.status === 'merged'
                  ? 'Merged.'
                  : outcome.status === 'queued-auto-merge'
                    ? 'Auto-merge enabled.'
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
              Review again
            </Button>
          )}
        </>
      )}
      <ConfirmModal
        isOpen={!!intent}
        title={
          intent?.action === 'merge'
            ? intent.autoMerge
              ? 'Enable auto-merge'
              : 'Merge pull request'
            : intent?.action === 'approve'
              ? 'Approve pull request'
              : 'Post review comment'
        }
        message={`${
          intent?.action === 'merge'
            ? intent.autoMerge
              ? 'Auto-merge'
              : 'Merge'
            : intent?.action === 'approve'
              ? 'Approve'
              : 'Comment on'
        } ${target.owner}/${target.repository} #${target.ref} at ${intent?.expectedHeadSha ?? ''}${intent?.action === 'merge' ? ` with ${humanise(intent.method).toLowerCase()}` : ''}, as the account signed in to ${siteName}?`}
        confirmLabel={
          intent?.action === 'merge'
            ? intent.autoMerge
              ? 'Enable auto-merge'
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
