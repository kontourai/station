import type {
  KitLink,
  KitRecord,
} from '@kontourai/station-contracts/knowledge-store';
import { useKnowledgeRecordQuery } from '@kontourai/station-sdk';
import type {
  KnowledgeGraph,
  KnowledgeGraphNode,
} from '@kontourai/station-sdk/client';
import { useEffect, useState } from 'react';
import { freshnessLabel, recordFreshness } from './freshness';
import { ErrorState, Skeleton } from './state';

const BODY_EXCERPT_LENGTH = 800;

function bodyExcerpt(body: string): string {
  const trimmed = body.trim();
  return trimmed.length <= BODY_EXCERPT_LENGTH
    ? trimmed
    : `${trimmed.slice(0, BODY_EXCERPT_LENGTH).trimEnd()}…`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function RecordLink({
  link,
  nodes,
  onSelect,
  testIdPrefix = 'kl-record-link',
}: {
  link: KitLink;
  nodes: Map<string, KnowledgeGraphNode>;
  onSelect: (id: string) => void;
  testIdPrefix?: string;
}) {
  const target = nodes.get(link.target_id);
  if (!target) {
    return (
      <li>
        <code>{link.target_id}</code>{' '}
        <span className="kl-muted">({link.kind}, outside graph)</span>
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        className="kl-link-button"
        data-testid={`${testIdPrefix}-${link.target_id}`}
        onClick={() => onSelect(link.target_id)}
      >
        {target.title} <span className="kl-muted">({link.kind})</span>
      </button>
    </li>
  );
}

function RecordFacts({ record }: { record: KitRecord }) {
  return (
    <dl className="kl-facts">
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
        <dd data-testid="kl-record-freshness">
          {freshnessLabel(recordFreshness(record))}
        </dd>
      </div>
      <div>
        <dt>Updated</dt>
        <dd>{record.updated_at}</dd>
      </div>
    </dl>
  );
}

function RecordProvenance({
  record,
  nodes,
  onSelect,
}: {
  record: KitRecord;
  nodes: Map<string, KnowledgeGraphNode>;
  onSelect: (id: string) => void;
}) {
  const sourceIds = record.provenance.source_ids ?? [];
  return (
    <section data-testid="kl-record-provenance">
      <h3>Provenance</h3>
      <dl className="kl-provenance">
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
          <ul className="kl-links">
            {sourceIds.map((id) => (
              <RecordLink
                key={`source:${id}`}
                link={{ target_id: id, kind: 'source' }}
                nodes={nodes}
                onSelect={onSelect}
                testIdPrefix="kl-source-link"
              />
            ))}
          </ul>
        </>
      ) : (
        <p className="kl-muted">No source records declared.</p>
      )}
    </section>
  );
}

function RecordLinks({
  links,
  nodes,
  onSelect,
}: {
  links: KitLink[] | undefined;
  nodes: Map<string, KnowledgeGraphNode>;
  onSelect: (id: string) => void;
}) {
  return (
    <section>
      <h3>Links</h3>
      {links?.length ? (
        <ul className="kl-links">
          {links.map((link) => (
            <RecordLink
              key={`${link.kind}:${link.target_id}`}
              link={link}
              nodes={nodes}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : (
        <p className="kl-muted">No outgoing links.</p>
      )}
    </section>
  );
}

function CanonicalRecord({
  record,
  graph,
  onSelect,
}: {
  record: KitRecord;
  graph: KnowledgeGraph;
  onSelect: (id: string) => void;
}) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  return (
    <article className="kl-detail" data-testid="kl-record-detail">
      <header className="kl-detail__header">
        <div>
          <p className="kl-eyebrow">Canonical record</p>
          <h2 data-testid="kl-record-title">{record.title}</h2>
        </div>
        <span className={`kl-status kl-status--${record.status ?? 'active'}`}>
          {record.status ?? 'active'}
        </span>
      </header>
      <RecordFacts record={record} />
      <section>
        <h3>Record</h3>
        <p className="kl-record-body" data-testid="kl-record-body">
          {bodyExcerpt(record.body)}
        </p>
      </section>
      <RecordProvenance record={record} nodes={nodes} onSelect={onSelect} />
      <RecordLinks links={record.links} nodes={nodes} onSelect={onSelect} />
    </article>
  );
}

export function RecordDetail({
  rootId,
  recordId,
  graph,
  authorityKey,
  onSelect,
}: {
  rootId: string;
  recordId: string;
  graph: KnowledgeGraph;
  authorityKey: string;
  onSelect: (id: string) => void;
}) {
  const recordQuery = useKnowledgeRecordQuery(rootId, recordId);
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
    return <Skeleton variant="block" height="20rem" />;
  }
  if (recordQuery.isError) {
    return (
      <ErrorState
        title="Could not load the canonical record"
        description={errorText(recordQuery.error)}
        action={
          <button
            type="button"
            className="kl-button"
            onClick={() => recordQuery.refetch()}
          >
            Try again
          </button>
        }
      />
    );
  }

  const record = recordQuery.data as KitRecord | undefined;
  if (!record) {
    return (
      <ErrorState
        title="Canonical record unavailable"
        description="The graph still references this record, but the root adapter did not return it."
      />
    );
  }
  return <CanonicalRecord record={record} graph={graph} onSelect={onSelect} />;
}
