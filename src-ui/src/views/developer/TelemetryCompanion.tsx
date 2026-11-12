import type { TelemetryCompanionPrerequisites } from '@kontourai/station-contracts/telemetry-delivery';
import { useTelemetryCompanionPrerequisitesQuery } from '@kontourai/station-sdk';
import { StationHttpError } from '@kontourai/station-sdk/client';
import { Button } from '../../components/Button';
import { PageSection } from '../../components/PageSection';
import { SkeletonBlock } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { CompanionArchivePreparation } from './CompanionArchivePreparation';
import { CompanionManaged } from './CompanionManaged';

const missing: Record<
  Extract<TelemetryCompanionPrerequisites, { kind: 'unavailable' }>['reason'],
  string
> = {
  'container-runtime-missing':
    'Install Docker and Compose on the computer running Station, then check again.',
  'container-daemon-unavailable':
    'Start Docker on the computer running Station, then check again.',
  'remote-container-context':
    "Docker must use a local context. Connecting a remote companion isn't supported yet.",
  'container-host-unsupported':
    'This profile needs Linux containers on amd64 or arm64.',
  'compose-unavailable':
    'Install Docker Compose 2.24 or later on the computer running Station, then check again.',
};

const missingArtifact = {
  'archive-install-required':
    'Install Station from a release archive to check companion releases.',
  'release-envelope-missing':
    "This install didn't keep its signed release file. Reinstall Station from a current release.",
  'release-envelope-invalid':
    "Station couldn't verify its signed release file for this version and computer.",
  'companion-payload-invalid':
    "The bundled companion files are missing or don't match the release.",
};

export function TelemetryCompanion() {
  const authority = useHostRequestAuthorityScope();
  return (
    <PageSection
      title="Telemetry companion"
      description="Store and explore telemetry alongside Station. Check the computer running Station before installing the optional companion."
    >
      {authority ? (
        <CompanionHost
          key={`${authority.apiBase}:${authority.authorityKey}`}
          authority={authority}
        />
      ) : (
        <p role="status">Connect to this Station to check the companion.</p>
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
    keepPreviousData: false,
  });
  return (
    <>
      {query.isError ? (
        <p role="alert">
          {query.error instanceof StationHttpError && query.error.status === 403
            ? "Sign in as the Station operator to manage the companion. Agents and ordinary paired devices can't."
            : query.error instanceof StationHttpError &&
                query.error.status === 404
              ? "This Station doesn't have companion controls yet. Update Station."
              : "Couldn't check the computer running Station. Check the Station connection and try again."}
        </p>
      ) : query.isFetching || !query.data ? (
        <SkeletonBlock count={1} label="Checking prerequisites" />
      ) : (
        <div role="status">
          {query.data.kind === 'available' ? (
            <>
              <p>
                Prerequisites passed: Linux {query.data.architecture}, Docker{' '}
                {query.data.dockerVersion}, Compose {query.data.composeVersion}.
              </p>
              {query.data.artifact?.kind === 'parent-envelope-verified' ? (
                <p>
                  Release {query.data.artifact.version} is signed and its
                  companion files match. Prepare the archive below before
                  installing.
                </p>
              ) : query.data.artifact?.kind === 'unavailable' ? (
                <p>{missingArtifact[query.data.artifact.reason]}</p>
              ) : null}
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
        Check prerequisites again
      </Button>
      {query.data && !query.isError ? (
        <CompanionArchivePreparation
          authority={authority}
          artifactReady={
            query.data.kind === 'available' &&
            query.data.artifact?.kind === 'parent-envelope-verified'
          }
        />
      ) : null}
      {!(
        query.isError &&
        query.error instanceof StationHttpError &&
        [403, 404].includes(query.error.status)
      ) ? (
        <CompanionManaged
          authority={authority}
          hostReady={
            !query.isError &&
            !query.isFetching &&
            query.data?.kind === 'available' &&
            query.data.artifact?.kind === 'parent-envelope-verified'
          }
          architecture={
            !query.isError && query.data?.kind === 'available'
              ? query.data.architecture
              : null
          }
        />
      ) : null}
    </>
  );
}
