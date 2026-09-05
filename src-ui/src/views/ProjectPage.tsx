import type { WorkspacePaneAvailabilityAction } from '@kontourai/station-contracts/workspace-pane-availability';
import {
  useApplyProjectLayoutMutation,
  useAvailableProjectLayoutsQuery,
  useKnowledgeDocsQuery,
  useKnowledgeNamespacesQuery,
  useKnowledgeStatusQuery,
  useProjectConversationsQuery,
  useProjectLayoutsQuery,
  useProjectQuery,
  useUpdateProjectMutation,
} from '@kontourai/station-sdk';
import { useReducer, useState } from 'react';
import { ErrorState, SkeletonBlock } from '../components/state';
import { useApiBase } from '../contexts/ApiBaseContext';
import { useNavigation } from '../contexts/NavigationContext';
import { useDegradedQueryState } from '../hooks/useDegradedQueryState';
import { useGitLog, useGitStatus } from '../hooks/useGitStatus';
import { trackRecentLayout } from '../hooks/useRecentLayouts';
import { errorText } from '../utils/errorText';
import { ProjectWorkspacePaneModal } from '../workspace-panes/ProjectWorkspacePaneCatalog';
import { useResolvedWorkspacePaneCatalog } from '../workspace-panes/resolvedWorkspacePaneCatalog';
import type { WorkspacePaneAvailabilityCatalogEntry } from '../workspace-panes/workspacePaneAvailabilityPresentation';
import {
  workspacePaneDirectRoute,
  workspacePaneRequiresLayoutIdentity,
} from '../workspace-panes/workspacePaneDirectRoute';
import { ProjectConversationsSection } from './project-page/ProjectConversationsSection';
import { ProjectKnowledgeSection } from './project-page/ProjectKnowledgeSection';
import {
  ProjectAddLayoutModal,
  ProjectLayoutsSection,
} from './project-page/ProjectLayoutsSection';
import { ProjectLiveWorkSection } from './project-page/ProjectLiveWorkSection';
import { ProjectPageHeader } from './project-page/ProjectPageHeader';
import { ProjectTasksSection } from './project-page/ProjectTasksSection';
import type { AvailableLayout, ConversationRecord } from './project-page/types';
import './ProjectPage.css';

