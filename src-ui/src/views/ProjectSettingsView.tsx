import type { ModelConnectionConfig } from '@kontourai/station-contracts/tool';
import {
  resolveWorkspaceIsolationMode,
  type WorkspaceIsolationMode,
} from '@kontourai/station-contracts/workspace-isolation';
import {
  useDeleteProjectMutation,
  useModelConnectionsQuery,
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
import { useConfig } from '../contexts/ConfigContext';
import { useNavigation } from '../contexts/NavigationContext';
import {
  type ProjectConfig,
  useScopedProjectQuery,
} from '../contexts/ProjectsContext';
import { useShowSurface } from '../contexts/useShowSurface';
import { useCloseShortcut } from '../hooks/useCloseShortcut';
import { useSectionNavigation } from '../hooks/useSectionNavigation';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { errorText } from '../utils/errorText';
import { AccessSection } from './project-settings/AccessSection';
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
  ['access', 'People and access'],
  ['knowledge', 'Project knowledge'],
  ['danger', 'Danger zone'],
] as const;

/** How each stored workspace mode reads in this picker. */
const WORKSPACE_MODE_LABELS: Record<WorkspaceIsolationMode, string> = {
  worktree: 'a fresh git worktree',
  shared: 'the current checkout',
};

/**
 * The inherit option's label, naming the mode it currently resolves to when —
 * and only when — the Station config has actually been read.
 *
 * `useConfig()` returns `null` while the read is in flight or has failed, and
 * "currently: the current checkout" is a claim about a value nobody has
 * looked at yet: `shared` is the resolver's fallback, so an unloaded config
 * and a Station that really is on `shared` produce the same string from
 * different amounts of knowledge. The bare label is what we can say then.
 */
function inheritOptionLabel(
  stationDefault: WorkspaceIsolationMode | undefined,
  configLoaded: boolean,
): string {
  if (!configLoaded) return 'Follow the Station default';
  return `Use the Station default (currently: ${
    WORKSPACE_MODE_LABELS[
      resolveWorkspaceIsolationMode(undefined, stationDefault)
    ]
  })`;
}

/** A connection's own catalog, in the shape `ModelSelector` takes. */
function connectionModelOptions(
  connection: ModelConnectionConfig | undefined,
): Array<{ id: string; name: string; originalId: string }> | undefined {
  const raw = connection?.config.modelOptions;
  if (!Array.isArray(raw)) return undefined;
  return (
    raw as Array<{ id?: unknown; name?: unknown; originalId?: unknown }>
  ).flatMap((model) =>
    typeof model?.id === 'string'
      ? [
          {
            id: model.id,
            name: typeof model.name === 'string' ? model.name : model.id,
            originalId:
              typeof model.originalId === 'string'
                ? model.originalId
                : model.id,
          },
        ]
      : [],
  );
}

/**
 * The model id this field STARTS at when a connection is chosen — an opening
 * value the person can change, not an authoritative default.
 *
 * Only the first branch is a declared default (`config.defaultModel`). The
 * second is the connection's catalog in whatever order the provider listed
 * it, which is a model the connection offers and nothing stronger; the
 * copy beside the field says exactly that rather than calling it "the
 * connection's default".
 *
 * Why pre-fill at all: `ProviderService.resolve` requires BOTH
 * `defaultProviderId` and `defaultModel` (provider-service.ts) and silently
 * falls through to the Station default when either is missing — while the
 * browser-side resolver would fall back to the connection's own default, so
 * the two disagree about the same project. And a model id left over from a
 * previously chosen connection is refused outright ("Model '…' is not
 * available on provider connection").
 *
 * Returns `''` when the connection declares no default and offers no
 * catalog. That leaves the pair genuinely half-set, and it is the one case
 * this cannot fix from here: there is no model id to commit. The field
 * renders empty and its hint still says the Station default applies.
 */
function connectionInitialModelId(
  connection: ModelConnectionConfig | undefined,
): string {
  if (!connection) return '';
  const declared = connection.config.defaultModel;
  if (typeof declared === 'string' && declared) return declared;
  return connectionModelOptions(connection)?.[0]?.id ?? '';
}

