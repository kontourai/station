import { useConnections } from '@kontourai/station-connect';
import type { MemberProjectView } from '@kontourai/station-contracts/project';
import type { ProjectInvitationAcceptance } from '@kontourai/station-contracts/project-membership';
import { getAuthorityObservation } from '@kontourai/station-sdk/authority-observation';
import {
  getProjectView,
  isMemberProjectView,
  listProjectViews,
} from '@kontourai/station-sdk/client';
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../components/Button';
import { ThemeToggle } from '../../components/header/ThemeToggle';
import { PageFrame, PageFrameActions } from '../../components/page-frame';
import { Empty, ErrorState, SkeletonBlock } from '../../components/state';
import { useHostRequestAuthorityScope } from '../../contexts/ApiBaseContext';
import { KeyboardShortcutsProvider } from '../../contexts/KeyboardShortcutsContext';
import {
  NavigationProvider,
  useNavigation,
} from '../../contexts/NavigationContext';
import { ToastProvider } from '../../contexts/ToastContext';
import { LocaleProvider } from '../../i18n/LocaleContext';
import { RelayRouteProfiles } from '../connections-hub/RelayRouteProfiles';
import { MemberProjectPage } from '../project-page/MemberProjectPage';
import '../project-page-frame.css';

type Scope = NonNullable<ReturnType<typeof useHostRequestAuthorityScope>>;
const options = {
  queries: {
    retry: false,
    staleTime: 0,
    gcTime: 0,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  },
} as const;

type InvitationAccepted = (
  accepted: ProjectInvitationAcceptance,
  capturedScope: Scope,
) => void;
function NativeSavedStations({
  onInvitationAccepted,
}: {
  onInvitationAccepted: InvitationAccepted;
}) {
  const { connections, activeConnection, setActiveConnection } =
    useConnections();
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  return (
    <section aria-label="Saved Stations">
      <label>
        Station{' '}
        <select
          className="choice-trigger"
          aria-label="Station"
          value={activeConnection?.id ?? ''}
          disabled={selecting}
          onChange={(event) => {
            const selected = event.target.value;
            setSelecting(true);
            setSelectionError(null);
            void setActiveConnection(selected)
              .catch(() =>
                setSelectionError(
                  'This Station could not be selected. Try again.',
                ),
              )
              .finally(() => setSelecting(false));
          }}
        >
          {connections.map((connection) => (
            <option key={connection.id} value={connection.id}>
              {connection.name}
            </option>
          ))}
        </select>
      </label>
      {selectionError && <p role="alert">{selectionError}</p>}
      <RelayRouteProfiles onInvitationAccepted={onInvitationAccepted} />
    </section>
  );
}

function NativeMemberProjects({
  scope,
  stationId,
}: {
  scope: Scope;
  stationId: string;
}) {
  const { selectedProject, setProject } = useNavigation();
  const observation = useQuery({
    queryKey: ['native-member-authority', scope.apiBase, scope.authorityKey],
    queryFn: async ({ signal }) => {
      if (!scope.isCurrent())
        throw new Error('Station account access changed.');
      const value = await getAuthorityObservation(scope.apiBase, {
        requestScope: scope,
        requireCredential: true,
        signal,
        timeoutMs: 15_000,
        maxResponseBytes: 64 * 1024,
      });
      if (
        !scope.isCurrent() ||
        value.environmentId !== stationId ||
        value.grant.kind !== 'device'
      )
        throw new Error('Station account authority could not be verified.');
      return value;
    },
    enabled: scope.isCurrent(),
  });
  const verified =
    scope.isCurrent() && observation.isSuccess && !observation.isFetching;
  const projects = useQuery({
    queryKey: ['native-member-projects', scope.apiBase, scope.authorityKey],
    queryFn: async ({ signal }) => {
      if (!scope.isCurrent())
        throw new Error('Station account access changed.');
      const values = await listProjectViews(scope.apiBase, {
        requestScope: scope,
        requireCredential: true,
        signal,
        timeoutMs: 15_000,
        maxResponseBytes: 1024 * 1024,
      });
      if (!scope.isCurrent())
        throw new Error('Station account access changed.');
      const members = values.filter(isMemberProjectView);
      return { members, unsupported: members.length !== values.length };
    },
    enabled: verified,
  });
  const selected =
    projects.data?.members.find(
      (project) => project.slug === selectedProject,
    ) ?? projects.data?.members[0];
  const project = useQuery<MemberProjectView>({
    queryKey: [
      'native-member-project',
      scope.apiBase,
      scope.authorityKey,
      selected?.id,
      selected?.slug,
    ],
    queryFn: async ({ signal }) => {
      if (!scope.isCurrent() || !selected)
        throw new Error('Shared Project access changed.');
      const value = await getProjectView(scope.apiBase, selected.slug, {
        requestScope: scope,
        requireCredential: true,
        signal,
        timeoutMs: 15_000,
        maxResponseBytes: 64 * 1024,
      });
      if (
        !scope.isCurrent() ||
        !isMemberProjectView(value) ||
        value.id !== selected.id ||
        value.slug !== selected.slug
      )
        throw new Error(
          'This connection cannot show this Project with shared access.',
        );
      return value;
    },
    enabled:
      verified && projects.isSuccess && !projects.isFetching && !!selected,
  });
  if (!scope.isCurrent()) return null;
  if (observation.isError)
    return (
      <ErrorState
        title="Station access is unavailable"
        description="Check this Station connection and account sign-in, then try again."
        action={
          <Button onClick={() => void observation.refetch()}>
            Check access
          </Button>
        }
      />
    );
  if (!verified)
    return <SkeletonBlock label="Verifying shared Project access" />;
  if (projects.isError)
    return (
      <ErrorState
        title="Shared Projects are unavailable"
        description="Your Project access may have changed."
        action={
          <Button onClick={() => void projects.refetch()}>
            Refresh Projects
          </Button>
        }
      />
    );
  if (projects.isPending || projects.isFetching)
    return <SkeletonBlock label="Loading shared Projects" />;
  return (
    <section aria-label="Shared Projects">
      <h2>Shared Projects</h2>
      {projects.data?.unsupported && (
        <p>
          Some Projects need connection capabilities that are not available here
          yet.
        </p>
      )}
      {!selected ? (
        <Empty label="Nothing is shared with this account yet." />
      ) : (
        <>
          <nav aria-label="Shared Projects">
            {projects.data?.members.map((item) => (
              <Button
                key={item.id}
                active={item.id === selected.id}
                onClick={() => setProject(item.slug)}
              >
                {item.name}
              </Button>
            ))}
          </nav>
          {project.isError ? (
            <ErrorState
              title="This Project is unavailable"
              description="Your Project access may have changed."
              action={
                <Button onClick={() => void project.refetch()}>
                  Refresh Project
                </Button>
              }
            />
          ) : project.isPending || project.isFetching || !project.data ? (
            <SkeletonBlock label="Loading shared Project" />
          ) : (
            <MemberProjectPage
              key={project.data.id}
              project={project.data}
              requestScope={scope}
            />
          )}
        </>
      )}
    </section>
  );
}

