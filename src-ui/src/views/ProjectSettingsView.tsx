import type { ModelConnectionConfig } from '@kontourai/station-contracts/tool';
import {
  resolveWorkspaceIsolationMode,
  type WorkspaceIsolationMode,
} from '@kontourai/station-contracts/workspace-isolation';
import {
  useDeleteProjectMutation,
  useModelConnectionsQuery,
  useProjectIconCandidatesQuery,
  useUpdateProjectMutation,
} from '@kontourai/station-sdk';
import { Fragment, useEffect, useRef, useState } from 'react';
import {
  AccountIdentityConflict,
  isAccountIdentityConflict,
} from '../components/AccountIdentityConflict';
import { Button } from '../components/Button';
import { DetailHeader } from '../components/DetailHeader';
import { EnvironmentPicker } from '../components/EnvironmentPicker';
import {
  displayableProjectIcon,
  ProjectIcon,
} from '../components/icons/ProjectIcon';
import { ModelSelector } from '../components/ModelSelector';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import {
  getWorkingDirectoryLeaf,
  normalizeWorkingDirectory,
} from '../components/modals/project-form-utils';
import { PageRow } from '../components/PageRow';
import { PageSection } from '../components/PageSection';
import { PathAutocomplete } from '../components/PathAutocomplete';
import {
  ProjectIconPicker,
  projectIconInputProblem,
} from '../components/project-icon/ProjectIconPicker';
import { SectionNav } from '../components/SectionNav';
import { ErrorState, Skeleton } from '../components/state';
import { useHostRequestAuthorityScope } from '../contexts/ApiBaseContext';
import { useConfig } from '../contexts/ConfigContext';
import { useNavigation } from '../contexts/NavigationContext';
import {
  type ProjectConfig,
  useScopedProjectChatDefaultsQuery,
  useScopedProjectQuery,
} from '../contexts/ProjectsContext';
import { useShowSurface } from '../contexts/useShowSurface';
import { useCloseShortcut } from '../hooks/useCloseShortcut';
import { useSectionNavigation } from '../hooks/useSectionNavigation';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { userFacingErrorMessage } from '../utils/errorText';
import { AccessSection } from './project-settings/AccessSection';
import { AgentsSection } from './project-settings/AgentsSection';
import { KnowledgeSection } from './project-settings/KnowledgeSection';
import { LayoutsSection } from './project-settings/LayoutsSection';
import { NewChatDefaultsSection } from './project-settings/NewChatDefaultsSection';
import { ProjectCheckoutFreshnessNotice } from './project-settings/ProjectCheckoutFreshnessNotice';
import { ProjectSourcesSection } from './project-settings/ProjectSourcesSection';
import { ToolsSection } from './project-settings/ToolsSection';
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
  ['new-chat', 'New chats'],
  ['thread-execution', 'Thread execution'],
  ['agents', 'Agents'],
  ['tools', 'Tools'],
  ['layouts', 'Layouts'],
  ['resources', 'Sources'],
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
  const authority = useHostRequestAuthorityScope();
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

  const hydratedProject = useRef<{
    slug: string;
    project: ProjectConfig;
  } | null>(null);
  useEffect(() => {
    if (
      !project ||
      (hydratedProject.current?.slug === slug &&
        hydratedProject.current.project === project)
    )
      return;
    const sameProject = hydratedProject.current?.slug === slug;
    hydratedProject.current = { slug, project };
    // A query refresh must not replace an unsaved draft.
    if (
      sameProject &&
      form &&
      JSON.stringify(form) !== JSON.stringify(savedForm)
    )
      return;
    const next = buildProjectForm(project);
    setForm(next);
    setSavedForm(next);
  }, [project, slug, form, savedForm]);

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
  const { data: chatDefaultsAnswer } = useScopedProjectChatDefaultsQuery(slug);
  const chatDefaults = chatDefaultsAnswer ?? undefined;

  // The icon picker reads the project's SAVED folder for artwork, and only
  // while it is open: discovery is a filesystem scan, and suggestions are
  // offered, never applied.
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const iconCandidates = useProjectIconCandidatesQuery(
    project?.workingDirectory,
    { enabled: iconPickerOpen },
  );

  const deleteMutation = useDeleteProjectMutation();

  const isDirty =
    !isLoading && !!form && JSON.stringify(form) !== JSON.stringify(savedForm);
  const { DiscardModal } = useUnsavedGuard(isDirty);
  useCloseShortcut(() => navigate(`/projects/${slug}`));

  if (
    isLoadError &&
    !project &&
    authority &&
    isAccountIdentityConflict(loadError)
  ) {
    return (
      <div className="page page--full">
        <div className="project-settings__body">
          <AccountIdentityConflict
            apiBase={authority.apiBase}
            onRecovered={() => refetchProject()}
          />
        </div>
      </div>
    );
  }

  if (isLoadError && !project) {
    return (
      <div className="page page--full">
        <div className="project-settings__body">
          <ErrorState
            title="Could not load project settings"
            description={userFacingErrorMessage(loadError)}
            action={<Button onClick={() => refetchProject()}>Retry</Button>}
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
  // The header preview start-truncates the parent so the leaf folder stays in
  // view (#2799); a root (`/`, `~`, `D:\`) has no leaf to split off.
  const workingDirectoryParent = workingDirectoryLeaf
    ? workingDirectory.slice(0, -workingDirectoryLeaf.length)
    : workingDirectory;

  // Only a CHANGED icon can block Save: a stored value the icon rule now
  // refuses (a legacy remote URL) is not re-sent by an unrelated edit — see
  // `buildProjectSavePayload` — so it must not block one either.
  const iconProblem =
    form.icon !== savedForm?.icon
      ? projectIconInputProblem(form.icon ?? '')
      : undefined;
  // A stored icon the rule refuses (a link saved before the rule) and not
  // yet replaced. Every surface already shows it as no icon; here it is
  // named once, and the picker starts from "no icon" rather than putting
  // the link in the emoji field with an error the user did not cause.
  const legacyIcon =
    !!savedForm?.icon &&
    form.icon === savedForm.icon &&
    displayableProjectIcon(savedForm.icon) === undefined;

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
        ...buildProjectSavePayload(form, workingDirectory, savedForm),
      });
      const savedProjectForm = buildProjectForm(saved);
      setSavedForm(savedProjectForm);
      setForm((current) =>
        JSON.stringify(current) === JSON.stringify(form)
          ? savedProjectForm
          : current,
      );
    } catch (saveFailure) {
      setSaveError(userFacingErrorMessage(saveFailure));
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
      setDeleteError(userFacingErrorMessage(deleteFailure));
    }
  }

  return (
    <div className="page page--full">
      {/* Header */}
      <DetailHeader
        title={form.name}
        badge={
          isDirty
            ? { label: 'unsaved', variant: 'warning' as const }
            : undefined
        }
      >
        <Button onClick={() => navigate(`/projects/${slug}`)}>← Back</Button>
        <Button
          variant="primary"
          disabled={
            saveMutation.isPending || !form.name.trim() || !!iconProblem
          }
          onClick={() => void saveProject()}
        >
          {saveMutation.isPending ? 'Saving…' : 'Save'}
        </Button>
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
        <p className="project-settings__save-hint">
          Save to apply changes to project defaults.
        </p>
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
          description="The folder used for work in this project."
          actions={
            <div className="project-settings__identity-preview">
              <ProjectIcon
                project={{ name: form.name, icon: form.icon }}
                size={46}
                fallback="initials"
              />
              <div className="project-settings__identity-copy">
                <div className="project-settings__identity-name">
                  {form.name}
                </div>
                {workingDirectory ? (
                  <div
                    className="project-settings__identity-path"
                    title={workingDirectory}
                  >
                    {/* The line is rtl only for the start-side ellipsis; the
                        ltr isolate restores character order (#304). Both parts
                        stay inline, so the path reads and copies as one. */}
                    <span dir="ltr">
                      <span className="project-settings__identity-path-parent">
                        {workingDirectoryParent}
                      </span>
                      {workingDirectoryLeaf && (
                        <span className="project-settings__identity-path-leaf">
                          {workingDirectoryLeaf}
                        </span>
                      )}
                    </span>
                  </div>
                ) : (
                  <div className="project-settings__identity-path project-settings__identity-path--unset">
                    No working directory configured
                  </div>
                )}
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
                placeholder="~/code/my-project"
                className="editor-input path-autocomplete__input project-settings__working-dir-input"
              />
              <span className="editor-hint">
                Use an absolute path or <code>~/…</code>.
              </span>
              {workingDirectory && (
                <div className="project-settings__path-pills">
                  <span className="project-settings__path-pill">
                    leaf <code>{workingDirectoryLeaf || 'project'}</code>
                  </span>
                  <span className="project-settings__path-pill">
                    path{' '}
                    <code>
                      {workingDirectory
                        .split(/(?<=[/\\])/)
                        .map((part, index) => (
                          <Fragment key={index}>
                            {part}
                            <wbr />
                          </Fragment>
                        ))}
                    </code>
                  </span>
                </div>
              )}
            </div>
          </div>
          <div className="project-settings__checkout-freshness">
            <ProjectCheckoutFreshnessNotice slug={slug} />
          </div>
        </PageSection>

        <PageSection
          id="section-basic-info"
          className="project-settings__section"
          eyebrow="Project identity"
          title="Basic info"
        >
          <div className="project-settings__identity-grid">
            <div className="editor-field">
              <label className="editor-label" htmlFor="project-name">
                Name *
              </label>
              <div className="project-settings__name-row">
                <button
                  type="button"
                  className="project-settings__icon-button"
                  aria-label="Choose project icon"
                  aria-expanded={iconPickerOpen}
                  onClick={() => setIconPickerOpen((open) => !open)}
                >
                  <ProjectIcon
                    project={{ name: form.name, icon: form.icon }}
                    size={40}
                    fallback="initials"
                  />
                </button>
                <input
                  id="project-name"
                  required
                  className="editor-input project-settings__name-input"
                  type="text"
                  value={form.name}
                  onChange={(e) => setField('name', e.target.value)}
                />
              </div>
              {legacyIcon && (
                <p className="project-settings__icon-notice">
                  This project’s icon can’t be shown any more. Choose a new one.
                </p>
              )}
              {iconPickerOpen && (
                <ProjectIconPicker
                  idPrefix="project-settings-icon"
                  name={form.name}
                  value={legacyIcon ? '' : (form.icon ?? '')}
                  onChange={(icon) => setField('icon', icon)}
                  candidates={iconCandidates.data ?? []}
                  fetching={iconCandidates.isFetching}
                />
              )}
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
          description="Choose a connection and model, or follow the Station default."
        >
          <PageRow
            label="Model connection"
            description="The connection used for this project’s model."
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
                ? 'Choose a connection to override the Station default.'
                : form.defaultModel
                  ? 'Used with the selected connection.'
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

        <NewChatDefaultsSection
          form={form}
          setField={setField}
          chatDefaults={chatDefaults}
          stationApprovalDefault={stationConfig?.defaultApprovalMode}
          stationConfigLoaded={stationConfig !== null}
          projectModelSet={!!form.defaultProviderId && !!form.defaultModel}
        />

        <PageSection
          id="section-thread-execution"
          className="project-settings__section"
          eyebrow="New thread default"
          title="Thread execution"
          description="A thread's own selection takes precedence."
        >
          <EnvironmentPicker
            id="project-default-environment"
            value={form.defaultEnvironment ?? { kind: 'current' }}
            onChange={(value) => setField('defaultEnvironment', value)}
          />
          <PageRow
            label="Execution environment"
            description="A fresh worktree isolates changes. The current checkout shares this project’s working directory."
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
        <AgentsSection form={form} setForm={setForm} projectSlug={slug} />
        <ToolsSection slug={slug} form={form} setForm={setForm} />

        <p className="project-settings__save-hint">
          Layouts, sources, access, and knowledge actions apply immediately.
        </p>
        <LayoutsSection slug={slug} />

        <ProjectSourcesSection slug={slug} projectId={project?.id} />
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
          <Button
            variant="danger-outline"
            onClick={() => {
              setDeleteError(null);
              setDeleteOpen(true);
            }}
          >
            Delete Project
          </Button>
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
