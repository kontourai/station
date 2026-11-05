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
import { Badge } from '@kontourai/ui/react';
import { Button } from '../../components/Button';
import { ForgeMark, forgeForHost } from '../../components/icons/ForgeMark';
import { Empty, ErrorState, SkeletonList } from '../../components/state';
import { errorText } from '../../utils/errorText';

const AVAILABILITY: Record<ResourceResolutionResult['state'], string> = {
  bound: 'Working copy verified',
  unbound: 'No working copy recorded',
  missing: 'Working copy missing',
  stale: 'Identity not verified',
  drifted: 'Repository changed',
  ambiguous: 'Resource unclear',
  unresolvable: 'Access denied',
  'not-portable': 'Local only',
};

export function ProjectRepositorySources({
  slug,
  projectId,
  authority,
  stationName,
}: {
  slug: string;
  projectId: string;
  authority: ApiRequestScope;
  stationName: string;
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
  // Failed refreshes may retain an older successful query value. It is not a
  // current availability answer and must not lend its paths to these cards.
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
      <p className="project-sources__hint">
        A Project can use several repositories, or work without one.
      </p>
      {identity.isError && (
        <ErrorState
          variant="compact"
          title="Could not read repository identity"
          description={errorText(identity.error)}
          action={
            <Button onClick={() => void identity.refetch()}>
              Retry identity
            </Button>
          }
        />
      )}
      {resolution.isError && (
        <ErrorState
          variant="compact"
          title="Working copy availability unknown"
          description={errorText(resolution.error)}
          action={
            <Button onClick={() => void resolution.refetch()}>
              Retry working copies
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
              stationName={stationName}
              primary={primary?.ok === true && primary.resource.id === repo.id}
              startingDirectory={
                startingId === repo.id
                  ? (manifest.executionRoot?.path ?? '.')
                  : undefined
              }
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function RepositorySourceCard({
  repo,
  view,
  stationName,
  primary,
  startingDirectory,
}: {
  repo: ProjectRepoResource;
  view: ProjectResolutionView | undefined;
  stationName: string;
  primary: boolean;
  startingDirectory: string | undefined;
}) {
  const remote = repo.kind === 'git' ? repo.canonicalRemote : undefined;
  const forge = remote ? forgeForHost(remote.split('/')[0]) : null;
  const resource =
    view?.posture === 'backing'
      ? view.resources.find((row) => row.resourceId === repo.id)
      : undefined;
  const status =
    view?.posture === 'not-backing'
      ? 'No working copy on this Station'
      : resource
        ? AVAILABILITY[resource.state]
        : 'Availability unknown';
  return (
    <li className="project-repositories__card">
      <div className="project-repositories__heading">
        <div className="project-repositories__identity">
          {forge && (
            <ForgeMark forge={forge} className="project-repositories__mark" />
          )}
          <strong>
            {repo.label ||
              remote?.split('/').slice(1).join('/') ||
              'Local folder'}
          </strong>
        </div>
        <Badge
          value={status}
          tone={resource?.state === 'bound' ? 'positive' : 'neutral'}
        />
      </div>
      <span className="project-sources__hint">
        {remote ?? 'Local-only resource'}
      </span>
      <div className="project-repositories__roles">
        {primary && <Badge value="Primary resource" />}
        {startingDirectory !== undefined && (
          <Badge value="Agent starting resource" />
        )}
      </div>
      <details className="project-sources__diagnostics">
        <summary>Details for {repo.label || remote || 'local folder'}</summary>
        <RepositoryMappingDetails
          repo={repo}
          resource={resource}
          stationName={stationName}
          startingDirectory={startingDirectory}
          unreadableReason={
            view?.posture === 'unreadable' ? view.reason : undefined
          }
        />
      </details>
    </li>
  );
}

function RepositoryMappingDetails({
  repo,
  resource,
  stationName,
  startingDirectory,
  unreadableReason,
}: {
  repo: ProjectRepoResource;
  resource: ResourceResolutionResult | undefined;
  stationName: string;
  startingDirectory: string | undefined;
  unreadableReason: string | undefined;
}) {
  return (
    <dl className="project-repositories__details">
      <dt>Working copy via</dt>
      <dd>{stationName}</dd>
      <ResourceLocation resource={resource} />
      {resource && 'reason' in resource && (
        <>
          <dt>Availability detail</dt>
          <dd>{resource.reason}</dd>
        </>
      )}
      {unreadableReason && (
        <>
          <dt>Availability detail</dt>
          <dd>{unreadableReason}</dd>
        </>
      )}
      {startingDirectory !== undefined && (
        <>
          <dt>Starting directory within resource</dt>
          <dd>
            <code>{startingDirectory}</code>
          </dd>
        </>
      )}
      <dt>Resource identity</dt>
      <dd>
        <code>{repo.id}</code>
      </dd>
    </dl>
  );
}

function ResourceLocation({
  resource,
}: {
  resource: ResourceResolutionResult | undefined;
}) {
  if (!resource) return null;
  switch (resource.state) {
    case 'bound':
      return (
        <>
          <dt>Verified path</dt>
          <dd>
            <code>{resource.path}</code>
          </dd>
        </>
      );
    case 'stale':
    case 'drifted':
      return (
        <>
          <dt>Directory found — identity not verified</dt>
          <dd>
            <code>{resource.unverifiedPath}</code>
          </dd>
        </>
      );
    case 'missing':
      return (
        <>
          <dt>Declared path — not found</dt>
          <dd>
            <code>{resource.declaredPath}</code>
          </dd>
        </>
      );
    default:
      return null;
  }
}
