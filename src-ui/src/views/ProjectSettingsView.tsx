import { PROJECT_ROOM_COORDINATOR_PREVIEW_ID } from '@kontourai/station-contracts/project-room-coordinator';
import { PULL_REQUEST_FEEDBACK_PREVIEW_ID } from '@kontourai/station-contracts/pull-request-feedback';
import type { ModelConnectionConfig } from '@kontourai/station-contracts/tool';
import {
  resolveWorkspaceIsolationMode,
  type WorkspaceIsolationMode,
} from '@kontourai/station-contracts/workspace-isolation';
import {
  useModelConnectionsQuery,
  useProjectIconCandidatesQuery,
  useUpdateProjectMutation,
} from '@kontourai/station-sdk';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  AccountIdentityConflict,
  isAccountIdentityConflict,
} from '../components/AccountIdentityConflict';
import { Button } from '../components/Button';
import { DetailHeader } from '../components/DetailHeader';
import { EnvironmentPicker } from '../components/EnvironmentPicker';
import { ArrowLeftGlyph } from '../components/icons/Glyph';
import {
  displayableProjectIcon,
  ProjectIcon,
} from '../components/icons/ProjectIcon';
import { ModelSelector } from '../components/ModelSelector';
import { normalizeWorkingDirectory } from '../components/modals/project-form-utils';
import { PageRow } from '../components/PageRow';
import { PageSection } from '../components/PageSection';
import { PathAutocomplete } from '../components/PathAutocomplete';
import {
  ProjectIconPicker,
  projectIconInputProblem,
} from '../components/project-icon/ProjectIconPicker';
import { SectionNavigation } from '../components/SectionNavigation';
import { StationPath } from '../components/StationPath';
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
import { useDevicePresentation } from '../hooks/useDevicePresentation';
import { useSectionNavigation } from '../hooks/useSectionNavigation';
import { useSurfaceVisibilityFlags } from '../hooks/useSurfaceVisibilityFlags';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import { userFacingErrorMessage } from '../utils/errorText';
import { useProjectOverviewPreview } from './project-page/projectOverviewPreview';
import { AccessSection } from './project-settings/AccessSection';
import { AgentsSection } from './project-settings/AgentsSection';
import { BriefSection } from './project-settings/BriefSection';
import { KnowledgeSection } from './project-settings/KnowledgeSection';
import { LayoutsSection } from './project-settings/LayoutsSection';
import { MemorySection } from './project-settings/MemorySection';
import { NewChatDefaultsSection } from './project-settings/NewChatDefaultsSection';
import { OverviewNotificationsSection } from './project-settings/OverviewNotificationsSection';
import { ProjectCheckoutFreshnessNotice } from './project-settings/ProjectCheckoutFreshnessNotice';
import { ProjectLifecycleSection } from './project-settings/ProjectLifecycleSection';
import { ProjectModelsSection } from './project-settings/ProjectModelsSection';
import { ProjectPullRequestSettings } from './project-settings/ProjectPullRequestSettings';
import { ProjectSchedulesSection } from './project-settings/ProjectSchedulesSection';
import { ProjectSourcesSection } from './project-settings/ProjectSourcesSection';
import { ProjectUsageSection } from './project-settings/ProjectUsageSection';
import { useProjectCoordinationPreview } from './project-settings/projectCoordinationPreview';
import { RoomCoordinatorSection } from './project-settings/RoomCoordinatorSection';
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
  ['brief', 'Brief'],
  ['memory', 'Memory'],
  ['model', 'Model'],
  ['models', 'Models and effort'],
  ['usage', 'Usage'],
  ['new-chat', 'New chats'],
  ['overview', 'Overview and notifications'],
  ['thread-execution', 'Chat workspace'],
  ['agents', 'Agents'],
  ['tools', 'Tools'],
  ['layouts', 'Layouts'],
  ['pull-requests', 'Pull requests'],
  ['coordinator', 'Coordinator'],
  ['resources', 'Sources'],
  ['access', 'People and access'],
  ['knowledge', 'Project knowledge'],
  ['schedules', 'Schedules'],
  ['danger', 'Danger zone'],
] as const;

/** Sections only the `project-coordination` preview shows. */
const PROJECT_COORDINATION_SECTIONS: ReadonlySet<string> = new Set([
  'brief',
  'memory',
  'models',
  'usage',
]);