export function ProjectSettingsView({ slug }: { slug: string }) {
  const stationConfig = useConfig();
  const { navigate } = useNavigation();
  const showSurface = useShowSurface();

  const [form, setForm] = useState<ProjectForm | null>(null);
  const [savedForm, setSavedForm] = useState<ProjectForm | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // `SectionNav` forwards this ref to its own `<nav>` element (archive#4463
  // review — no wrapper `<div>` needed, so this flex child's
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
  } = useScopedProjectQuery(slug) as {
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

  // Connections a project default could actually run through. `status` on a
  // model connection is derived from "a non-empty key is saved", so `ready`
  // is the weakest honest filter available here; offering a disabled or
  // unconfigured connection would persist a pair that resolves to nothing.
  const { data: modelConnections = [] } = useModelConnectionsQuery() as {
    data?: ModelConnectionConfig[];
  };
  const selectableModelConnections = modelConnections.filter(
    (connection) =>
      connection.kind === 'model' &&
      connection.enabled &&
      connection.status === 'ready',
  );
  const selectedConnection = selectableModelConnections.find(
    (connection) => connection.id === form?.defaultProviderId,
  );
  // Undefined (not an empty array) when there is no catalog to offer, so the
  // picker falls back to the global model list rather than rendering empty,
  // and an off-catalog id typed into it still commits.
  const selectedConnectionModels = connectionModelOptions(selectedConnection);

  const saveMutation = useUpdateProjectMutation();

  const deleteMutation = useDeleteProjectMutation();

  const isDirty =
    !isLoading && !!form && JSON.stringify(form) !== JSON.stringify(savedForm);
  const { DiscardModal } = useUnsavedGuard(isDirty);
  useCloseShortcut(() => navigate(`/projects/${slug}`));

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

  async function saveProject() {
    if (!form) return;
    setSaveError(null);
    try {
      const saved = await saveMutation.mutateAsync({
        slug,
        ...buildProjectSavePayload(form, workingDirectory),
      });
      const savedProjectForm = buildProjectForm(saved);
      setSavedForm(savedProjectForm);
    } catch (saveFailure) {
      setSaveError(errorText(saveFailure));
    }
  }

  async function deleteProject() {
    setDeleteError(null);
    try {
      await deleteMutation.mutateAsync(slug);
      // The project this view was about is gone, so there is no "back" to
      // return to: land on Home BY NAME — the Home surface, placed in `main`
      // (the model navigates to `/`) — not on whatever occupies `main` (#1523).
      showSurface('home');
    } catch (deleteFailure) {
      setDeleteError(errorText(deleteFailure));
    }
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
          onClick={() => navigate(`/projects/${slug}`)}
        >
          ← Back
        </button>
        <button
          type="button"
          className="editor-btn editor-btn--primary"
          disabled={saveMutation.isPending || !form.name}
          onClick={() => void saveProject()}
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
        {saveError && (
          <ErrorState
            variant="compact"
            title="Could not save project settings"
            description={saveError}
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
          description="Choose the starting model for new work in this project. Both a model connection and a model are needed — with only one of them set, this project falls back to the Station default."
        >
          <PageRow
            label="Model connection"
            description="Which configured model connection this project's chats run through."
            control={
              <select
                id="project-default-provider"
                className="editor-input"
                aria-label="Model connection"
                value={form.defaultProviderId ?? ''}
                onChange={(event) => {
                  const providerId = event.target.value;
                  // A model id only means something against the connection
                  // that offers it. Choosing or switching a connection
                  // commits a model THAT connection offers, so the field
                  // never carries the previous connection's id (which the
                  // server refuses outright). Clearing the connection clears
                  // the model with it.
                  //
                  // One case still leaves the pair half-set: a ready
                  // connection that declares no `config.defaultModel` and
                  // lists no `modelOptions` has no id to commit, so the
                  // field lands empty. The server then resolves this project
                  // to the Station default, which is what the model field's
                  // own hint says happens when either half is missing.
                  setForm((current) =>
                    current
                      ? {
                          ...current,
                          defaultProviderId: providerId,
                          defaultModel: connectionInitialModelId(
                            selectableModelConnections.find(
                              (connection) => connection.id === providerId,
                            ),
                          ),
                        }
                      : current,
                  );
                }}
              >
                <option value="">Station default</option>
                {selectableModelConnections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.name}
                  </option>
                ))}
              </select>
            }
          />
          <PageRow
            label="Default model"
            // Derived from what the field actually holds. A connection that
            // offered nothing to pre-fill leaves this empty, and saying
            // "pre-filled" over an empty box is the class of claim this whole
            // change exists to remove.
            description={
              !form.defaultProviderId
                ? 'Choose a model connection first. Without one, chats in this project use the Station default.'
                : form.defaultModel
                  ? 'Pre-filled with a model this connection offers. Both the connection and a model are needed; with either missing, this project uses the Station default.'
                  : 'This connection offers no model to pre-fill. Choose one, or this project uses the Station default.'
            }
            control={
              <ModelSelector
                value={form.defaultModel ?? ''}
                models={selectedConnectionModels}
                disabled={!form.defaultProviderId}
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
            description="Fresh worktrees isolate changes; the current checkout shares this project's working directory. Leave it on the Station default and this project follows whatever Settings says."
            control={
              <select
                id="project-default-workspace-isolation"
                className="editor-input"
                aria-label="Execution environment"
                value={form.defaultWorkspaceIsolation}
                onChange={(event) =>
                  setField(
                    'defaultWorkspaceIsolation',
                    event.target
                      .value as ProjectForm['defaultWorkspaceIsolation'],
                  )
                }
              >
                <option value="inherit">
                  {inheritOptionLabel(
                    stationConfig?.defaultWorkspaceIsolation,
                    stationConfig !== null,
                  )}
                </option>
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
        {project && <AccessSection slug={slug} projectId={project.id} />}

        {/* Knowledge */}
        <KnowledgeSection slug={slug} />

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
            onClick={() => {
              setDeleteError(null);
              setDeleteOpen(true);
            }}
          >
            Delete Project
          </button>
        </PageSection>
      </div>

      <ConfirmModal
        isOpen={deleteOpen}
        title="Delete Project"
        message={`Delete "${form.name}"? Project settings and layouts will be deleted. Tasks and chats stay in history, but they will no longer have a live Project workspace. This cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        pending={deleteMutation.isPending}
        error={deleteError}
        onConfirm={() => void deleteProject()}
        onCancel={() => {
          setDeleteOpen(false);
          setDeleteError(null);
        }}
      />

      <DiscardModal />
    </div>
  );
}
