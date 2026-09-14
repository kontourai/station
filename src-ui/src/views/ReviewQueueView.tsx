import type { DiffComment } from '@kontourai/station-contracts/diff-comment';
import type { LayoutConfig } from '@kontourai/station-contracts/layout';
import type { ProposedChange } from '@kontourai/station-contracts/proposed-change';
import {
  type SurveyFlowReviewItemVM,
  type SurveyFlowReviewUnavailableReason,
  useAllDiffCommentsQuery,
  useBulkApproveProposedChangesMutation,
  useBulkRejectProposedChangesMutation,
  useProjectLayoutsQuery,
  useProposedChangesQuery,
  useResolveDiffCommentMutation,
  useReviewEvidenceQuery,
  useSurveyFlowReviewsQuery,
} from '@kontourai/station-sdk';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../components/Button';
import { CheckGlyph } from '../components/icons/Glyph';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import { IndependentReviewReceiptDetail } from '../components/review/IndependentReviewReceiptDetail';
import { IndependentReviewRunModal } from '../components/review/IndependentReviewRunModal';
import { useProposedChangeDecision } from '../components/review/proposedChangeDecision';
import { REVIEW_UNAVAILABLE_REASON_COPY } from '../components/review/reviewEvidenceCopy';
import { SplitPaneLayout } from '../components/SplitPaneLayout';
import { useNavigation } from '../contexts/NavigationContext';
import './ReviewQueueView.css';
import './page-layout.css';

type BulkAction = 'approve' | 'reject' | null;

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

/** The surface name recorded on a decision made here. See `proposedChangeDecision`. */
const REVIEW_QUEUE_SURFACE = 'review queue';

/**
 * #2064 (D4): Review stays routed this slice, and the attention inbox's rows
 * link INTO it — a proposed change by id, a paused gate review by its session
 * ref. Without this the inbox's "open" landed on the list and asked the user
 * to find the row again, which is the same "opens somewhere, not at the
 * thing" failure the receipt deep link above was added to fix.
 *
 * Returns the list item id the params name, or `null` when they name nothing.
 * It never falls back to a different item: a stale link shows the notice
 * below rather than opening someone else's change.
 */
function inboxDeepLinkSelection(): string | null {
  const params = new URLSearchParams(window.location.search);
  const changeId = params.get('change');
  if (changeId) return changeId;
  const reviewSessionRef = params.get('review');
  return reviewSessionRef ? `${SURVEY_PREFIX}${reviewSessionRef}` : null;
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
  const [inboxTarget, setInboxTarget] = useState(inboxDeepLinkSelection);
  const [selectedId, setSelectedId] = useState<string | null>(() =>
    receiptTarget
      ? reviewEvidenceItemId(receiptTarget.projectSlug, receiptTarget.receiptId)
      : inboxDeepLinkSelection(),
  );
  const [bulkAction, setBulkAction] = useState<BulkAction>(null);
  const [reviewRunOpen, setReviewRunOpen] = useState(false);
  useEffect(() => {
    const sync = () => {
      const target = receiptDeepLink();
      setReceiptTarget(target);
      if (target) {
        setSelectedId(
          reviewEvidenceItemId(target.projectSlug, target.receiptId),
        );
        return;
      }
      const inbox = inboxDeepLinkSelection();
      setInboxTarget(inbox);
      if (inbox) setSelectedId(inbox);
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
  const changeDecision = useProposedChangeDecision(REVIEW_QUEUE_SURFACE);
  const bulkApproveMutation = useBulkApproveProposedChangesMutation();
  const bulkRejectMutation = useBulkRejectProposedChangesMutation();
  const deleteCommentMutation = useResolveDiffCommentMutation();

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
        subtitle: `${review.pendingDecisions} awaiting a decision · ${review.workflowSubjectRef}`,
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
  /**
   * Whether the inbox's deep-linked item is still in its SOURCE — the
   * unfiltered `changes`/`surveyReviews`, never the search-narrowed `items`.
   * Keying the notice on the narrowed list would make typing in the search box
   * announce that a still-pending change had been decided.
   */
  const inboxTargetExists = inboxTarget
    ? changes.some((change) => change.id === inboxTarget) ||
      surveyReviews.some(
        (review) =>
          `${SURVEY_PREFIX}${review.reviewSessionRef}` === inboxTarget,
      )
    : true;
  const pendingIds = changes.map((change) => change.id);
  const bulkPending =
    bulkApproveMutation.isPending || bulkRejectMutation.isPending;

  /**
   * #2064 product decision (b): this DELETES the comment.
   * `useResolveDiffCommentMutation` calls
   * `DELETE /api/projects/:slug/diff-comments/:id`, and
   * `DiffCommentService.delete` removes the record — `DiffComment` has no
   * resolved state to move it into. The button said "Resolve", which is a
   * label nothing derives; the diff pane's own control for the same call has
   * always said "Delete". The copy here now matches the call rather than a
   * state the data does not have.
   */
  function deleteComment(comment: DiffComment) {
    deleteCommentMutation.mutate(
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
      {/* #2064 review LOW-3: a FAILED fetch defaults `changes`/`surveyReviews`
          to [], so without the error gate this announced "no longer pending"
          for an item that is pending and simply could not be read — the
          sourceNotices alert beside it is what that state really means. */}
      {inboxTarget &&
        !isLoading &&
        !surveyLoading &&
        !changesError &&
        !surveyError &&
        !inboxTargetExists && (
          <p role="status">
            That review item is no longer pending, and Station won’t open a
            different one in its place.
          </p>
        )}
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
        // #765 F3c: a bare letter "R" read as a broken glyph; the check
        // echoes the sidebar's Review icon, like the sibling views' glyphs.
        emptyIcon={<CheckGlyph />}
        emptyTitle="Select an item"
        emptyDescription="Review a proposed change, or read and delete a diff comment."
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
            pending={changeDecision.pending}
            onApprove={() =>
              changeDecision.decide(selectedChange.id, 'approve')
            }
            onReject={() => changeDecision.decide(selectedChange.id, 'reject')}
          />
        )}
        {selectedComment && (
          <ReviewCommentDetail
            comment={selectedComment}
            pending={deleteCommentMutation.isPending}
            onDelete={() => deleteComment(selectedComment)}
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
        {/* #2064 review MED-2: what the run is waiting for. `summary.unresolved`
            reads 0 for a session whose remaining items are all escalated. */}
        <span>{review.pendingDecisions} awaiting a decision</span>
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
  onDelete,
}: {
  comment: DiffComment;
  pending: boolean;
  /** See `deleteComment` — the call removes the record; the label says so. */
  onDelete: () => void;
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
          <Button variant="secondary" disabled={pending} onClick={onDelete}>
            Delete
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
