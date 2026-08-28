import type { DiffComment } from '@kontourai/station-contracts/diff-comment';
import type { LayoutConfig } from '@kontourai/station-contracts/layout';
import type { ProposedChange } from '@kontourai/station-contracts/proposed-change';
import type {
  IndependentReviewReceipt,
  IndependentReviewRequest,
  ReviewEvidenceUnavailableReason,
} from '@kontourai/station-contracts/review-evidence';
import {
  type SurveyFlowReviewItemVM,
  type SurveyFlowReviewUnavailableReason,
  useAgentsQuery,
  useAllDiffCommentsQuery,
  useApproveProposedChangeMutation,
  useBulkApproveProposedChangesMutation,
  useBulkRejectProposedChangesMutation,
  useProjectLayoutsQuery,
  useProjectsQuery,
  useProposedChangesQuery,
  useRejectProposedChangeMutation,
  useResolveDiffCommentMutation,
  useReviewEvidenceQuery,
  useRunIndependentReviewMutation,
  useSurveyFlowReviewsQuery,
} from '@kontourai/station-sdk';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../components/Button';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import {
  ResponsiveDialogSurface,
  ResponsiveSurfaceActions,
} from '../components/ResponsiveDialogSurface';
import { SplitPaneLayout } from '../components/SplitPaneLayout';
import { useNavigation } from '../contexts/NavigationContext';
import './ReviewQueueView.css';
import './page-layout.css';

type BulkAction = 'approve' | 'reject' | null;

/** The operator remedy differs by reason, so the copy names it per project. */
const REVIEW_UNAVAILABLE_REASON_COPY: Record<
  ReviewEvidenceUnavailableReason,
  string
> = {
// Deliberately not "locked by another Station process": the read only knows
// the lock was held past its wait, which a slow index repair produces as
// readily as a second process, and sending the operator to hunt a process
// that may not exist is worse than naming what was observed.
  'lock-unavailable': 'contended — another Station process or a long repair',
  'workspace-unreadable': 'workspace path unreadable',
  'receipts-unreadable': 'receipts unreadable',
};

/** Same rule for the Flow-review feed's own per-project unavailability
 * (archive#3322): a new reason is a type error here until it has its own copy,
*  rather than silently rendering under the wrong remedy. */
const SURVEY_UNAVAILABLE_REASON_COPY: Record<
  SurveyFlowReviewUnavailableReason,
  string
> = {
  'workspace-unreadable': 'workspace path unreadable',
  'sessions-unreadable': 'review sessions unreadable',
  'projection-failed': 'review list could not be built',
};

/** Selected diff-comment list ids are namespaced so they can't collide with a
*  proposed-change id in the shared selection state. */
const COMMENT_PREFIX = 'comment:';
const SURVEY_PREFIX = 'survey:';
const REVIEW_EVIDENCE_PREFIX = 'evidence:';

function reviewEvidenceItemId(projectSlug: string, receiptId: string): string {
  return `${REVIEW_EVIDENCE_PREFIX}${encodeURIComponent(projectSlug)}:${encodeURIComponent(receiptId)}`;
}

function receiptDeepLink(): { projectSlug: string; receiptId: string } | null {
  const params = new URLSearchParams(window.location.search);
  const projectSlug = params.get('project');
  const receiptId = params.get('receipt');
  return projectSlug && receiptId ? { projectSlug, receiptId } : null;
}

