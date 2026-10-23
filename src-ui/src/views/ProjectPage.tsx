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
import { useReducer, useState } from 'react';
import { Button } from '../components/Button';
import { BranchGlyph } from '../components/icons/Glyph';
import { LazyBoundary } from '../components/LazyBoundary';
import { useStationExtensionsAccess } from '../components/registry/StationExtensionsAccess';
import { ErrorState, SkeletonBlock } from '../components/state';
import { useNavigation } from '../contexts/NavigationContext';
import {
  type ProjectConfig,
  useScopedProjectPageViewQuery,
} from '../contexts/ProjectsContext';
import { useDegradedQueryState } from '../hooks/useDegradedQueryState';
import { useGitLog, useGitStatus } from '../hooks/useGitStatus';
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
import { MemberProjectPage } from './project-page/MemberProjectPage';
import { ProjectKnowledgeSection } from './project-page/ProjectKnowledgeSection';
import {
  ProjectAddLayoutModal,
  ProjectLayoutsSection,
} from './project-page/ProjectLayoutsSection';
import { ProjectLiveWorkSection } from './project-page/ProjectLiveWorkSection';
import {
  ProjectNavigation,
  useProjectDestination,
} from './project-page/ProjectNavigation';
import { ProjectPageHeader } from './project-page/ProjectPageHeader';
import { ProjectPluginPublishSection } from './project-page/ProjectPluginPublishSection';
import type { ProjectRoomProps } from './project-page/ProjectRoom';
import { ProjectRoom } from './project-page/ProjectRoom';
import { ProjectTasksSection } from './project-page/ProjectTasksSection';
import type { AvailableLayout } from './project-page/types';
import { ProjectSourcesSection } from './project-settings/ProjectSourcesSection';
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
                <Button onClick={() => navigate('/connections/computers')}>
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
            description="Native relay accounts can open Projects shared with them. Ask a Station operator to share this Project; operator configuration is unavailable through this route."
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
  requestScope: ProjectRoomProps['requestScope'];
}) {
  const { setLayout, navigate } = useNavigation();
  const { destination, selectDestination } = useProjectDestination(slug);
  const extensionAccess = useStationExtensionsAccess();
  // #801: the page renders as soon as the *project* query settles, so a
  // layouts fetch still in flight used to reach the section as an empty array
  // and render the empty state for a project that has layouts.
  const {
    data: layouts = [],
    isLoading: layoutsLoading,
    isError: layoutsError,
    refetch: refetchLayouts,
  } = useProjectLayoutsQuery(slug);
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
    setShowAddPane(false);
    const requiresLayout = workspacePaneRequiresLayoutIdentity(
      entry.descriptor,
    );
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
      return 'Opening the layout registry to review distribution.';
    }
    return 'This build can explain the requirement but cannot complete that step from the pane catalog.';
  }

  return (
    <div className="project-page project-page--space">
      <div className="project-page__inner project-page__space">
        <ProjectPageHeader
          project={project}
          gitStatus={gitStatus}
          navigateToSettings={() => navigate(`/projects/${slug}/edit`)}
        />

        <ProjectNavigation slug={slug} projectId={project.id} />
        <main className="project-page__content">
          <section
            hidden={destination !== 'overview'}
            aria-label="Project overview"
          >
            <div className="project-page__operator-actions">
              <Button onClick={() => requestTaskShaping({ projectSlug: slug })}>
                New Task
              </Button>
              <Button onClick={() => selectDestination('sources')}>
                Add files
              </Button>
            </div>
            <ProjectLiveWorkSection slug={slug} />
            <div className="project-page__overview-links">
              <Button onClick={() => selectDestination('tasks')}>
                View Tasks
              </Button>
              <Button onClick={() => selectDestination('sources')}>
                Files & connections
              </Button>
            </div>
          </section>

          <div hidden={destination !== 'overview' && destination !== 'room'}>
            <ProjectRoom
              slug={slug}
              projectId={project.id}
              requestScope={requestScope}
              variant={destination === 'room' ? 'full' : 'preview'}
              onOpenRoom={() => selectDestination('room')}
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
                    onClick={() => setShowAddPane(true)}
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
                loading={layoutsLoading}
                error={layoutsError}
                onRetry={() => void refetchLayouts()}
                setLayout={setLayout}
              />
            </section>
          </details>

          <section hidden={destination !== 'tasks'} aria-label="Project tasks">
            <ProjectTasksSection
              slug={slug}
              projectId={project.id}
              projectWorkingDirectory={project.workingDirectory}
              gitStatus={gitStatus}
              agents={project.agents}
            />
          </section>

          <section
            hidden={destination !== 'sources'}
            aria-label="Files and connections"
          >
            <ProjectSourcesSection slug={slug} projectId={project.id} />
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
        </main>
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
