import type {
  PullRequest,
  PullRequestCheck,
  PullRequestCheckState,
  PullRequestChecksObservation,
  PullRequestMergeMethod,
  PullRequestMergeResult,
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
import { useEffect, useRef, useState } from 'react';
import {
  activeChatsStore,
  useActiveChatActions,
} from '../../contexts/ActiveChatsContext';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { useNavigation } from '../../contexts/NavigationContext';
import { useUnsavedGuard } from '../../hooks/useUnsavedGuard';
import { openExternalLink } from '../../platform/openExternalLink';
import { Button } from '../Button';
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
            <Button
              variant="ghost"
              size="sm"
              aria-label={`Open ${check.name} details`}
              onClick={() => void openExternalLink(check.url!)}
            >
              Details
            </Button>
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
export function PullRequestChecks({
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
  return (
    <>
      <p role="status" className="pull-request-review__checks-summary">
        {counts
          .map(
            ([state, count]) =>
              `${count} ${CHECK_STATE_LABEL[state].toLowerCase()}`,
          )
          .join(' · ')}
        {checks.partial
          ? '. Only part of the checks could be read; open the forge for the rest.'
          : ''}
      </p>
      <CheckList checks={needsAttention} />
      {settled.length > 0 && (
        <details className="pull-request-review__settled">
          <summary>
            {needsAttention.length === 0 ? 'Show' : 'Show the other'}{' '}
            {settled.length} passed, neutral or skipped check
            {settled.length === 1 ? '' : 's'}
          </summary>
          <CheckList checks={settled} />
        </details>
      )}
    </>
  );
}

/** Inline comments the diff cannot place: outdated, or on a file it omits. */
function UnplacedReviewComments({
  comments,
  placedPaths,
}: {
  comments: PullRequestReviewCommentsObservation | undefined;
  placedPaths: ReadonlySet<string>;
}) {
  if (!comments) return null;
  if (comments.state === 'unavailable')
    return <p className="pull-request-review__muted">{comments.reason}</p>;
  const unplaced = comments.comments.filter(
    (comment) => comment.line === null || !placedPaths.has(comment.path),
  );
  return (
    <>
      {comments.partial && (
        <p className="pull-request-review__muted">
          Only part of the inline review comments could be read. Open the forge
          for the rest.
        </p>
      )}
      {unplaced.length > 0 && (
        <details className="pull-request-review__unplaced">
          <summary>
            {unplaced.length} inline comment{unplaced.length === 1 ? '' : 's'}{' '}
            not on the current diff
          </summary>
          <ol className="pull-request-review__discussion">
            {unplaced.map((comment) => (
              <li key={comment.id}>
                <strong>{comment.author}</strong> on <code>{comment.path}</code>
                {comment.line === null ? ' (outdated)' : ''}
                <div className="pull-request-review__body">{comment.body}</div>
              </li>
            ))}
          </ol>
        </details>
      )}
    </>
  );
}

/**
 * Paths with hunks in a unified patch: the new name (`+++ b/x`) and, for a
 * deletion or rename, the old one (`--- a/x`).
 */
function patchPaths(patch: string): Set<string> {
  const paths = new Set<string>();
  for (const match of patch.matchAll(/^(?:\+\+\+ b|--- a)\/(.+)$/gm))
    paths.add(match[1]);
  return paths;
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
      <ResponsiveSurfaceActions className="pull-request-review__actions">
        {onBack && (
          <Button onClick={() => guard(onBack)}>Back to pull requests</Button>
        )}
        <Button
          disabled={review.isFetching || pending || !scope?.isCurrent()}
          onClick={() => void review.refetch()}
        >
          Refresh
        </Button>
        {data?.pullRequest.url ? (
          // Beside Refresh rather than in the body, so the way to the forge
          // is the first thing on screen. On the web it opens a new tab. In
          // the Station app the host opens what its policy admits (#2480:
          // any https link, once that widening lands), and any refusal shows
          // the link with a Copy action rather than nothing.
          <Button onClick={() => void openExternalLink(data.pullRequest.url)}>
            {pullRequestExternalLabel(data.pullRequest.url)}
          </Button>
        ) : null}
      </ResponsiveSurfaceActions>
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
          <h2>{data.pullRequest.title}</h2>
          <p>
            {target.host}/{target.owner}/{target.repository} · #{target.ref} ·{' '}
            {data.pullRequest.state}
          </p>
          <p>
            {data.pullRequest.author.login} · {data.pullRequest.sourceBranch} →{' '}
            {data.pullRequest.targetBranch} · {data.pullRequest.commits} commits
            · {data.pullRequest.reviewStatus}
          </p>
          <p>
            Head <code>{data.headSha}</code> · Observed{' '}
            {new Date(data.observedAt).toLocaleString()}
          </p>
          <h3>Status</h3>
          <p
            className="pull-request-review__mergeability"
            data-mergeability={data.pullRequest.mergeability}
          >
            {MERGEABILITY_COPY[data.pullRequest.mergeability]}{' '}
            <code>{data.pullRequest.targetBranch}</code>.
          </p>
          <PullRequestChecks checks={data.checks} />
          <ResponsiveSurfaceActions className="pull-request-review__actions">
            <Button onClick={addReviewContextToChat} disabled={!activeChat}>
              Add review context to open chat
            </Button>
          </ResponsiveSurfaceActions>
          {handoffStatus && <p role="status">{handoffStatus}</p>}
          <div className="pull-request-review__body">
            {data.pullRequest.body}
          </div>
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
            placedPaths={
              data.diff.state === 'available'
                ? patchPaths(data.diff.patch)
                : new Set()
            }
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
                <strong>{item.author}</strong> {item.state ?? item.kind}
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
