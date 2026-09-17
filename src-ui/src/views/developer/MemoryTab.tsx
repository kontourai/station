import {
  KnowledgeRecallBrowser,
  knowledgeRootIncarnationKey,
  useGlobalKnowledgeStatusQuery,
  useKnowledgeGraphQuery,
  useKnowledgeRootsQuery,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import {
  describeReadFailure,
  Empty,
  ErrorState,
  Skeleton,
} from '../../components/state';
import { Tabs, tabElementId, tabPanelElementId } from '../../components/Tabs';
import { LearningSourceAction } from '../learning-review/LearningSourceAction';

/** Groups this view's generated tab/panel ids — see `components/Tabs.tsx`. */
const TABS_ID = 'memory-knowledge-roots';

/**
 * Read-only recall surface over the configured memory stores: vector/graph
 * stats plus a canonical-record browser for the selected knowledge root. Heavy
 * (pulls the SDK's KnowledgeRecall subtree), so DeveloperView mounts it behind
 * its own lazy boundary.
 */
export default function MemoryTab() {
  const {
    data: roots = [],
    isLoading: rootsLoading,
    isError: rootsError,
    error: rootsFailure,
    refetch: refetchRoots,
  } = useKnowledgeRootsQuery();
  const { data: status, isError: statusUnavailable } =
    useGlobalKnowledgeStatusQuery();
  const [selectedRootId, setSelectedRootId] = useState<string | null>(null);

  const activeRoot =
    roots.find((root) => root.id === selectedRootId) ?? roots[0];
  const rootId = activeRoot?.id;
  const authorityKey = activeRoot
    ? knowledgeRootIncarnationKey(activeRoot)
    : '';
  const {
    data: graph,
    isLoading: graphLoading,
    isError: graphError,
    error: graphFailure,
    refetch: refetchGraph,
  } = useKnowledgeGraphQuery(rootId);

  const stats = status?.stats;

  return (
    <section className="developer-tab" aria-label="Memory">
      <p className="developer-tab__hint">
        Recall and canonical records from the configured memory stores.
      </p>

      {statusUnavailable && (
        <ErrorState
          variant="compact"
          title="Couldn't load knowledge store stats."
        />
      )}
      {stats ? (
        <dl className="developer-tab__stats" aria-label="Knowledge store stats">
          <div className="developer-tab__stat">
            <dt>Documents</dt>
            <dd>{stats.totalDocuments.toLocaleString()}</dd>
          </div>
          <div className="developer-tab__stat">
            <dt>Chunks</dt>
            <dd>{stats.totalChunks.toLocaleString()}</dd>
          </div>
          <div className="developer-tab__stat">
            <dt>Projects</dt>
            <dd>{stats.projectCount.toLocaleString()}</dd>
          </div>
        </dl>
      ) : null}

      {roots.length > 1 ? (
        <Tabs
          id={TABS_ID}
          aria-label="Knowledge roots"
          // Automatic activation: switching the selected root is a cheap
          // in-place re-render (no route push), matching Guidance/Registry.
          activation="automatic"
          items={roots.map((root) => ({
            key: root.id,
            label: root.displayName || root.id,
          }))}
          activeKey={activeRoot?.id ?? ''}
          onSelect={setSelectedRootId}
        />
      ) : null}

      {(() => {
        // archive#771: `!rootId`/`graph` falsy also cover a settled query
        // error, which used to render as "no memory stores are configured" /
        // "no recall graph available" — a fabricated negative fact, not the
        // read failure that actually happened.
        //
        // archive#771: both error branches are now
        // gated on the data ALSO being absent — a refetch failure with
        // cached roots/graph on hand must keep rendering them, never blank a
        // working tab behind an error card (the archive#769 contract: ProjectPage
        // renders cached data with no banner on a refetch failure).
        const detail = rootsLoading ? (
          <Skeleton variant="block" />
        ) : rootsError && roots.length === 0 ? (
          <ErrorState
            variant="compact"
            title="Couldn't load memory stores"
            description={describeReadFailure(rootsFailure)}
            action={
              <button type="button" onClick={() => refetchRoots()}>
                Retry
              </button>
            }
          />
        ) : !rootId ? (
          <Empty variant="compact" label="No memory stores are configured." />
        ) : graphLoading ? (
          <Skeleton variant="block" />
        ) : graphError && !graph ? (
          <ErrorState
            variant="compact"
            title="Couldn't load this memory store's recall graph"
            description={describeReadFailure(graphFailure)}
            action={
              <button type="button" onClick={() => refetchGraph()}>
                Retry
              </button>
            }
          />
        ) : graph ? (
          <KnowledgeRecallBrowser
            rootId={rootId}
            authorityKey={authorityKey}
            graph={graph}
            renderRecordActions={({ recordId }) =>
              activeRoot ? (
                <LearningSourceAction root={activeRoot} recordId={recordId} />
              ) : null
            }
          />
        ) : (
          <p>The selected memory store has no recall graph available.</p>
        );
        // Only a real tab (roots.length > 1) gets a tabpanel — with one
        // root there is no tablist for it to be a panel OF.
        if (roots.length <= 1 || !activeRoot) return detail;
        return (
          <div
            role="tabpanel"
            id={tabPanelElementId(TABS_ID, activeRoot.id)}
            aria-labelledby={tabElementId(TABS_ID, activeRoot.id)}
          >
            {detail}
          </div>
        );
      })()}
    </section>
  );
}
