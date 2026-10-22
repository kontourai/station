import {
  isProjectKnowledgeRoot,
  type KnowledgeStoreRoot,
} from '@kontourai/station-contracts/knowledge-store';
import {
  KnowledgeRecallBrowser,
  knowledgeRootIncarnationKey,
  useCreateKnowledgeRootMutation,
  useKnowledgeGraphQuery,
  useKnowledgeRecallGraph,
  useKnowledgeRecordQuery,
  useKnowledgeRootsQuery,
} from '@kontourai/station-sdk';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { InfoTip } from '../../components/InfoTip';
import { PageRow } from '../../components/PageRow';
import { ErrorState, Skeleton } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { errorText } from '../../utils/errorText';
import './ProjectKnowledgeStores.css';

function StoreRecords({
  root,
  authority,
}: {
  root: KnowledgeStoreRoot;
  authority: ApiRequestScope;
}) {
  function useScopedGraph(rootId: string | undefined) {
    return useKnowledgeGraphQuery(rootId, {
      requestScope: authority,
      requireRequestScope: true,
    });
  }
  function useScopedRecord(
    rootId: string | undefined,
    recordId: string | undefined,
  ) {
    return useKnowledgeRecordQuery(rootId, recordId, {
      requestScope: authority,
      requireRequestScope: true,
    });
  }
  const authorityKey = knowledgeRootIncarnationKey(root);
  const graph = useKnowledgeRecallGraph(root.id, authorityKey, useScopedGraph);
  if (graph.isAuthorityLoading) return <Skeleton variant="block" />;
  if (graph.isError)
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
      useRecordQuery={useScopedRecord}
    />
  ) : null;
}

function Store({
  root,
  authority,
}: {
  root: KnowledgeStoreRoot;
  authority: ApiRequestScope;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="project-knowledge-stores__store"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{root.displayName}</summary>
      {open && <StoreRecords root={root} authority={authority} />}
    </details>
  );
}

export function ProjectKnowledgeStores({
  slug,
  projectId,
}: {
  slug: string;
  projectId?: string;
}) {
  const authority = useHostRequestAuthorityScope();
  return authority ? (
    <ScopedProjectKnowledgeStores
      key={`${projectId}:${slug}:${authority.apiBase}:${authority.authorityKey}`}
      slug={slug}
      projectId={projectId}
      authority={authority}
    />
  ) : (
    <p>Connect to this Station to read project knowledge.</p>
  );
}

function ScopedProjectKnowledgeStores({
  slug,
  projectId,
  authority,
}: {
  slug: string;
  projectId?: string;
  authority: ApiRequestScope;
}) {
  const roots = useKnowledgeRootsQuery({
    requestScope: authority,
    requireRequestScope: true,
  });
  const create = useCreateKnowledgeRootMutation(authority);
  const stores =
    roots.data?.filter((root) => isProjectKnowledgeRoot(root, projectId)) ?? [];
  if (!projectId)
    return (
      <p>
        Project identity is unavailable. Reload the Project before reading its
        stores.
      </p>
    );
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
      ) : roots.isError ? (
        <ErrorState
          title="Could not load stores"
          description={errorText(roots.error)}
          action={<Button onClick={() => void roots.refetch()}>Retry</Button>}
        />
      ) : (
        stores.map((root) => (
          <Store
            key={knowledgeRootIncarnationKey(root)}
            root={root}
            authority={authority}
          />
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
