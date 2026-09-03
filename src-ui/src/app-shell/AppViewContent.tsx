import { useConnections } from '@kontourai/station-connect';
import { lazy } from 'react';
// Deep import, not the barrel: this file is in the eager shell chunk, and
// the barrel also reaches `PageEyebrowTrail`, which only lazy route views use.
import { PageFrame } from '../components/page-frame/PageFrame';
import { ErrorState, SkeletonList } from '../components/state';
import {
  shouldRenderSetupLauncher,
  useOnboardingSetupState,
} from '../contexts/onboarding-setup-store';
import type { AgentSummary, NavigationView } from '../types';
import { resolvePageFrame } from './page-frame-registry';
import { RoutePendingSkeleton } from './RoutePendingSkeleton';
import { routeIdentity, routeSurfaceIdentity } from './route-identity';
import './route-transition.css';
import { RouteViewBoundary } from './RouteViewBoundary';
import { APP_SURFACE_REGISTRY } from './surface-registry';

// Project creation is a route-only overlay. Keeping it lazy avoids charging
// every initial desktop load for its form, icon picker, and path autocomplete.
const NewProjectModal = lazy(() =>
  import('../components/modals/NewProjectModal').then((module) => ({
    default: module.NewProjectModal,
  })),
);

const ACPConnectionsView = lazy(() =>
  import('../views/ACPConnectionsView').then((module) => ({
    default: module.ACPConnectionsView,
  })),
);
const AgentConnectionView = lazy(() =>
  import('../views/AgentConnectionView').then((module) => ({
    default: module.AgentConnectionView,
  })),
);
const AgentsView = lazy(() =>
  import('../views/AgentsView').then((module) => ({
    default: module.AgentsView,
  })),
);
const ConnectionsHub = lazy(() =>
  import('../views/ConnectionsHub').then((module) => ({
    default: module.ConnectionsHub,
  })),
);
const ConnectionsSectionFrame = lazy(() =>
  import('../views/ConnectionsSectionFrame').then((module) => ({
    default: module.ConnectionsSectionFrame,
  })),
);
const ComputersSection = lazy(() =>
  import('../views/connections-hub/ComputersSection').then((module) => ({
    default: module.ComputersSection,
  })),
);
const HomeView = lazy(() =>
  import('../views/HomeView').then((module) => ({
    default: module.HomeView,
  })),
);
const IntegrationsView = lazy(() =>
  import('../views/IntegrationsView').then((module) => ({
    default: module.IntegrationsView,
  })),
);
const KnowledgeConnectionView = lazy(() =>
  import('../views/KnowledgeConnectionView').then((module) => ({
    default: module.KnowledgeConnectionView,
  })),
);
const DeveloperView = lazy(() =>
  import('../views/DeveloperView').then((module) => ({
    default: module.DeveloperView,
  })),
);
const NotificationsPage = lazy(() =>
  import('../pages/NotificationsPage').then((module) => ({
    default: module.NotificationsPage,
  })),
);
const GuidanceView = lazy(() =>
  import('../views/GuidanceView').then((module) => ({
    default: module.GuidanceView,
  })),
);
const PluginManagementView = lazy(() =>
  import('../views/PluginManagementView').then((module) => ({
    default: module.PluginManagementView,
  })),
);
const ProfilePage = lazy(() =>
  import('../pages/ProfilePage').then((module) => ({
    default: module.ProfilePage,
  })),
);
const ProjectLayoutRenderer = lazy(() =>
  import('./ProjectLayoutRenderer').then((module) => ({
    default: module.ProjectLayoutRenderer,
  })),
);
const ProjectPage = lazy(() =>
  import('../views/ProjectPage').then((module) => ({
    default: module.ProjectPage,
  })),
);
const WorkspacePaneRouteView = lazy(() =>
  import('../workspace-panes/WorkspacePaneRouteView').then((module) => ({
    default: module.WorkspacePaneRouteView,
  })),
);
const ProjectFlowConsoleView = lazy(() =>
  import('../views/ProjectFlowConsoleView').then((module) => ({
    default: module.ProjectFlowConsoleView,
  })),
);
const ProjectSettingsView = lazy(() =>
  import('../views/ProjectSettingsView').then((module) => ({
    default: module.ProjectSettingsView,
  })),
);
const ProviderSettingsView = lazy(() =>
  import('../views/ProviderSettingsView').then((module) => ({
    default: module.ProviderSettingsView,
  })),
);
const RegistryView = lazy(() =>
  import('../views/RegistryView').then((module) => ({
    default: module.RegistryView,
  })),
);
const ReviewQueueView = lazy(() =>
  import('../views/ReviewQueueView').then((module) => ({
    default: module.ReviewQueueView,
  })),
);
const ScheduleView = lazy(() =>
  import('../views/ScheduleView').then((module) => ({
    default: module.ScheduleView,
  })),
);
const ConsoleBoardView = lazy(() =>
  import('../views/ConsoleBoardView').then((module) => ({
    default: module.ConsoleBoardView,
  })),
);
// The standalone placement of the Activity Workspace Pane (
// archive#4142) — the pane path to the sessions surface, never the
// surface directly.
const ActivityView = lazy(() =>
  import('../views/ActivityView').then((module) => ({
    default: module.ActivityView,
  })),
);
const SettingsView = lazy(() =>
  import('../views/SettingsView').then((module) => ({
    default: module.SettingsView,
  })),
);
const TaskWorkspaceView = lazy(() =>
  import('../views/TaskWorkspaceView').then((module) => ({
    default: module.TaskWorkspaceView,
  })),
);
const BoardView = lazy(() =>
  import('../views/BoardView').then((module) => ({
    default: module.BoardView,
  })),
);

