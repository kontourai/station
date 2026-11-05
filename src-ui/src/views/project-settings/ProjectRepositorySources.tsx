import {
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
          label="No repositories attached"
          description="Add one when you need code. Documents and connected tools can be used on their own."
        />
      ) : (
        <ul className="project-repositories__list">
          {manifest.repos.map((repo) => {
            const remote =
              repo.kind === 'git' ? repo.canonicalRemote : undefined;
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
              <li key={repo.id} className="project-repositories__card">
                <div className="project-repositories__heading">
                  <div className="project-repositories__identity">
                    {forge && (
                      <ForgeMark
                        forge={forge}
                        className="project-repositories__mark"
                      />
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
                  {primary?.ok && primary.resource.id === repo.id && (
                    <Badge value="Primary resource" />
                  )}
                  {startingId === repo.id && (
                    <Badge value="Agent starting resource" />
                  )}
                </div>
                <details className="project-sources__diagnostics">
                  <summary>
                    Details for {repo.label || remote || 'local folder'}
                  </summary>
                  <dl className="project-repositories__details">
                    <dt>Working copy via</dt>
                    <dd>{stationName}</dd>
                    {resource?.state === 'bound' && (
                      <>
                        <dt>Verified path</dt>
                        <dd>
                          <code>{resource.path}</code>
                        </dd>
                      </>
                    )}
                    {resource && 'unverifiedPath' in resource && (
                      <>
                        <dt>Directory found — identity not verified</dt>
                        <dd>
                          <code>{resource.unverifiedPath}</code>
                        </dd>
                      </>
                    )}
                    {resource?.state === 'missing' && (
                      <>
                        <dt>Declared path — not found</dt>
                        <dd>
                          <code>{resource.declaredPath}</code>
                        </dd>
                      </>
                    )}
                    {resource && 'reason' in resource && (
                      <>
                        <dt>Availability detail</dt>
                        <dd>{resource.reason}</dd>
                      </>
                    )}
                    {view?.posture === 'unreadable' && (
                      <>
                        <dt>Availability detail</dt>
                        <dd>{view.reason}</dd>
                      </>
                    )}
                    {startingId === repo.id && (
                      <>
                        <dt>Starting directory within resource</dt>
                        <dd>
                          <code>{manifest.executionRoot?.path ?? '.'}</code>
                        </dd>
                      </>
                    )}
                    <dt>Resource identity</dt>
                    <dd>
                      <code>{repo.id}</code>
                    </dd>
                  </dl>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
