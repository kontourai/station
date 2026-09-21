import { JoinDevicePairingPanel } from '@kontourai/station-connect';
import type { MemberProjectView } from '@kontourai/station-contracts/project';
import {
  getProjectView,
  listProjectViews,
  StationHttpError,
} from '@kontourai/station-sdk';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { LazyBoundary } from '../../components/LazyBoundary';
import { Empty, SkeletonList } from '../../components/state';
import {
  classifyGuestReadFailure,
  GuestAccountRequired,
  GuestAccountUnavailable,
  GuestApprovalRequired,
  requireGuestAccount,
} from './guest-account-authority';

const loadSharedTasks = () =>
  import('./GuestSharedTaskView').then(({ GuestSharedTaskView }) => ({
    default: GuestSharedTaskView,
  }));

const loadProjectAccess = () =>
  import('./GuestProjectAccessView').then(({ GuestProjectAccessView }) => ({
    default: GuestProjectAccessView,
  }));

const options = (signal: AbortSignal) => ({
  authentication: 'omit' as const,
  signal,
  timeoutMs: 15_000,
  maxResponseBytes: 64 * 1024,
});

function member(value: unknown): MemberProjectView {
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 'station.member-project/v1' ||
    !('kind' in value) ||
    value.kind !== 'member-project'
  )
    throw new Error('Station returned a personal Project view to guest entry.');
  return value as MemberProjectView;
}

