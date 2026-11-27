import { useConnections } from '@kontourai/station-connect';
import type { MemberProjectView } from '@kontourai/station-contracts/project';
import type { WorkspacePaneAvailabilityAction } from '@kontourai/station-contracts/workspace-pane-availability';
import {
  StationHttpError,
  useApplyProjectLayoutMutation,
  useAvailableProjectLayoutsQuery,
  useKnowledgeDocsQuery,
  useKnowledgeNamespacesQuery,
  useKnowledgeStatusQuery,
  useProjectLayoutsQuery,
} from '@kontourai/station-sdk';
import { useReducer, useRef, useState } from 'react';
import { Button } from '../components/Button';
import { BranchGlyph } from '../components/icons/Glyph';
import { LazyBoundary } from '../components/LazyBoundary';
import { requestNewChannel } from '../components/project-conversations/new-channel-request';
import { ProjectConversationList } from '../components/project-conversations/ProjectConversationList';
import { useStationExtensionsAccess } from '../components/registry/StationExtensionsAccess';
import { ErrorState, SkeletonBlock } from '../components/state';
import { useNavigation } from '../contexts/NavigationContext';
import {
  type ProjectConfig,
  useScopedProjectPageViewQuery,
} from '../contexts/ProjectsContext';
import { useForegroundProject } from '../hooks/projectForeground';
import { useDegradedQueryState } from '../hooks/useDegradedQueryState';
import { useGitLog, useGitStatus } from '../hooks/useGitStatus';
import { useIsMobile } from '../hooks/useIsMobile';
import { trackRecentLayout } from '../hooks/useRecentLayouts';
import { requestTaskShaping } from '../lib/task-shaping';
import { errorText } from '../utils/errorText';
import { ProjectWorkspacePaneModal } from '../workspace-panes/ProjectWorkspacePaneCatalog';
import { useResolvedWorkspacePaneCatalog } from '../workspace-panes/resolvedWorkspacePaneCatalog';
import type { WorkspacePaneAvailabilityCatalogEntry } from '../workspace-panes/workspacePaneAvailabilityPresentation';
import {
  workspacePaneDirectRoute,
  workspacePaneRequiresLayoutIdentity,
} from '../workspace-panes/workspacePaneDirectRoute';
import { COMPUTERS_PATH } from './connections-hub/connection-sections';
import { MemberProjectPage } from './project-page/MemberProjectPage';
import { ProjectHeldBanner } from './project-page/ProjectHeldBanner';
import { ProjectKnowledgeSection } from './project-page/ProjectKnowledgeSection';
import {
  ProjectAddLayoutModal,
  ProjectLayoutsSection,
} from './project-page/ProjectLayoutsSection';
import { ProjectLibrarySection } from './project-page/ProjectLibrarySection';
import { ProjectLiveWorkSection } from './project-page/ProjectLiveWorkSection';
import {
  ProjectNavigation,
  useProjectDestination,
} from './project-page/ProjectNavigation';
import { ProjectOverviewSection } from './project-page/ProjectOverviewSection';
import { ProjectPageHeader } from './project-page/ProjectPageHeader';
import { ProjectPluginPublishSection } from './project-page/ProjectPluginPublishSection';
import { ProjectRoom } from './project-page/ProjectRoom';
import { ProjectTasksSection } from './project-page/ProjectTasksSection';
import { ProjectWebMcpShare } from './project-page/ProjectWebMcp';
import { useProjectSearch } from './project-page/project-room-navigation';
import { SetupRecommendationsCard } from './project-page/SetupRecommendationsCard';
import type { AvailableLayout } from './project-page/types';
import { useListScrollMemory } from './project-page/useListScrollMemory';
import {
  ProjectRepositoriesSection,
  ProjectSourcesSection,
} from './project-settings/ProjectSourcesSection';
import { useProjectCoordinationPreview } from './project-settings/projectCoordinationPreview';
import './project-page-frame.css';
import './ProjectPage.css';

