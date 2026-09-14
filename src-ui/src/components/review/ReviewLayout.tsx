import {
  useBulkApproveProposedChangesMutation,
  useBulkRejectProposedChangesMutation,
  useProposedChangesQuery,
  useReviewEvidenceQuery,
  useSurveyFlowReviewsQuery,
} from '@kontourai/station-sdk';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../Button';
import { CheckGlyph } from '../icons/Glyph';
import { ConfirmModal } from '../modals/ConfirmModal';
import { SplitPaneLayout } from '../SplitPaneLayout';
import { IndependentReviewReceiptDetail } from './IndependentReviewReceiptDetail';
import { IndependentReviewRunModal } from './IndependentReviewRunModal';
import { ProposedChangeDetail } from './ProposedChangeDetail';
import { useProposedChangeDecision } from './proposedChangeDecision';
import {
  REVIEW_UNAVAILABLE_REASON_COPY,
  SURVEY_UNAVAILABLE_REASON_COPY,
} from './reviewEvidenceCopy';
import { SurveyFlowReviewDetail } from './SurveyFlowReviewDetail';
import './review-detail.css';

type BulkAction = 'approve' | 'reject' | null;

/** Namespaced so a survey ref or receipt id can never collide with a change id. */
const SURVEY_PREFIX = 'survey:';
const REVIEW_EVIDENCE_PREFIX = 'evidence:';

/** The surface name recorded on a decision made here. See `proposedChangeDecision`. */
const REVIEW_LAYOUT_SURFACE = 'review layout';

function reviewEvidenceItemId(receiptId: string): string {
  return `${REVIEW_EVIDENCE_PREFIX}${encodeURIComponent(receiptId)}`;
}

/**
 * Which item the URL names, if any. The three params are the three deep links
 * the retired `/review-queue` accepted, re-pointed at this layout by
 * `getLegacyPathRedirect` and emitted directly by the inbox and starter-work
 * producers.
 *
 * Returns the list item id, or `null` when the params name nothing. It never
 * falls back to a different item: a stale link renders the notice below rather
 * than opening someone else's change.
 */
function deepLinkSelection(search: string): string | null {
  const params = new URLSearchParams(search);
  const receiptId = params.get('receipt');
  if (receiptId) return reviewEvidenceItemId(receiptId);
  const changeId = params.get('change');
  if (changeId) return changeId;
  const reviewSessionRef = params.get('review');
  return reviewSessionRef ? `${SURVEY_PREFIX}${reviewSessionRef}` : null;
}

/**
 * #2065 (D4): Review is a layout kind a project places, backed by the Survey
 * review workbench. It is scoped to ONE project — the layout's owner — which
 * is the difference that matters against the global queue it replaces: a bulk
 * decision here applies to this project's pending changes, never to every
 * project's at once.
 *
 * The attention inbox carries the decision rows (proposed changes and paused
 * gates) and links in here for the detail a decision needs: the before/after
 * snapshots, and a gate session's candidate sets.
 */
