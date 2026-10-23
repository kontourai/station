import type { TelemetryCompanionPrerequisites } from '@kontourai/station-contracts/telemetry-delivery';
import { useTelemetryCompanionPrerequisitesQuery } from '@kontourai/station-sdk';
import { StationHttpError } from '@kontourai/station-sdk/client';
import { Button } from '../../components/Button';
import { PageSection } from '../../components/PageSection';
import { SkeletonBlock } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';

const missing: Record<
  Extract<TelemetryCompanionPrerequisites, { kind: 'unavailable' }>['reason'],
  string
> = {
  'container-runtime-missing':
    'Install Docker and Compose on the Station host, then check again.',
  'container-daemon-unavailable':
    'Start the container runtime on the Station host, then check again.',
  'remote-container-context':
    'Local installation needs a local container context. Connecting an existing remote companion is not available here yet.',
  'container-host-unsupported':
    'This profile needs Linux containers on amd64 or arm64.',
  'compose-unavailable':
    'Install Docker Compose 2.24 or later on the Station host, then check again.',
};

export function TelemetryCompanion() {
  const authority = useHostRequestAuthorityScope();
  return (
    <PageSection
      title="Telemetry companion"
      description="Store and explore telemetry alongside Station. Check the host before installing the optional companion."
    >
      {authority ? (
        <CompanionHost
          key={`${authority.apiBase}:${authority.authorityKey}`}
          authority={authority}
        />
      ) : (
        <p role="status">
          Connect to this Station to check its companion host.
        </p>
      )}
    </PageSection>
  );
}

function CompanionHost({
  authority,
}: {
  authority: NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
}) {
  const query = useTelemetryCompanionPrerequisitesQuery(authority.apiBase, {
    requestScope: authority,
  });
  return (
    <>
      {query.isError ? (
        <p role="alert">
          {query.error instanceof StationHttpError && query.error.status === 403
            ? 'Open this pane from an operator session on the Station host. Agents and ordinary paired devices cannot manage the companion.'
            : query.error instanceof StationHttpError &&
                query.error.status === 404
              ? 'This Station does not provide companion controls yet. Update the Station server to check its host.'
              : 'The host check is unavailable. Check the Station connection and try again.'}
        </p>
      ) : query.isFetching || !query.data ? (
        <SkeletonBlock count={1} label="Checking companion host" />
      ) : (
        <div role="status">
          {query.data.kind === 'available' ? (
            <>
              <p>
                Host prerequisites passed: Linux {query.data.architecture},
                Docker {query.data.dockerVersion}, Compose{' '}
                {query.data.composeVersion}.
              </p>
              <p>
                Installation is not available yet. A qualified companion release
                is still required.
              </p>
            </>
          ) : (
            <p>{missing[query.data.reason]}</p>
          )}
          <p>Checked {new Date(query.data.checkedAt).toLocaleString()}.</p>
        </div>
      )}
      <Button
        variant="secondary"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        Check host again
      </Button>
    </>
  );
}