// Epic #2323 S2: the plugin-start offer (its eligibility query included)
// loads after first paint, off the entry bundle.
const loadProjectPluginStartGate = () =>
  import('./project-page/ProjectPluginStartGate').then((module) => ({
    default: module.ProjectPluginStartGate,
  }));

export function ProjectPage({ slug }: { slug: string }) {
  const projectQuery = useScopedProjectPageViewQuery(slug);
  const { captureCredentialEvidence, isCredentialEvidenceCurrent } =
    useConnections();
  const evidence = captureCredentialEvidence();
  const selectedNativeRelay = Boolean(
    evidence?.nativeBrokerRoute && isCredentialEvidenceCurrent(evidence),
  );
  const { navigate } = useNavigation();
  const [projectRetrySeq, bumpProjectRetry] = useReducer(
    (n: number) => n + 1,
    0,
  );
  const projectQueryState = useDegradedQueryState({
    isPending: projectQuery.isPending,
    resetKey: projectRetrySeq,
  });
  const requestScope = projectQuery.requestScope;

  if (!requestScope?.isCurrent()) {
    if (selectedNativeRelay) {
      return (
        <div className="project-page">
          <div className="project-page__inner">
            <ErrorState
              title="Sign in to this Station account"
              description="A native relay route is selected. Sign in to its Station account before opening shared Projects."
              action={
                <Button onClick={() => navigate(COMPUTERS_PATH)}>
                  Open Station connections
                </Button>
              }
            />
          </div>
        </div>
      );
    }
    return (
      <div className="project-page">
        <div className="project-page__inner">
          <ErrorState
            title="Station connection unavailable"
            description="Connect to a Station with current access to this Project."
          />
        </div>
      </div>
    );
  }

  if (projectQuery.isError) {
    return (
      <div className="project-page">
        <div className="project-page__inner">
          <ErrorState
            title="Could not load project"
            description={
              projectQuery.error instanceof StationHttpError &&
              [401, 403, 404].includes(projectQuery.error.status)
                ? 'This Project is unavailable or your access has changed.'
                : errorText(projectQuery.error)
            }
            action={
              <button type="button" onClick={() => void projectQuery.refetch()}>
                Retry
              </button>
            }
          />
        </div>
      </div>
    );
  }

  if (projectQuery.isPending || !projectQuery.data) {
    if (projectQueryState === 'degraded') {
      return (
        <div className="project-page">
          <div className="project-page__inner">
            <ErrorState
              title="Project is taking longer than expected"
              description="This view hasn't loaded yet."
              action={
                <button
                  type="button"
                  onClick={() => {
                    bumpProjectRetry();
                    void projectQuery.refetch();
                  }}
                >
                  Retry
                </button>
              }
            />
          </div>
        </div>
      );
    }
    return (
      <div className="project-page">
        <div className="project-page__inner">
          <SkeletonBlock count={3} label="Loading project" />
        </div>
      </div>
    );
  }

  if (projectQuery.isMemberProject) {
    return (
      <MemberProjectPage
        project={projectQuery.data as MemberProjectView}
        requestScope={requestScope}
      />
    );
  }

  if (selectedNativeRelay) {
    return (
      <div className="project-page">
        <div className="project-page__inner">
          <ErrorState
            title="This Project is not shared with this account"
            description="Ask a Station operator to share it with you."
          />
        </div>
      </div>
    );
  }

  return (
    <ProjectOperatorPage
      slug={slug}
      project={projectQuery.data as ProjectConfig}
      requestScope={requestScope}
    />
  );
}

