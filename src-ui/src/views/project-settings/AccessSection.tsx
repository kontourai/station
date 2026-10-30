import './project-access.css';
import {
  type ApiRequestScope,
  StationHttpError,
} from '@kontourai/station-sdk/client';
import {
  type ProjectAccessCommand,
  projectAccessRefusal,
  useProjectAccess,
} from '@kontourai/station-sdk/project-access';
import { type ReactNode, useState } from 'react';
import {
  AccountIdentityConflict,
  isAccountIdentityConflict,
} from '../../components/AccountIdentityConflict';
import { Button } from '../../components/Button';
import { PageSection } from '../../components/PageSection';
import { Empty, ErrorState, SkeletonList } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { AccessPanelView } from './AccessPanelView';
import {
  ENABLE_SHARING_FORBIDDEN,
  projectAccessErrorMessage,
} from './projectAccessErrorText';

export function AccessSection({
  slug,
  projectId,
  allowEnableSharing = true,
  writeDisabledReason,
}: {
  slug: string;
  projectId: string;
  allowEnableSharing?: boolean;
  writeDisabledReason?: string;
}) {
  const authority = useHostRequestAuthorityScope();
  return (
    <AccessPanel
      key={`${slug}:${authority?.apiBase}:${authority?.authorityKey}`}
      slug={slug}
      projectId={projectId}
      authority={authority}
      allowEnableSharing={allowEnableSharing}
      writeDisabledReason={writeDisabledReason}
    />
  );
}

/** The section frame for every state that has no administration view to show. */
function AccessFrame({ children }: { children: ReactNode }) {
  return (
    <PageSection
      id="section-access"
      title="People and access"
      description="Who can participate in this Project."
    >
      {children}
    </PageSection>
  );
}

function AccessPanel({
  slug,
  projectId,
  authority,
  allowEnableSharing,
  writeDisabledReason,
}: {
  slug: string;
  projectId: string;
  authority?: ApiRequestScope;
  allowEnableSharing: boolean;
  writeDisabledReason?: string;
}) {
  const { query, mutation, change } = useProjectAccess(slug, authority);
  const busy = mutation.isPending || query.isFetching;
  const [enableError, setEnableError] = useState<string>();
  const [identityConflict, setIdentityConflict] = useState(false);

  async function enable() {
    setEnableError(undefined);
    try {
      await change({ kind: 'enable', localProjectId: projectId });
    } catch (cause) {
      if (isAccountIdentityConflict(cause)) setIdentityConflict(true);
      else
        setEnableError(
          projectAccessErrorMessage(cause, ENABLE_SHARING_FORBIDDEN),
        );
    }
  }

  async function apply(command: ProjectAccessCommand) {
    try {
      return await change(command);
    } catch (cause) {
      if (isAccountIdentityConflict(cause)) setIdentityConflict(true);
      throw cause;
    }
  }

  if (!authority) {
    return <p>Connect to this Station to manage access.</p>;
  }
  if (identityConflict || isAccountIdentityConflict(query.error)) {
    return (
      <AccountIdentityConflict
        apiBase={authority.apiBase}
        onRecovered={() => {
          setIdentityConflict(false);
          void query.refetch();
        }}
      />
    );
  }
  if (query.isPending) {
    return <SkeletonList count={2} />;
  }
  if (query.isError) {
    const error = query.error;
    const refusal = projectAccessRefusal(error);
    const enableButton = (
      <Button
        variant="primary"
        pending={mutation.isPending}
        onClick={() => void enable()}
      >
        Enable Project sharing
      </Button>
    );
    const enableAlert = enableError && (
      <p role="alert" className="project-access__error">
        {enableError}
      </p>
    );
    if (error instanceof StationHttpError && error.status === 501)
      return (
        <AccessFrame>
          <Empty label="Project sharing is not enabled on this Station." />
        </AccessFrame>
      );
    if (refusal?.sharing === 'off')
      return (
        <AccessFrame>
          <Empty
            label="Sharing is off"
            description={
              allowEnableSharing
                ? 'Turn on sharing to invite people with a link. You become the Project owner.'
                : 'Sharing can be turned on from this Project’s settings.'
            }
            action={allowEnableSharing ? enableButton : undefined}
          />
          {enableAlert}
        </AccessFrame>
      );
    if (refusal)
      return (
        <AccessFrame>
          <Empty
            label="You can’t manage people for this Project from here"
            description={
              refusal.sharing === 'on'
                ? 'This Project is shared. Its owner or an admin manages who can access it.'
                : 'A Project owner or admin manages access. Turning sharing on needs Station owner authority.'
            }
          />
        </AccessFrame>
      );
    if (
      error instanceof StationHttpError &&
      error.status === 403 &&
      error.code === 'project_access_forbidden'
    )
      // An older Station refuses without saying why, so the button stays
      // for the owner who can use it, and a refusal is explained in words.
      return (
        <AccessFrame>
          <Empty
            label="Sharing may be off"
            description="This Station didn’t say whether you can turn on sharing here."
            action={allowEnableSharing ? enableButton : undefined}
          />
          {enableAlert}
        </AccessFrame>
      );
    return (
      <AccessFrame>
        <ErrorState
          variant="compact"
          title="Project access is unavailable"
          description={projectAccessErrorMessage(error)}
          action={
            <Button disabled={busy} onClick={() => void query.refetch()}>
              Refresh access
            </Button>
          }
        />
      </AccessFrame>
    );
  }
  if (!query.data) return null;
  return (
    <AccessPanelView
      view={query.data}
      busy={busy}
      apply={apply}
      writeDisabledReason={writeDisabledReason}
    />
  );
}
