import {
  useDeleteProjectMutation,
  useProjectQuery,
  useUpdateProjectMutation,
} from '@kontourai/station-sdk';
import { useEffect, useRef, useState } from 'react';
import { DetailHeader } from '../components/DetailHeader';
import { EnvironmentPicker } from '../components/EnvironmentPicker';
import { LayoutIcon } from '../components/icons/LayoutIcon';
import { ModelSelector } from '../components/ModelSelector';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import {
  getWorkingDirectoryLeaf,
  normalizeWorkingDirectory,
} from '../components/modals/project-form-utils';
import { PageRow } from '../components/PageRow';
import { PageSection } from '../components/PageSection';
import { PathAutocomplete } from '../components/PathAutocomplete';
import { SectionNav } from '../components/SectionNav';
import { ErrorState, Skeleton } from '../components/state';
import { useApiBase } from '../contexts/ApiBaseContext';
import { useNavigation } from '../contexts/NavigationContext';
import type { ProjectConfig } from '../contexts/ProjectsContext';
import { useCloseShortcut } from '../hooks/useCloseShortcut';
import { useSectionNavigation } from '../hooks/useSectionNavigation';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { errorText } from '../utils/errorText';
import { AgentsSection } from './project-settings/AgentsSection';
import { KnowledgeSection } from './project-settings/KnowledgeSection';
import { LayoutsSection } from './project-settings/LayoutsSection';
import { ResourcesSection } from './project-settings/ResourcesSection';
import type { ProjectForm } from './project-settings/types';
import {
  buildProjectForm,
  buildProjectSavePayload,
} from './project-settings/utils';
import './page-layout.css';
import './editor-layout.css';
import './ProjectSettingsView.css';

const PROJECT_SETTINGS_SECTIONS = [
  ['workspace', 'Workspace'],
  ['basic-info', 'Basic info'],
  ['model', 'Model'],
  ['thread-execution', 'Thread execution'],
  ['agents', 'Agents'],
  ['layouts', 'Layouts'],
  ['resources', 'Resources'],
  ['knowledge', 'Project knowledge'],
  ['danger', 'Danger zone'],
] as const;

