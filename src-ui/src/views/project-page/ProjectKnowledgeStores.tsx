import type { KnowledgeStoreRoot } from '@kontourai/station-contracts/knowledge-store';
import {
  KnowledgeRecallBrowser,
  knowledgeRootIncarnationKey,
  useCreateKnowledgeRootMutation,
  useKnowledgeRecallGraph,
  useKnowledgeRootsQuery,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { InfoTip } from '../../components/InfoTip';
import { PageRow } from '../../components/PageRow';
import { ErrorState, Skeleton } from '../../components/state';
import { errorText } from '../../utils/errorText';
import './ProjectKnowledgeStores.css';

function StoreRecords({ root }: { root: KnowledgeStoreRoot }) {
  const authorityKey = knowledgeRootIncarnationKey(root);
  const graph = useKnowledgeRecallGraph(root.id, authorityKey);
  if (graph.isAuthorityLoading) return <Skeleton variant="block" />;
  if (graph.isError && !graph.data)
    return (
      <ErrorState
        title="Could not load records"
        description={errorText(graph.error)}
        action={<Button onClick={() => void graph.refetch()}>Retry</Button>}
      />
    );
  return graph.data ? (
    <KnowledgeRecallBrowser
      key={authorityKey}
      rootId={root.id}
      authorityKey={authorityKey}
      graph={graph.data}
    />
  ) : null;
}

function Store({ root }: { root: KnowledgeStoreRoot }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="project-knowledge-stores__store"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{root.displayName}</summary>
      {open && <StoreRecords root={root} />}
    </details>
  );
}

export function ProjectKnowledgeStores({ slug }: { slug: string }) {
  const roots = useKnowledgeRootsQuery();
  const create = useCreateKnowledgeRootMutation();
  const stores =
    roots.data?.filter(
      (root) =>
        root.scope.kind === 'project' && root.scope.projectSlug === slug,
    ) ?? [];
  return (
    <div className="project-knowledge-stores">
      <PageRow
        label={
          <>
            Knowledge stores{' '}
            <InfoTip label="Project Knowledge stores">
              Registered stores are detected automatically. Project agents can
              use the Knowledge tools to read records when needed. Agent
              restrictions and store permissions still apply.
            </InfoTip>
          </>
        }
        control={
          !stores.length && !roots.isLoading && !roots.isError ? (
            <Button
              size="sm"
              onClick={() =>
                create.mutate({
                  scope: { kind: 'project', projectSlug: slug },
                  adapterId: 'kit-default-store',
                })
              }
              disabled={create.isPending}
            >
              {create.isPending ? 'Creating…' : 'Create store'}
            </Button>
          ) : undefined
        }
      />
      {roots.isLoading ? (
        <Skeleton variant="line" />
      ) : roots.isError && !roots.data ? (
        <ErrorState
          title="Could not load stores"
          description={errorText(roots.error)}
          action={<Button onClick={() => void roots.refetch()}>Retry</Button>}
        />
      ) : (
        stores.map((root) => (
          <Store key={knowledgeRootIncarnationKey(root)} root={root} />
        ))
      )}
      {create.isError && (
        <ErrorState
          title="Could not create store"
          description={errorText(create.error)}
        />
      )}
    </div>
  );
}
