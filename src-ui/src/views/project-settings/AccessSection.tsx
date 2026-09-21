import {
  type ApiRequestScope,
  StationHttpError,
} from '@kontourai/station-sdk/client';
import {
  type ProjectAccessCommand,
  useProjectAccess,
} from '@kontourai/station-sdk/project-access';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { ErrorState, SkeletonList } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { errorText } from '../../utils/errorText';
import { AccessPanelView } from './AccessPanelView';

export function AccessSection({
  slug,
  projectId,
}: {
  slug: string;
  projectId: string;
}) {
  const authority = useHostRequestAuthorityScope();
  return (
    <AccessPanel
      key={`${slug}:${authority?.apiBase}:${authority?.authorityKey}`}
      slug={slug}
      projectId={projectId}
      authority={authority}
    />
  );
}

function AccessPanel({
  slug,
  projectId,
  authority,
}: {
  slug: string;
  projectId: string;
  authority?: ApiRequestScope;
}) {
  const { query, mutation, change } = useProjectAccess(slug, authority);
  const busy = mutation.isPending || query.isFetching;
  const [enableError, setEnableError] = useState<string>();

  async function enable() {
    setEnableError(undefined);
    try {
      await change({ kind: 'enable', localProjectId: projectId });
    } catch (cause) {
      setEnableError(errorText(cause));
    }
  }

  async function apply(command: ProjectAccessCommand) {
    return change(command);
  }

  if (!authority) {
    return <p>Connect to this Station to manage access.</p>;
  }
  if (query.isPending) {
    return <SkeletonList count={2} />;
  }
  if (query.isError) {
    return (
      <>
        {query.error instanceof StationHttpError &&
        query.error.status === 501 ? (
          <p>Project sharing is not enabled on this Station.</p>
        ) : (
          <ErrorState
            title="Project access is unavailable"
            description={errorText(query.error)}
          />
        )}
        {query.error instanceof StationHttpError &&
          query.error.status === 403 && (
            <Button pending={mutation.isPending} onClick={() => void enable()}>
              Enable Project sharing
            </Button>
          )}
        <Button disabled={busy} onClick={() => void query.refetch()}>
          Refresh access
        </Button>
        {enableError && <p role="alert">{enableError}</p>}
      </>
    );
  }
  if (!query.data) return null;
  return <AccessPanelView view={query.data} busy={busy} apply={apply} />;
}
