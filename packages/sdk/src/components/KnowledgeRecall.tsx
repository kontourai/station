import type {
  KitLink,
  KitRecord,
  KnowledgeStoreRoot,
} from '@kontourai/station-contracts/knowledge-store';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { KnowledgeGraph, KnowledgeGraphNode } from '../client/knowledge';
import {
  useKnowledgeGraphQuery,
  useKnowledgeRecordQuery,
} from '../query-domains/knowledgeStores';
import './KnowledgeRecall.css';

const BODY_EXCERPT_LENGTH = 800;

export type KnowledgeRecordFreshness =
  | { kind: 'declared'; expiresAt: string }
  | { kind: 'not-declared' }
  | { kind: 'invalid'; value: string };

export interface KnowledgeRecallQuery<T> {
  data?: T;
  error?: unknown;
  isError: boolean;
  isLoading: boolean;
  refetch: () => Promise<unknown>;
}

export type KnowledgeGraphQueryHook = (
  rootId: string | undefined,
) => KnowledgeRecallQuery<KnowledgeGraph>;

export type KnowledgeRecordQueryHook = (
  rootId: string | undefined,
  recordId: string | undefined,
) => KnowledgeRecallQuery<KitRecord>;

export interface KnowledgeRecallRendererProps {
  graph: KnowledgeGraph;
  selectedId: string | null;
  onSelect: (recordId: string) => void;
}

export interface KnowledgeRecallTestIds {
  detail?: string;
  recordDetail?: string;
  recordTitle?: string;
  recordBody?: string;
  recordFreshness?: string;
  recordProvenance?: string;
  recordLink?: (recordId: string) => string;
  sourceLink?: (recordId: string) => string;
}

export interface KnowledgeGraphRecordListProps
  extends KnowledgeRecallRendererProps {
  ariaLabel?: string;
  className?: string;
  nodeClassName?: string;
  selectedNodeClassName?: string;
  titleClassName?: string;
  metaClassName?: string;
  testIdForNode?: (recordId: string) => string;
}

export interface KnowledgeRecordDetailProps {
  rootId: string;
  recordId: string;
  graph: KnowledgeGraph;
  authorityKey: string;
  onSelect: (recordId: string) => void;
  useRecordQuery?: KnowledgeRecordQueryHook;
  testIds?: KnowledgeRecallTestIds;
  renderLoading?: () => ReactNode;
  renderError?: (error: unknown, retry: () => void) => ReactNode;
  renderMissing?: () => ReactNode;
}

export interface KnowledgeRecallBrowserProps {
  rootId: string;
  authorityKey: string;
  graph: KnowledgeGraph;
  selectedId?: string | null;
  onSelect?: (recordId: string) => void;
  className?: string;
  detailClassName?: string;
  detailLabel?: string;
  emptyDetail?: ReactNode;
  renderGraph?: (props: KnowledgeRecallRendererProps) => ReactNode;
  graphListProps?: Omit<
    KnowledgeGraphRecordListProps,
    keyof KnowledgeRecallRendererProps
  >;
  useRecordQuery?: KnowledgeRecordQueryHook;
  testIds?: KnowledgeRecallTestIds;
  renderRecordLoading?: () => ReactNode;
  renderRecordError?: (error: unknown, retry: () => void) => ReactNode;
  renderRecordMissing?: () => ReactNode;
}

/** Personal roots are always visible; project roots only match the active project. */
export function isRelevantKnowledgeRoot(
  root: KnowledgeStoreRoot,
  selectedProject: string | null,
): boolean {
  if (root.scope.kind === 'personal') return true;
  return selectedProject !== null && root.scope.projectSlug === selectedProject;
}

/**
 * A root id alone is not authority. Include every field that can change which
 * adapter and store answer that id so cached graph/detail UI cannot be relabeled
 * across root replacement.
 */
export function knowledgeRootIncarnationKey(root: KnowledgeStoreRoot): string {
  return JSON.stringify([
    root.id,
    root.scope.kind,
    root.scope.kind === 'project' ? root.scope.projectSlug : null,
    root.adapterId,
    root.storeRoot,
    root.displayName,
    root.createdAt,
  ]);
}

