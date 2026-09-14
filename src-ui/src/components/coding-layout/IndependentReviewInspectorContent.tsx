import { useReviewEvidenceQuery } from '@kontourai/station-sdk';
import { useState } from 'react';
import { Button } from '../Button';
import { LazyBoundary } from '../LazyBoundary';
import { IndependentReviewReceiptDetail } from '../review/IndependentReviewReceiptDetail';
import { REVIEW_UNAVAILABLE_REASON_COPY } from '../review/reviewEvidenceCopy';
import { Empty, SkeletonList } from '../state';

/**
 * #2064 (D4): independent-review receipts, and the action that produces them,
 * in the project's Coding layout — next to the Git range they judge, rather
 * than on a global page that mixed them with three unrelated review sources.
 *
 * Both halves are the SAME code the Review page runs
 * (`components/review/IndependentReviewRunModal`,
 * `components/review/IndependentReviewReceiptDetail`), extracted rather than
 * copied: the input-only framing, the distinct-reviewer validation, and the
 * "no findings is not clean unless every reviewer completed" branch are the
 * parts that must not diverge between two surfaces.
 *
 * The modal is loaded on demand. It pulls in the dialog surface, the project
 * and agent queries, and the whole request builder, none of which a reader
 * who never runs a review should pay for in the Coding layout's chunk.
 */
const loadRunModal = () =>
  import('../review/IndependentReviewRunModal').then((module) => ({
    default: module.IndependentReviewRunModal,
  }));

export function IndependentReviewInspectorContent({
  projectSlug,
}: {
  projectSlug: string;
}) {
  const { data, isLoading, isError } = useReviewEvidenceQuery();
  const [runOpen, setRunOpen] = useState(false);
  const [selectedReceiptId, setSelectedReceiptId] = useState<string | null>(
    null,
  );

  const receipts = (data?.receipts ?? []).filter(
    (receipt) => receipt.target.projectSlug === projectSlug,
  );
  // This project's own unavailability, not the aggregate's. A project Station
  // could not read has receipts it cannot show; rendering that as "no
  // receipts" would be the absence-as-success failure one level down.
  const unavailable = (data?.unavailableProjects ?? []).find(
    (entry) => entry.projectSlug === projectSlug,
  );
  const selectedReceipt =
    receipts.find((receipt) => receipt.receiptId === selectedReceiptId) ?? null;

  return (
    <div className="coding-inspector__reviews">
      <div className="coding-inspector__reviews-actions">
        <Button size="sm" variant="secondary" onClick={() => setRunOpen(true)}>
          Run independent review
        </Button>
      </div>
      {isError ? (
        <p role="alert">
          Independent review evidence could not be loaded. Receipts may exist
          that are not shown.
        </p>
      ) : null}
      {unavailable ? (
        <p role="alert">
          Independent review evidence for {projectSlug} is unavailable (
          {REVIEW_UNAVAILABLE_REASON_COPY[unavailable.reason]}).
        </p>
      ) : null}
      {isLoading ? (
        <SkeletonList count={2} label="Loading independent review evidence" />
      ) : selectedReceipt ? (
        <>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setSelectedReceiptId(null)}
          >
            Back to receipts
          </Button>
          <IndependentReviewReceiptDetail receipt={selectedReceipt} />
        </>
      ) : receipts.length === 0 && !unavailable && !isError ? (
        <Empty
          variant="compact"
          label="No independent reviews yet"
          description="Findings recorded here are evidence input for verification. They do not approve, reject, or satisfy a gate."
        />
      ) : (
        <ul className="coding-inspector__reviews-list">
          {receipts.map((receipt) => (
            <li key={receipt.receiptId}>
              <button
                type="button"
                onClick={() => setSelectedReceiptId(receipt.receiptId)}
              >
                {receipt.findings.length} independent finding
                {receipt.findings.length === 1 ? '' : 's'} · {receipt.mode} ·{' '}
                {receipt.target.baseSha.slice(0, 8)}..
                {receipt.target.headSha.slice(0, 8)}
              </button>
            </li>
          ))}
        </ul>
      )}
      {runOpen ? (
        <LazyBoundary
          load={loadRunModal}
          componentProps={{
            isOpen: true,
            lockedProjectSlug: projectSlug,
            onClose: () => setRunOpen(false),
            onCompleted: (receiptId: string) => {
              setRunOpen(false);
              setSelectedReceiptId(receiptId);
            },
          }}
          pending={<SkeletonList count={1} label="Opening review form" />}
        />
      ) : null}
    </div>
  );
}