const SECTION_SAVE_HINTS: Partial<Record<string, string>> = {
  overview: 'Changes in this section save automatically.',
  'pull-requests': 'Changes in this section save automatically.',
  brief: 'Saved changes reach new Sessions, not ones already running.',
  models: 'Saved changes reach new Sessions, not ones already running.',
  usage: 'Usage on this Station only.',
};

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
  const stationName = useDevicePresentation()?.hostName ?? 'This Station';
  const { navigate } = useNavigation();
  const showSurface = useShowSurface();

  const [form, setForm] = useState<ProjectForm | null>(null);
  // #5069/#5070: Pause/Archive and Project schedules are Feature Previews.
  const previewFlags = useSurfaceVisibilityFlags();
  const [savedForm, setSavedForm] = useState<ProjectForm | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const projectOverviewOn = useProjectOverviewPreview();
  const projectCoordination = useProjectCoordinationPreview();
  const settingsSections = PROJECT_SETTINGS_SECTIONS.filter(
    ([id]) => projectCoordination || !PROJECT_COORDINATION_SECTIONS.has(id),
  );
  const agentFeedback = previewFlags.has(PULL_REQUEST_FEEDBACK_PREVIEW_ID);
  const roomCoordinator = previewFlags.has(PROJECT_ROOM_COORDINATOR_PREVIEW_ID);
  // Keep preview section links navigable while their flags load.
  const { activeSection, hrefForSection, navigateToSection } =
    useSectionNavigation(
      PROJECT_SETTINGS_SECTIONS.map(([id]) => id),
      'workspace',
      {
        scrollOnNavigate: false,
        sectionAliases: { 'agent-feedback': 'pull-requests' },
      },
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

  // Connections a project default could actually run through. `status` on a
  // model connection is derived from "a non-empty key is saved", so `ready`
  // is the weakest honest filter available here; offering a disabled or
  // unconfigured connection would persist a pair that resolves to nothing.
  const modelConnectionsQuery = useModelConnectionsQuery();
  const modelConnections: ModelConnectionConfig[] =
    modelConnectionsQuery.data ?? [];
  const selectableModelConnections = modelConnections.filter(
    (connection) =>
      connection.kind === 'model' &&
      connection.enabled &&
      connection.status === 'ready',
  );
  const selectedConnection = selectableModelConnections.find(
    (connection) => connection.id === form?.defaultProviderId,
  );
  const unavailableConnection = Boolean(
    form?.defaultProviderId && !selectedConnection,
  );
  // Undefined (not an empty array) when there is no catalog to offer, so the
  // picker falls back to the global model list rather than rendering empty,
  // and an off-catalog id typed into it still commits.
  const selectedConnectionModels = connectionModelOptions(selectedConnection);

  const saveMutation = useUpdateProjectMutation();
  const backButton = useRef<HTMLButtonElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const restoreFocusAfterSave = useRef(false);
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

  const isDirty =
    !isLoading && !!form && JSON.stringify(form) !== JSON.stringify(savedForm);
  const { DiscardModal } = useUnsavedGuard(isDirty);
  const goBack = () => navigate(`/projects/${slug}`);
  useCloseShortcut(goBack);

  useLayoutEffect(() => {
    if (isDirty || saveMutation.isPending || !restoreFocusAfterSave.current)
      return;
    restoreFocusAfterSave.current = false;
    if (document.activeElement === document.body)
      backButton.current?.focus({ preventScroll: true });
  }, [isDirty, saveMutation.isPending]);

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
    if (!form || !isDirty || saveMutation.isPending) return;
    restoreFocusAfterSave.current =
      saveButton.current?.matches(':focus-visible') ?? false;
    setSaveError(null);
    try {
      const saved = await saveMutation.mutateAsync({
        slug,
        ...buildProjectSavePayload(form, workingDirectory, savedForm, {
          projectCoordination,
        }),
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

  return (
    <div
      className={`page page--full${activeSection === 'resources' || activeSection === 'memory' ? ' project-settings--bounded-list' : ''}`}
    >
      <DetailHeader
        title={form.name}
        badge={
          isDirty
            ? { label: 'unsaved', variant: 'warning' as const }
            : undefined
        }
        navigation={
          <Button
            ref={backButton}
            variant="ghost"
            aria-label="Back to project"
            title="Back to project"
            onClick={goBack}
          >
            <ArrowLeftGlyph />
          </Button>
        }
      >
        {(isDirty || saveMutation.isPending) && (
          <Button
            ref={saveButton}
            variant="primary"
            pending={saveMutation.isPending}
            pendingLabel="Saving…"
            disabled={!form.name.trim() || !!iconProblem}
            onClick={() => void saveProject()}
          >
            Save
          </Button>
        )}
      </DetailHeader>

      <div className="section-nav-rail project-settings__layout">
        <SectionNavigation
          label="Project settings sections"
          pickerLabel="Project settings section"
          items={settingsSections
            .filter(
              ([id]) =>
                (id !== 'overview' || projectOverviewOn) &&
                (id !== 'coordinator' || roomCoordinator),
            )
            .map(([id, label]) => ({
              key: id,
              label,
              href: hrefForSection(id),
            }))}
          activeKey={activeSection}
          onNavigate={navigateToSection}
        />

        {/* Body */}
        <div className="section-nav-rail__body project-settings__body">
          {SECTION_SAVE_HINTS[activeSection] && (
            <p className="project-settings__save-hint">
              {SECTION_SAVE_HINTS[activeSection]}
            </p>
          )}
          {isDirty &&
            activeSection !== 'basic-info' &&
            (!form.name.trim() || iconProblem) && (
              <ErrorState
                variant="compact"
                title="Review Basic info before saving"
                description={
                  !form.name.trim()
                    ? 'Enter a project name.'
                    : (iconProblem ?? undefined)
                }
                action={
                  <Button onClick={() => navigateToSection('basic-info')}>
                    Fix Basic info
                  </Button>
                }
              />
            )}
          {isLoadError && project && (
            <ErrorState
              variant="compact"
              title="Could not refresh project settings"
              description={userFacingErrorMessage(loadError)}
              action={<Button onClick={() => refetchProject()}>Retry</Button>}
            />
          )}
          {saveError && (
            <ErrorState
              variant="compact"
              title="Could not save project settings"
              description={saveError}
            />
          )}

          <div
            className="project-settings__panel"
            hidden={activeSection !== 'workspace'}
          >
            <PageSection
              id="section-workspace"
              className="project-settings__section project-settings__section--hero"
              title="Workspace"
              description="The folder used for work in this project."
              actions={
                <div className="project-settings__identity-preview">
                  <ProjectIcon
                    project={{
                      name: form.name,
                      icon: form.icon || undefined,
                      derivedIcon: project?.derivedIcon,
                      iconDisabled: form.iconDisabled,
                    }}
                    size={46}
                    fallback="initials"
                  />
                  <div className="project-settings__identity-copy">
                    <div className="project-settings__identity-name">
                      {form.name}
                    </div>
                    {workingDirectory ? (
                      <StationPath
                        path={workingDirectory}
                        stationName={stationName}
                        className="project-settings__identity-path"
                      />
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
                    On {stationName}. Use an absolute path or <code>~/…</code>.
                  </span>
                </div>
              </div>
              <div className="project-settings__checkout-freshness">
                <ProjectCheckoutFreshnessNotice slug={slug} />
              </div>
            </PageSection>
          </div>

          <div
            className="project-settings__panel"
            hidden={activeSection !== 'basic-info'}
          >
            <PageSection
              id="section-basic-info"
              className="project-settings__section"
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
                        project={{
                          name: form.name,
                          icon: form.icon || undefined,
                          derivedIcon: project?.derivedIcon,
                          iconDisabled: form.iconDisabled,
                        }}
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
                      This project’s icon can’t be shown any more. Choose a new
                      one.
                    </p>
                  )}
                  {project?.derivedIcon && !form.iconDisabled && !form.icon && (
                    <p className="project-settings__icon-notice">
                      Detected icon · Choose No icon to hide it.
                    </p>
                  )}
                  {iconPickerOpen && (
                    <ProjectIconPicker
                      idPrefix="project-settings-icon"
                      iconDisabled={legacyIcon || form.iconDisabled}
                      name={form.name}
                      value={legacyIcon ? '' : (form.icon ?? '')}
                      onUseDetected={() =>
                        setForm((current) =>
                          current
                            ? { ...current, icon: '', iconDisabled: false }
                            : current,
                        )
                      }
                      onChange={(icon, disabled) => {
                        setForm((current) =>
                          current
                            ? {
                                ...current,
                                icon,
                                iconDisabled: disabled ?? false,
                              }
                            : current,
                        );
                      }}
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
          </div>

          {projectCoordination && (
            <>
              <div
                className="project-settings__panel"
                hidden={activeSection !== 'brief'}
              >
                <BriefSection form={form} setField={setField} />
              </div>
              <div
                className="project-settings__panel"
                hidden={activeSection !== 'memory'}
              >
                {activeSection === 'memory' && <MemorySection slug={slug} />}
              </div>
            </>
          )}

          {/* Default AI Model */}
          <div
            className="project-settings__panel"
            hidden={activeSection !== 'model'}
          >
            <PageSection
              id="section-model"
              className="project-settings__section"
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
                    {unavailableConnection && (
                      <option value={form.defaultProviderId}>
                        {form.defaultProviderId} — saved connection unavailable
                      </option>
                    )}
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
                    : unavailableConnection
                      ? 'The saved connection is unavailable. Its model is preserved until you choose another connection.'
                      : form.defaultModel
                        ? 'Used with the selected connection.'
                        : 'This connection offers no model to pre-fill. Choose one, or this project uses the Station default.'
                }
                control={
                  <ModelSelector
                    value={form.defaultModel ?? ''}
                    models={selectedConnectionModels}
                    disabled={!form.defaultProviderId || unavailableConnection}
                    onChange={(modelId) => setField('defaultModel', modelId)}
                    placeholder="Station default"
                  />
                }
              />
              {modelConnectionsQuery.isError && (
                <ErrorState
                  variant="compact"
                  title="Could not load model connections"
                  description={userFacingErrorMessage(
                    modelConnectionsQuery.error,
                  )}
                  action={
                    <Button
                      onClick={() => void modelConnectionsQuery.refetch()}
                    >
                      Retry
                    </Button>
                  }
                />
              )}
            </PageSection>
          </div>

          {projectCoordination && (
            <>
              <div
                className="project-settings__panel"
                hidden={activeSection !== 'models'}
              >
                <ProjectModelsSection form={form} setField={setField} />
              </div>
              <div
                className="project-settings__panel"
                hidden={activeSection !== 'usage'}
              >
                {activeSection === 'usage' && (
                  <ProjectUsageSection slug={slug} />
                )}
              </div>
            </>
          )}

          <div
            className="project-settings__panel"
            hidden={activeSection !== 'new-chat'}
          >
            <NewChatDefaultsSection
              form={form}
              setField={setField}
              chatDefaults={chatDefaults}
              stationApprovalDefault={stationConfig?.defaultApprovalMode}
              stationConfigLoaded={stationConfig !== null}
              projectModelSet={!!form.defaultProviderId && !!form.defaultModel}
            />
          </div>

          <div
            className="project-settings__panel"
            hidden={activeSection !== 'thread-execution'}
          >
            <PageSection
              id="section-thread-execution"
              className="project-settings__section"
              title="Chat workspace"
              description="Where new chats in this Project run. A chat's own choice takes precedence."
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
          </div>

          {/* Layouts — list + save as template */}
          <div
            className="project-settings__panel"
            hidden={activeSection !== 'agents'}
          >
            <AgentsSection form={form} setForm={setForm} projectSlug={slug} />
          </div>
          <div
            className="project-settings__panel"
            hidden={activeSection !== 'tools'}
          >
            <ToolsSection slug={slug} form={form} setForm={setForm} />
          </div>

          <div
            className="project-settings__panel"
            hidden={activeSection !== 'overview'}
          >
            {projectOverviewOn && (
              <OverviewNotificationsSection
                slug={slug}
                projectId={project?.id}
                autoResolveDays={project?.overviewAutoResolveDays}
              />
            )}
          </div>

          <div
            className="project-settings__panel"
            hidden={activeSection !== 'layouts'}
          >
            <LayoutsSection slug={slug} />
          </div>

          <div
            className="project-settings__panel"
            hidden={activeSection !== 'pull-requests'}
          >
            <ProjectPullRequestSettings
              project={project}
              slug={slug}
              active={activeSection === 'pull-requests'}
              feedbackAvailable={agentFeedback}
              onSaved={refetchProject}
              onSources={() => navigateToSection('resources')}
            />
          </div>

          {roomCoordinator && (
            <div
              className="project-settings__panel"
              hidden={activeSection !== 'coordinator'}
            >
              <RoomCoordinatorSection
                slug={slug}
                settings={project?.roomCoordinator}
                onSaved={refetchProject}
              />
            </div>
          )}

          <div
            className="project-settings__panel"
            hidden={activeSection !== 'resources'}
          >
            <ProjectSourcesSection
              slug={slug}
              projectId={project?.id}
              stationName={stationName}
              onNavigateToSection={navigateToSection}
              hrefForSection={hrefForSection}
            />
          </div>
          <div
            className="project-settings__panel"
            hidden={activeSection !== 'access'}
          >
            {project && <AccessSection slug={slug} projectId={project.id} />}
          </div>

          {/* Knowledge */}
          <div
            className="project-settings__panel"
            hidden={activeSection !== 'knowledge'}
          >
            <KnowledgeSection slug={slug} />
          </div>

          {/* #5070: the Project's own schedules (`project-schedules` preview) */}
          <div
            className="project-settings__panel"
            hidden={activeSection !== 'schedules'}
          >
            {project && previewFlags.has('project-schedules') && (
              <ProjectSchedulesSection
                projectId={project.id}
                projectName={form.name}
                held={project.lifecycle !== undefined}
              />
            )}
          </div>

          {/* #5069: Pause, Archive, Delete */}
          <div
            className="project-settings__panel"
            hidden={activeSection !== 'danger'}
          >
            <ProjectLifecycleSection
              slug={slug}
              name={form.name}
              lifecycle={project?.lifecycle}
              pauseArchiveEnabled={previewFlags.has('project-pause-archive')}
              // The Project is gone, so there is no "back": land on Home BY
              // NAME, placed in `main`, not on whatever occupies it (#1523).
              onDeleted={() => showSurface('home')}
            />
          </div>
        </div>
      </div>

      <DiscardModal />
    </div>
  );
}
