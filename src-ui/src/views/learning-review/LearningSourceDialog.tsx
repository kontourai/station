import { useLearningSourceObservationQuery } from '@kontourai/station-sdk';
import type { LearningSourceReference } from '@kontourai/station-sdk/client';
import { Button } from '../../components/Button';
import {
  ResponsiveDialogHeader,
  ResponsiveDialogSurface,
  ResponsiveSurfaceActions,
} from '../../components/ResponsiveDialogSurface';
import {
  describeReadFailure,
  ErrorState,
  SkeletonList,
} from '../../components/state';
import type { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import './LearningSourceDialog.css';

type Authority = NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
const gaps: Record<string, string> = {
  restricted:
    'Source inspection requires current local access to this personal store. The source is not disclosed.',
  unsupported: 'This store does not support source-only inspection.',
  missing: 'The selected source record is no longer available.',
  busy: 'The store is changing. Retry after its current operation finishes.',
  corrupt: 'The source could not be verified. No repair was attempted.',
  unavailable: 'The source is unavailable. No source content was returned.',
  'invalid-input': 'The source reference is invalid.',
  'over-budget': 'The source exceeds the inspection budget.',
};
export function LearningSourceDialog({
  reference,
  authority,
  onClose,
}: {
  reference: LearningSourceReference;
  authority: Authority;
  onClose: () => void;
}) {
  const current = authority.isCurrent();
  const query = useLearningSourceObservationQuery(
    reference,
    authority,
    current,
  );
  const observed =
    current && query.data?.state === 'observed' ? query.data : undefined;
  return (
    <ResponsiveDialogSurface
      ariaLabel="Learning source"
      onClose={onClose}
      overlayClassName="learning-source-overlay"
      panelClassName="learning-source-dialog"
    >
      <ResponsiveDialogHeader
        title="Learning source"
        closeLabel="Close learning source"
        onClose={onClose}
      />
      <div className="learning-source-body">
        {!current ? (
          <ErrorState
            variant="compact"
            title="Station authorization changed. Close and inspect the source again."
          />
        ) : query.isError ? (
          <ErrorState
            variant="compact"
            title="Couldn't inspect the source"
            description={describeReadFailure(query.error)}
            action={
              <Button onClick={() => void query.refetch()}>
                Retry inspection
              </Button>
            }
          />
        ) : query.isLoading ? (
          <SkeletonList count={3} label="Checking the exact learning source" />
        ) : observed ? (
          <>
            <p className="learning-source-label">Source only</p>
            <h3>{observed.source.title}</h3>
            <p>
              This record does not supply a learning candidate, decision,
              activation, or effect receipt. Its record status does not mean a
              learning is active.
            </p>
            <dl className="learning-source-facts">
              <dt>Record type</dt>
              <dd>{observed.source.type}</dd>
              <dt>Record status</dt>
              <dd>{observed.source.status ?? 'Not supplied'}</dd>
              <dt>Category</dt>
              <dd>{observed.source.category}</dd>
              <dt>Source freshness</dt>
              <dd>Unknown</dd>
              <dt>Owner revision</dt>
              <dd>Unknown</dd>
              <dt>Observed</dt>
              <dd>{observed.observation.observedAt}</dd>
            </dl>
            <details open>
              <summary>Source content</summary>
              <pre className="learning-source-content">
                {observed.source.body}
              </pre>
            </details>
            <details>
              <summary>Exact source and provenance</summary>
              <dl className="learning-source-facts">
                <dt>Store</dt>
                <dd>{observed.source.rootId}</dd>
                <dt>Record</dt>
                <dd>{observed.source.recordId}</dd>
                <dt>Agent</dt>
                <dd>{observed.source.provenance.agent}</dd>
                {observed.source.provenance.session_id ? (
                  <>
                    <dt>Source session</dt>
                    <dd>{observed.source.provenance.session_id}</dd>
                  </>
                ) : null}
                {observed.source.provenance.note ? (
                  <>
                    <dt>Source note</dt>
                    <dd>{observed.source.provenance.note}</dd>
                  </>
                ) : null}
                {observed.source.provenance.source_ids?.length ? (
                  <>
                    <dt>Declared source IDs</dt>
                    <dd>{observed.source.provenance.source_ids.join(', ')}</dd>
                  </>
                ) : null}
                <dt>Created</dt>
                <dd>{observed.source.created_at}</dd>
                <dt>Updated</dt>
                <dd>{observed.source.updated_at}</dd>
                <dt>Observed content digest</dt>
                <dd>
                  <code>{observed.observation.contentDigest}</code>
                </dd>
              </dl>
            </details>
            <p className="learning-source-disclosure">
              This is a non-atomic observation. Transaction state and owner
              revision are unknown; the digest identifies the bytes observed,
              not a learning revision.
            </p>
          </>
        ) : query.data ? (
          <p role="status">{gaps[query.data.state]}</p>
        ) : null}
      </div>
      <ResponsiveSurfaceActions className="learning-source-actions">
        {current ? (
          <Button
            variant="secondary"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Refresh source
          </Button>
        ) : null}
        <Button variant="primary" onClick={onClose}>
          Close
        </Button>
      </ResponsiveSurfaceActions>
    </ResponsiveDialogSurface>
  );
}