export function ProjectPage({ slug }: { slug: string }) {
  const { apiBase } = useApiBase();
  const { setLayout, setConversation, navigate, setDockState } =
    useNavigation();

  const {
    data: project,
    isLoading,
    isError: isProjectError,
    error: projectError,
    refetch: refetchProject,
  } = useProjectQuery(slug);
  const [projectRetrySeq, bumpProjectRetry] = useReducer(
    (n: number) => n + 1,
    0,
  );
  const projectQueryState = useDegradedQueryState({
    isPending: isLoading,
    resetKey: projectRetrySeq,
  });
  // #801: the page renders as soon as the *project* query settles, so a
  // layouts fetch still in flight used to reach the section as an empty array
  // and render the empty state for a project that has layouts.
  const {
    data: layouts = [],
    isLoading: layoutsLoading,
    isError: layoutsError,
    refetch: refetchLayouts,
  } = useProjectLayoutsQuery(slug);
  const { data: gitStatus } = useGitStatus(project?.workingDirectory);
  const { data: gitLog = [] } = useGitLog(project?.workingDirectory, 5);
  const {
    data: docs = [],
    isError: docsError,
    error: docsFailure,
    refetch: refetchDocs,
  } = useKnowledgeDocsQuery(slug);
  const { data: knowledgeStatus } = useKnowledgeStatusQuery(slug);
  const { data: namespaces = [] } = useKnowledgeNamespacesQuery(slug);
  const { data: conversations = [] } = useProjectConversationsQuery(slug);
  const paneCatalog = useResolvedWorkspacePaneCatalog(slug);

  const [editingDir, setEditingDir] = useState(false);
  const [dirDraft, setDirDraft] = useState('');
  const [showAddLayout, setShowAddLayout] = useState(false);
  const [showAddPane, setShowAddPane] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<unknown>(null);

  const layoutCatalog = useAvailableProjectLayoutsQuery({
    enabled: showAddLayout,
  });
  const available = layoutCatalog.data ?? [];

  const updateProjectMutation = useUpdateProjectMutation();
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

  function updateWorkingDirectory(value: string) {
    updateProjectMutation.mutate(
      { slug, workingDirectory: value || undefined },
      { onSuccess: () => setEditingDir(false) },
    );
  }

  function handleConversationClick(conversation: ConversationRecord) {
    const layoutSlug = conversation.layoutId || (layouts as any[])[0]?.slug;
    if (layoutSlug) {
      setLayout(slug, layoutSlug);
      setTimeout(() => setConversation(conversation.id), 100);
    }
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
      ? (layouts as Array<{ slug: string; type?: string }>).find(
          (layout) => layout.type === 'coding',
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

  if (isProjectError && !project) {
    return (
      <div className="project-page">
        <div className="project-page__inner">
          <ErrorState
            title="Could not load project"
            description={errorText(projectError)}
            action={
              <button type="button" onClick={() => refetchProject()}>
                Retry
              </button>
            }
          />
        </div>
      </div>
    );
  }

  if (isLoading || !project) {
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
                    void refetchProject();
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

  return (
    <div className="project-page">
      <div className="project-page__inner">
        <ProjectPageHeader
          apiBase={apiBase}
          project={project}
          gitStatus={gitStatus}
          editingDir={editingDir}
          setEditingDir={setEditingDir}
          dirDraft={dirDraft}
          setDirDraft={setDirDraft}
          updateWorkingDirectory={updateWorkingDirectory}
          navigateToSettings={() => navigate(`/projects/${slug}/edit`)}
        />

        {/* archive#3202: what is live in this project leads the page, because
            that is what the sidebar badge sent you here for. Renders nothing
            when nothing is in flight. */}
        <ProjectLiveWorkSection slug={slug} />

        {conversations.length === 0 && !navigator.webdriver && (
          <div className="project-page__chat-cta">
            <div className="project-page__chat-cta-text">
              <strong>New here? Chat with Station to get started.</strong>
              <span>
                Ask a question or describe a task — no setup required.
              </span>
            </div>
            <button
              type="button"
              className="project-page__chat-cta-btn"
              onClick={() => setDockState(true)}
            >
              Start a chat
            </button>
          </div>
        )}

        {gitStatus && gitStatus.isRepo === false && (
          <div className="project-page__git-section project-page__git-section--empty">
            <span className="project-page__section-label project-page__git-section-muted">
              Not a git repository
            </span>
          </div>
        )}

        {gitStatus?.isRepo && (
          <div className="project-page__git-section">
            <div className="project-page__section-header">
              <span className="project-page__section-label">
                ⎇ {gitStatus.branch}
                {gitStatus.changes.length > 0 && (
                  <span className="project-page__git-section-dirty">
                    {' '}
                    · {gitStatus.staged} staged, {gitStatus.unstaged} modified,{' '}
                    {gitStatus.untracked} untracked
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
                  <div key={commit.sha} className="project-page__git-commit">
                    <span className="project-page__git-sha">{commit.sha}</span>
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

        <section
          className="project-page__layouts"
          aria-labelledby="project-open-title"
        >
          <div className="project-page__section-header">
            <span
              id="project-open-title"
              className="project-page__section-label"
            >
              Open
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
            layouts={layouts as any[]}
            loading={layoutsLoading}
            error={layoutsError}
            onRetry={() => void refetchLayouts()}
            setLayout={setLayout}
          />
        </section>

        <ProjectTasksSection
          slug={slug}
          projectWorkingDirectory={project.workingDirectory}
          gitStatus={gitStatus}
          agents={project.agents}
        />

        <ProjectKnowledgeSection
          apiBase={apiBase}
          slug={slug}
          projectWorkingDirectory={project.workingDirectory}
          docs={docs}
          docsError={docsError}
          docsFailure={docsFailure}
          onRetryDocs={() => void refetchDocs()}
          namespaces={namespaces}
          knowledgeStatus={knowledgeStatus}
        />

        <ProjectConversationsSection
          conversations={conversations as ConversationRecord[]}
          onConversationClick={handleConversationClick}
        />

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
        <ProjectWorkspacePaneModal
          show={showAddPane}
          entries={paneCatalog.entries}
          loading={paneCatalog.isLoading}
          error={paneCatalog.isError}
          onRetry={() => void paneCatalog.refetch()}
          onSelect={openPane}
          onAction={handlePaneAction}
          canExecuteAction={canExecutePaneAction}
          // The removed page grid was the only surface that supplied this, and
          // without it a card whose availability names the Registry falls back
          // to a bounded action instead of the navigation that resolves it.
          onReviewInRegistry={() => navigate('/registry')}
          onClose={() => setShowAddPane(false)}
        />
      </div>
    </div>
  );
}