function declaredExpiry(record: KitRecord): string | null {
  if (record.expires_at) return record.expires_at;
  if (record.ttl_seconds === undefined) return null;
  const createdAt = Date.parse(record.created_at);
  if (!Number.isFinite(createdAt)) return record.created_at;
  return new Date(createdAt + record.ttl_seconds * 1000).toISOString();
}

export function knowledgeRecordFreshness(
  record: KitRecord,
): KnowledgeRecordFreshness {
  const expiresAt = declaredExpiry(record);
  if (expiresAt === null) return { kind: 'not-declared' };
  if (!Number.isFinite(Date.parse(expiresAt))) {
    return { kind: 'invalid', value: expiresAt };
  }
  return { kind: 'declared', expiresAt };
}

export function knowledgeFreshnessLabel(
  freshness: KnowledgeRecordFreshness,
): string {
  switch (freshness.kind) {
    case 'declared':
      return `Expires at ${freshness.expiresAt}`;
    case 'invalid':
      return `Invalid expiry declaration: ${freshness.value}`;
    case 'not-declared':
      return 'No expiry declared';
  }
}

function bodyExcerpt(body: string): string {
  const trimmed = body.trim();
  return trimmed.length <= BODY_EXCERPT_LENGTH
    ? trimmed
    : `${trimmed.slice(0, BODY_EXCERPT_LENGTH).trimEnd()}…`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Revalidates a derived graph whenever the selected root's authority changes. */
export function useKnowledgeRecallGraph(
  rootId: string | undefined,
  authorityKey: string | undefined,
  useGraphQuery: KnowledgeGraphQueryHook = useKnowledgeGraphQuery,
) {
  const query = useGraphQuery(rootId);
  const [verifiedAuthorityKey, setVerifiedAuthorityKey] = useState<
    string | null
  >(null);

  useEffect(() => {
    let active = true;
    setVerifiedAuthorityKey(null);
    if (!rootId || !authorityKey) return () => undefined;
    void query.refetch().then(
      () => {
        if (active) setVerifiedAuthorityKey(authorityKey);
      },
      () => {
        if (active) setVerifiedAuthorityKey(authorityKey);
      },
    );
    return () => {
      active = false;
    };
  }, [authorityKey, query.refetch, rootId]);

  return {
    ...query,
    isAuthorityLoading:
      query.isLoading ||
      Boolean(rootId && authorityKey && verifiedAuthorityKey !== authorityKey),
  };
}

export function KnowledgeGraphRecordList({
  graph,
  selectedId,
  onSelect,
  ariaLabel = 'Knowledge graph records',
  className = 'knowledge-recall-node-list',
  nodeClassName = 'knowledge-recall-node',
  selectedNodeClassName = 'knowledge-recall-node--selected',
  titleClassName = 'knowledge-recall-node__title',
  metaClassName = 'knowledge-recall-node__meta',
  testIdForNode = (recordId) => `knowledge-recall-node-${recordId}`,
}: KnowledgeGraphRecordListProps) {
  const connectionCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of graph.edges) {
      counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
      counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1);
    }
    return counts;
  }, [graph.edges]);

  return (
    <ul className={className} aria-label={ariaLabel}>
      {graph.nodes.map((node) => (
        <li key={node.id}>
          <button
            type="button"
            className={`${nodeClassName}${
              selectedId === node.id ? ` ${selectedNodeClassName}` : ''
            }`}
            data-testid={testIdForNode(node.id)}
            aria-pressed={selectedId === node.id}
            onClick={() => onSelect(node.id)}
          >
            <span className={titleClassName}>{node.title}</span>
            <span className={metaClassName}>
              {node.type} · {node.category} ·{' '}
              {connectionCounts.get(node.id) ?? 0} connections
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function RecordLink({
  link,
  nodes,
  onSelect,
  testId,
}: {
  link: KitLink;
  nodes: Map<string, KnowledgeGraphNode>;
  onSelect: (recordId: string) => void;
  testId?: string;
}) {
  const target = nodes.get(link.target_id);
  if (!target) {
    return (
      <li>
        <code>
          {link.label ? `${link.label}: ` : ''}
          {link.target_id}
        </code>{' '}
        <span className="knowledge-recall-muted">
          ({link.kind}, outside graph)
        </span>
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        className="knowledge-recall-link"
        data-testid={testId}
        onClick={() => onSelect(link.target_id)}
      >
        {link.label ? `${link.label}: ` : ''}
        {target.title}{' '}
        <span className="knowledge-recall-muted">({link.kind})</span>
      </button>
    </li>
  );
}

function CanonicalRecord({
  record,
  graph,
  onSelect,
  testIds = {},
}: {
  record: KitRecord;
  graph: KnowledgeGraph;
  onSelect: (recordId: string) => void;
  testIds?: KnowledgeRecallTestIds;
}) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const sourceIds = record.provenance.source_ids ?? [];
  return (
    <article
      className="knowledge-recall-detail"
      data-testid={testIds.recordDetail ?? 'knowledge-recall-record-detail'}
    >
      <header className="knowledge-recall-detail__header">
        <div>
          <p className="knowledge-recall-eyebrow">Canonical record</p>
          <h2
            data-testid={testIds.recordTitle ?? 'knowledge-recall-record-title'}
          >
            {record.title}
          </h2>
        </div>
        <span
          className={`knowledge-recall-status knowledge-recall-status--${
            record.status ?? 'active'
          }`}
        >
          {record.status ?? 'active'}
        </span>
      </header>
      <dl className="knowledge-recall-facts">
        <div>
          <dt>Type</dt>
          <dd>{record.type}</dd>
        </div>
        <div>
          <dt>Category</dt>
          <dd>{record.category}</dd>
        </div>
        <div>
          <dt>Freshness</dt>
          <dd
            data-testid={
              testIds.recordFreshness ?? 'knowledge-recall-record-freshness'
            }
          >
            {knowledgeFreshnessLabel(knowledgeRecordFreshness(record))}
          </dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{record.updated_at}</dd>
        </div>
      </dl>
      <section>
        <h3>Record</h3>
        <p
          className="knowledge-recall-record-body"
          data-testid={testIds.recordBody ?? 'knowledge-recall-record-body'}
        >
          {bodyExcerpt(record.body)}
        </p>
      </section>
      <section
        data-testid={
          testIds.recordProvenance ?? 'knowledge-recall-record-provenance'
        }
      >
        <h3>Provenance</h3>
        <dl className="knowledge-recall-provenance">
          <div>
            <dt>Agent</dt>
            <dd>{record.provenance.agent}</dd>
          </div>
          {record.provenance.session_id ? (
            <div>
              <dt>Session</dt>
              <dd>{record.provenance.session_id}</dd>
            </div>
          ) : null}
          {record.provenance.note ? (
            <div>
              <dt>Note</dt>
              <dd>{record.provenance.note}</dd>
            </div>
          ) : null}
        </dl>
        {sourceIds.length ? (
          <>
            <h4>Sources</h4>
            <ul className="knowledge-recall-links">
              {sourceIds.map((recordId) => (
                <RecordLink
                  key={`source:${recordId}`}
                  link={{ target_id: recordId, kind: 'source' }}
                  nodes={nodes}
                  onSelect={onSelect}
                  testId={testIds.sourceLink?.(recordId)}
                />
              ))}
            </ul>
          </>
        ) : (
          <p className="knowledge-recall-muted">No source records declared.</p>
        )}
      </section>
      <section>
        <h3>Links</h3>
        {record.links?.length ? (
          <ul className="knowledge-recall-links">
            {record.links.map((link) => (
              <RecordLink
                key={`${link.kind}:${link.target_id}`}
                link={link}
                nodes={nodes}
                onSelect={onSelect}
                testId={testIds.recordLink?.(link.target_id)}
              />
            ))}
          </ul>
        ) : (
          <p className="knowledge-recall-muted">
            This record has no outgoing links.
          </p>
        )}
      </section>
    </article>
  );
}

export function KnowledgeRecordDetail({
  rootId,
  recordId,
  graph,
  authorityKey,
  onSelect,
  useRecordQuery = useKnowledgeRecordQuery,
  testIds,
  renderLoading = () => (
    <p className="knowledge-recall-state" aria-live="polite">
      Loading canonical record…
    </p>
  ),
  renderError = (error, retry) => (
    <div className="knowledge-recall-state" role="alert">
      <p>Could not load the canonical record: {errorText(error)}</p>
      <button type="button" onClick={retry}>
        Try again
      </button>
    </div>
  ),
  renderMissing = () => (
    <div className="knowledge-recall-state" role="alert">
      Canonical record unavailable. The derived graph still references a record
      that the root adapter did not return.
    </div>
  ),
}: KnowledgeRecordDetailProps) {
  const recordQuery = useRecordQuery(rootId, recordId);
  const recordAuthorityKey = `${authorityKey}\u0000${recordId}`;
  const [verifiedRecordKey, setVerifiedRecordKey] = useState<string | null>(
    null,
  );

  useEffect(() => {
    let active = true;
    setVerifiedRecordKey(null);
    void recordQuery.refetch().then(
      () => {
        if (active) setVerifiedRecordKey(recordAuthorityKey);
      },
      () => {
        if (active) setVerifiedRecordKey(recordAuthorityKey);
      },
    );
    return () => {
      active = false;
    };
  }, [recordAuthorityKey, recordQuery.refetch]);

  if (recordQuery.isLoading || verifiedRecordKey !== recordAuthorityKey) {
    return renderLoading();
  }
  if (recordQuery.isError) {
    return renderError(recordQuery.error, () => {
      void recordQuery.refetch();
    });
  }
  if (!recordQuery.data) return renderMissing();
  return (
    <CanonicalRecord
      record={recordQuery.data}
      graph={graph}
      onSelect={onSelect}
      testIds={testIds}
    />
  );
}

export function KnowledgeRecallBrowser({
  rootId,
  authorityKey,
  graph,
  selectedId: controlledSelectedId,
  onSelect,
  className = 'knowledge-recall-browser',
  detailClassName = 'knowledge-recall-detail-panel',
  detailLabel = 'Canonical record detail',
  emptyDetail = (
    <p className="knowledge-recall-state">
      Select a record to resolve its canonical detail and provenance.
    </p>
  ),
  renderGraph,
  graphListProps,
  useRecordQuery,
  testIds,
  renderRecordLoading,
  renderRecordError,
  renderRecordMissing,
}: KnowledgeRecallBrowserProps) {
  const [internalSelectedId, setInternalSelectedId] = useState<string | null>(
    null,
  );
  const isControlled = controlledSelectedId !== undefined;
  const selectedId = isControlled
    ? (controlledSelectedId ?? null)
    : internalSelectedId;

  // Uncontrolled selection belongs to exactly one authority: when the root's
  // incarnation changes under a mounted browser, the previous root's record id
  // must not survive into the new authority's detail resolution.
  //
  // That clearing is a render-phase adjustment rather than an effect. An effect
  // runs in the window between the commit that makes the graph clickable and
  // the passive-effect flush, so a selection made inside that window was
  // silently undone (#957, root-caused in #955). Comparing against the
  // last-applied authority also means mount clears nothing at all — there is no
  // prior authority to clear, and the mount reset only ever had the power to
  // destroy a selection that raced it.
  const selectionAuthority = isControlled ? null : authorityKey;
  const [appliedSelectionAuthority, setAppliedSelectionAuthority] =
    useState(selectionAuthority);
  if (appliedSelectionAuthority !== selectionAuthority) {
    setAppliedSelectionAuthority(selectionAuthority);
    if (selectionAuthority) setInternalSelectedId(null);
  }

  const handleSelect = useCallback(
    (recordId: string) => {
      if (!isControlled) setInternalSelectedId(recordId);
      onSelect?.(recordId);
    },
    [isControlled, onSelect],
  );

  const rendererProps = { graph, selectedId, onSelect: handleSelect };
  return (
    <div className={className}>
      {renderGraph ? (
        renderGraph(rendererProps)
      ) : (
        <KnowledgeGraphRecordList {...rendererProps} {...graphListProps} />
      )}
      <section
        className={detailClassName}
        aria-label={detailLabel}
        data-testid={testIds?.detail}
      >
        {selectedId ? (
          <KnowledgeRecordDetail
            rootId={rootId}
            recordId={selectedId}
            graph={graph}
            authorityKey={authorityKey}
            onSelect={handleSelect}
            useRecordQuery={useRecordQuery}
            testIds={testIds}
            renderLoading={renderRecordLoading}
            renderError={renderRecordError}
            renderMissing={renderRecordMissing}
          />
        ) : (
          emptyDetail
        )}
      </section>
    </div>
  );
}