function NativeMemberEpoch({
  scope,
  stationId,
  client,
}: {
  scope: Scope;
  stationId: string;
  client: QueryClient;
}) {
  return (
    <QueryClientProvider client={client}>
      <NativeMemberProjects scope={scope} stationId={stationId} />
    </QueryClientProvider>
  );
}

/** Member reads and local connection recovery never mount operator providers or persist their cache. */
function NativeRelayMemberContent() {
  const { activeConnection } = useConnections();
  const scope = useHostRequestAuthorityScope();
  const { navigate } = useNavigation();
  const authorityKey = scope?.isCurrent() ? scope.authorityKey : null;
  const previousAuthority = useRef(authorityKey);
  const memberClient = useMemo(
    () => (authorityKey ? new QueryClient({ defaultOptions: options }) : null),
    [authorityKey],
  );
  useEffect(
    () => () => {
      if (memberClient) {
        void memberClient.cancelQueries();
        memberClient.clear();
      }
    },
    [memberClient],
  );
  useEffect(() => {
    if (previousAuthority.current !== authorityKey) {
      previousAuthority.current = authorityKey;
      navigate('/');
    }
  }, [authorityKey, navigate]);
  const [recoveryClient] = useState(
    () => new QueryClient({ defaultOptions: options }),
  );
  useEffect(
    () => () => {
      void recoveryClient.cancelQueries();
      recoveryClient.clear();
    },
    [recoveryClient],
  );
  const route = activeConnection?.nativeBrokerRoute;
  if (!route) return null;
  return (
    <PageFrame
      spec={{
        title: activeConnection.name,
        width: 'full',
      }}
      routeIdentity={`native-relay:${activeConnection.id}`}
    >
      <PageFrameActions>
        <ThemeToggle />
      </PageFrameActions>
      <main className="project-page">
        <div className="project-page__inner">
          <QueryClientProvider client={recoveryClient}>
            <details open={!scope?.isCurrent()} className="native-relay-setup">
              <summary>Your Station connection</summary>
              <NativeSavedStations
                onInvitationAccepted={(accepted, capturedScope) => {
                  if (
                    !memberClient ||
                    !scope?.isCurrent() ||
                    !capturedScope.isCurrent() ||
                    capturedScope.authorityKey !== scope.authorityKey ||
                    capturedScope.apiBase !== scope.apiBase ||
                    accepted.scope.stationId !== route.stationId
                  )
                    return;
                  void memberClient.invalidateQueries({
                    queryKey: [
                      'native-member-projects',
                      scope.apiBase,
                      scope.authorityKey,
                    ],
                    exact: true,
                  });
                }}
              />
            </details>
          </QueryClientProvider>
          {scope?.isCurrent() && memberClient ? (
            <NativeMemberEpoch
              key={scope.authorityKey}
              scope={scope}
              stationId={route.stationId}
              client={memberClient}
            />
          ) : (
            <p>Finish the steps above to see your shared projects.</p>
          )}
        </div>
      </main>
    </PageFrame>
  );
}

export function NativeRelayMemberShell() {
  return (
    <LocaleProvider>
      <NavigationProvider>
        <ToastProvider>
          <KeyboardShortcutsProvider>
            <div className="native-relay-member-shell native-relay-setup">
              <NativeRelayMemberContent />
            </div>
          </KeyboardShortcutsProvider>
        </ToastProvider>
      </NavigationProvider>
    </LocaleProvider>
  );
}