function ProjectOperatorPage({
  slug,
  project,
  requestScope,
}: {
  slug: string;
  project: ProjectConfig;
  requestScope: NonNullable<
    ReturnType<typeof useScopedProjectPageViewQuery>['requestScope']
  >;
}) {
  const { setLayout, navigate, updateParams } = useNavigation();
  // #5072: this Project's own alerts are not sent here while it is shown.
  useForegroundProject(project.id);
  // The Tasks section's presentation: the board unless the address asks
  // for the list (`?tasksView=list`).
  const tasksView =
    new URLSearchParams(useProjectSearch()).get('tasksView') === 'list'
      ? 'list'
      : 'board';
  const {
    destination,
    selectDestination,
    room,
    openRoom,
    openThread,
    leaveRoom,
  } = useProjectDestination(slug);
  // #4795: on a phone the Project page is its channel list, and a channel
  // is its own full screen; one breakpoint, `MOBILE_MEDIA_QUERY`.
  const phone = useIsMobile();
  const projectCoordination = useProjectCoordinationPreview();
  const roomScreen = phone && destination === 'room';
  const pageRef = useRef<HTMLDivElement>(null);
  const { openFromList } = useListScrollMemory(
    slug,
    pageRef,
    phone && destination === 'overview',
    roomScreen,
  );
  const extensionAccess = useStationExtensionsAccess();
  // #801: the page renders as soon as the *project* query settles, so a
  // layouts fetch still in flight used to reach the section as an empty array
  // and render the empty state for a project that has layouts.
  const {
    data: layouts = [],
    isLoading: layoutsLoading,
    isFetching: layoutsFetching,
    isError: layoutsError,
    refetch: refetchLayouts,
  } = useProjectLayoutsQuery(slug, {
    // IndexedDB can still hold the list from before an applied layout.
    refetchOnMount: 'always',
  });
  const layoutsPending = layoutsLoading || layoutsFetching;
  const layoutOpenNotice = layoutsPending
    ? 'Layouts are still loading.'
    : layoutsError
      ? 'Could not load layouts. Close this picker and retry.'
      : undefined;
  const { data: gitStatus } = useGitStatus(slug, project?.workingDirectory);
  const { data: gitLog = [] } = useGitLog(slug, project?.workingDirectory, 5);
  const {
    data: docs = [],
    isPending: docsPending,
    isError: docsError,
    error: docsFailure,
    refetch: refetchDocs,
  } = useKnowledgeDocsQuery(slug);
  const knowledgeStatusQuery = useKnowledgeStatusQuery(slug);
  const knowledgeStatus = knowledgeStatusQuery.data;
  const namespacesQuery = useKnowledgeNamespacesQuery(slug);
  const namespaces = namespacesQuery.data ?? [];
  const paneCatalog = useResolvedWorkspacePaneCatalog(slug);

  const [showAddLayout, setShowAddLayout] = useState(false);
  const [showAddPane, setShowAddPane] = useState(false);
  const [layoutOpenBlocked, setLayoutOpenBlocked] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<unknown>(null);

  const layoutCatalog = useAvailableProjectLayoutsQuery({
    enabled: showAddLayout,
  });
  const available = layoutCatalog.data ?? [];

  const applyLayoutMutation = useApplyProjectLayoutMutation(slug);

  async function addLayout(item: AvailableLayout) {
    setAdding(item.slug);
    setApplyError(null);
    try {
      await applyLayoutMutation.mutateAsync(item.id);
      trackRecentLayout(item.id);
      setShowAddLayout(false);
    } catch (error: unknown) {
      // 4-HOME-014, same defect as the Settings picker: this was
      // `catch { /* ignore */ }`, leaving the dialog open and silent.
      setApplyError(error);
    }
    setAdding(null);
  }

  function openPane(entry: WorkspacePaneAvailabilityCatalogEntry) {
    if (!entry.instance) return;
    const requiresLayout = workspacePaneRequiresLayoutIdentity(
      entry.descriptor,
    );
    if (requiresLayout && layoutOpenNotice) {
      setLayoutOpenBlocked(true);
      return;
    }
    setShowAddPane(false);
    // Every renderer in today's closed `requiresLayout` set reads Coding
    // layout configuration, so Coding is the intentional host capability.
    // Making this generic requires a versioned descriptor field naming its
    // accepted layout type(s), plus parser and retained-LayoutTab adaptation
    // checks so contributed routing metadata cannot bypass integrity checks.
    const hostingLayout = requiresLayout
      ? layouts.find(
          (layout: { slug: string; type?: string }) => layout.type === 'coding',
        )
      : undefined;
    const directRoute = workspacePaneDirectRoute(
      slug,
      entry.descriptor,
      entry.instance,
      hostingLayout?.slug,
    );
    if (!directRoute) {
      // Layout-bound panes cannot manufacture workspace identity. Start the
      // existing layout creation flow instead of advertising a route that is
      // guaranteed to reject the user on its next screen.
      setShowAddLayout(true);
      return;
    }
    if (hostingLayout && requiresLayout) {
      setLayout(slug, hostingLayout.slug);
    }
    navigate(directRoute);
  }

  function canExecutePaneAction(
    _entry: WorkspacePaneAvailabilityCatalogEntry,
    action: WorkspacePaneAvailabilityAction,
  ) {
    return (
      action.code === 'retry-availability-check' ||
      action.code === 'enable-distribution'
    );
  }

  function handlePaneAction(
    _entry: WorkspacePaneAvailabilityCatalogEntry,
    action: WorkspacePaneAvailabilityAction,
  ): string {
    if (action.code === 'retry-availability-check') {
      void paneCatalog.refetch();
      return 'Checking the current pane availability.';
    }
    if (action.code === 'enable-distribution') {
      navigate('/registry/layouts');
      return 'Opening Browse layouts to review distribution.';
    }
    return 'This build can explain the requirement but cannot complete that step from the pane catalog.';
  }

  return (
    <div
      ref={pageRef}
      className={`project-page project-page--space${roomScreen ? ' project-page--room-screen' : ''}`}
    >
      <div className="project-page__inner project-page__space">
        {!roomScreen && (
          <ProjectPageHeader
            project={project}
            {...(projectCoordination && project.goal
              ? { goal: project.goal }
              : {})}
            gitStatus={gitStatus}
            invitePeople={() =>
              navigate(`/projects/${slug}/edit`, { section: 'access' })
            }
            navigateToSettings={() => navigate(`/projects/${slug}/edit`)}
          />
        )}
        {!roomScreen && (
          <ProjectHeldBanner slug={slug} lifecycle={project.lifecycle} />
        )}

        <div className="section-nav-rail project-page__layout">
          {!roomScreen && <ProjectNavigation slug={slug} />}
          <section className="section-nav-rail__body project-page__content">
            <section
              hidden={destination !== 'overview'}
              aria-label="Project overview"
            >
              {/* #4795: on a phone the Project page leads with its channels. */}
              {phone && (
                <ProjectConversationList
                  variant="page"
                  project={{
                    slug,
                    id: project.id,
                    name: project.name || slug,
                  }}
                  requestScope={requestScope}
                  onOpenChannel={(channelId) =>
                    openFromList(() => openRoom(channelId))
                  }
                  onOpenTask={(taskId) =>
                    openFromList(() =>
                      navigate(`/tasks/${encodeURIComponent(taskId)}`, {
                        taskView: 'conversation',
                      }),
                    )
                  }
                  onMoreTasks={() => selectDestination('tasks')}
                  onNewChannel={() => {
                    requestNewChannel(slug);
                    openFromList(() => openRoom(undefined));
                  }}
                />
              )}
              <SetupRecommendationsCard
                requestScope={requestScope}
                project={{
                  id: project.id,
                  slug,
                  name: project.name || slug,
                  ...(project.description
                    ? { description: project.description }
                    : {}),
                }}
                hasRepository={Boolean(
                  gitStatus?.isRepo || project.repositorySource,
                )}
              />
              <div className="project-page__operator-actions">
                <Button
                  variant="primary"
                  onClick={() => requestTaskShaping({ projectSlug: slug })}
                >
                  New Task
                </Button>
                <Button onClick={() => selectDestination('sources')}>
                  Add files
                </Button>
              </div>
              {destination === 'overview' && (
                <>
                  <ProjectWebMcpShare project={project} scope={requestScope} />
                  <ProjectRepositoriesSection
                    slug={slug}
                    projectId={project.id}
                    onManageSources={() => selectDestination('sources')}
                  />
                </>
              )}
              <ProjectOverviewSection
                slug={slug}
                projectId={project.id}
                autoResolveDays={project.overviewAutoResolveDays}
              />
              <ProjectLiveWorkSection slug={slug} />
            </section>

            <div
              hidden={
                phone
                  ? destination !== 'room'
                  : destination !== 'overview' && destination !== 'room'
              }
            >
              <ProjectRoom
                slug={slug}
                projectId={project.id}
                requestScope={requestScope}
                variant={destination === 'room' ? 'full' : 'preview'}
                onOpenRoom={openRoom}
                {...(destination === 'room'
                  ? {
                      routeChannel: { id: room.channelId },
                      onRouteChannel: openRoom,
                      thread: { rootId: room.threadId, open: openThread },
                    }
                  : {})}
                {...(roomScreen
                  ? {
                      screen: {
                        backLabel: `Back to ${project.name || slug}`,
                        onBack: leaveRoom,
                      },
                    }
                  : {})}
              />
            </div>

            <details
              className="project-page__workspace"
              hidden={destination !== 'overview'}
            >
              <summary>Open workspace</summary>
              {/* Epic #2323 S2: renders only when the server says this Project's
            folder is empty and could take a starter plugin. */}
              {!navigator.webdriver && (
                <LazyBoundary
                  load={loadProjectPluginStartGate}
                  componentProps={{
                    project: { slug, name: project.name || slug },
                  }}
                  pending={null}
                />
              )}

              {gitStatus?.isRepo && (
                <div className="project-page__git-section">
                  <div className="project-page__section-header">
                    <span className="project-page__section-label">
                      <BranchGlyph className="project-page__section-label-icon" />{' '}
                      {gitStatus.branch}
                      {gitStatus.changes.length > 0 && (
                        <span className="project-page__git-section-dirty">
                          {' '}
                          · {gitStatus.staged} staged, {gitStatus.unstaged}{' '}
                          modified, {gitStatus.untracked} untracked
                        </span>
                      )}
                      {(gitStatus.ahead > 0 || gitStatus.behind > 0) && (
                        <span className="project-page__git-section-remote">
                          {gitStatus.ahead > 0 && ` · ↑${gitStatus.ahead}`}
                          {gitStatus.behind > 0 && ` · ↓${gitStatus.behind}`}
                        </span>
                      )}
                    </span>
                  </div>
                  {gitLog.length > 0 && (
                    <div className="project-page__git-log">
                      {gitLog.map((commit) => (
                        <div
                          key={commit.sha}
                          className="project-page__git-commit"
                        >
                          <span className="project-page__git-sha">
                            {commit.sha}
                          </span>
                          <span className="project-page__git-msg">
                            {commit.message}
                          </span>
                          <span className="project-page__git-meta">
                            {commit.author} · {commit.relativeTime}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <ProjectPluginPublishSection slug={slug} />

              <section
                className="project-page__layouts"
                aria-labelledby="project-open-title"
              >
                <div className="project-page__section-header">
                  <span
                    id="project-open-title"
                    className="project-page__section-label"
                  >
                    Workspace views
                  </span>
                  <div className="project-page__section-actions">
                    <button
                      type="button"
                      className="project-page__add-btn"
                      onClick={() => setShowAddLayout(true)}
                    >
                      + Add layout
                    </button>
                    <button
                      type="button"
                      className="project-page__add-btn"
                      onClick={() => {
                        setLayoutOpenBlocked(false);
                        setShowAddPane(true);
                      }}
                    >
                      + Add pane
                    </button>
                  </div>
                </div>
                {/* #765 F4: plain copy — the layouts→panes migration is an internal
              narrative and does not belong in product copy. */}
                <p className="project-page__section-explainer">
                  Workspace views open in this project.
                </p>
                {/* #1536 E8: this section lists what the user ADDED to this
              project. It used to carry a second grid of every pane in the
              distribution — a catalog rendered as project state, duplicating
              the "+ Add pane" picker above. The picker's entry list is a
              superset of what that grid could show (the grid filtered the same
              catalog down to placed occurrences), so nothing became
              unreachable. */}
                <ProjectLayoutsSection
                  slug={slug}
                  layouts={layouts}
                  loading={layoutsPending}
                  error={layoutsError}
                  onRetry={() => void refetchLayouts()}
                  setLayout={setLayout}
                />
              </section>
            </details>

            <section
              hidden={destination !== 'tasks'}
              aria-label="Project tasks"
            >
              <ProjectTasksSection
                slug={slug}
                active={destination === 'tasks'}
                projectId={project.id}
                projectWorkingDirectory={project.workingDirectory}
                gitStatus={gitStatus}
                agents={project.agents}
                presentation={tasksView}
                onPresentationChange={(view) =>
                  updateParams({ tasksView: view === 'board' ? null : view })
                }
              />
            </section>

            <section
              hidden={destination !== 'sources'}
              aria-label="Files and connections"
            >
              <ProjectLibrarySection slug={slug} />
              <ProjectSourcesSection
                slug={slug}
                projectId={project.id}
                showRepositories={destination === 'sources'}
              />
              {namespacesQuery.isError && (
                <ErrorState
                  title="Could not load document categories"
                  description={errorText(namespacesQuery.error)}
                  action={
                    <Button onClick={() => void namespacesQuery.refetch()}>
                      Retry categories
                    </Button>
                  }
                />
              )}
              {knowledgeStatusQuery.isError && (
                <ErrorState
                  title="Could not load indexing status"
                  description={errorText(knowledgeStatusQuery.error)}
                  action={
                    <Button onClick={() => void knowledgeStatusQuery.refetch()}>
                      Retry indexing status
                    </Button>
                  }
                />
              )}
              {docsPending ? (
                <SkeletonBlock count={2} label="Loading project documents" />
              ) : (
                <ProjectKnowledgeSection
                  slug={slug}
                  projectId={project.id}
                  projectWorkingDirectory={project.workingDirectory}
                  docs={docs}
                  docsError={docsError}
                  docsFailure={docsFailure}
                  onRetryDocs={() => void refetchDocs()}
                  namespaces={namespaces}
                  knowledgeStatus={knowledgeStatus}
                />
              )}
            </section>
          </section>
        </div>
        <ProjectAddLayoutModal
          show={showAddLayout}
          available={available}
          appliedLayouts={layouts}
          adding={adding}
          applyError={applyError}
          loading={layoutCatalog.isLoading}
          catalogError={layoutCatalog.error}
          onClose={() => setShowAddLayout(false)}
          onRetry={() => void layoutCatalog.refetch()}
          onAddLayout={addLayout}
        />
        {extensionAccess.dialog}
        <ProjectWorkspacePaneModal
          show={showAddPane}
          notice={layoutOpenBlocked ? layoutOpenNotice : undefined}
          entries={paneCatalog.entries}
          loading={paneCatalog.isLoading}
          error={paneCatalog.isError}
          hasData={paneCatalog.data !== undefined}
          retrying={paneCatalog.isFetching}
          onRetry={() => void paneCatalog.refetch()}
          onSelect={openPane}
          onAction={handlePaneAction}
          canExecuteAction={canExecutePaneAction}
          onReviewExtensions={extensionAccess.review}
          onClose={() => setShowAddPane(false)}
        />
      </div>
    </div>
  );
}