export function ReviewQueueView() {
  const [search, setSearch] = useState('');
  const [receiptTarget, setReceiptTarget] = useState(receiptDeepLink);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    receiptTarget
      ? reviewEvidenceItemId(receiptTarget.projectSlug, receiptTarget.receiptId)
      : null,
  );
  const [bulkAction, setBulkAction] = useState<BulkAction>(null);
  const [reviewRunOpen, setReviewRunOpen] = useState(false);
  useEffect(() => {
    const sync = () => {
      const target = receiptDeepLink();
      setReceiptTarget(target);
      if (target)
        setSelectedId(
          reviewEvidenceItemId(target.projectSlug, target.receiptId),
        );
    };
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  const {
    data: changes = [],
    isLoading,
    isError: changesError,
  } = useProposedChangesQuery({
    status: ['pending'],
  });
  const {
    data: comments = [],
    isLoading: commentsLoading,
    isError: commentsError,
  } = useAllDiffCommentsQuery();
  const {
    data: surveyFlowReviews,
    isLoading: surveyLoading,
    isError: surveyError,
  } = useSurveyFlowReviewsQuery();
  const surveyReviews = surveyFlowReviews?.items ?? [];
  const unavailableSurveyProjects =
    surveyFlowReviews?.unavailableProjects ?? [];
  const {
    data: reviewEvidence,
    isLoading: reviewEvidenceLoading,
    isError: reviewEvidenceError,
  } = useReviewEvidenceQuery();
  const reviewReceipts = reviewEvidence?.receipts ?? [];
  const unavailableReviewProjects = reviewEvidence?.unavailableProjects ?? [];
// A failed source must never read as an empty queue: `data = []` on error
// rendered "Nothing to review" — absence-as-success on the one surface
// whose job is making pending approvals visible. Errors are scoped per
// source so one failing fetch does not paint the others as broken either.
  const failedSources = [
    changesError ? 'proposed changes' : null,
    commentsError ? 'review comments' : null,
    surveyError ? 'flow reviews' : null,
    reviewEvidenceError ? 'independent review evidence' : null,
  ].filter((source): source is string => source !== null);
// Review evidence is additionally scoped per project. A partial result is
// not a failed source — the source DID load — so it gets its own copy,
// naming each unavailable project with its reason (the remedy differs:
// a lock means find the second process; an unreadable path means fix it).
  const partialReviewEvidenceNotice =
    !reviewEvidenceError && unavailableReviewProjects.length > 0
      ? `Independent review evidence is partial — ${unavailableReviewProjects.length} project${unavailableReviewProjects.length === 1 ? '' : 's'} unavailable: ${unavailableReviewProjects.map((project) => `${project.projectSlug} (${REVIEW_UNAVAILABLE_REASON_COPY[project.reason]})`).join(', ')}.`
      : null;
  const partialSurveyNotice =
    !surveyError && unavailableSurveyProjects.length > 0
      ? `Flow reviews are partial — ${unavailableSurveyProjects.length} project${unavailableSurveyProjects.length === 1 ? '' : 's'} unavailable: ${unavailableSurveyProjects.map((project) => `${project.projectSlug} (${SURVEY_UNAVAILABLE_REASON_COPY[project.reason]})`).join(', ')}.`
      : null;
  const sourceNotices = [
    failedSources.length > 0
      ? `Failed to load: ${failedSources.join(', ')}. Items may be pending that are not shown.`
      : null,
    partialSurveyNotice,
    partialReviewEvidenceNotice,
  ].filter((notice): notice is string => notice !== null);
  const approveMutation = useApproveProposedChangeMutation();
  const rejectMutation = useRejectProposedChangeMutation();
  const bulkApproveMutation = useBulkApproveProposedChangesMutation();
  const bulkRejectMutation = useBulkRejectProposedChangesMutation();
  const resolveMutation = useResolveDiffCommentMutation();

  const filteredChanges = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return changes;
    return changes.filter((change) =>
      [change.path, change.projectId, change.sessionId, change.sourceRuntime]
        .join(' ')
        .toLowerCase()
        .includes(query),
    );
  }, [changes, search]);

  const filteredComments = useMemo(() => {
    const query = search.trim().toLowerCase();
    const scoped = query
      ? comments.filter((comment) =>
          [comment.filePath, comment.projectId, comment.body]
            .join(' ')
            .toLowerCase()
            .includes(query),
        )
      : comments;
// Group each project's comments together so section headers stay coherent.
    return [...scoped].sort(
      (a, b) =>
        a.projectId.localeCompare(b.projectId) ||
        b.createdAt.localeCompare(a.createdAt),
    );
  }, [comments, search]);

  const items = useMemo(
    () => [
      ...filteredChanges.map((change) => ({
        id: change.id,
        name: change.path,
        subtitle: `${change.projectId} | ${change.sourceRuntime} | ${change.contentKind}`,
        section: change.projectId,
      })),
      ...filteredComments.map((comment) => ({
        id: `${COMMENT_PREFIX}${comment.id}`,
        name: comment.filePath,
        subtitle: `${comment.side} · line ${comment.lineNumber} · ${comment.projectId}`,
        section: `Comments · ${comment.projectId}`,
      })),
      ...surveyReviews.map((review) => ({
        id: `${SURVEY_PREFIX}${review.reviewSessionRef}`,
        name: review.sessionName,
        subtitle: `${review.summary.unresolved} unresolved · ${review.workflowSubjectRef}`,
        section: `Flow reviews · ${review.projectSlug}`,
      })),
      ...reviewReceipts
        .filter((receipt) => {
          const query = search.trim().toLowerCase();
          return (
            (receiptTarget?.projectSlug === receipt.target.projectSlug &&
              receiptTarget.receiptId === receipt.receiptId) ||
            !query ||
            [
              receipt.target.projectSlug,
              receipt.receiptId,
              receipt.mode,
              ...receipt.findings.map((finding) => finding.summary),
            ]
              .join(' ')
              .toLowerCase()
              .includes(query)
          );
        })
        .map((receipt) => ({
          id: reviewEvidenceItemId(
            receipt.target.projectSlug,
            receipt.receiptId,
          ),
          name: `${receipt.findings.length} independent finding${receipt.findings.length === 1 ? '' : 's'}`,
          subtitle: `${receipt.mode} · ${receipt.target.baseSha.slice(0, 8)}..${receipt.target.headSha.slice(0, 8)}`,
          section: `Independent reviews · ${receipt.target.projectSlug}`,
        })),
    ],
    [
      filteredChanges,
      filteredComments,
      receiptTarget,
      reviewReceipts,
      search,
      surveyReviews,
    ],
  );

  const selectedChange =
    filteredChanges.find((change) => change.id === selectedId) ?? null;
  const selectedComment =
    selectedId?.startsWith(COMMENT_PREFIX) === true
      ? (filteredComments.find(
          (comment) => `${COMMENT_PREFIX}${comment.id}` === selectedId,
        ) ?? null)
      : null;
  const selectedSurveyReview = selectedId?.startsWith(SURVEY_PREFIX)
    ? (surveyReviews.find(
        (review) => `${SURVEY_PREFIX}${review.reviewSessionRef}` === selectedId,
      ) ?? null)
    : null;
  const selectedReviewReceipt = selectedId?.startsWith(REVIEW_EVIDENCE_PREFIX)
    ? (reviewReceipts.find(
        (receipt) =>
          reviewEvidenceItemId(
            receipt.target.projectSlug,
            receipt.receiptId,
          ) === selectedId,
      ) ?? null)
    : null;
  const pendingIds = changes.map((change) => change.id);
  const bulkPending =
    bulkApproveMutation.isPending || bulkRejectMutation.isPending;

  function decide(change: ProposedChange, decision: 'approve' | 'reject') {
    const reason = `${decision === 'approve' ? 'Approved' : 'Rejected'} from review queue`;
    if (decision === 'approve') {
      approveMutation.mutate({ id: change.id, decision: { reason } });
    } else {
      rejectMutation.mutate({ id: change.id, decision: { reason } });
    }
  }

  function resolveComment(comment: DiffComment) {
    resolveMutation.mutate(
      { projectSlug: comment.projectId, id: comment.id },
      { onSuccess: () => setSelectedId(null) },
    );
  }

  function confirmBulk() {
    if (!bulkAction || pendingIds.length === 0) return;
    const input = {
      ids: pendingIds,
      reason: `${bulkAction === 'approve' ? 'Bulk approved' : 'Bulk rejected'} from review queue`,
    };
    if (bulkAction === 'approve') {
      bulkApproveMutation.mutate(input);
    } else {
      bulkRejectMutation.mutate(input);
    }
    setBulkAction(null);
    setSelectedId(null);
  }

  return (
    <div className="pane-host" data-first-run-anchor="review-queue">
      {receiptTarget && !reviewEvidenceLoading && !selectedReviewReceipt && (
        <p role="status">
          That review receipt isn’t available for {receiptTarget.projectSlug},
          and Station won’t open a different one in its place.
        </p>
      )}
      <SplitPaneLayout
        label="review"
        title="Review"
        subtitle="Pending changes, review comments, and attributable review evidence"
        items={items}
        loading={
          isLoading || commentsLoading || surveyLoading || reviewEvidenceLoading
        }
        selectedId={selectedId}
        onSelect={setSelectedId}
        onDeselect={() => setSelectedId(null)}
        onSearch={setSearch}
        searchValue={search}
 // Review was the last route on the
// shared "items" placeholder noun — and the branch's own proving
 // case (archive#4463 's double-empty test lives here).
        listFilteredEmptyNoun="review items"
 // the four sources are each independently empty/non-empty; the
// collection as a whole is empty only when ALL of them are, which is
// exactly when a typed search should never be blamed for the empty
// queue (nothing exists regardless of the query).
        collectionEmpty={
          changes.length === 0 &&
          comments.length === 0 &&
          surveyReviews.length === 0 &&
          reviewReceipts.length === 0
        }
        searchPlaceholder="Search changes, comments, and evidence..."
        listEmptyTitle={
          sourceNotices.length > 0
            ? 'Some reviews could not load'
            : 'Nothing to review'
        }
        listEmptyDescription={
          sourceNotices.length > 0
            ? sourceNotices.join(' ')
            : 'AI proposals awaiting approval and inline review comments appear here.'
        }
        emptyIcon="R"
        emptyTitle="Select an item"
        emptyDescription="Review a proposed change, or read and resolve a diff comment."
        headerActions={
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setReviewRunOpen(true)}
          >
            Run independent review
          </Button>
        }
        sidebarActions={
          <>
            {sourceNotices.length > 0 ? (
// Present with or without items: a partial failure while
// other sections still render must not be invisible — that
// is the same absence-as-success failure, one level down.
              <p className="review-queue__sources-error" role="alert">
                {sourceNotices.join(' ')}
              </p>
            ) : null}
            {pendingIds.length > 0 ? (
              <div className="review-queue__bulk-actions">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={bulkPending}
                  onClick={() => setBulkAction('approve')}
                >
                  Approve All
                </Button>
                <Button
                  size="sm"
                  variant="danger-outline"
                  disabled={bulkPending}
                  onClick={() => setBulkAction('reject')}
                >
                  Reject All
                </Button>
              </div>
            ) : null}
          </>
        }
      >
        {selectedChange && (
          <ReviewQueueDetail
            change={selectedChange}
            pending={approveMutation.isPending || rejectMutation.isPending}
            onApprove={() => decide(selectedChange, 'approve')}
            onReject={() => decide(selectedChange, 'reject')}
          />
        )}
        {selectedComment && (
          <ReviewCommentDetail
            comment={selectedComment}
            pending={resolveMutation.isPending}
            onResolve={() => resolveComment(selectedComment)}
          />
        )}
        {selectedSurveyReview && (
          <SurveyFlowReviewDetail review={selectedSurveyReview} />
        )}
        {selectedReviewReceipt && (
          <IndependentReviewReceiptDetail
            receipt={selectedReviewReceipt}
            focused={
              receiptTarget?.projectSlug ===
                selectedReviewReceipt.target.projectSlug &&
              receiptTarget.receiptId === selectedReviewReceipt.receiptId
            }
          />
        )}
      </SplitPaneLayout>

      <ConfirmModal
        isOpen={bulkAction !== null}
        title={
          bulkAction === 'approve'
            ? 'Approve pending changes'
            : 'Reject pending changes'
        }
        message={`Apply this decision to ${pendingIds.length} pending proposed change${pendingIds.length === 1 ? '' : 's'}?`}
        confirmLabel={bulkAction === 'approve' ? 'Approve All' : 'Reject All'}
        variant={bulkAction === 'reject' ? 'danger' : 'warning'}
        onConfirm={confirmBulk}
        onCancel={() => setBulkAction(null)}
      />
      <IndependentReviewRunModal
        isOpen={reviewRunOpen}
        onClose={() => setReviewRunOpen(false)}
        onCompleted={(receiptId, projectSlug) => {
          setReviewRunOpen(false);
          setSelectedId(reviewEvidenceItemId(projectSlug, receiptId));
        }}
      />
    </div>
  );
}

