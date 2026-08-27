/**
 * Recall UI — wikilink graph pane (`s203-knowledge-meeting-notes` plan,
 * Wave 2 Task 4; Neo4j view toggle added in Wave 3 cleanup, plan item 1c).
 * Renders the wikilink graph a root's Kit records form
 * (`useKnowledgeGraphQuery(rootId)`, Wave 1 Task 2's
 * `GET /api/knowledge/roots/:rootId/graph`) and, on node click, a side
 * detail panel (`useKnowledgeRecordQuery`) showing the selected record's
 * title/type/category/body excerpt and its forward links — clicking a
 * linked node re-selects it, so provenance chains are navigable without
 * leaving this pane.
 *
 * Rendering approach (Stop-short risk in the plan: no graph-viz library
 * anywhere in this repo, and this wave should not add one): a minimal,
 * dependency-free SVG renderer with a deterministic radial layout — nodes
 * grouped into concentric rings by `KitRecordType` (`RING_ORDER` below),
 * evenly spaced by angle within their ring. This is not a force-directed
 * layout and does not attempt to minimize edge crossings; it is boring and
 * readable, which is what the plan asks for over a real graph-viz
 * dependency. `examples/knowledge-docs-starter/` was read as prior art per
 * the plan's context note — it is a layout/tab-shape precedent only (static
 * demo rows), not a source of reusable graph-rendering code.
 *
 * **Neo4j view toggle** (Wave 3 cleanup, plan item 1c, flagged by the K5
 * Neo4j worker's own `neo4j-graph-routes.ts` doc comment: the file-based
 * `/graph` route "defers wiring a Neo4j-backed root's graph read to
 * whichever task lands the final wiring decision"). This pane now offers two
 * views over the same root: **Files** (unchanged — the file-adapter-derived
 * `useKnowledgeGraphQuery`) and **Neo4j view** (`useKnowledgeGraphNeo4jQuery`,
 * reading whatever `neo4j-graph-sync.ts`'s idempotent sync last projected).
 * The Neo4j view is opt-in — it never fetches until the user actively
 * switches to it (`config.enabled` gated on `view === 'neo4j'`), and when no
 * Neo4j graph-view connection is registered (or the driver failed to load)
 * the route answers an honest `503`, rendered here as "Neo4j graph view
 * isn't configured" (never a silent empty graph, never a generic error). A
 * "Sync now" button (`useSyncKnowledgeGraphNeo4jMutation`) triggers
 * `POST .../graph/neo4j-sync` and reports the returned stats or the same
 * honest not-configured/unavailable reason on failure.
 */
import type {
  KitRecordType,
  KnowledgeStoreRoot,
} from '@kontourai/station-contracts/knowledge-store';
import type { LayoutComponentProps } from '@kontourai/station-sdk';
import {
  KnowledgeRecallBrowser,
  knowledgeRootIncarnationKey,
  useKnowledgeGraphNeo4jQuery,
  useKnowledgeGraphQuery,
  useKnowledgeRecallGraph,
  useKnowledgeRecordQuery,
  useSyncKnowledgeGraphNeo4jMutation,
} from '@kontourai/station-sdk';
import type {
  KnowledgeGraphEdge,
  KnowledgeGraphNode,
} from '@kontourai/station-sdk/client';
import { useCallback, useMemo, useState } from 'react';
import { RootPicker } from './RootPicker';
import { Empty, ErrorState, Skeleton } from './state';

/** Deterministic ring order (outermost last) — every `KitRecordType`
 * (`packages/contracts/src/knowledge-store.ts`) gets a fixed ring, so the
 * same root always lays out the same way across renders. */
const RING_ORDER: KitRecordType[] = [
  'raw',
  'compiled',
  'concept',
  'snapshot',
  'person',
];

const VIEWBOX_SIZE = 600;
const CENTER = VIEWBOX_SIZE / 2;
const RING_BASE_RADIUS = 70;
const RING_GAP = 60;
const NODE_RADIUS = 10;

/** Matches `neo4j-graph-routes.ts`'s `NOT_CONFIGURED_ERROR` text verbatim —
 * the honest "no connection registered" reason, distinct from a transient
 * network/server failure. */
