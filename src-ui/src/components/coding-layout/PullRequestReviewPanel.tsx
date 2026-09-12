import type {
  PullRequestMergeMethod,
  PullRequestMergeResult,
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
const loadDiff = () =>
  import('./DiffPanel').then((module) => ({
    default: module.ObservedDiffPanel,
  }));

export function PullRequestReviewPanel({
  target,
  onBack,
}: {
  target: PullRequestReviewTarget;
  onBack: () => void;
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
  onBack: () => void;
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
        <Button onClick={() => guard(onBack)}>Back to pull requests</Button>
        <Button
          disabled={review.isFetching || pending || !scope?.isCurrent()}
          onClick={() => void review.refetch()}
        >
          Refresh
        </Button>
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
          <p>
            <a href={data.pullRequest.url} target="_blank" rel="noreferrer">
              Open on forge
            </a>
          </p>
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