function IndependentReviewRunModal({
  isOpen,
  onClose,
  onCompleted,
}: {
  isOpen: boolean;
  onClose: () => void;
  onCompleted: (receiptId: string, projectSlug: string) => void;
}) {
  const titleId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const { data: projectData = [] } = useProjectsQuery();
  const { data: agentData = [] } = useAgentsQuery();
  const projects = projectData as Array<{ slug: string; name?: string }>;
  const agents = agentData as Array<{ slug: string }>;
  const mutation = useRunIndependentReviewMutation();
  const [mode, setMode] = useState<'initial' | 'delta'>('initial');
  const [projectSlug, setProjectSlug] = useState('');
  const [baseRevision, setBaseRevision] = useState('origin/main');
  const [headRevision, setHeadRevision] = useState('HEAD');
  const [implementerAgentSlug, setImplementerAgentSlug] = useState('station');
  const [executorAgentSlugs, setExecutorAgentSlugs] = useState('');
  const [lensId, setLensId] = useState('architecture');
  const [lensInstructions, setLensInstructions] = useState(
    'Review placement, reachability, failure totality, and compatibility.',
  );
  const [priorReceiptId, setPriorReceiptId] = useState('');
  const [claimedFindingIds, setClaimedFindingIds] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectSlug && projects[0]?.slug) setProjectSlug(projects[0].slug);
  }, [projectSlug, projects]);

  if (!isOpen) return null;

  function submit() {
    const agentSlugs = commaList(executorAgentSlugs);
    if (
      !projectSlug ||
      !implementerAgentSlug.trim() ||
      agentSlugs.length === 0
    ) {
      setValidationError(
        'Project, implementing Agent, and reviewer Agents are required.',
      );
      return;
    }
    if (new Set(agentSlugs).size !== agentSlugs.length) {
      setValidationError(
        'Every independent reviewer must use a distinct Agent.',
      );
      return;
    }
    const deltaFindingIds = commaList(claimedFindingIds);
    if (
      mode === 'delta' &&
      (!priorReceiptId.trim() || deltaFindingIds.length === 0)
    ) {
      setValidationError(
        'Delta reviews require a prior receipt and finding IDs.',
      );
      return;
    }
    setValidationError(null);
    const request: IndependentReviewRequest = {
      requestId: crypto.randomUUID(),
      mode,
      target: {
        kind: 'git-range',
        projectSlug,
        baseRevision: baseRevision.trim(),
        headRevision: headRevision.trim(),
      },
      implementerAgentSlug: implementerAgentSlug.trim(),
      reviewers: agentSlugs.map((agentSlug, index) => ({
        reviewerId: `reviewer-${index + 1}`,
        executorAgentSlug: agentSlug,
        lens: { id: lensId.trim(), instructions: lensInstructions.trim() },
      })),
      ...(mode === 'delta'
        ? {
            delta: {
              priorReceiptId: priorReceiptId.trim(),
              claimedFindingIds: deltaFindingIds,
            },
          }
        : {}),
    };
    mutation.mutate(request, {
      onSuccess: (result) =>
        onCompleted(
          result.receipt.receiptId,
          result.receipt.target.projectSlug,
        ),
    });
  }

  return createPortal(
    <ResponsiveDialogSurface
      onClose={onClose}
      ariaLabelledBy={titleId}
      overlayClassName="modal-overlay"
      panelClassName="modal-dialog review-run-modal"
      initialFocusRef={cancelRef}
      initialFocusPolicy="always"
      historyMode="none"
    >
      <div className="modal-header">
        <h3 id={titleId}>Run independent review</h3>
      </div>
      <div className="modal-body review-run-modal__fields">
        <label>
          Project
          <select
            value={projectSlug}
            onChange={(event) => setProjectSlug(event.target.value)}
          >
            <option value="">Select a project</option>
            {projects.map((project) => (
              <option key={project.slug} value={project.slug}>
                {project.name ?? project.slug}
              </option>
            ))}
          </select>
        </label>
        <label>
          Mode
          <select
            value={mode}
            onChange={(event) =>
              setMode(event.target.value as 'initial' | 'delta')
            }
          >
            <option value="initial">Initial review</option>
            <option value="delta">Delta review</option>
          </select>
        </label>
        <label>
          Base revision
          <input
            value={baseRevision}
            onChange={(event) => setBaseRevision(event.target.value)}
          />
        </label>
        <label>
          Head revision
          <input
            value={headRevision}
            onChange={(event) => setHeadRevision(event.target.value)}
          />
        </label>
        <label>
          Implementing Agent
          <select
            value={implementerAgentSlug}
            onChange={(event) => setImplementerAgentSlug(event.target.value)}
          >
            {agents.map((agent) => (
              <option key={agent.slug} value={agent.slug}>
                {agent.slug}
              </option>
            ))}
          </select>
        </label>
        <label>
          Reviewer Agent slugs
          <input
            list="review-run-agent-slugs"
            value={executorAgentSlugs}
            onChange={(event) => setExecutorAgentSlugs(event.target.value)}
            placeholder="reviewer-one, reviewer-two"
          />
          <datalist id="review-run-agent-slugs">
            {agents.map((agent) => (
              <option key={agent.slug} value={agent.slug} />
            ))}
          </datalist>
        </label>
        <label>
          Lens ID
          <input
            value={lensId}
            onChange={(event) => setLensId(event.target.value)}
          />
        </label>
        <label>
          Lens instructions
          <textarea
            value={lensInstructions}
            onChange={(event) => setLensInstructions(event.target.value)}
          />
        </label>
        {mode === 'delta' ? (
          <>
            <label>
              Prior receipt ID
              <input
                value={priorReceiptId}
                onChange={(event) => setPriorReceiptId(event.target.value)}
              />
            </label>
            <label>
              Claimed finding IDs
              <textarea
                value={claimedFindingIds}
                onChange={(event) => setClaimedFindingIds(event.target.value)}
                placeholder="finding ID, finding ID"
              />
            </label>
          </>
        ) : null}
        <p className="review-run-modal__truth">
          Findings are recorded as evidence input. They do not approve, reject,
          or satisfy a gate.
        </p>
        {validationError ? <p role="alert">{validationError}</p> : null}
        {mutation.isError ? (
          <p role="alert">The independent review could not be completed.</p>
        ) : null}
      </div>
      <ResponsiveSurfaceActions className="modal-footer">
        <Button ref={cancelRef} variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={mutation.isPending} onClick={submit}>
          {mutation.isPending ? 'Reviewing…' : 'Run review'}
        </Button>
      </ResponsiveSurfaceActions>
    </ResponsiveDialogSurface>,
    document.body,
  );
}