interface AppViewContentProps {
  currentView: NavigationView;
  agents: AgentSummary[];
  apiBase: string;
  availableModels: Array<{ id: string; name: string }>;
  defaultModel?: string;
  onNavigate: (view: NavigationView) => void;
  onNavigateHome: () => void;
  onSettingsSaved: () => void;
  projectsLoading?: boolean;
  homeContinuation?: Extract<
    NavigationView,
    { type: 'layout' } | { type: 'project' }
  > | null;
}

export function AppViewContent(props: AppViewContentProps) {
  // One rule for what counts as a different route, shared by the entrance and
  // the pending publisher so they can never disagree about it. See
  // `routeIdentity` for what is and is not part of a route's identity.
  const routeKey = routeIdentity(props.currentView);
  const surfaceKey = routeSurfaceIdentity(props.currentView);
  // The surface the sidebar would highlight for this view — the same
  // `getSurfaceForView` resolution `ProjectSidebarNav` uses, so the row marked
  // pending is by construction the row that will be marked active.
  const pendingSurfaceId =
    APP_SURFACE_REGISTRY.getSurfaceForView(props.currentView)?.id ?? null;
  // Resolved ONCE and handed to both consumers: the frame that renders the
  // header, and the boundary that renders the body while the route's chunk is
  // in flight. Two calls would be two chances to disagree about what the
  // arriving page looks like — which is the whole of archive#3660.
  const frameSpec = resolvePageFrame(props.currentView);
  return (
    // The frame is the outermost thing a route renders, above the boundary
    // and above Suspense: the page keeps its header while its chunk loads and
    // while its error state is on screen, so a failed route still tells you
    // which page failed (SHELL-06's companion — the route error used to be
    // the entire screen). The frame takes the section surface identity so a
    // Connections list/edit pair can preserve its detail root; the boundary
    // below keeps the exact route identity for errors and pending state.
    <PageFrame spec={frameSpec} routeIdentity={surfaceKey}>
      <RouteViewBoundary
        routeKey={routeKey}
        pendingSurfaceId={pendingSurfaceId}
        pendingBody={
          <RoutePendingSkeleton view={props.currentView} spec={frameSpec} />
        }
      >
        {/* The entrance lives here, at the one seam every route passes through,
            instead of on `.page` — which eight split-pane routes never render.
            `key` remounts it on an actual surface transition; Connections
            list/edit routes intentionally share a section surface.

            station#753 item 4 (skeleton -> content fade) was tried here as a
            second, nested `.route-outlet-content` wrapper keyed the same as
            this div — review found it was a no-op key (identical to the
            parent's) wrapping an animation that COMPOUNDS with `route-enter`
            below rather than resolving ahead of it: opacity is the PRODUCT of
            both curves, so content is measurably LATER at 25ms (0.031 vs
            0.359), the opposite of what both this comment and the CSS
            comment claimed. The Suspense boundary above is OUTSIDE
            `.route-transition`, so a skeleton->content reveal and a route
            entrance remount TOGETHER here — `route-enter` already IS the
            item-4 fade for every route this seam covers. Removed; do not
            re-add without re-deriving the actual composed opacity curve. */}
        <div className="route-transition" key={surfaceKey}>
          <AppViewContentBody {...props} />
        </div>
      </RouteViewBoundary>
    </PageFrame>
  );
}