const NEO4J_NOT_CONFIGURED_SUBSTRING =
  'Neo4j graph-view connection is not configured';

function isNeo4jNotConfiguredError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes(NEO4J_NOT_CONFIGURED_SUBSTRING)
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type GraphView = 'files' | 'neo4j';

interface NodePosition {
  x: number;
  y: number;
}

/** Places every node on a ring keyed by its type, evenly spaced by angle
 * within that ring. Nodes of a type absent from the graph simply skip that
 * ring's radius (rings are not padded out for missing types). */
function layoutNodes(nodes: KnowledgeGraphNode[]): Map<string, NodePosition> {
  const byType = new Map<KitRecordType, KnowledgeGraphNode[]>();
  for (const node of nodes) {
    const bucket = byType.get(node.type) ?? [];
    bucket.push(node);
    byType.set(node.type, bucket);
  }

  const positions = new Map<string, NodePosition>();
  let ringIndex = 0;
  for (const type of RING_ORDER) {
    const ringNodes = byType.get(type);
    if (!ringNodes || ringNodes.length === 0) continue;
    const radius = RING_BASE_RADIUS + ringIndex * RING_GAP;
    ringNodes.forEach((node, i) => {
      const angle = (2 * Math.PI * i) / ringNodes.length - Math.PI / 2;
      positions.set(node.id, {
        x: CENTER + radius * Math.cos(angle),
        y: CENTER + radius * Math.sin(angle),
      });
    });
    ringIndex += 1;
  }
  return positions;
}