export function ReviewLayout({
  projectSlug,
}: {
  projectSlug: string;
  layoutSlug: string;
  config: Record<string, unknown>;
}) {
  const [search, setSearch] = useState('');
  const [deepLink, setDeepLink] = useState(() =>
    deepLinkSelection(window.location.search),
  );
  const [selectedId, setSelectedId] = useState<string | null>(deepLink);
  const [bulkAction, setBulkAction] = useState<BulkAction>(null);
  const [reviewRunOpen, setReviewRunOpen] = useState(false);
  useEffect(() => {
    const sync = () => {
      const target = deepLinkSelection(window.location.search);
      setDeepLink(target);
      if (target) setSelectedId(target);
    };
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);

  const {
    data: allChanges = [],
    isLoading,
    isError: changesError,
  } = useProposedChangesQuery({ status: ['pending'] });
  const {
    data: surveyFlowReviews,
    isLoading: surveyLoading,
    isError: surveyError,
  } = useSurveyFlowReviewsQuery();
  const {
    data: reviewEvidence,
    isLoading: reviewEvidenceLoading,
    isError: reviewEvidenceError,
  } = useReviewEvidenceQuery();

  // Every source Station has is a cross-project aggregate. This layout is
  // owned by one project, so each is narrowed to its owner here rather than
  // rendering another project's work under this project's name.
  const changes = useMemo(
    () => allChanges.filter((change) => change.projectId === projectSlug),
    [allChanges, projectSlug],
  );
  const surveyReviews = (surveyFlowReviews?.items ?? []).filter(
    (review) => review.projectSlug === projectSlug,
  );
  const unavailableSurveyProjects = (
    surveyFlowReviews?.unavailableProjects ?? []
  ).filter((project) => project.projectSlug === projectSlug);
  const reviewReceipts = (reviewEvidence?.receipts ?? []).filter(
    (receipt) => receipt.target.projectSlug === projectSlug,
  );
  const unavailableReviewProjects = (
    reviewEvidence?.unavailableProjects ?? []
  ).filter((project) => project.projectSlug === projectSlug);

  // A failed source must never read as an empty queue: `data = []` on error
  // would render "Nothing to review" — absence-as-success on the one surface
  // whose job is making pending decisions visible. Scoped per source so one
  // failing fetch does not paint the others as broken.
  const failedSources = [
    changesError ? 'proposed changes' : null,
    surveyError ? 'flow reviews' : null,
    reviewEvidenceError ? 'independent review evidence' : null,
  ].filter((source): source is string => source !== null);
  // A partial result is not a failed source — the source DID load — so it gets
  // its own copy naming the reason, because the remedy differs.
  const partialNotices = [
    !surveyError && unavailableSurveyProjects.length > 0
      ? `Flow reviews are unavailable for ${projectSlug} (${unavailableSurveyProjects.map((project) => SURVEY_UNAVAILABLE_REASON_COPY[project.reason]).join(', ')}).`
      : null,
    !reviewEvidenceError && unavailableReviewProjects.length > 0
      ? `Independent review evidence is unavailable for ${projectSlug} (${unavailableReviewProjects.map((project) => REVIEW_UNAVAILABLE_REASON_COPY[project.reason]).join(', ')}).`
      : null,
  ];
  const sourceNotices = [
    failedSources.length > 0
      ? `Failed to load: ${failedSources.join(', ')}. Items may be pending that are not shown.`
      : null,
    ...partialNotices,
  ].filter((notice): notice is string => notice !== null);

  const changeDecision = useProposedChangeDecision(REVIEW_LAYOUT_SURFACE);
  const bulkApproveMutation = useBulkApproveProposedChangesMutation();
  const bulkRejectMutation = useBulkRejectProposedChangesMutation();

  const query = search.trim().toLowerCase();

  const items = useMemo(() => {
    const keepDeepLinked = (id: string) => id === deepLink;
    const matches = (fields: readonly string[]) =>
      !query || fields.join(' ').toLowerCase().includes(query);
    return [
      ...changes
        .filter(
          (change) =>
            keepDeepLinked(change.id) ||
            matches([change.path, change.sessionId, change.sourceRuntime]),
        )
        .map((change) => ({
          id: change.id,
          name: change.path,
          subtitle: `${change.sourceRuntime} | ${change.contentKind}`,
          section: 'Proposed changes',
        })),
      ...surveyReviews
        .filter(
          (review) =>
            keepDeepLinked(`${SURVEY_PREFIX}${review.reviewSessionRef}`) ||
            matches([review.sessionName, review.workflowSubjectRef]),
        )
        .map((review) => ({
          id: `${SURVEY_PREFIX}${review.reviewSessionRef}`,
          name: review.sessionName,
          subtitle: `${review.pendingDecisions} awaiting a decision · ${review.workflowSubjectRef}`,
          section: 'Flow reviews',
        })),
      ...reviewReceipts
        .filter(
          (receipt) =>
            keepDeepLinked(reviewEvidenceItemId(receipt.receiptId)) ||
            matches([
              receipt.receiptId,
              receipt.mode,
              ...receipt.findings.map((finding) => finding.summary),
            ]),
        )
        .map((receipt) => ({
          id: reviewEvidenceItemId(receipt.receiptId),
          name: `${receipt.findings.length} independent finding${receipt.findings.length === 1 ? '' : 's'}`,
          subtitle: `${receipt.mode} · ${receipt.target.baseSha.slice(0, 8)}..${receipt.target.headSha.slice(0, 8)}`,
          section: 'Independent reviews',
        })),
    ];
  }, [changes, deepLink, query, reviewReceipts, surveyReviews]);

  const selectedChange = changes.find((change) => change.id === selectedId);
  const selectedSurveyReview = selectedId?.startsWith(SURVEY_PREFIX)
    ? surveyReviews.find(
        (review) => `${SURVEY_PREFIX}${review.reviewSessionRef}` === selectedId,
      )
    : undefined;
  const selectedReceipt = selectedId?.startsWith(REVIEW_EVIDENCE_PREFIX)
    ? reviewReceipts.find(
        (receipt) => reviewEvidenceItemId(receipt.receiptId) === selectedId,
      )
    : undefined;

  const loading = isLoading || surveyLoading || reviewEvidenceLoading;
  /**
   * Whether the deep-linked item is still in its SOURCE — the unfiltered
   * project-scoped lists, never the search-narrowed `items`. Keying the notice
   * on the narrowed list would make typing in the search box announce that a
   * still-pending change had been decided.
   *
   * Gated on the sources having loaded AND not errored: a failed fetch
   * defaults its list to `[]`, so without the gate this announced "no longer
   * pending" for an item that is pending and simply could not be read.
   */
  const deepLinkMissing =
    deepLink !== null &&
    !loading &&
    failedSources.length === 0 &&
    !selectedChange &&
    !selectedSurveyReview &&
    !selectedReceipt &&
    selectedId === deepLink;

  const pendingIds = changes.map((change) => change.id);
  const bulkPending =
    bulkApproveMutation.isPending || bulkRejectMutation.isPending;

  function confirmBulk() {
    if (!bulkAction || pendingIds.length === 0) return;
    const input = {
      ids: pendingIds,
      reason: `${bulkAction === 'approve' ? 'Bulk approved' : 'Bulk rejected'} from the ${projectSlug} review layout`,
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
    <div className="pane-host" data-first-run-anchor="review">
      {deepLinkMissing && (
        <p role="status">
          That review item is no longer pending in {projectSlug}, and Station
          won’t open a different one in its place.
        </p>
      )}
      <SplitPaneLayout
        label="review"
        title="Review"
        subtitle={`Pending changes, paused gate reviews, and review evidence for ${projectSlug}`}
        items={items}
        loading={loading}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onDeselect={() => setSelectedId(null)}
        onSearch={setSearch}
        searchValue={search}
        listFilteredEmptyNoun="review items"
        // The three sources are each independently empty; the collection as a
        // whole is empty only when ALL of them are, which is exactly when a
        // typed search should not be blamed for the empty list.
        collectionEmpty={
          changes.length === 0 &&
          surveyReviews.length === 0 &&
          reviewReceipts.length === 0
        }
        searchPlaceholder="Search changes, gate reviews, and evidence..."
        listEmptyTitle={
          sourceNotices.length > 0
            ? 'Some reviews could not load'
            : 'Nothing to review'
        }
        listEmptyDescription={
          sourceNotices.length > 0
            ? sourceNotices.join(' ')
            : 'Proposals awaiting approval, paused gate reviews, and independent review receipts for this Project appear here.'
        }
        emptyIcon={<CheckGlyph />}
        emptyTitle="Select an item"
        emptyDescription="Decide a proposed change, read a paused gate review, or open a review receipt."
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
              // Present with or without items: a partial failure while other
              // sections still render must not be invisible.
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
          <ProposedChangeDetail
            change={selectedChange}
            pending={changeDecision.pending}
            onApprove={() => changeDecision.decide(selectedChange.id, 'approve')}
            onReject={() => changeDecision.decide(selectedChange.id, 'reject')}
          />
        )}
        {selectedSurveyReview && (
          <SurveyFlowReviewDetail review={selectedSurveyReview} />
        )}
        {selectedReceipt && (
          <IndependentReviewReceiptDetail
            receipt={selectedReceipt}
            focused={reviewEvidenceItemId(selectedReceipt.receiptId) === deepLink}
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
        message={`Apply this decision to ${pendingIds.length} pending proposed change${pendingIds.length === 1 ? '' : 's'} in ${projectSlug}?`}
        confirmLabel={bulkAction === 'approve' ? 'Approve All' : 'Reject All'}
        variant={bulkAction === 'reject' ? 'danger' : 'warning'}
        onConfirm={confirmBulk}
        onCancel={() => setBulkAction(null)}
      />
      <IndependentReviewRunModal
        isOpen={reviewRunOpen}
        onClose={() => setReviewRunOpen(false)}
        // This layout is owned by one project, so the form's project picker
        // would be a second, contradictable answer to a question the host has
        // already answered.
        lockedProjectSlug={projectSlug}
        onCompleted={(receiptId) => {
          setReviewRunOpen(false);
          setSelectedId(reviewEvidenceItemId(receiptId));
        }}
      />
    </div>
  );
}