export function GuestDeviceOnboarding({
  apiBase,
  principalId,
  onAccountRequired,
}: {
  apiBase: string;
  principalId: string;
  onAccountRequired: () => void;
}) {
  const client = useQueryClient();
  const [request, setRequest] = useState<{ clientInstanceId: string }>();
  const [selectedProject, setSelectedProject] = useState<string>();
  const [hiddenProject, setHiddenProject] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const onAccountRequiredRef = useRef(onAccountRequired);
  onAccountRequiredRef.current = onAccountRequired;
  const projects = useQuery({
    queryKey: ['guest-projects', apiBase, principalId],
    queryFn: async ({ signal }) => {
      try {
        await requireGuestAccount(apiBase, principalId, signal);
        const values = await listProjectViews(apiBase, options(signal));
        await requireGuestAccount(apiBase, principalId, signal);
        return values.map(member);
      } catch (cause) {
        return classifyGuestReadFailure(cause, apiBase, principalId, signal);
      }
    },
    retry: false,
    gcTime: 0,
  });
  const detail = useQuery({
    queryKey: ['guest-project', apiBase, principalId, selectedProject],
    queryFn: async ({ signal }) => {
      try {
        await requireGuestAccount(apiBase, principalId, signal);
        const value = member(
          await getProjectView(apiBase, selectedProject!, options(signal)),
        );
        await requireGuestAccount(apiBase, principalId, signal);
        return value;
      } catch (cause) {
        return classifyGuestReadFailure(cause, apiBase, principalId, signal);
      }
    },
    enabled: !!selectedProject,
    retry: false,
    gcTime: 0,
  });
  const accountRequired =
    projects.error instanceof GuestAccountRequired ||
    detail.error instanceof GuestAccountRequired;
  const approvalRequired =
    projects.error instanceof GuestApprovalRequired ||
    detail.error instanceof GuestApprovalRequired;
  useEffect(() => {
    if (!accountRequired) return;
    onAccountRequiredRef.current();
  }, [accountRequired]);
  useEffect(() => {
    if (
      !selectedProject ||
      !(detail.error instanceof StationHttpError) ||
      detail.error.status !== 404
    )
      return;
    let current = true;
    const slug = selectedProject;
    setSelectedProject(undefined);
    setHiddenProject(slug);
    setNotice(
      'Project details are unavailable. Shared Projects were refreshed.',
    );
    void projects.refetch().finally(() => {
      if (current) setHiddenProject(undefined);
    });
    return () => {
      current = false;
    };
  }, [detail.error, projects, selectedProject]);
  useEffect(
    () => () => {
      void client.cancelQueries({
        queryKey: ['guest-projects', apiBase, principalId],
      });
      void client.removeQueries({
        queryKey: ['guest-projects', apiBase, principalId],
      });
      void client.cancelQueries({
        queryKey: ['guest-project', apiBase, principalId],
      });
      void client.removeQueries({
        queryKey: ['guest-project', apiBase, principalId],
      });
    },
    [apiBase, client, principalId],
  );

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
            setSelectedProject(undefined);
            setNotice(undefined);
            void projects.refetch();
          }}
        />
      </div>
    );

  if (projects.isPending || accountRequired)
    return <SkeletonList count={2} label="Checking browser access" />;

  if (approvalRequired || projects.error) {
    return (
      <section className="account-entry__guest-access">
        <p>
          Access is limited to Projects shared with this account. Editing and
          running work are unavailable.
        </p>
        {projects.error instanceof GuestAccountUnavailable ? (
          <p role="alert">Station could not verify the current account.</p>
        ) : !approvalRequired ? (
          <p role="alert">Shared Projects are unavailable.</p>
        ) : null}
        {approvalRequired ? (
          <Button
            variant="primary"
            onClick={() => {
              setSelectedProject(undefined);
              setNotice(undefined);
              setRequest({ clientInstanceId: randomCorrelationId() });
            }}
          >
            Request access for this browser
          </Button>
        ) : (
          <Button onClick={() => void projects.refetch()}>Try again</Button>
        )}
      </section>
    );
  }

  return (
    <section
      className="account-entry__guest-home"
      aria-labelledby="shared-projects-title"
    >
      <div className="account-entry__guest-heading">
        <div>
          <h2 id="shared-projects-title">Available Projects</h2>
          <p role="status">This browser has view-only Project access.</p>
        </div>
        <Button
          onClick={() => {
            setSelectedProject(undefined);
            void projects.refetch();
          }}
        >
          Refresh
        </Button>
      </div>
      {notice && <p role="alert">{notice}</p>}
      {projects.data.length === 0 ? (
        <Empty
          variant="compact"
          label="Projects are not currently shared with this account."
        />
      ) : (
        <ul className="account-entry__project-list">
          {projects.data
            .filter((project) => project.slug !== hiddenProject)
            .map((project) => (
              <li key={project.id}>
                <div>
                  <strong>{project.name}</strong>
                  {project.description && <p>{project.description}</p>}
                  <small>View only</small>
                </div>
                <Button onClick={() => setSelectedProject(project.slug)}>
                  Read Project details
                </Button>
              </li>
            ))}
        </ul>
      )}
      {detail.isPending && selectedProject && (
        <SkeletonList count={1} label="Reading Project details" />
      )}
      {detail.isError && !accountRequired && !approvalRequired && (
        <section className="account-entry__project-detail" role="alert">
          <p>Project details are unavailable.</p>
          <Button onClick={() => setSelectedProject(undefined)}>Close</Button>
        </section>
      )}
      {detail.isSuccess && selectedProject && (
        <section
          className="account-entry__project-detail"
          aria-label={`${detail.data.name} details`}
        >
          <h3>{detail.data.name}</h3>
          {detail.data.description && <p>{detail.data.description}</p>}
          <p>Available action: View</p>
          <LazyBoundary
            key={`${principalId}:${detail.data.id}:${detail.data.slug}`}
            load={loadSharedTasks}
            componentProps={{
              apiBase,
              principalId,
              project: {
                id: detail.data.id,
                slug: detail.data.slug,
              },
              onScopeLost: () => {
                setSelectedProject(undefined);
                setNotice('Shared Project access changed. Projects refreshed.');
                void projects.refetch();
              },
            }}
            pending={<SkeletonList count={1} label="Opening shared Tasks" />}
          />
          <LazyBoundary
            key={`access:${principalId}:${detail.data.id}:${detail.data.slug}`}
            load={loadProjectAccess}
            componentProps={{
              apiBase,
              principalId,
              project: {
                id: detail.data.id,
                slug: detail.data.slug,
              },
              onAccountRequired: () => {
                void client.resetQueries({
                  queryKey: ['account', apiBase, 'session'],
                });
              },
              onAccessLost: () => {
                setSelectedProject(undefined);
                setNotice('Shared Project access changed. Projects refreshed.');
                void projects.refetch();
              },
            }}
            pending={
              <SkeletonList count={1} label="Checking Project administration" />
            }
          />
        </section>
      )}
    </section>
  );
}