interface GraphSvgProps {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

function GraphSvg({ nodes, edges, selectedId, onSelect }: GraphSvgProps) {
  const positions = useMemo(() => layoutNodes(nodes), [nodes]);

  return (
    <svg
      className="mn-graph-svg"
      data-testid="mn-graph-svg"
      viewBox={`0 0 ${VIEWBOX_SIZE} ${VIEWBOX_SIZE}`}
      role="img"
      aria-label="Wikilink graph"
    >
      <g className="mn-graph-edges">
        {edges
          .filter((edge) => edge.source !== edge.target)
          .map((edge) => {
            const from = positions.get(edge.source);
            const to = positions.get(edge.target);
            if (!from || !to) return null;
            return (
              <line
                key={`${edge.source}->${edge.target}:${edge.kind}`}
                className="mn-graph-edge"
                data-testid="mn-graph-edge"
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
              />
            );
          })}
      </g>
      <g className="mn-graph-nodes">
        {nodes.map((node) => {
          const pos = positions.get(node.id);
          if (!pos) return null;
          const isSelected = node.id === selectedId;
          return (
            // biome-ignore lint/a11y/useSemanticElements: an <svg> tree has no native button; role + tabIndex + Enter/Space IS the accessible pattern
            <g
              key={node.id}
              className={`mn-graph-node mn-graph-node--${node.type}${
                isSelected ? ' mn-graph-node--selected' : ''
              }`}
              data-testid={`mn-graph-node-${node.id}`}
              tabIndex={0}
              role="button"
              aria-label={`${node.title} (${node.type})`}
              aria-pressed={isSelected}
              transform={`translate(${pos.x}, ${pos.y})`}
              onClick={() => onSelect(node.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onSelect(node.id);
                }
              }}
            >
              <circle className="mn-graph-node__circle" r={NODE_RADIUS} />
              <text className="mn-graph-node__label" y={NODE_RADIUS + 14}>
                {node.title}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function SharedRecallBrowser({
  rootId,
  authorityKey,
  graph,
  selectedId,
  onSelect,
}: {
  rootId: string;
  authorityKey: string;
  graph: { nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[] };
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <KnowledgeRecallBrowser
      rootId={rootId}
      authorityKey={authorityKey}
      graph={graph}
      selectedId={selectedId}
      onSelect={onSelect}
      className="mn-graph-body"
      detailClassName="mn-graph-detail"
      useRecordQuery={useKnowledgeRecordQuery}
      renderGraph={({ graph: renderedGraph, selectedId, onSelect }) => (
        <GraphSvg
          nodes={renderedGraph.nodes}
          edges={renderedGraph.edges}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      )}
      emptyDetail={
        <Empty
          variant="compact"
          label="Select a record"
          description="Click a node in the graph to see its canonical detail, provenance, lifecycle, and links."
        />
      }
      renderRecordLoading={() => (
        <div data-testid="mn-graph-detail-loading">
          <Skeleton variant="block" />
        </div>
      )}
      renderRecordError={(error) => (
        <ErrorState
          title="Could not load that record"
          description={errorText(error)}
        />
      )}
      renderRecordMissing={() => (
        <ErrorState
          title="Canonical record unavailable"
          description="The derived graph references a record the root adapter did not return."
        />
      )}
      testIds={{
        detail: 'mn-graph-detail',
        recordDetail: 'mn-graph-detail-record',
        recordTitle: 'mn-graph-detail-title',
        recordBody: 'mn-graph-detail-body',
        recordFreshness: 'mn-graph-detail-freshness',
        recordProvenance: 'mn-graph-detail-provenance',
        recordLink: (recordId) => `mn-graph-detail-link-${recordId}`,
        sourceLink: (recordId) => `mn-graph-detail-source-${recordId}`,
      }}
    />
  );
}

interface GraphViewToggleProps {
  view: GraphView;
  onChange: (view: GraphView) => void;
}

/** Files vs. Neo4j-view segmented toggle — two buttons, not a `<select>`,
 * since there are exactly two backends and both should stay visible/scannable
 * at once (mirrors `AnswerCard`'s `aria-pressed` toggle-button convention
 * elsewhere in this plugin). */
function GraphViewToggle({ view, onChange }: GraphViewToggleProps) {
  return (
    <fieldset className="mn-graph-view-toggle" aria-label="Graph backend">
      <button
        type="button"
        className="button button--secondary button--small"
        data-testid="mn-graph-view-files"
        aria-pressed={view === 'files'}
        onClick={() => onChange('files')}
      >
        Files
      </button>
      <button
        type="button"
        className="button button--secondary button--small"
        data-testid="mn-graph-view-neo4j"
        aria-pressed={view === 'neo4j'}
        onClick={() => onChange('neo4j')}
      >
        Neo4j view
      </button>
    </fieldset>
  );
}

interface Neo4jGraphSectionProps {
  rootId: string;
  authorityKey: string;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/** The Neo4j-backed half of the toggle — its own query/mutation/rendering,
 * kept as a sibling component (not inlined into `GraphPane`) so the
 * unconfigured/error/empty states here don't tangle with the Files view's
 * own state machine. */
function Neo4jGraphSection({
  rootId,
  authorityKey,
  selectedId,
  onSelect,
}: Neo4jGraphSectionProps) {
  const graphQuery = useKnowledgeRecallGraph(
    rootId,
    `${authorityKey}\u0000neo4j`,
    useKnowledgeGraphNeo4jQuery,
  );
  const syncMutation = useSyncKnowledgeGraphNeo4jMutation();

  const graph = graphQuery.data;

  const syncButton = (
    <button
      type="button"
      className="button button--secondary button--small"
      data-testid="mn-graph-neo4j-sync"
      disabled={syncMutation.isPending}
      onClick={() => syncMutation.mutate(rootId)}
    >
      {syncMutation.isPending ? 'Syncing…' : 'Sync now'}
    </button>
  );

  return (
    <div className="mn-graph-neo4j-section">
      <div className="mn-toolbar">
        {syncButton}
        {syncMutation.isSuccess && (
          <span className="mn-hint" data-testid="mn-graph-neo4j-sync-stats">
            Synced: {syncMutation.data.nodesWritten} node(s) written,{' '}
            {syncMutation.data.nodesUnchanged} unchanged;{' '}
            {syncMutation.data.linksWritten} link(s) written,{' '}
            {syncMutation.data.linksUnchanged} unchanged.
          </span>
        )}
        {syncMutation.isError && (
          <span className="mn-hint" data-testid="mn-graph-neo4j-sync-error">
            Sync failed: {errorText(syncMutation.error)}
          </span>
        )}
      </div>

      {graphQuery.isAuthorityLoading && (
        <div data-testid="mn-graph-neo4j-loading">
          <Skeleton variant="block" />
        </div>
      )}

      {!graphQuery.isAuthorityLoading &&
        graphQuery.isError &&
        isNeo4jNotConfiguredError(graphQuery.error) && (
          <ErrorState
            title="Neo4j graph view isn't configured"
            description="No Neo4j graph-view connection is registered for this Station instance yet. Register one (see docs/guides/knowledge.md's Neo4j section), then use Sync now above to project this root's records into it."
          />
        )}

      {!graphQuery.isAuthorityLoading &&
        graphQuery.isError &&
        !isNeo4jNotConfiguredError(graphQuery.error) && (
          <ErrorState
            title="Could not load the Neo4j graph view"
            description={errorText(graphQuery.error)}
          />
        )}

      {!graphQuery.isAuthorityLoading &&
        !graphQuery.isError &&
        graph &&
        graph.nodes.length === 0 && (
          <Empty
            variant="prominent"
            label="This root hasn't been synced to Neo4j yet"
            description="Click Sync now above to project this root's records and links into the connected Neo4j graph."
          />
        )}

      {!graphQuery.isAuthorityLoading &&
        !graphQuery.isError &&
        graph &&
        graph.nodes.length > 0 && (
          <SharedRecallBrowser
            rootId={rootId}
            authorityKey={`${authorityKey}\u0000neo4j`}
            graph={graph}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        )}
    </div>
  );
}

export function GraphPane(_props: LayoutComponentProps) {
  const [rootId, setRootId] = useState<string | null>(null);
  const [authorityKey, setAuthorityKey] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<GraphView>('files');

  const graphQuery = useKnowledgeRecallGraph(
    view === 'files' ? (rootId ?? undefined) : undefined,
    view === 'files' ? (authorityKey ?? undefined) : undefined,
    useKnowledgeGraphQuery,
  );

  const handleRootChange = useCallback(
    (newRootId: string, root: KnowledgeStoreRoot) => {
      setRootId(newRootId);
      setAuthorityKey(knowledgeRootIncarnationKey(root));
      setSelectedId(null);
    },
    [],
  );

  const handleViewChange = useCallback((newView: GraphView) => {
    setView(newView);
    setSelectedId(null);
  }, []);

  const graph = graphQuery.data;

  return (
    <div className="mn-shell mn-graph-shell" data-testid="mn-graph-pane">
      <div className="mn-toolbar">
        <RootPicker value={rootId} onChange={handleRootChange} />
        {rootId && <GraphViewToggle view={view} onChange={handleViewChange} />}
      </div>

      {!rootId && (
        <Empty
          variant="compact"
          label="Select a knowledge root"
          description="Choose a personal or project knowledge root above to see its wikilink graph."
        />
      )}

      {rootId && authorityKey && view === 'neo4j' && (
        <Neo4jGraphSection
          rootId={rootId}
          authorityKey={authorityKey}
          selectedId={selectedId}
          onSelect={setSelectedId}
        />
      )}

      {rootId && view === 'files' && graphQuery.isAuthorityLoading && (
        <div data-testid="mn-graph-loading">
          <Skeleton variant="block" />
        </div>
      )}

      {rootId &&
        view === 'files' &&
        !graphQuery.isAuthorityLoading &&
        graphQuery.isError && (
          <ErrorState
            title="Could not load the wikilink graph"
            description={errorText(graphQuery.error)}
          />
        )}

      {rootId &&
        view === 'files' &&
        !graphQuery.isAuthorityLoading &&
        graph &&
        graph.nodes.length === 0 && (
          <Empty
            variant="prominent"
            label="This root's library is empty so far"
            description="Capture a meeting in the Capture tab to create your first raw transcript and compiled note — they'll appear here as linked records once saved."
          />
        )}

      {rootId &&
        authorityKey &&
        view === 'files' &&
        !graphQuery.isAuthorityLoading &&
        graph &&
        graph.nodes.length > 0 && (
          <SharedRecallBrowser
            rootId={rootId}
            authorityKey={authorityKey}
            graph={graph}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        )}
    </div>
  );
}

export default GraphPane;