function commaList(value: string): string[] {
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function IndependentReviewReceiptDetail({
  receipt,
  focused = false,
}: {
  receipt: IndependentReviewReceipt;
  focused?: boolean;
}) {
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) detailRef.current?.focus();
  }, [focused]);
  return (
    <section
      ref={detailRef}
      className="review-queue-detail"
      data-testid="independent-review-receipt-detail"
      tabIndex={focused ? -1 : undefined}
    >
      <header className="review-queue-detail__header">
        <div>
          <p className="review-queue-detail__eyebrow">
            Independent review evidence · input only
          </p>
          <h3>{receipt.target.projectSlug}</h3>
          <p>
            {receipt.target.baseSha.slice(0, 12)} →{' '}
            {receipt.target.headSha.slice(0, 12)}
          </p>
        </div>
      </header>
      <div className="review-queue-detail__meta">
        <span>{receipt.executions.length} reviewers</span>
        <span>{receipt.findings.length} findings</span>
        <span>{new Date(receipt.completedAt).toLocaleString()}</span>
      </div>
      <p>
        These findings are reviewer-authored evidence for verification. This
        receipt does not approve, reject, or satisfy a gate.
      </p>
      <section aria-label="Reviewer execution status">
        <h3>Reviewer execution</h3>
        <ul>
          {receipt.executions.map((execution) => (
            <li key={execution.reviewerId}>
              {execution.actor.displayName ?? execution.actor.actorId}:{' '}
              {execution.status}
              {execution.failureReason ? ` — ${execution.failureReason}` : ''}
            </li>
          ))}
        </ul>
      </section>
      {receipt.findings.length === 0 &&
      receipt.executions.every(
        (execution) => execution.status === 'completed',
      ) ? (
        <p>All reviewers completed; no concrete findings were recorded.</p>
      ) : receipt.findings.length === 0 ? (
        <p>
          Review evidence is incomplete. No findings can be interpreted as a
          clean review until every reviewer completes successfully.
        </p>
      ) : (
        receipt.findings.map((finding) => (
          <article
            className="review-comment-detail__body"
            key={finding.findingId}
          >
            <h3>{finding.summary}</h3>
            <p>
              {finding.location.file}:{finding.location.line} ·{' '}
              {finding.severity} · {finding.confidence} confidence ·{' '}
              {finding.basis}
            </p>
            <p>
              <strong>Trigger:</strong> {finding.scenario.stateOrInput}
            </p>
            <p>
              <strong>Wrong outcome:</strong> {finding.scenario.wrongOutcome}
            </p>
          </article>
        ))
      )}
    </section>
  );
}