function AppViewContentBody({
  currentView,
  agents,
  apiBase,
  availableModels,
  defaultModel,
  onNavigate,
  onNavigateHome,
  onSettingsSaved,
  projectsLoading,
  homeContinuation,
}: AppViewContentProps) {
  if (currentView.type === 'home') {
    return (
      <HomeView
        continuation={homeContinuation ?? null}
        onNavigate={onNavigate}
      />
    );
  }
  if (
    currentView.type === 'agents' ||
    currentView.type === 'agent-new' ||
    currentView.type === 'agent-edit'
  ) {
    return (
      <AgentsView
        agents={agents}
        apiBase={apiBase}
        availableModels={availableModels}
        defaultModel={defaultModel}
        onNavigate={onNavigate}
      />
    );
  }

  if (currentView.type === 'guidance') {
    return <GuidanceView route={currentView} />;
  }
  if (currentView.type === 'registry') {
    return <RegistryView initialTab={currentView.tab} />;
  }
  if (currentView.type === 'review-queue') {
    return <ReviewQueueView />;
  }
  if (currentView.type === 'activity') {
    return (
      <ActivityView
        apiBase={apiBase}
        sessionId={currentView.sessionId}
        focusHint={currentView.focus}
      />
    );
  }
  if (currentView.type === 'plugins') {
    return <PluginManagementView onNavigate={onNavigate} />;
  }
  if (currentView.type === 'connections') {
    return <ConnectionsHub />;
  }
  if (currentView.type === 'connections-models') {
    return (
      <ConnectionsSectionFrame sectionId="models">
        <ProviderSettingsView onNavigate={onNavigate} />
      </ConnectionsSectionFrame>
    );
  }
  if (currentView.type === 'connections-model-edit') {
    return (
      <ConnectionsSectionFrame sectionId="models">
        <ProviderSettingsView
          selectedProviderId={currentView.id}
          onNavigate={onNavigate}
        />
      </ConnectionsSectionFrame>
    );
  }
  if (currentView.type === 'connections-engine-edit') {
    return (
      <ConnectionsSectionFrame sectionId="engines">
        <AgentConnectionView
          selectedRuntimeId={currentView.id}
          onNavigate={onNavigate}
        />
      </ConnectionsSectionFrame>
    );
  }
  if (currentView.type === 'connections-engines') {
    return (
      <ConnectionsSectionFrame sectionId="engines">
        <AgentConnectionView onNavigate={onNavigate} />
      </ConnectionsSectionFrame>
    );
  }
  if (currentView.type === 'connections-engine-new') {
    return (
      <ConnectionsSectionFrame sectionId="engines">
        <ACPConnectionsView
          agents={agents}
          initialProviderId={currentView.providerId}
        />
      </ConnectionsSectionFrame>
    );
  }
  if (
    currentView.type === 'connections-tools' ||
    currentView.type === 'connections-tool-edit'
  ) {
    return (
      <ConnectionsSectionFrame sectionId="tools">
        <IntegrationsView />
      </ConnectionsSectionFrame>
    );
  }
  if (currentView.type === 'connections-knowledge') {
    return (
      <ConnectionsSectionFrame sectionId="knowledge">
        <KnowledgeConnectionView />
      </ConnectionsSectionFrame>
    );
  }
  if (currentView.type === 'connections-computers') {
    return (
      <ConnectionsSectionFrame sectionId="computers">
        <ComputersSection />
      </ConnectionsSectionFrame>
    );
  }
  if (currentView.type === 'project-new') {
    // On a cold load the root path resolves to 'project-new' (the no-lastProject
    // fallback) before the projects query settles, briefly flashing the New
    // Project modal until the projects-aware redirect routes to the default
    // project. Wait until we actually know no projects exist.
    //
    // SHELL-13: this used to be `FullScreenLoader` — Station's boot splash,
    // logo and cycling "Negotiating with the cloud..." phrases — rendered from
    // INSIDE an authenticated shell, so opening /projects/new tore down the
    // sidebar, toolbar and dock for the length of one list read. A full-screen
    // loader is a pre-shell affordance; a route that is already inside the
    // shell fills its own region and leaves the chrome alone.
    if (projectsLoading) {
      return <SkeletonList count={3} label="Loading your projects" />;
    }
    return <ProjectNewViewGate onNavigateHome={onNavigateHome} />;
  }
  if (currentView.type === 'project-edit') {
    return <ProjectSettingsView slug={currentView.slug} />;
  }
  if (currentView.type === 'layout') {
    return (
      <ProjectLayoutRenderer
        projectSlug={currentView.projectSlug}
        layoutSlug={currentView.layoutSlug}
      />
    );
  }
  if (currentView.type === 'project') {
    return <ProjectPage slug={currentView.slug} />;
  }
  if (currentView.type === 'workspace-pane') {
    return (
      <WorkspacePaneRouteView
        projectSlug={currentView.projectSlug}
        layoutSlug={currentView.layoutSlug}
        descriptorId={currentView.descriptorId}
        instanceId={currentView.instanceId}
      />
    );
  }
  if (currentView.type === 'task') {
    return <TaskWorkspaceView taskId={currentView.taskId} />;
  }
  if (currentView.type === 'board') {
    return <BoardView reference={currentView.reference} />;
  }
  if (currentView.type === 'project-session-board') {
    return <ConsoleBoardView projectSlug={currentView.slug} />;
  }
  if (currentView.type === 'project-flow-console') {
    return (
      <ProjectFlowConsoleView
        projectSlug={currentView.slug}
        runId={currentView.runId}
      />
    );
  }
  if (currentView.type === 'settings') {
    return (
      <SettingsView
        onBack={onNavigateHome}
        onSaved={onSettingsSaved}
        onNavigate={onNavigate}
      />
    );
  }
  if (currentView.type === 'profile') {
    return <ProfilePage />;
  }
  if (currentView.type === 'notifications') {
    return <NotificationsPage />;
  }
  if (currentView.type === 'developer') {
    return <DeveloperView tab={currentView.tab} apiBase={apiBase} />;
  }
  if (currentView.type === 'schedule') {
    return <ScheduleView />;
  }
  if (currentView.type === 'not-found') {
    return (
      <ErrorState
        title="Page not found"
        description={
          <>
            No view matches <code>{currentView.path}</code>.
          </>
        }
        action={
          <button
            type="button"
            className="editor-btn editor-btn--primary"
            onClick={onNavigateHome}
          >
            Go home
          </button>
        }
      />
    );
  }

  return null;
}

/**
 * `project-new` is the one genuinely-first-run coincidence (zero connections
 * AND zero projects): the first-run `SetupLauncher` already covers the full
 * screen with its own backdrop, so stacking `NewProjectModal` behind it is a
 * second, redundant overlay (archive#191). Suppressing it here only changes
 * behavior for this view; a later, non-blocking banner (e.g. the user's only
 * connection gets disabled mid-session on some other view) is untouched and
 * still renders its normal content underneath.
 */
function ProjectNewViewGate({
  onNavigateHome,
}: {
  onNavigateHome: () => void;
}) {
  const { activeConnection } = useConnections();
  const { visible, content } = useOnboardingSetupState();
  const setupLauncherVisible = shouldRenderSetupLauncher({
    credentialRequired: activeConnection?.credentialState === 'required',
    setupVisible: visible,
    setupContent: content,
    pathname: window.location.pathname,
  });

  if (setupLauncherVisible) {
    return null;
  }

  return (
    <NewProjectModal
      isOpen
      onClose={() => {
        if (window.location.pathname === '/projects/new') {
          onNavigateHome();
        }
      }}
    />
  );
}
