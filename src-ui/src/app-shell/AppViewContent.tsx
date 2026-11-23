import { lazy } from 'react';
// Deep import, not the barrel: this file is in the eager shell chunk, and
// the barrel also reaches `PageEyebrowTrail`, which only lazy route views use.
import { PageFrame } from '../components/page-frame/PageFrame';
import { ErrorState, SkeletonList } from '../components/state';
import type { AgentSummary, NavigationView } from '../types';
import { resolvePageFrame } from './page-frame-registry';
import { RoutePendingSkeleton } from './RoutePendingSkeleton';
import { routeIdentity, routeSurfaceIdentity } from './route-identity';
import './route-transition.css';
import { CustomizeShell } from './CustomizeShell';
import {
  APP_DESTINATION_REGISTRY,
  customizeItemForView,
} from './destination-registry';
import { RouteViewBoundary } from './RouteViewBoundary';

const ProjectAdminRoute = lazy(() =>
  import('./ProjectAdminRoute').then((module) => ({
    default: module.ProjectAdminRoute,
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
const CustomizeLanding = lazy(() =>
  import('../views/customize/CustomizeLanding').then((module) => ({
    default: module.CustomizeLanding,
  })),
);
const CustomizeSectionFrame = lazy(() =>
  import('../views/CustomizeSectionFrame').then((module) => ({
    default: module.CustomizeSectionFrame,
  })),
);
const ComputersPage = lazy(() =>
  import('../views/connections-hub/ComputersPage').then((module) => ({
    default: module.ComputersPage,
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
const AppearancePage = lazy(() =>
  import('../pages/AppearancePage').then((module) => ({
    default: module.AppearancePage,
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
const AppsView = lazy(() =>
  import('../views/apps/AppsView').then((module) => ({
    default: module.AppsView,
  })),
);
const ProfilePage = lazy(() =>
  import('../pages/ProfilePage').then((module) => ({
    default: module.ProfilePage,
  })),
);
const ProjectPage = lazy(() =>
  import('../views/ProjectPage').then((module) => ({
    default: module.ProjectPage,
  })),
);
const WorkspaceProjectRoute = lazy(() =>
  import('./WorkspaceProjectRoute').then((module) => ({
    default: module.WorkspaceProjectRoute,
  })),
);
const ProjectFlowConsoleView = lazy(() =>
  import('../views/ProjectFlowConsoleView').then((module) => ({
    default: module.ProjectFlowConsoleView,
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
// #2062. Lazy for the same reason every other view here is: a Board's host
// pulls in the layout renderer, and the panel's Boards section must not put
// that in the entry bundle for a Station where nobody opens one.
const PersonalBoardView = lazy(() =>
  import('../views/PersonalBoardView').then((module) => ({
    default: module.PersonalBoardView,
  })),
);

interface AppViewContentProps {
  currentView: NavigationView;
  stationUnavailable?: boolean;
  agents: AgentSummary[];
  apiBase: string;
  availableModels: Array<{ id: string; name: string }>;
  defaultModel?: string;
  onNavigate: (view: NavigationView) => void;
  /**
   * Show Home BY NAME (#1523): reveals the Home surface, placing it in `main`.
   * For an affordance that says "home" — the not-found view's "Go home".
   */
  onShowHome: () => void;
  /**
   * Leave the routed view for `/`, whatever occupies `main` (#1523). For a
   * dismissal — the Settings view's Escape, the New Project modal's close —
   * which returns the user to where they were, Activity in `main` included.
   */
  onReturnToOutlet: () => void;
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
  // `getDestinationForView` resolution `ProjectSidebarNav` uses, so the row marked
  // pending is by construction the row that will be marked active.
  const pendingSurfaceId =
    APP_DESTINATION_REGISTRY.getDestinationForView(props.currentView)?.id ??
    null;
  // Resolved ONCE and handed to both consumers: the frame that renders the
  // header, and the boundary that renders the body while the route's chunk is
  // in flight. Two calls would be two chances to disagree about what the
  // arriving page looks like — which is the whole of archive#3660.
  const frameSpec = resolvePageFrame(props.currentView);
  const customizeItem = customizeItemForView(props.currentView);
  const page = (
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
        stationUnavailable={props.stationUnavailable}
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
        <div
          className={`route-transition${props.currentView.type === 'layout' ? ' route-transition--fill' : ''}`}
          key={surfaceKey}
        >
          <AppViewContentBody {...props} />
        </div>
      </RouteViewBoundary>
    </PageFrame>
  );
  // A Customize item's page sits beside the Customize list, which stays
  // mounted across items and so lives outside the frame.
  return customizeItem ? (
    <CustomizeShell activeId={customizeItem} fill={frameSpec?.body === 'fill'}>
      {page}
    </CustomizeShell>
  ) : (
    page
  );
}

function AppViewContentBody({
  currentView,
  agents,
  apiBase,
  availableModels,
  defaultModel,
  onNavigate,
  onShowHome,
  onReturnToOutlet,
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
  if (currentView.type === 'apps') {
    return <AppsView tab={currentView.tab} />;
  }
  if (currentView.type === 'customize') {
    return <CustomizeLanding />;
  }
  if (currentView.type === 'connections-models') {
    return (
      <CustomizeSectionFrame sectionId="providers">
        <ProviderSettingsView onNavigate={onNavigate} />
      </CustomizeSectionFrame>
    );
  }
  if (currentView.type === 'connections-model-edit') {
    return (
      <CustomizeSectionFrame sectionId="providers">
        <ProviderSettingsView
          selectedProviderId={currentView.id}
          onNavigate={onNavigate}
        />
      </CustomizeSectionFrame>
    );
  }
  if (currentView.type === 'connections-engine-edit') {
    return (
      <CustomizeSectionFrame
        sectionId="engines"
        creating={currentView.id === 'new'}
      >
        <AgentConnectionView
          selectedRuntimeId={currentView.id}
          agents={agents}
          onNavigate={onNavigate}
        />
      </CustomizeSectionFrame>
    );
  }
  if (currentView.type === 'connections-engines') {
    return (
      <CustomizeSectionFrame sectionId="engines">
        <AgentConnectionView agents={agents} onNavigate={onNavigate} />
      </CustomizeSectionFrame>
    );
  }
  // A deep link to one catalogue entry (`/customize/engines/new/<id>`,
  // and the legacy `/connections/acp/new/<id>` that redirects here) opens
  // the same Add engine flow on that entry's confirm step.
  if (currentView.type === 'connections-engine-new') {
    return (
      <CustomizeSectionFrame sectionId="engines" creating>
        <AgentConnectionView
          selectedRuntimeId="new"
          addChoiceId={currentView.providerId}
          agents={agents}
          onNavigate={onNavigate}
        />
      </CustomizeSectionFrame>
    );
  }
  if (
    currentView.type === 'connections-tools' ||
    currentView.type === 'connections-tool-edit'
  ) {
    return (
      <CustomizeSectionFrame sectionId="tools">
        <IntegrationsView />
      </CustomizeSectionFrame>
    );
  }
  if (currentView.type === 'connections-knowledge') {
    return (
      <CustomizeSectionFrame sectionId="knowledge">
        <KnowledgeConnectionView />
      </CustomizeSectionFrame>
    );
  }
  if (currentView.type === 'connections-computers') {
    return <ComputersPage />;
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
    return (
      <ProjectAdminRoute
        route={currentView}
        onReturnToOutlet={onReturnToOutlet}
      />
    );
  }
  if (currentView.type === 'project-edit') {
    return (
      <ProjectAdminRoute
        route={currentView}
        onReturnToOutlet={onReturnToOutlet}
      />
    );
  }
  if (currentView.type === 'layout' || currentView.type === 'workspace-pane') {
    return <WorkspaceProjectRoute route={currentView} />;
  }
  if (currentView.type === 'project') {
    return <ProjectPage slug={currentView.slug} />;
  }
  if (currentView.type === 'task') {
    return <TaskWorkspaceView taskId={currentView.taskId} />;
  }
  if (currentView.type === 'board') {
    return <BoardView reference={currentView.reference} />;
  }
  if (currentView.type === 'personal-board') {
    // No `WorkspacePaneHostActionsFrame`: that frame is project-scoped and
    // takes a required `projectSlug`, which a Board has none of.
    return <PersonalBoardView boardSlug={currentView.boardSlug} />;
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
        // Escape from Settings is a dismissal, the same return as the ⌘,
        // toggle: the outlet's occupant, not Home by name (#1523).
        onBack={onReturnToOutlet}
        onSaved={onSettingsSaved}
        onNavigate={onNavigate}
      />
    );
  }
  if (currentView.type === 'profile') {
    return <ProfilePage />;
  }
  if (currentView.type === 'appearance') {
    return <AppearancePage />;
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
            // Says "home", means Home: the Home surface, not `/`'s occupant.
            onClick={onShowHome}
          >
            Go home
          </button>
        }
      />
    );
  }

  return null;
}