export function ProjectSettingsView({ slug }: { slug: string }) {
  const { apiBase } = useApiBase();
  const { navigate } = useNavigation();

  const [form, setForm] = useState<ProjectForm | null>(null);
  const [savedForm, setSavedForm] = useState<ProjectForm | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // `SectionNav` forwards this ref to its own `<nav>` element (station#4463
  // slice 2 review LOW — no wrapper `<div>` needed, so this flex child's
  // `flex-shrink: 0` (`.project-settings__section-nav` in the CSS) lands on
  // the real scrolling strip, not an inert wrapper one level out).
  const sectionNavRef = useRef<HTMLElement | null>(null);
  const { activeSection, hrefForSection, navigateToSection } =
    useSectionNavigation(
      PROJECT_SETTINGS_SECTIONS.map(([id]) => id),
      'workspace',
    );

  const {
    data: project,
    isLoading,
    isError: isLoadError,
    error: loadError,
    refetch: refetchProject,
  } = useProjectQuery(slug) as {
    data?: ProjectConfig;
    isLoading: boolean;
    isError: boolean;
    error: Error | null;
    refetch: () => void;
  };

  useEffect(() => {
    if (project) {
      const f = buildProjectForm(project);
      setForm(f);
      setSavedForm(f);
    }
  }, [project]);

  useEffect(() => {
    if (!form) return;
    sectionNavRef.current
      ?.querySelector<HTMLElement>(
        `[aria-current="location"][href*="section=${activeSection}"]`,
      )
      ?.scrollIntoView?.({ block: 'nearest', inline: 'start' });
  }, [activeSection, form]);

  const saveMutation = useUpdateProjectMutation({
    onSuccess: (saved) => {
      const f = buildProjectForm(saved);
      setSavedForm(f);
      setError(null);
    },
    onError: (err: Error) => setError(err.message),
  });

  const deleteMutation = useDeleteProjectMutation({
    onSuccess: () => {
      navigate('/');
    },
    onError: (err: Error) => setError(err.message),
  });

  const isDirty =
    !isLoading && !!form && JSON.stringify(form) !== JSON.stringify(savedForm);
  const { guard, DiscardModal } = useUnsavedGuard(isDirty);
  useCloseShortcut(() => guard(() => navigate(`/projects/${slug}`)));

  if (isLoadError && !project) {
    return (
      <div className="page page--full">
        <div className="project-settings__body">
          <ErrorState
            title="Could not load project settings"
            description={errorText(loadError)}
            action={
              <button
                type="button"
                className="editor-btn"
                onClick={() => refetchProject()}
              >
                Retry
              </button>
            }
          />
        </div>
      </div>
    );
  }

  if (isLoading || !form) {
    return (
      <div className="page page--full">
        <div
          className="project-settings__body"
          role="status"
          aria-label="Loading project"
        >
          <Skeleton variant="block" />
          <Skeleton variant="block" />
          <Skeleton variant="block" />
        </div>
      </div>
    );
  }

  const workingDirectory = normalizeWorkingDirectory(
    form.workingDirectory ?? '',
  );
  const workingDirectoryLeaf = getWorkingDirectoryLeaf(workingDirectory);

  function setField<K extends keyof ProjectForm>(
    key: K,
    value: ProjectForm[K],
  ) {
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  return (
    <div className="page page--full">
      {/* Header */}
      <DetailHeader
        title={`${form.icon || project?.icon || ''} ${form.name}`.trim()}
        badge={
          isDirty
            ? { label: 'unsaved', variant: 'warning' as const }
            : undefined
        }
      >
        <button
          type="button"
          className="editor-btn"
          onClick={() => guard(() => navigate(`/projects/${slug}`))}
        >
          ← Back
        </button>
        <button
          type="button"
          className="editor-btn editor-btn--primary"
          disabled={saveMutation.isPending || !form.name}
          onClick={() =>
            saveMutation.mutate({
              slug,
              ...buildProjectSavePayload(form, workingDirectory),
            })
          }
        >
          {saveMutation.isPending ? 'Saving…' : 'Save'}
        </button>
      </DetailHeader>

      <SectionNav
        ref={sectionNavRef}
        className="project-settings__section-nav"
        aria-label="Project settings sections"
        items={PROJECT_SETTINGS_SECTIONS.map(([id, label]) => ({
          key: id,
          label,
          href: hrefForSection(id),
        }))}
        activeKey={activeSection}
        onNavigate={navigateToSection}
      />

      {/* Body */}
      <div className="project-settings__body">
        {error && (
          <ErrorState
            variant="compact"
            title="Could not save project settings"
            description={error}
          />
        )}

        <PageSection
          id="section-workspace"
          className="project-settings__section project-settings__section--hero"
          eyebrow="Project home"
          title="Workspace"
          description="Keep the project pointed at the folder you actually work in. Name and icon stay editable, but the directory is the first thing surfaced here."
          actions={
            <div className="project-settings__identity-preview">
              <LayoutIcon
                layout={{ name: form.name, icon: form.icon || project?.icon }}
                size={46}
              />
              <div>
                <div className="project-settings__identity-name">
                  {form.name}
                </div>
                <div className="project-settings__identity-path">
                  {workingDirectory || 'No working directory configured'}
                </div>
              </div>
            </div>
          }
        >
          <div className="project-settings__hero-grid">
            <div className="editor-field project-settings__field--featured">
              <label
                className="editor-label"
                htmlFor="project-working-directory"
              >
                Working Directory
              </label>
              <PathAutocomplete
                id="project-working-directory"
                apiBase={apiBase}
                autoFocus={false}
                suggestionsInitiallyOpen={false}
                value={form.workingDirectory ?? ''}
                onChange={(v) => setField('workingDirectory', v)}
                placeholder="/path/to/project"
                className="editor-input path-autocomplete__input project-settings__working-dir-input"
              />
              <span className="editor-hint">
                Use an absolute path or <code>~/…</code>. Folder completion now
                treats an exact typed directory as a selectable folder state.
              </span>
              {workingDirectory && (
                <div className="project-settings__path-pills">
                  <span className="project-settings__path-pill">
                    leaf <code>{workingDirectoryLeaf || 'project'}</code>
                  </span>
                  <span className="project-settings__path-pill">
                    saved as <code>{workingDirectory}</code>
                  </span>
                </div>
              )}
            </div>
          </div>
        </PageSection>

        <PageSection
          id="section-basic-info"
          className="project-settings__section"
          eyebrow="Project identity"
          title="Basic info"
          description="Set the name and description Station uses throughout the project."
        >
          <div className="project-settings__identity-grid">
            <div className="editor-field">
              <label className="editor-label" htmlFor="project-name">
                Name *
              </label>
              <div className="project-settings__name-row">
                <input
                  className="editor-input project-settings__icon-input"
                  type="text"
                  value={form.icon ?? ''}
                  placeholder="—"
                  aria-label="Project icon"
                  title="Optional project icon"
                  onChange={(e) => setField('icon', e.target.value)}
                />
                <input
                  id="project-name"
                  className="editor-input project-settings__name-input"
                  type="text"
                  value={form.name}
                  onChange={(e) => setField('name', e.target.value)}
                />
              </div>
            </div>
          </div>
          <div className="editor-field">
            <label className="editor-label" htmlFor="project-description">
              Description
            </label>
            <textarea
              id="project-description"
              className="editor-textarea"
              value={form.description ?? ''}
              rows={2}
              onChange={(e) => setField('description', e.target.value)}
            />
          </div>
        </PageSection>

        {/* Default AI Model */}
        <PageSection
          id="section-model"
          className="project-settings__section"
          eyebrow="Conversation default"
          title="AI model"
          description="Choose the starting model for new work in this project."
        >
          <PageRow
            label="Default model"
            description="Leave empty to use the system default."
            control={
              <ModelSelector
                value={form.defaultModel ?? ''}
                onChange={(modelId) => setField('defaultModel', modelId)}
                placeholder="System default"
              />
            }
          />
        </PageSection>

        <PageSection
          id="section-thread-execution"
          className="project-settings__section"
          eyebrow="New thread default"
          title="Thread execution"
          description="Choose where new threads for this project begin. A thread-specific selection takes precedence."
        >
          <EnvironmentPicker
            id="project-default-environment"
            value={form.defaultEnvironment ?? { kind: 'current' }}
            onChange={(value) => setField('defaultEnvironment', value)}
          />
          <PageRow
            label="Execution environment"
            description="Fresh worktrees isolate changes; the current checkout shares this project's working directory."
            control={
              <select
                id="project-default-workspace-isolation"
                className="editor-input"
                aria-label="Execution environment"
                value={form.defaultWorkspaceIsolation ?? 'shared'}
                onChange={(event) =>
                  setField(
                    'defaultWorkspaceIsolation',
                    event.target
                      .value as ProjectForm['defaultWorkspaceIsolation'],
                  )
                }
              >
                <option value="worktree">Use a fresh git worktree</option>
                <option value="shared">Use the current checkout</option>
              </select>
            }
          />
        </PageSection>

        {/* Layouts — list + save as template */}
        <AgentsSection form={form} setForm={setForm} />

        <LayoutsSection slug={slug} />

        {/*
          station#1502 slice 4 — §3.6's resolution states and their repair
          actions. Mounted HERE and nowhere else: `ProjectPage.tsx` stays
          byte-unchanged so the first-run journey `tests/first-run-live.spec.ts`
          pins is provably untouched without an e2e run this slice cannot make.
        */}
        <ResourcesSection slug={slug} />

        {/* Knowledge */}
        <KnowledgeSection slug={slug} guard={guard} />

        {/* Danger Zone */}
        <PageSection
          id="section-danger"
          className="project-settings__section"
          eyebrow="Destructive action"
          title="Danger zone"
          description="Deleting this project cannot be undone."
          tone="danger"
        >
          <button
            type="button"
            className="editor-btn editor-btn--danger"
            onClick={() => setDeleteOpen(true)}
          >
            Delete Project
          </button>
        </PageSection>
      </div>

      <ConfirmModal
        isOpen={deleteOpen}
        title="Delete Project"
        message={`Delete "${form.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => {
          setDeleteOpen(false);
          deleteMutation.mutate(slug);
        }}
        onCancel={() => setDeleteOpen(false)}
      />

      <DiscardModal />
    </div>
  );
}
