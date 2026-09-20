import { JoinDevicePairingPanel } from '@kontourai/station-connect/device-pairing-panel';
import type { MemberProjectView } from '@kontourai/station-contracts/project';
import {
  getProjectView,
  listProjectViews,
  StationHttpError,
} from '@kontourai/station-sdk';
import { getAccountSession } from '@kontourai/station-sdk/account-authentication';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { SkeletonList } from '../../components/state';

const options = (signal: AbortSignal) => ({
  authentication: 'omit' as const,
  signal,
  timeoutMs: 15_000,
  maxResponseBytes: 64 * 1024,
});

function members(values: Awaited<ReturnType<typeof listProjectViews>>) {
  if (values.some((value) => !('kind' in value)))
    throw new Error('Station returned a personal Project view to guest entry.');
  return values as MemberProjectView[];
}

export function GuestDeviceOnboarding({
  apiBase,
  onAccountRequired,
}: {
  apiBase: string;
  onAccountRequired: () => void;
}) {
  const [request, setRequest] = useState<{ clientInstanceId: string }>();
  const [projects, setProjects] = useState<MemberProjectView[]>();
  const [detail, setDetail] = useState<MemberProjectView>();
  const [error, setError] = useState<string>();
  const [canRequest, setCanRequest] = useState<boolean>();
  const active = useRef<AbortController | undefined>(undefined);
  const nextSignal = useCallback(() => {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    return controller.signal;
  }, []);
  const handleFailure = useCallback(
    async (cause: unknown) => {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      if (cause instanceof StationHttpError && cause.status === 401) {
        try {
          const account = await getAccountSession(
            apiBase,
            options(nextSignal()),
          );
          if (!account) return onAccountRequired();
          setCanRequest(true);
          setRequest(undefined);
          setProjects(undefined);
          setDetail(undefined);
          setError('This browser needs new Device approval.');
          return;
        } catch (accountFailure) {
          if (
            accountFailure instanceof DOMException &&
            accountFailure.name === 'AbortError'
          )
            return;
          setError('Station could not verify the current account. Try again.');
          setCanRequest(false);
          return;
        }
      }
      setError(
        cause instanceof Error
          ? cause.message
          : 'Shared Projects are unavailable.',
      );
      setCanRequest(false);
    },
    [apiBase, nextSignal, onAccountRequired],
  );
  const loadProjects = useCallback(async () => {
    setError(undefined);
    setDetail(undefined);
    setCanRequest(undefined);
    try {
      setProjects(
        members(await listProjectViews(apiBase, options(nextSignal()))),
      );
      setCanRequest(false);
    } catch (cause) {
      await handleFailure(cause);
    }
  }, [apiBase, handleFailure, nextSignal]);
  useEffect(() => {
    setRequest(undefined);
    setProjects(undefined);
    setDetail(undefined);
    setError(undefined);
    setCanRequest(undefined);
    void loadProjects();
    return () => active.current?.abort();
  }, [loadProjects]);

  if (projects) {
    return (
      <section
        className="account-entry__guest-home"
        aria-labelledby="shared-projects-title"
      >
        <div className="account-entry__guest-heading">
          <div>
            <h2 id="shared-projects-title">Projects shared with you</h2>
            <p role="status">This browser has view-only Project access.</p>
          </div>
          <Button onClick={() => void loadProjects()}>Refresh</Button>
        </div>
        {projects.length === 0 ? (
          <p>No Projects are currently shared with this account.</p>
        ) : (
          <ul className="account-entry__project-list">
            {projects.map((project) => (
              <li key={project.id}>
                <div>
                  <strong>{project.name}</strong>
                  {project.description && <p>{project.description}</p>}
                  <small>View only</small>
                </div>
                <Button
                  onClick={async () => {
                    setError(undefined);
                    try {
                      const value = await getProjectView(
                        apiBase,
                        project.slug,
                        options(nextSignal()),
                      );
                      if (!('kind' in value))
                        throw new Error(
                          'Station returned a personal Project view to guest entry.',
                        );
                      setDetail(value);
                    } catch (cause) {
                      await handleFailure(cause);
                    }
                  }}
                >
                  Read Project details
                </Button>
              </li>
            ))}
          </ul>
        )}
        {detail && (
          <section
            className="account-entry__project-detail"
            aria-label={`${detail.name} details`}
          >
            <h3>{detail.name}</h3>
            {detail.description && <p>{detail.description}</p>}
            <p>Available action: View</p>
          </section>
        )}
      </section>
    );
  }
  if (request)
    return (
      <div className="account-entry__device-onboarding">
        <JoinDevicePairingPanel
          initialMode="direct"
          originIsStation
          accountBoundDeviceRequest={request}
          onCancel={() => setRequest(undefined)}
          onPaired={(result) => {
            const expected = result.requiredAccountBinding;
            const actual = result.device.principalBinding;
            if (
              !expected ||
              !actual ||
              !('kind' in actual) ||
              actual.kind !== 'account' ||
              actual.issuer !== expected.issuer ||
              actual.subject !== expected.subject
            )
              throw new Error(
                'Station did not issue the requested account-bound Device.',
              );
            setRequest(undefined);
            void loadProjects();
          }}
        />
      </div>
    );
  if (canRequest === undefined)
    return <SkeletonList count={2} label="Checking browser access" />;
  return (
    <section className="account-entry__guest-access">
      <p>
        Access is limited to Projects shared with this account. Editing and
        running work are unavailable.
      </p>
      {error && <p role="alert">{error}</p>}
      {canRequest ? (
        <Button
          variant="primary"
          onClick={() => {
            setError(undefined);
            setRequest({ clientInstanceId: crypto.randomUUID() });
          }}
        >
          Request access for this browser
        </Button>
      ) : (
        <Button onClick={() => void loadProjects()}>Try again</Button>
      )}
    </section>
  );
}
