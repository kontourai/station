import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import {
  KnowledgeGraphRecordList,
  KnowledgeRecallBrowser,
  knowledgeRootIncarnationKey,
  useKnowledgeGraphQuery,
  useKnowledgeRecallGraph,
  useKnowledgeRecordQuery,
  useKnowledgeRootsQuery,
  useNavigation,
} from '@kontourai/station-sdk';
import type { KnowledgeGraph } from '@kontourai/station-sdk/client';
import { useEffect, useState } from 'react';
import { isRelevantRoot, RootPicker } from './RootPicker';
import { Empty, ErrorState, Skeleton } from './state';

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const rootIncarnationKey = knowledgeRootIncarnationKey;

function KnowledgeWorkspace({
  root,
  graph,
  authorityKey,
}: {
  root: KnowledgeStoreRoot;
  graph: KnowledgeGraph;
  authorityKey: string;
}) {
  return (
    <KnowledgeRecallBrowser
      rootId={root.id}
      authorityKey={authorityKey}
      graph={graph}
      className="kl-grid"
      detailClassName="kl-panel"
      useRecordQuery={useKnowledgeRecordQuery}
      renderGraph={({ graph: renderedGraph, selectedId, onSelect }) => (
        <section className="kl-panel" aria-labelledby="kl-graph-title">
          <div className="kl-panel__header">
            <div>
              <p className="kl-eyebrow">Derived navigation</p>
              <h2 id="kl-graph-title">Record graph</h2>
            </div>
            <span>
              {renderedGraph.nodes.length} records ·{' '}
              {renderedGraph.edges.length} links
            </span>
          </div>
          <KnowledgeGraphRecordList
            graph={renderedGraph}
            selectedId={selectedId}
            onSelect={onSelect}
            className="kl-node-list"
            nodeClassName="kl-node"
            selectedNodeClassName="kl-node--selected"
            titleClassName="kl-node__title"
            metaClassName="kl-node__meta"
            testIdForNode={(recordId) => `kl-node-${recordId}`}
          />
        </section>
      )}
      emptyDetail={
        <Empty
          variant="compact"
          label="Select a record"
          description="Choose a graph node to resolve its canonical detail and provenance."
        />
      }
      renderRecordLoading={() => <Skeleton variant="block" height="20rem" />}
      renderRecordError={(error, retry) => (
        <ErrorState
          title="Could not load the canonical record"
          description={errorText(error)}
          action={
            <button type="button" className="kl-button" onClick={retry}>
              Try again
            </button>
          }
        />
      )}
      renderRecordMissing={() => (
        <ErrorState
          title="Canonical record unavailable"
          description="The graph still references this record, but the root adapter did not return it."
        />
      )}
      testIds={{
        recordDetail: 'kl-record-detail',
        recordTitle: 'kl-record-title',
        recordBody: 'kl-record-body',
        recordFreshness: 'kl-record-freshness',
        recordProvenance: 'kl-record-provenance',
        recordLink: (recordId) => `kl-record-link-${recordId}`,
        sourceLink: (recordId) => `kl-source-link-${recordId}`,
      }}
    />
  );
}

function KnowledgeContent({
  root,
  authorityKey,
}: {
  root: KnowledgeStoreRoot;
  authorityKey: string;
}) {
  const graphQuery = useKnowledgeRecallGraph(
    root.id,
    authorityKey,
    useKnowledgeGraphQuery,
  );

  if (graphQuery.isAuthorityLoading) {
    return (
      <div className="kl-grid">
        <Skeleton variant="block" height="30rem" />
        <Skeleton variant="block" height="30rem" />
      </div>
    );
  }
  if (graphQuery.isError) {
    return (
      <ErrorState
        title="Could not load the knowledge graph"
        description={errorText(graphQuery.error)}
        action={
          <button
            type="button"
            className="kl-button"
            onClick={() => graphQuery.refetch()}
          >
            Try again
          </button>
        }
      />
    );
  }
  if (!graphQuery.data || graphQuery.data.nodes.length === 0) {
    return (
      <Empty
        variant="compact"
        label="This root has no graph records"
        description="The root loaded successfully, but it does not currently expose any canonical records."
      />
    );
  }
  return (
    <KnowledgeWorkspace
      root={root}
      graph={graphQuery.data}
      authorityKey={authorityKey}
    />
  );
}

export function KnowledgeLibrary() {
  const navigation = useNavigation() as {
    selectedProject?: string | null;
    navigate?: (path: string) => void;
  };
  const rootsQuery = useKnowledgeRootsQuery();
  const selectedProject = navigation.selectedProject ?? null;
  const [selectedRoot, setSelectedRoot] = useState<KnowledgeStoreRoot | null>(
    null,
  );
  const roots = rootsQuery.isError ? [] : (rootsQuery.data ?? []);
  const relevantRoots = roots.filter((root) =>
    isRelevantRoot(root, selectedProject),
  );
  const activeRoot = selectedRoot
    ? (relevantRoots.find((root) => root.id === selectedRoot.id) ?? null)
    : null;
  const authorityKey = activeRoot
    ? knowledgeRootIncarnationKey(activeRoot)
    : null;

  useEffect(() => {
    if (selectedRoot && !activeRoot && !rootsQuery.isLoading) {
      setSelectedRoot(null);
    }
  }, [activeRoot, rootsQuery.isLoading, selectedRoot]);

  return (
    <main className="kl-shell">
      <header className="kl-page-header">
        <div>
          <p className="kl-eyebrow">Learn · Knowledge Kit</p>
          <h1>Knowledge Library</h1>
          <p>
            Browse canonical records, provenance, and explicit lifecycle state
            across installed roots.
          </p>
        </div>
        <span className="kl-read-only">Read-only</span>
      </header>
      <RootPicker
        roots={relevantRoots}
        isLoading={rootsQuery.isLoading}
        error={rootsQuery.isError ? rootsQuery.error : null}
        value={activeRoot?.id ?? null}
        onChange={setSelectedRoot}
        onRetry={() => rootsQuery.refetch()}
        onOpenSettings={
          navigation.navigate
            ? () => navigation.navigate?.('/settings?section=knowledge')
            : undefined
        }
      />
      {activeRoot ? (
        <>
          <p className="kl-authority" data-testid="kl-authority">
            <strong>Authority:</strong> {activeRoot.displayName} via{' '}
            {activeRoot.adapterId}. The graph is derived; selected details are
            resolved from the canonical record store.
          </p>
          <KnowledgeContent
            key={authorityKey}
            root={activeRoot}
            authorityKey={authorityKey as string}
          />
        </>
      ) : (
        <Empty
          variant="compact"
          label="Choose a knowledge root"
          description="Root selection is explicit; this surface does not guess which store should answer."
        />
      )}
    </main>
  );
}
