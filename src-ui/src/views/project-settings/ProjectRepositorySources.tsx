import {
  type ProjectRepoResource,
  type ProjectResolutionView,
  type ResourceResolutionResult,
  selectPrimaryResource,
} from '@kontourai/station-contracts/project-identity';
import {
  useProjectIdentityQuery,
  useProjectResolutionQuery,
} from '@kontourai/station-sdk';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { ForgeMark, forgeForHost } from '../../components/icons/ForgeMark';
import { Empty, ErrorState, SkeletonList } from '../../components/state';
import { errorText } from '../../utils/errorText';
import { ProjectRepositoryAccess } from './ProjectRepositoryAccess';

const CHECKOUT_PROBLEMS: Record<
  Exclude<ResourceResolutionResult['state'], 'bound'>,
  string
> = {
  unbound: 'Choose a checkout folder on this Station.',
  missing: 'The saved folder was not found. Check its location.',
  stale:
    'Station could not check this folder. Check its location and try again.',
  drifted:
    'This folder points to a different repository. Choose the right folder.',
  ambiguous: 'Choose which repository to use before starting a chat.',
  unresolvable: 'Ask this Station’s operator for access to the checkout.',
  'not-portable':
    'This folder is available only on the Station that registered it.',
};

export function ProjectRepositorySources({
  slug,
  projectId,
  authority,
  stationName,
  onRepair,
}: {
  slug: string;
  projectId: string;
  authority: ApiRequestScope;
  stationName: string;
  onRepair?: () => void;
}) {
  const identity = useProjectIdentityQuery(slug, {
    requestScope: authority,
    requireRequestScope: true,
    expectedProjectId: projectId,
  });
  const resolution = useProjectResolutionQuery(slug, {
    requestScope: authority,
    requireRequestScope: true,
    keepPreviousData: false,
  });
  const manifest = identity.data?.identity;
  const primary = manifest ? selectPrimaryResource(manifest.repos) : undefined;
  const startingId =
    manifest?.executionRoot?.repoId ??
    (primary?.ok ? primary.resource.id : undefined);
  // A failed refresh can retain cached data; it cannot confirm a checkout.
  const view =
    identity.isError || resolution.isError ? undefined : resolution.data;
  return (
    <section aria-label="Repository sources" className="project-repositories">
      <div className="project-repositories__heading">
        <h3>Repositories and folders</h3>
        <Button
          variant="secondary"
          disabled={identity.isFetching || resolution.isFetching}
          onClick={() => {
            void identity.refetch();
            void resolution.refetch();
          }}
        >
          Refresh sources
        </Button>
      </div>
      {identity.isError && (
        <ErrorState
          variant="compact"
          title="Could not load repositories"
          description={errorText(identity.error)}
          action={
            <Button onClick={() => void identity.refetch()}>
              Retry repositories
            </Button>
          }
        />
      )}
      {resolution.isError && (
        <ErrorState
          variant="compact"
          title="Checkout details unavailable"
          description={errorText(resolution.error)}
          action={
            <Button onClick={() => void resolution.refetch()}>
              Retry checkouts
            </Button>
          }
        />
      )}
      {!manifest ? (
        !identity.isError && <SkeletonList count={2} />
      ) : !manifest.repos.length ? (
        <Empty
          variant="compact"
          label="Start with documents or connected tools"
          description="Add a repository when you need code."
        />
      ) : (
        <ul className="project-repositories__list">
          {manifest.repos.map((repo) => (
            <RepositorySourceCard
              key={repo.id}
              repo={repo}
              view={view}
              authority={authority}
              stationName={stationName}
              primary={primary?.ok === true && primary.resource.id === repo.id}
              startingDirectory={
                startingId === repo.id
                  ? (manifest.executionRoot?.path ?? '.')
                  : undefined
              }
              onRepair={onRepair}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

type CardProps = {
  repo: ProjectRepoResource;
  view: ProjectResolutionView | undefined;
  authority: ApiRequestScope;
  stationName: string;
  primary: boolean;
  startingDirectory: string | undefined;
  onRepair?: () => void;
};

function RepositorySourceCard({
  repo,
  view,
  authority,
  stationName,
  primary,
  startingDirectory,
  onRepair,
}: CardProps) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const remote = repo.kind === 'git' ? repo.canonicalRemote : undefined;
  const resource =
    view?.posture === 'backing'
      ? view.resources.find((row) => row.resourceId === repo.id)
      : undefined;
  return (
    <li className="project-repositories__card">
      <div className="project-repositories__heading">
        <RepositorySourceIdentity repo={repo} />
        {startingDirectory !== undefined && (
          <span className="project-repositories__usage">
            Used for new chats
          </span>
        )}
      </div>
      {resource && resource.state !== 'bound' && (
        <div className="project-repositories__problem">
          <p>{CHECKOUT_PROBLEMS[resource.state]}</p>
          {onRepair &&
            ['unbound', 'missing', 'stale', 'drifted'].includes(
              resource.state,
            ) && (
              <Button variant="secondary" onClick={onRepair}>
                Review checkout
              </Button>
            )}
        </div>
      )}
      {!view && (
        <p className="project-sources__hint">
          Checkout details have not been checked.
        </p>
      )}
      {view?.posture === 'not-backing' && (
        <p className="project-sources__hint">
          This Station does not provide a checkout for this Project.
        </p>
      )}
      {view?.posture === 'unreadable' && (
        <p className="project-sources__hint">
          Station could not read its checkout records. Refresh to try again.
        </p>
      )}
      <details
        className="project-sources__diagnostics"
        open={detailsOpen}
        onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
      >
        <summary>Checkout and access details</summary>
        <p className="project-sources__hint">
          Showing {stationName} only. Other Stations and Peers are not listed
          here.
        </p>
        <section
          aria-label={`Checkout on ${stationName}`}
          className="project-repositories__checkout"
        >
          <h4>{stationName}</h4>
          <dl className="project-repositories__details">
            <ResourceLocation resource={resource} />
            {startingDirectory !== undefined && (
              <>
                <dt>New chats start in</dt>
                <dd>
                  <code>{startingDirectory}</code> within this checkout
                </dd>
              </>
            )}
          </dl>
        </section>
        {detailsOpen && (
          <ProjectRepositoryAccess
            authority={authority}
            stationName={stationName}
            github={Boolean(
              remote && forgeForHost(remote.split('/')[0]) === 'github',
            )}
          />
        )}
        <details className="project-sources__diagnostics">
          <summary>Advanced details</summary>
          <dl className="project-repositories__details">
            {repo.label && (
              <>
                <dt>Project label</dt>
                <dd>{repo.label}</dd>
              </>
            )}
            <dt>Resource identity</dt>
            <dd>
              <code>{repo.id}</code>
            </dd>
            <dt>Primary resource</dt>
            <dd>{primary ? 'Yes' : 'No'}</dd>
            <dt>Checkout check</dt>
            <dd>{resource?.state ?? view?.posture ?? 'Not available'}</dd>
            {resource && 'reason' in resource && (
              <>
                <dt>Check details</dt>
                <dd>{resource.reason}</dd>
              </>
            )}
            {view?.posture === 'unreadable' && (
              <>
                <dt>Record details</dt>
                <dd>{view.reason}</dd>
              </>
            )}
          </dl>
        </details>
      </details>
    </li>
  );
}

function RepositorySourceIdentity({ repo }: { repo: ProjectRepoResource }) {
  if (repo.kind === 'local-only')
    return <strong>{repo.label || 'Local folder'}</strong>;
  const [host, ...parts] = repo.canonicalRemote.split('/');
  const forge = forgeForHost(host);
  return (
    <a
      className="project-repositories__identity"
      href={`https://${repo.canonicalRemote}`}
      target="_blank"
      rel="noopener noreferrer"
    >
      {forge && (
        <ForgeMark forge={forge} className="project-repositories__mark" />
      )}
      <strong>{parts.join('/')}</strong>
      {!forge && <span className="project-sources__hint">{host}</span>}
    </a>
  );
}

function ResourceLocation({
  resource,
}: {
  resource: ResourceResolutionResult | undefined;
}) {
  if (!resource)
    return (
      <>
        <dt>Checkout folder</dt>
        <dd>Not reported</dd>
      </>
    );
  switch (resource.state) {
    case 'bound':
      return (
        <>
          <dt>Checkout folder</dt>
          <dd>
            <code>{resource.path}</code>
          </dd>
        </>
      );
    case 'stale':
    case 'drifted':
      return (
        <>
          <dt>Folder to check</dt>
          <dd>
            <code>{resource.unverifiedPath}</code>
          </dd>
        </>
      );
    case 'missing':
      return (
        <>
          <dt>Last saved folder</dt>
          <dd>
            <code>{resource.declaredPath}</code>
          </dd>
        </>
      );
    default:
      return (
        <>
          <dt>Checkout folder</dt>
          <dd>Not available on this Station</dd>
        </>
      );
  }
}