function SurveyFlowReviewDetail({
  review,
}: {
  review: SurveyFlowReviewItemVM;
}) {
  return (
    <section
      className="review-queue-detail"
      data-testid="survey-flow-review-detail"
    >
      <header className="review-queue-detail__header">
        <div>
          <p className="review-queue-detail__eyebrow">Survey Flow gate</p>
          <h3>{review.sessionName}</h3>
          <p>{review.workflowSubjectRef}</p>
        </div>
      </header>
      <div className="review-queue-detail__meta">
        <span>Project {review.projectSlug}</span>
        <span>{review.summary.unresolved} unresolved</span>
        <span>Source {review.projectionSource}</span>
      </div>
      {review.items.map((item) => (
        <article className="review-comment-detail__body" key={item.target}>
          <h3>{item.targetLabel}</h3>
          <p>{item.statusLabel}</p>
          <ul>
            {item.candidates.map((candidate) => (
              <li key={`${candidate.roleLabel}:${candidate.valueText}`}>
                {candidate.roleLabel}: {candidate.valueText} ·{' '}
                {candidate.sourceText}
              </li>
            ))}
          </ul>
        </article>
      ))}
    </section>
  );
}

function ReviewQueueDetail({
  change,
  pending,
  onApprove,
  onReject,
}: {
  change: ProposedChange;
  pending: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  return (
    <section className="review-queue-detail" data-testid="review-queue-detail">
      <header className="review-queue-detail__header">
        <div>
          <p className="review-queue-detail__eyebrow">{change.contentKind}</p>
          <h3>{change.path}</h3>
          <p>
            {change.changeType} from {change.sourceRuntime} in session{' '}
            {change.sessionId}
          </p>
        </div>
        <div className="review-queue-detail__actions">
          <Button variant="secondary" disabled={pending} onClick={onApprove}>
            Approve
          </Button>
          <Button
            variant="danger-outline"
            disabled={pending}
            onClick={onReject}
          >
            Reject
          </Button>
        </div>
      </header>

      <div className="review-queue-detail__meta">
        <span>Project {change.projectId}</span>
        <span>Created {new Date(change.createdAt).toLocaleString()}</span>
        <span>Status {change.status}</span>
      </div>

      <div className="review-queue-diff" data-kind={change.contentKind}>
        <SnapshotPanel
          label="Before"
          content={change.baseSnapshot?.content ?? ''}
        />
        <SnapshotPanel
          label="After"
          content={change.proposedSnapshot?.content ?? ''}
        />
      </div>
    </section>
  );
}

function ReviewCommentDetail({
  comment,
  pending,
  onResolve,
}: {
  comment: DiffComment;
  pending: boolean;
  onResolve: () => void;
}) {
  const { setLayout } = useNavigation();
// Resolve the comment's project coding layout so the reviewer can jump from
// the queue straight into the workspace for that file. The comment only
// carries a projectId, so the coding layout slug is looked up from the
// project's layouts (type === 'coding'); the action is hidden when the
// project has no coding layout rather than navigating nowhere.
  const { data: layouts = [] } = useProjectLayoutsQuery(comment.projectId);
  const codingLayout = (layouts as LayoutConfig[]).find(
    (layout) => layout.type === 'coding',
  );

  return (
    <section
      className="review-queue-detail"
      data-testid="review-comment-detail"
    >
      <header className="review-queue-detail__header">
        <div>
          <p className="review-queue-detail__eyebrow">Review comment</p>
          <h3>{comment.filePath}</h3>
          <p>
            {comment.side} · line {comment.lineNumber} · {comment.projectId}
          </p>
        </div>
        <div className="review-queue-detail__actions">
          {codingLayout && (
// Jump to the comment's Project coding workspace with its exact,
// inclusive one-line File Preview intent.
            <Button
              variant="secondary"
              onClick={() =>
                setLayout(comment.projectId, codingLayout.slug, {
                  openFilePreviewIntent: {
                    projectSlug: comment.projectId,
                    path: comment.filePath,
                    lineRange: {
                      start: comment.lineNumber,
                      end: comment.lineNumber,
                    },
                  },
                })
              }
            >
              Open in coding
            </Button>
          )}
          <Button variant="secondary" disabled={pending} onClick={onResolve}>
            Resolve
          </Button>
        </div>
      </header>

      <div className="review-queue-detail__meta">
        <span>Project {comment.projectId}</span>
        <span>Created {new Date(comment.createdAt).toLocaleString()}</span>
      </div>

      <div className="review-comment-detail__body">
        <p>{comment.body}</p>
      </div>
    </section>
  );
}

function SnapshotPanel({ label, content }: { label: string; content: string }) {
  return (
    <div className="review-queue-diff__panel">
      <div className="review-queue-diff__label">{label}</div>
      <pre>{content || 'No snapshot content'}</pre>
    </div>
  );
}
