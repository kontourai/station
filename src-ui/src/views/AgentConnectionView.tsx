import {
  type EngineConnectionId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import type {
  CredentialProfile,
  CredentialProfileApplicationProjection,
} from '@kontourai/station-contracts/connection-recovery';
import type {
  AgentConnectionView as AgentConnectionViewData,
  ConnectionConfig,
} from '@kontourai/station-contracts/tool';
import {
  useAgentConnectionCatalogQuery,
  useAgentConnectionQuery,
  useAgentConnectionsQuery,
  useAppHomeProfileQuery,
  useApplyCredentialProfileMutation,
  useClearAppHomeProfileMutation,
  useCredentialRecoveryQuery,
  useDeleteAgentConnectionMutation,
  useDeleteCredentialProfileMutation,
  useImportAppHomeSnapshotMutation,
  useImportCredentialProfileSnapshotMutation,
  useSaveAgentConnectionMutation,
  useSetCredentialProfileEnrollmentMutation,
  useSetCredentialRecoveryAutomaticPolicyMutation,
  useSkillsQuery,
  useTestAgentConnectionMutation,
  useUpsertCredentialProfileMutation,
} from '@kontourai/station-sdk';
import { useEffect, useMemo, useState } from 'react';
import { Checkbox } from '../components/Checkbox';
import { DetailHeader } from '../components/DetailHeader';
import { BrandIcon } from '../components/icons/BrandIcon';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import { SplitPaneLayout } from '../components/SplitPaneLayout';
import { CONNECTIONS_ENGINES_PANE_ID } from '../components/split-pane-metrics';
import {
  describeReadFailure,
  Empty,
  ErrorState,
  SkeletonBlock,
} from '../components/state';
import {
  type ACPConnectionRegistryEntry,
  useACPConnectionRegistry,
} from '../hooks/useACPConnections';
import type { NavigationView } from '../types';
import {
  capabilityLabel,
  connectionDisplayLabel,
  connectionEngineId,
  connectionStatusLabel,
  connectionTypeLabel,
  prerequisiteCategoryLabel,
  prerequisiteStatusLabel,
  runtimeCatalogSourceLabel,
  runtimeCatalogSourceSentence,
} from '../utils/execution';
import { CredentialProfileEnrolment } from './CredentialProfileEnrolment';
import { resolveProviderPresentation } from './provider-settings/providerCatalog';
import './PluginManagementView.css';
import './page-layout.css';
import './editor-layout.css';

interface AgentConnectionViewProps {
  selectedRuntimeId?: EngineConnectionId | string;
  onNavigate: (view: NavigationView) => void;
}

/**
 * Whether this Station has ADDED an engine, as opposed to merely supporting it
 * (archive#3981).
 *
 * `available` means "supported here, but not yet added or usable"
 * (`AgentConnectionView['setup']`), so the configured list is right to omit
 * it — but it is then the ONLY thing the Add catalogue can usefully offer.
 * Both derivations ask this one question so they cannot disagree: Add used to
 * subtract every id in the inventory, which removed the very rows the list had
 * just dropped. A detected engine was then absent from BOTH surfaces, and the
 * emptied catalogue asserted "Every supported provider is already listed" —
 * the opposite of what the reader could see beside it, with no path left to
 * persist the engine at all.
 *
 * Module scope, not a component body: it closes over nothing, and as a
 * per-render arrow it destabilised the two memos that read it.
 */
function isAddedEngine(connection: AgentConnectionViewData): boolean {
  return connection.setup?.state !== 'available';
}

export function AgentConnectionView({
  selectedRuntimeId,
  onNavigate,
}: AgentConnectionViewProps) {
  const [search, setSearch] = useState('');
  const [form, setForm] = useState<AgentConnectionViewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAddCatalog, setShowAddCatalog] = useState(false);
  /**
   * The section frame owns this section's single add action (design P3), and
   * it navigates to `/connections/engines/new` rather than reaching into this
   * component's state. `new` is not a connection id: it selects nothing, and
   * opens the same add catalog the in-page trigger opens.
   */
  const isAddRoute = selectedRuntimeId === 'new';
  const addCatalogOpen = isAddRoute || showAddCatalog;

  const {
    data: runtimes = [],
    isLoading,
    error: runtimesError,
    refetch: refetchRuntimes,
  } = useAgentConnectionsQuery() as {
    data?: AgentConnectionViewData[];
    isLoading?: boolean;
    error?: unknown;
    refetch: () => unknown;
  };
  const { data: catalog = [] } = useAgentConnectionCatalogQuery() as {
    data?: AgentConnectionViewData[];
  };
  // The merged Add-engine catalogue's second population (#592 slice 2):
  // registry entries not yet installed as a connection. `installed` already
  // reflects a configured ACP connection, the same fact
  // `ACPConnectionsSection` filters on for its own registry read.
  const { data: acpRegistryEntries = [] } = useACPConnectionRegistry() as {
    data?: ACPConnectionRegistryEntry[];
  };
  const availableCommandEntries = useMemo(
    () => acpRegistryEntries.filter((entry) => !entry.installed),
    [acpRegistryEntries],
  );
  const onChooseCommand = (choice: ACPConnectionRegistryEntry | 'custom') =>
    onNavigate({
      type: 'connections-acp-new',
      providerId: choice === 'custom' ? 'custom' : choice.id,
    });

  const selectedEngineConnectionId =
    selectedRuntimeId && !isAddRoute
      ? engineConnectionId(selectedRuntimeId)
      : undefined;
  const { data: runtime } = useAgentConnectionQuery(
    selectedEngineConnectionId,
    {
      enabled: !!selectedEngineConnectionId,
    },
  );

  useEffect(() => {
    if (!runtime) {
      setForm(null);
      setError(null);
      return;
    }
    setForm({
      ...runtime,
      capabilities: [...runtime.capabilities],
      config: { ...runtime.config },
      prerequisites: [...runtime.prerequisites],
    });
    setError(null);
  }, [runtime]);

  const saveMutation = useSaveAgentConnectionMutation({
    onSuccess: (saved) => {
      setForm(saved);
      setError(null);
      setShowAddCatalog(false);
      onNavigate({ type: 'connections-runtime-edit', id: saved.id });
    },
    onError: (mutationError: Error) => {
      setError(mutationError.message);
    },
  });

  const resetMutation = useDeleteAgentConnectionMutation({
    onSuccess: () => {
      setError(null);
    },
    onError: (mutationError: Error) => {
      setError(mutationError.message);
    },
  });

  const testMutation = useTestAgentConnectionMutation();

  const externalAgentApps = useMemo(
    () =>
      runtimes.filter(
        (connection) => connectionEngineId(connection) !== 'station',
      ),
    [runtimes],
  );
  const availableAgentApps = useMemo(() => {
    const addedIds = new Set(
      externalAgentApps.filter(isAddedEngine).map(({ id }) => id),
    );
    return (
      catalog
        .filter((connection) => connectionEngineId(connection) !== 'station')
        // Review fix (#592 slice 2, M1): the catalog endpoint is not
        // registration-authoritative — it can carry entries this Station
        // already considers 'ready'/'configured' (an adapter the runtime
        // inventory hasn't registered yet). Only a genuinely `available` row
        // belongs in the Add catalogue; `isAddedEngine` is the one place that
        // question is answered, so the negation of it — not "not yet in
        // addedIds" — is the filter, mirroring
        // ProviderSettingsView.tsx's `agentChoices` derivation.
        .filter((connection) => !isAddedEngine(connection))
        .filter((connection) => !addedIds.has(connection.id))
    );
  }, [catalog, externalAgentApps]);
  const addedAgentApps = useMemo(
    () => externalAgentApps.filter(isAddedEngine),
    [externalAgentApps],
  );
  const items = useMemo(
    () =>
      addedAgentApps
        .filter((connection) => {
          if (!search) return true;
          const query = search.toLowerCase();
          return (
            connection.name.toLowerCase().includes(query) ||
            connection.type.toLowerCase().includes(query)
          );
        })
        .map((connection) => ({
          id: connection.id,
          name: connection.name,
          // The third segment used to be `connectionTypeLabel(type)`, which
          // either repeated the row's own name ("Claude Code · Claude Code")
          // or printed a slug for a type the map had missed ("muse-runtime").
          // The row is already named; the subtitle says what is true of it.
          subtitle: `${connectionStatusLabel(connection.status)} · ${runtimeCatalogSourceSentence(connection.runtimeCatalog?.source ?? 'none')}`,
          icon: (
            <BrandIcon name={connection.name} id={connection.id} size={22} />
          ),
        })),
    [addedAgentApps, search],
  );

  function setField<K extends keyof ConnectionConfig>(
    key: K,
    value: ConnectionConfig[K],
  ) {
    setForm((current) => (current ? { ...current, [key]: value } : current));
  }

  function setConfigField(key: string, value: unknown) {
    setForm((current) =>
      current
        ? {
            ...current,
            config: {
              ...current.config,
              [key]: value,
            },
          }
        : current,
    );
  }

  const providerLabel = form
    ? connectionDisplayLabel(form)
    : connectionTypeLabel('');
  const runtimeCatalog = (form as AgentConnectionViewData | null)
    ?.runtimeCatalog;
  const capabilityInventory = (form as AgentConnectionViewData | null)
    ?.capabilityInventory;
  const continuity = (form as AgentConnectionViewData | null)?.continuity;
  const providerPresentation = form
    ? resolveProviderPresentation({
        id: form.id,
        kind: 'agent',
        type: form.type,
        name: form.name,
        enabled: form.enabled,
        status: form.status,
        prerequisites: form.prerequisites,
        setup: form.setup,
        href: '',
      })
    : null;
  const reportedModelCount = runtimeCatalog
    ? runtimeCatalog.models.length || runtimeCatalog.builtInModels.length
    : 0;

  return (
    <SplitPaneLayout
      paneId={CONNECTIONS_ENGINES_PANE_ID}
      listClassName="entrance-stagger"
      label={
        selectedRuntimeId
          ? 'Connections / Engines / Detail'
          : 'Connections / Engines'
      }
      breadcrumbLinks={
        selectedRuntimeId
          ? {
              connections: () => onNavigate({ type: 'connections' }),
              engines: () =>
                onNavigate({ type: 'connections-engines' } as NavigationView),
            }
          : { connections: () => onNavigate({ type: 'connections' }) }
      }
      title="Engines"
      subtitle="Connect installed engines for chats and delegated work"
      loading={isLoading}
      error={runtimesError}
      onRetry={() => void refetchRuntimes()}
      items={items}
      selectedId={isAddRoute ? null : (selectedRuntimeId ?? null)}
      onSelect={(id) => {
        setShowAddCatalog(false);
        onNavigate({ type: 'connections-runtime-edit', id });
      }}
      onDeselect={() => {
        setShowAddCatalog(false);
        onNavigate({ type: 'connections-engines' } as NavigationView);
      }}
      onSearch={setSearch}
      searchValue={search}
      listFilteredEmptyNoun="engines"
      collectionEmpty={addedAgentApps.length === 0}
      /* empty-state action: the section frame's "Add engine" is adjacent. Copy
         stays action-shaped (matching the sibling providers list) rather than
         a bespoke "No engines yet" — the state-primitives ratchet exists to
         stop every view minting its own "No X" restatement of its noun. */
      listEmptyTitle="Add an engine to get started"
      listEmptyDescription="Detected and supported engines appear here once one is connected."
      emptyTitle="Select an engine"
      emptyDescription="Select an engine to review its status and setup."
      emptyContent={
        addCatalogOpen ? (
          <EngineAddCatalog
            connections={availableAgentApps}
            commandEntries={availableCommandEntries}
            error={error}
            pendingId={
              saveMutation.isPending
                ? saveMutation.variables?.connection.id
                : undefined
            }
            onAdd={(connection) =>
              saveMutation.mutate({ connection, isNew: false })
            }
            onChooseCommand={onChooseCommand}
          />
        ) : undefined
      }
      unselectedDetailOpen={addCatalogOpen}
      searchPlaceholder="Search engines..."
    >
      {form ? (
        <div className="editor-layout">
          <DetailHeader
            title={form.name}
            icon={<BrandIcon name={form.name} id={form.id} size={28} />}
          />
          <div className="agent-editor__section">
            <nav
              className="provider-detail__progress"
              aria-label="Engine setup"
            >
              <span className="provider-detail__progress-step provider-detail__progress-step--complete">
                Choose
              </span>
              <span aria-hidden="true">→</span>
              <span className="provider-detail__progress-step">Connect</span>
              <span aria-hidden="true">→</span>
              <span className="provider-detail__progress-step">Ready</span>
            </nav>

            <div className="provider-detail__summary" aria-live="polite">
              <div>
                <span className="provider-detail__summary-label">Status</span>
                <strong>{providerPresentation?.readiness}</strong>
              </div>
              <div>
                <span className="provider-detail__summary-label">Models</span>
                <strong>
                  {reportedModelCount > 0 ? reportedModelCount : 'Not reported'}
                </strong>
              </div>
              <div>
                <span className="provider-detail__summary-label">
                  Last check
                </span>
                <strong>
                  {form.lastCheckedAt
                    ? new Date(form.lastCheckedAt).toLocaleString()
                    : 'Not checked'}
                </strong>
              </div>
            </div>

            {providerPresentation?.readiness !== 'Ready' && (
              <div className="provider-detail__notice">
                <strong>{providerPresentation?.readiness}</strong>
                <span>{providerPresentation?.detail}</span>
                {form.prerequisites
                  .filter((item) => item.status !== 'installed')
                  .map((item) => (
                    <span key={item.id}>{item.name}</span>
                  ))}
              </div>
            )}

            <details className="provider-detail__advanced">
              <summary>Advanced</summary>
              <div className="provider-detail__advanced-fields">
                <div className="editor-field">
                  <label className="editor-label" htmlFor="agent-provider-name">
                    Name
                  </label>
                  <input
                    id="agent-provider-name"
                    className="editor-input"
                    value={form.name}
                    onChange={(event) => setField('name', event.target.value)}
                  />
                </div>

                <div className="editor-field">
                  <span className="editor-label">Type</span>
                  <div className="editor-input editor-input--readonly">
                    {connectionTypeLabel(form.type)}
                  </div>
                </div>

                <div className="editor-field">
                  <span className="editor-label">Status</span>
                  <div className="editor-input editor-input--readonly">
                    {connectionStatusLabel(form.status)}
                  </div>
                </div>

                <div className="editor-field">
                  <span className="editor-label">Catalog</span>
                  <div className="editor-input editor-input--readonly">
                    {runtimeCatalogSourceLabel(
                      runtimeCatalog?.source ?? 'none',
                    )}
                  </div>
                  {runtimeCatalog?.reason && (
                    <p className="editor-help">{runtimeCatalog.reason}</p>
                  )}
                </div>

                <div className="editor-field">
                  <span className="editor-label">Model backend</span>
                  <div
                    className="editor-input"
                    style={{
                      background: 'var(--bg-tertiary)',
                      cursor: 'default',
                    }}
                  >
                    {providerLabel || 'Unknown'}
                  </div>
                </div>

                <div className="editor-field">
                  <label className="editor-label" htmlFor="runtime-enabled">
                    Enabled
                  </label>
                  <label className="editor-checkbox">
                    <input
                      id="runtime-enabled"
                      type="checkbox"
                      checked={form.enabled}
                      onChange={(event) =>
                        setField('enabled', event.target.checked)
                      }
                    />
                    <span>
                      Expose this engine in Connections and agent setup
                    </span>
                  </label>
                </div>

                <div className="editor-field">
                  <span className="editor-label">Capabilities</span>
                  <div className="plugins__caps">
                    {form.capabilities.map((capability) => (
                      <span key={capability} className="plugins__cap">
                        {capabilityLabel(capability)}
                      </span>
                    ))}
                  </div>
                </div>

                <div className="editor-field">
                  <span className="editor-label">Description</span>
                  <p className="editor-help">
                    {form.description || 'No description available.'}
                  </p>
                </div>

                <div className="editor-field">
                  <span className="editor-label">Continuity</span>
                  <p className="editor-help">
                    {continuity
                      ? [
                          continuity.resume === 'same-session'
                            ? 'Can continue this execution session when its engine supports it.'
                            : 'Cannot resume an existing execution session.',
                          continuity.fork === 'native'
                            ? 'Can create an engine-native conversation branch.'
                            : continuity.fork === 'replay-seed'
                              ? 'Can start a new conversation from Station’s transcript. It does not carry engine cursor, tool, or approval state.'
                              : 'Cannot create an engine-native branch.',
                          continuity.rewind === 'in-place'
                            ? 'Can rewind this execution session in place.'
                            : 'Cannot rewind an execution session in place.',
                        ].join(' ')
                      : 'No native continuity capability declared by this connection.'}
                  </p>
                </div>

                {'defaultModel' in form.config && (
                  <div className="editor-field">
                    <label
                      className="editor-label"
                      htmlFor="agent-default-model"
                    >
                      Default model
                    </label>
                    <input
                      id="agent-default-model"
                      className="editor-input"
                      value={String(form.config.defaultModel || '')}
                      onChange={(event) =>
                        setConfigField('defaultModel', event.target.value)
                      }
                      placeholder="App default"
                    />
                    <p className="editor-help">
                      Optional app-scoped default model hint. Leave blank to
                      inherit the app default.
                    </p>
                  </div>
                )}

                {form.type === 'claude-runtime' && (
                  <ClaudeSkillsMaterializationField
                    selectedSkillIds={
                      Array.isArray(form.config.provideSkills)
                        ? form.config.provideSkills.filter(
                            (id): id is string => typeof id === 'string',
                          )
                        : []
                    }
                    onChange={(ids) => setConfigField('provideSkills', ids)}
                  />
                )}

                {(form.type === 'claude-runtime' ||
                  form.type === 'codex-runtime') && (
                  <AppHomeProfileField
                    connectionId={form.id}
                    engineLabel={
                      form.type === 'claude-runtime' ? 'Claude Code' : 'Codex'
                    }
                    useAppHome={form.config.useAppHome === true}
                    onToggle={(value) => setConfigField('useAppHome', value)}
                  />
                )}

                {runtimeCatalog && (
                  <div className="editor-field">
                    <span className="editor-label">Models</span>
                    <p className="editor-help">
                      {runtimeCatalog.models.length > 0
                        ? `${runtimeCatalog.models.length} live or cached models available.`
                        : runtimeCatalog.builtInModels.length > 0
                          ? `${runtimeCatalog.builtInModels.length} built-in models available.`
                          : 'No models reported.'}
                    </p>
                    <div className="plugins__caps">
                      {(runtimeCatalog.models.length > 0
                        ? runtimeCatalog.models
                        : runtimeCatalog.builtInModels
                      ).map((model) => (
                        <span key={model.id} className="plugins__cap">
                          {model.name}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {capabilityInventory && (
                  <div className="editor-field">
                    <span className="editor-label">Capabilities</span>
                    <p className="editor-help">
                      {capabilityInventory.displayName} ·{' '}
                      {capabilityInventory.freshness} inventory ·{' '}
                      {capabilityInventory.status}
                    </p>
                    {capabilityInventory.message && (
                      <p className="editor-help">
                        {capabilityInventory.message}
                      </p>
                    )}
                    {capabilityInventory.models.length > 0 && (
                      <>
                        <div className="editor-label">Models</div>
                        <div className="plugins__caps">
                          {capabilityInventory.models.map((model) => (
                            <span key={model.id} className="plugins__cap">
                              {model.name}
                            </span>
                          ))}
                        </div>
                      </>
                    )}
                    {capabilityInventory.slashCommands.length > 0 && (
                      <>
                        <div className="editor-label">Native Commands</div>
                        <div className="plugins__registry-list">
                          {capabilityInventory.slashCommands.map((command) => (
                            <div
                              key={command.id}
                              className="plugins__registry-item"
                            >
                              <div className="plugins__registry-info">
                                <div className="plugins__registry-name">
                                  {command.name}
                                  <span className="plugins__cap plugins__cap--ref">
                                    read-only
                                  </span>
                                </div>
                                {command.description && (
                                  <div className="plugins__registry-desc">
                                    {command.description}
                                  </div>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}

                <div className="editor-field">
                  <span className="editor-label">Prerequisites</span>
                  {form.prerequisites.length > 0 ? (
                    <div className="plugins__registry-list">
                      {form.prerequisites.map((item) => (
                        <div key={item.id} className="plugins__registry-item">
                          <div className="plugins__registry-info">
                            <div className="plugins__registry-name">
                              {item.name}
                              <span className="plugins__cap plugins__cap--ref">
                                {prerequisiteCategoryLabel(item.category)}
                              </span>
                              <span
                                className={`plugins__cap plugins__cap--ref ${item.status === 'installed' ? 'plugins__cap--ok' : 'plugins__cap--error'}`}
                              >
                                {prerequisiteStatusLabel(item.status)}
                              </span>
                            </div>
                            {item.description && (
                              <div className="plugins__registry-desc">
                                {item.description}
                              </div>
                            )}
                            {item.installGuide && (
                              <div style={{ marginTop: 8 }}>
                                <ol
                                  style={{
                                    margin: '4px 0 0',
                                    paddingLeft: 20,
                                    fontSize: 12,
                                    color: 'var(--text-secondary)',
                                  }}
                                >
                                  {item.installGuide.steps.map((step, i) => (
                                    <li key={i} style={{ marginBottom: 4 }}>
                                      {step}
                                    </li>
                                  ))}
                                </ol>
                                {item.installGuide.links?.map((link, i) => (
                                  <a
                                    key={i}
                                    href={link}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{
                                      display: 'inline-block',
                                      marginTop: 4,
                                      marginRight: 12,
                                      fontSize: 12,
                                      color: 'var(--accent-primary)',
                                    }}
                                  >
                                    Documentation →
                                  </a>
                                ))}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="editor-help">No prerequisites reported.</p>
                  )}
                </div>
                <div className="editor-field">
                  <button
                    type="button"
                    className="editor-btn editor-btn--ghost"
                    onClick={() =>
                      resetMutation.mutate(engineConnectionId(form.id))
                    }
                    disabled={saveMutation.isPending || resetMutation.isPending}
                  >
                    {resetMutation.isPending
                      ? 'Resetting…'
                      : 'Reset to defaults'}
                  </button>
                </div>
              </div>
            </details>

            <div className="editor-field">
              <span className="editor-label">Actions</span>
              <div className="editor-row">
                <button
                  type="button"
                  className="editor-btn"
                  onClick={() =>
                    saveMutation.mutate({ connection: form, isNew: false })
                  }
                  disabled={saveMutation.isPending || resetMutation.isPending}
                >
                  {saveMutation.isPending ? 'Saving…' : 'Save'}
                </button>
                <button
                  type="button"
                  className="editor-btn"
                  onClick={() => testMutation.mutate(form.id)}
                  disabled={testMutation.isPending}
                >
                  {testMutation.isPending ? 'Checking…' : 'Check again'}
                </button>
              </div>
              {testMutation.data && (
                <p
                  className={`editor-help ${
                    testMutation.data.healthy
                      ? 'editor-help--healthy'
                      : 'editor-help--unhealthy'
                  }`}
                >
                  {testMutation.data.healthy ? 'Healthy' : 'Unavailable'} ·{' '}
                  {connectionStatusLabel(testMutation.data.status ?? 'unknown')}
                </p>
              )}
              {testMutation.error && (
                <p className="editor-error">
                  {testMutation.error instanceof Error
                    ? testMutation.error.message
                    : String(testMutation.error)}
                </p>
              )}
              {error && <p className="editor-error">{error}</p>}
            </div>
          </div>
        </div>
      ) : (
        <Empty
          variant="prominent"
          label="Select an engine to review its status and setup."
        />
      )}
    </SplitPaneLayout>
  );
}

/**
 * The Engines tab's one Add catalogue (#592 slice 2): the two catalogues that
 * used to live on separate routes — this file's own detected/supported
 * native engines, and the ACP registry's CLI list inside its add modal — are
 * one list here, sharing the readiness vocabulary every other picker on
 * Connections already uses (`resolveProviderPresentation`) instead of the
 * bespoke Detected/Available chips this replaces.
 *
 * A native engine keeps its existing one-click add (`onAdd`, no
 * confirmation step — this catalogue only ever offers `setup.state ===
 * 'available'` rows, so there is nothing to confirm). An ACP registry entry
 * or the trailing custom option instead navigates into the existing
 * `/connections/engines/new/<id>` setup flow (`ACPConnectionSetupStages`),
 * which still owns confirm/checking/result — that flow is the setup
 * machinery, not a second catalogue.
 */
function EngineAddCatalog({
  connections,
  commandEntries,
  error,
  pendingId,
  onAdd,
  onChooseCommand,
}: {
  connections: AgentConnectionViewData[];
  commandEntries: ACPConnectionRegistryEntry[];
  error?: string | null;
  pendingId?: string;
  onAdd: (connection: AgentConnectionViewData) => void;
  onChooseCommand: (entry: ACPConnectionRegistryEntry | 'custom') => void;
}) {
  const hasCatalogEntries = connections.length > 0 || commandEntries.length > 0;
  return (
    <div className="editor-layout agent-app-catalog">
      <DetailHeader
        title="Add engine"
        subtitle="Station checks local apps and commands before showing them as ready."
      />
      {error ? <div className="editor-error">{error}</div> : null}
      {!hasCatalogEntries && (
        <Empty
          variant="prominent"
          label="Every supported engine is already listed"
          description="Detected apps and commands that are ready appear in the main list automatically. Connect a custom command below, or install another supported app and reopen this catalog."
        />
      )}
      <div className="plugins__registry-list">
        {connections.map((connection) => {
          const presentation = resolveProviderPresentation({
            id: connection.id,
            kind: 'agent',
            type: connection.type,
            name: connection.name,
            enabled: connection.enabled,
            status: connection.status,
            prerequisites: connection.prerequisites,
            setup: connection.setup,
            description: connection.description,
            href: '',
          });
          return (
            <div className="plugins__registry-item" key={connection.id}>
              <BrandIcon name={connection.name} id={connection.id} size={28} />
              <div className="plugins__registry-info">
                <div className="plugins__registry-name">
                  {connection.name}
                  <span className="plugins__cap plugins__cap--ref">
                    {presentation.readiness}
                  </span>
                </div>
                <div className="plugins__registry-desc">
                  {presentation.detail}
                </div>
              </div>
              <button
                type="button"
                className="editor-btn"
                disabled={pendingId === connection.id}
                onClick={() => onAdd(connection)}
                aria-label={
                  pendingId === connection.id
                    ? `Adding ${connection.name}`
                    : `Add ${connection.name}`
                }
              >
                {pendingId === connection.id ? 'Adding…' : 'Add'}
              </button>
            </div>
          );
        })}
        {commandEntries.map((entry) => {
          const presentation = resolveProviderPresentation({
            id: entry.id,
            kind: 'command',
            type: 'acp',
            name: entry.name,
            enabled: true,
            status: 'unknown',
            setup: null,
            discovery: entry.detected ? 'detected-unconfigured' : undefined,
            description: entry.description,
            href: '',
          });
          return (
            <div className="plugins__registry-item" key={entry.id}>
              <BrandIcon name={entry.name} id={entry.id} size={28} />
              <div className="plugins__registry-info">
                <div className="plugins__registry-name">
                  {entry.name}
                  <span className="plugins__cap plugins__cap--ref">
                    {presentation.readiness}
                  </span>
                </div>
                <div className="plugins__registry-desc">
                  {presentation.detail}
                </div>
              </div>
              <button
                type="button"
                className="editor-btn"
                onClick={() => onChooseCommand(entry)}
                aria-label={`${presentation.actionLabel} ${entry.name}`}
              >
                {presentation.actionLabel}
              </button>
            </div>
          );
        })}
        <div className="plugins__registry-item">
          <div className="plugins__registry-info">
            <div className="plugins__registry-name">Custom engine</div>
            <div className="plugins__registry-desc">
              Connect an engine that runs its own tools from a local command.
            </div>
          </div>
          <button
            type="button"
            className="editor-btn"
            aria-label="Set up custom engine"
            onClick={() => onChooseCommand('custom')}
          >
            Set up
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Skills materialization opt-in (docs/design/connections-onboarding.md §5):
 * an accessible multiselect of installed Station skills, scoped to the
 * claude-runtime connection only. Off by default — nothing is selected
 * until the user checks a box, and the resulting id list is only persisted
 * when the surrounding form's "Save Changes" button is pressed (mirrors how
 * Default Model above is edited, unlike the ACP tool-servers modal's
 * auto-save-per-toggle pattern).
 */
function ClaudeSkillsMaterializationField({
  selectedSkillIds,
  onChange,
}: {
  selectedSkillIds: string[];
  onChange: (ids: string[]) => void;
}) {
  const { data: skills = [] } = useSkillsQuery() as {
    data?: Array<{ name: string; description?: string }>;
  };

  function toggleSkill(id: string, checked: boolean) {
    onChange(
      checked
        ? [...new Set([...selectedSkillIds, id])]
        : selectedSkillIds.filter((existing) => existing !== id),
    );
  }

  return (
    <div className="editor-field">
      <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
        <legend className="editor-label" style={{ padding: 0 }}>
          Skills materialization
        </legend>
        <p className="editor-help">
          Off by default. Checking a skill copies it into this session's{' '}
          <code>.claude/skills/</code> so Claude Code loads it natively. Station
          never overwrites files it didn't write there, and removes only what it
          wrote once the session ends.
        </p>
        {skills.length === 0 ? (
          <p className="editor-help">
            No skills installed yet — install one from the Registry.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            {skills.map((skill) => (
              <Checkbox
                key={skill.name}
                id={`claude-runtime-skill-${skill.name}`}
                checked={selectedSkillIds.includes(skill.name)}
                onChange={(checked) => toggleSkill(skill.name, checked)}
              >
                {skill.name}
                {skill.description ? ` — ${skill.description}` : ''}
              </Checkbox>
            ))}
          </div>
        )}
      </fieldset>
    </div>
  );
}

/**
 * App-home profile opt-in (#896,
 * docs/design/agent-engine-unification.md §6.1's overlay model): a
 * Station-managed config home for the connection's sessions, off by
 * default. Parameterized over `engineLabel` (#896  — claude-runtime
 * and codex-runtime both render this field). Import is a separate,
 * explicit user action — never triggered by the toggle or a form save —
 * and always renders its copied/skipped report, never silent.
 */
/** `sizeBytes` → a short human-readable string (e.g. `1.2 MB`). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function AppHomeProfileField({
  connectionId,
  engineLabel,
  useAppHome,
  onToggle,
}: {
  connectionId: string;
  engineLabel: string;
  useAppHome: boolean;
  onToggle: (value: boolean) => void;
}) {
  const [includeCredentials, setIncludeCredentials] = useState(false);
  const [confirmClearOpen, setConfirmClearOpen] = useState(false);
  // Read-only status peek (docs/design/agent-engine-unification.md §6.1) —
  // fetched regardless of the toggle so a profile left over from a prior
  // opt-in still shows its usage report and clear action after the toggle
  // is turned back off.
  const { data: status } = useAppHomeProfileQuery(connectionId);
  const importMutation = useImportAppHomeSnapshotMutation();
  const clearMutation = useClearAppHomeProfileMutation();

  return (
    <div className="editor-field">
      <fieldset style={{ border: 'none', margin: 0, padding: 0 }}>
        <legend className="editor-label" style={{ padding: 0 }}>
          App home
        </legend>
        <Checkbox
          id={`${connectionId}-use-app-home`}
          checked={useAppHome}
          onChange={onToggle}
        >
          Run sessions in a Station-managed app home
        </Checkbox>
        <p className="editor-help">
          Keeps your global {engineLabel} settings untouched. Station points
          sessions at ~/.station/app-homes/{connectionId} instead.
        </p>
        {useAppHome && (
          <div style={{ marginTop: 8 }}>
            {status && (
              <p className="editor-help">
                {status.exists
                  ? `This app home is ${status.seededFrom === 'global-import' ? 'seeded from an imported snapshot' : 'currently empty'}. Sign-in status: ${status.authState}.${status.keychainAuthPossible ? ' On macOS, sign-in through the system Keychain works independently of this app home.' : ''}`
                  : 'No app home exists yet — Station creates it automatically the first time a session runs with this option on.'}
              </p>
            )}
            <label
              className="editor-checkbox"
              htmlFor={`${connectionId}-app-home-include-credentials`}
            >
              <input
                id={`${connectionId}-app-home-include-credentials`}
                type="checkbox"
                checked={includeCredentials}
                onChange={(event) =>
                  setIncludeCredentials(event.target.checked)
                }
              />
              <span>Include sign-in credentials</span>
            </label>
            <div className="editor-row">
              <button
                type="button"
                className="editor-btn"
                disabled={importMutation.isPending}
                onClick={() =>
                  importMutation.mutate({
                    id: connectionId,
                    includeCredentials,
                  })
                }
              >
                {importMutation.isPending
                  ? 'Importing…'
                  : `Import a snapshot of your global ${engineLabel} settings`}
              </button>
            </div>
            {importMutation.data && (
              <p className="editor-help">
                Copied:{' '}
                {importMutation.data.copied.length > 0
                  ? importMutation.data.copied.join(', ')
                  : 'nothing'}
                {importMutation.data.skipped.length > 0 && (
                  <>
                    {' '}
                    · Skipped:{' '}
                    {importMutation.data.skipped
                      .map((entry) => `${entry.path} (${entry.reason})`)
                      .join(', ')}
                  </>
                )}
                {!importMutation.data.provenanceUpdated && (
                  <>
                    {' '}
                    · Nothing was copied, so this app home was not marked as
                    imported.
                  </>
                )}
              </p>
            )}
            {importMutation.error && (
              <p className="editor-error">
                {importMutation.error instanceof Error
                  ? importMutation.error.message
                  : String(importMutation.error)}
              </p>
            )}
          </div>
        )}
        <CredentialRecoveryField
          connectionId={connectionId}
          engineLabel={engineLabel}
        />
        {status?.exists && status.usage && (
          <div style={{ marginTop: 8 }}>
            <p className="editor-help">
              {`This app home is using ${formatBytes(status.usage.sizeBytes)} across ${status.usage.entryCount}${status.usage.truncated ? '+' : ''} items.`}
            </p>
            <div className="editor-row">
              <button
                type="button"
                className="editor-btn"
                disabled={useAppHome || clearMutation.isPending}
                title={
                  useAppHome
                    ? 'Turn the app home off and save before clearing it.'
                    : undefined
                }
                onClick={() => setConfirmClearOpen(true)}
              >
                {clearMutation.isPending ? 'Clearing…' : 'Clear this app home'}
              </button>
            </div>
            {useAppHome && (
              <p className="editor-help">
                Turn the app home off and save before clearing it.
              </p>
            )}
            {clearMutation.error && (
              <p className="editor-error">
                {clearMutation.error instanceof Error
                  ? clearMutation.error.message
                  : String(clearMutation.error)}
              </p>
            )}
          </div>
        )}
      </fieldset>
      <ConfirmModal
        isOpen={confirmClearOpen}
        title="Clear app home"
        message={`This permanently removes the Station-managed app home at ~/.station/app-homes/${connectionId}, including any imported settings. This cannot be undone.`}
        confirmLabel="Clear"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={() => {
          setConfirmClearOpen(false);
          clearMutation.mutate(connectionId);
        }}
        onCancel={() => setConfirmClearOpen(false)}
      />
    </div>
  );
}

/**
 * Credential profiles are an explicit layer over an app home: refs are opaque
 * handles for Station's managed profile directories, while labels are only a
 * management convenience. This view deliberately never receives or renders
 * credential values, account identities, or filesystem paths.
 */
function CredentialRecoveryField({
  connectionId,
  engineLabel,
}: {
  connectionId: string;
  engineLabel: string;
}) {
  return (
    <CredentialRecoveryLayout
      connectionId={connectionId}
      engineLabel={engineLabel}
      state={useCredentialRecoveryState(connectionId)}
    />
  );
}

function useCredentialRecoveryState(connectionId: string) {
  const [profileToApply, setProfileToApply] = useState<string | null>(null);
  const {
    data: recovery,
    isLoading,
    isError,
    error,
    refetch,
  } = useCredentialRecoveryQuery(connectionId);
  const upsertMutation = useUpsertCredentialProfileMutation();
  const deleteMutation = useDeleteCredentialProfileMutation();
  const enrollmentMutation = useSetCredentialProfileEnrollmentMutation();
  const policyMutation = useSetCredentialRecoveryAutomaticPolicyMutation();
  const importMutation = useImportCredentialProfileSnapshotMutation();
  const applyMutation = useApplyCredentialProfileMutation();
  const hasCompleteRecoveryState =
    recovery != null &&
    !Array.isArray(recovery) &&
    recovery.group != null &&
    recovery.policy != null &&
    recovery.application != null;

  return {
    recovery,
    isLoading,
    isError,
    error,
    refetch,
    profiles: recovery?.profiles ?? [],
    enrolledProfileRefs: recovery?.group?.enrolledProfileRefs ?? [],
    automatic: recovery?.policy?.automatic === true,
    unsupported:
      !hasCompleteRecoveryState ||
      recovery?.application?.capability !== 'restart_resume',
    pendingRef: recovery?.application?.pendingProfileRef,
    applyingRef: applyMutation.isPending ? profileToApply : null,
    outcome: applyMutation.data?.outcome ?? recovery?.application?.outcome,
    errors: [
      upsertMutation.error,
      deleteMutation.error,
      enrollmentMutation.error,
      policyMutation.error,
      importMutation.error,
      applyMutation.error,
    ],
    profileToApply,
    importResult: importMutation.data,
    importPending: importMutation.isPending,
    policyPending: policyMutation.isPending,
    profileMutating: {
      upsert: upsertMutation.isPending,
      remove: deleteMutation.isPending,
      enrollment: enrollmentMutation.isPending,
    },
    upsert: (ref: string, label: string | undefined, onSuccess?: () => void) =>
      upsertMutation.mutate({ id: connectionId, ref, label }, { onSuccess }),
    remove: (ref: string) => deleteMutation.mutate({ id: connectionId, ref }),
    setEnrollment: (ref: string, enrolled: boolean) =>
      enrollmentMutation.mutate({ id: connectionId, ref, enrolled }),
    setAutomatic: (automatic: boolean) =>
      policyMutation.mutate({ id: connectionId, automatic }),
    importProfile: (ref: string, includeCredentials: boolean) =>
      importMutation.mutate({ id: connectionId, ref, includeCredentials }),
    requestApply: setProfileToApply,
    cancelApply: () => setProfileToApply(null),
    confirmApply: () => {
      if (profileToApply) {
        applyMutation.mutate({
          id: connectionId,
          ref: profileToApply,
          confirmed: true,
        });
      }
      setProfileToApply(null);
    },
  };
}

function CredentialRecoveryLayout({
  connectionId,
  engineLabel,
  state,
}: {
  connectionId: string;
  engineLabel: string;
  state: ReturnType<typeof useCredentialRecoveryState>;
}) {
  return (
    <section
      className="credential-recovery"
      aria-labelledby={`${connectionId}-credential-profiles-heading`}
    >
      <div>
        <h3
          id={`${connectionId}-credential-profiles-heading`}
          className="editor-label"
        >
          Credential entries
        </h3>
        <p className="editor-help">
          Add opaque credential references for this Station-managed app home.
          Labels are only for managing entries; Station does not store or show
          credentials here.
        </p>
      </div>

      <CredentialRecoveryStatus application={state.recovery?.application} />
      <CredentialRecoveryManagement
        connectionId={connectionId}
        engineLabel={engineLabel}
        state={state}
      />
      <CredentialRecoveryFeedback
        outcome={state.outcome}
        errors={state.errors}
      />
      <CredentialProfileApplyConfirmation state={state} />
    </section>
  );
}

function CredentialRecoveryManagement({
  connectionId,
  engineLabel,
  state,
}: {
  connectionId: string;
  engineLabel: string;
  state: ReturnType<typeof useCredentialRecoveryState>;
}) {
  if (state.isLoading) {
    return <SkeletonBlock count={2} label="Loading credential entries" />;
  }
  // archive#771: this used to fall straight through to the (empty) management
  // UI on a settled error, reading as "no credential entries" instead of "the
  // read failed". A retry that never had cached data has nothing to preserve.
  if (state.isError && !state.recovery) {
    return (
      <ErrorState
        title="Couldn't load credential entries"
        description={describeReadFailure(state.error)}
        action={
          <button type="button" onClick={() => state.refetch()}>
            Retry
          </button>
        }
      />
    );
  }
  return (
    <>
      <CredentialProfileEditor connectionId={connectionId} state={state} />
      <CredentialProfileProvisioning
        connectionId={connectionId}
        engineLabel={engineLabel}
        profiles={state.profiles}
        pending={state.importPending}
        result={state.importResult}
        onImport={state.importProfile}
      />
      <CredentialRecoveryPolicy
        connectionId={connectionId}
        automatic={state.automatic}
        unsupported={state.unsupported}
        pending={state.policyPending}
        onChange={state.setAutomatic}
      />
    </>
  );
}

function CredentialRecoveryFeedback({
  outcome,
  errors,
}: {
  outcome?: string;
  errors: unknown[];
}) {
  const isFailure =
    outcome === 'failed' ||
    outcome === 'rolled_back' ||
    outcome === 'rejected' ||
    outcome === 'unsupported';
  return (
    <>
      {outcome && (
        <p
          className={`credential-recovery__outcome${isFailure ? ' credential-recovery__outcome--failure' : ''}`}
          role={isFailure ? 'alert' : 'status'}
        >
          {isFailure
            ? `Credential application ${outcome === 'rolled_back' ? 'was rolled back' : 'did not complete'}; the active credential was not changed.`
            : `Credential application: ${outcome.replaceAll('_', ' ')}.`}
        </p>
      )}
      <CredentialRecoveryErrors errors={errors} />
    </>
  );
}

function CredentialProfileApplyConfirmation({
  state,
}: {
  state: ReturnType<typeof useCredentialRecoveryState>;
}) {
  return (
    <ConfirmModal
      isOpen={state.profileToApply !== null}
      title="Apply credential entry"
      message="Station will verify this credential entry with one potentially billable engine turn before making it active. If verification fails, the previous active credential is preserved."
      confirmLabel="Apply and verify"
      cancelLabel="Cancel"
      variant="warning"
      onConfirm={state.confirmApply}
      onCancel={state.cancelApply}
    />
  );
}

function CredentialRecoveryStatus({
  application,
}: {
  application?: CredentialProfileApplicationProjection;
}) {
  const capability = application?.capability ?? 'unsupported';
  return (
    <div className="credential-recovery__status" aria-live="polite">
      <span className="plugins__cap plugins__cap--ref">
        {capability === 'restart_resume'
          ? 'Restart and resume'
          : capability === 'hot_apply'
            ? 'Apply without restart'
            : 'Not supported'}
      </span>
      {application?.activeProfileRef && (
        <span className="credential-recovery__status-value">
          Active: {application.activeProfileRef}
        </span>
      )}
      {application?.pendingProfileRef && (
        <span className="credential-recovery__status-value">
          Pending verification: {application.pendingProfileRef}
        </span>
      )}
    </div>
  );
}

function CredentialProfileEditor({
  connectionId,
  state,
}: {
  connectionId: string;
  state: ReturnType<typeof useCredentialRecoveryState>;
}) {
  return (
    <>
      <CredentialProfileList connectionId={connectionId} state={state} />
      <CredentialProfileCreateForm
        pending={state.profileMutating.upsert}
        onUpsert={state.upsert}
      />
    </>
  );
}

function CredentialProfileList({
  connectionId,
  state,
}: {
  connectionId: string;
  state: ReturnType<typeof useCredentialRecoveryState>;
}) {
  const { profiles } = state;
  return (
    <>
      <div className="credential-recovery__profile-list">
        {profiles.map((profile) => (
          <CredentialProfileRow
            connectionId={connectionId}
            key={profile.ref}
            profile={profile}
            state={state}
          />
        ))}
      </div>
      {profiles.length === 0 && (
        <p className="credential-recovery__notice">
          No credential entries added yet.
        </p>
      )}
    </>
  );
}

function CredentialProfileRow({
  connectionId,
  profile,
  state,
}: {
  connectionId: string;
  profile: CredentialProfile;
  state: ReturnType<typeof useCredentialRecoveryState>;
}) {
  const enrolled = state.enrolledProfileRefs.includes(profile.ref);
  return (
    <div className="credential-recovery__profile">
      <div className="credential-recovery__profile-copy">
        <CredentialProfileMetadata profile={profile} state={state} />
        <CredentialProfileEnrolment
          connectionId={connectionId}
          profileRef={profile.ref}
        />
        <Checkbox
          id={`${connectionId}-credential-profile-${profile.ref}-enrolled`}
          checked={enrolled}
          onChange={(enabled) => state.setEnrollment(profile.ref, enabled)}
          disabled={state.profileMutating.enrollment}
        >
          Allow automatic recovery selection
        </Checkbox>
      </div>
      <CredentialProfileActions profile={profile} state={state} />
    </div>
  );
}

function CredentialProfileMetadata({
  profile,
  state,
}: {
  profile: CredentialProfile;
  state: ReturnType<typeof useCredentialRecoveryState>;
}) {
  const [label, setLabel] = useState(profile.label ?? '');
  return (
    <>
      <div className="credential-recovery__profile-name">
        {profile.label || profile.ref}
      </div>
      {profile.label && (
        <p className="credential-recovery__profile-ref">Ref: {profile.ref}</p>
      )}
      <CredentialProfileLabelEditor
        label={label}
        pending={state.profileMutating.upsert}
        profileRef={profile.ref}
        onChange={setLabel}
        onSave={() => state.upsert(profile.ref, label.trim() || undefined)}
      />
    </>
  );
}

function CredentialProfileLabelEditor({
  label,
  pending,
  profileRef,
  onChange,
  onSave,
}: {
  label: string;
  pending: boolean;
  profileRef: string;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  return (
    <div className="credential-recovery__profile-actions">
      <input
        className="editor-input"
        aria-label={`Label for ${profileRef}`}
        value={label}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Management label"
      />
      <button
        type="button"
        className="editor-btn editor-btn--ghost"
        disabled={pending}
        onClick={onSave}
      >
        Save label
      </button>
    </div>
  );
}

function CredentialProfileActions({
  profile,
  state,
}: {
  profile: CredentialProfile;
  state: ReturnType<typeof useCredentialRecoveryState>;
}) {
  const applyDisabled =
    state.unsupported ||
    state.applyingRef !== null ||
    Boolean(state.pendingRef);
  return (
    <div className="credential-recovery__profile-actions">
      <button
        type="button"
        className="editor-btn"
        disabled={applyDisabled}
        onClick={() => state.requestApply(profile.ref)}
      >
        {state.applyingRef === profile.ref ? 'Applying…' : 'Apply manually'}
      </button>
      <button
        type="button"
        className="editor-btn editor-btn--ghost"
        disabled={state.profileMutating.remove || Boolean(state.pendingRef)}
        onClick={() => state.remove(profile.ref)}
      >
        Remove
      </button>
    </div>
  );
}

function CredentialProfileCreateForm({
  pending,
  onUpsert,
}: {
  pending: boolean;
  onUpsert: (
    ref: string,
    label: string | undefined,
    onSuccess?: () => void,
  ) => void;
}) {
  const [profileRef, setProfileRef] = useState('');
  const [profileLabel, setProfileLabel] = useState('');
  const addProfile = () => {
    const ref = profileRef.trim();
    if (!ref) return;
    onUpsert(ref, profileLabel.trim() || undefined, () => {
      setProfileRef('');
      setProfileLabel('');
    });
  };

  return (
    <div className="credential-recovery__add-row">
      <input
        className="editor-input"
        aria-label="Credential entry reference"
        value={profileRef}
        onChange={(event) => setProfileRef(event.target.value)}
        placeholder="Credential reference"
      />
      <input
        className="editor-input"
        aria-label="Credential entry label"
        value={profileLabel}
        onChange={(event) => setProfileLabel(event.target.value)}
        placeholder="Management label (optional)"
      />
      <button
        type="button"
        className="editor-btn"
        disabled={pending || profileRef.trim().length === 0}
        onClick={addProfile}
      >
        {pending ? 'Adding…' : 'Add credential entry'}
      </button>
    </div>
  );
}

function CredentialProfileProvisioning({
  connectionId,
  engineLabel,
  profiles,
  pending,
  result,
  onImport,
}: {
  connectionId: string;
  engineLabel: string;
  profiles: CredentialProfile[];
  pending: boolean;
  result?: {
    copied: string[];
    skipped: Array<unknown>;
    provenanceUpdated: boolean;
  };
  onImport: (ref: string, includeCredentials: boolean) => void;
}) {
  const [includeCredentials, setIncludeCredentials] = useState(false);
  return (
    <fieldset>
      <legend className="editor-label">Provisioning import</legend>
      <p className="editor-help">
        Import a selected credential entry’s global {engineLabel} snapshot only
        when you choose to. Credentials are excluded unless you check the option
        below.
      </p>
      <Checkbox
        id={`${connectionId}-credential-profile-include-credentials`}
        checked={includeCredentials}
        onChange={setIncludeCredentials}
      >
        Include selected credential entry sign-in credentials
      </Checkbox>
      <div className="credential-recovery__profile-actions">
        {profiles.map((profile) => (
          <button
            key={profile.ref}
            type="button"
            className="editor-btn editor-btn--ghost"
            disabled={pending}
            onClick={() => onImport(profile.ref, includeCredentials)}
          >
            {pending
              ? 'Importing…'
              : `Import into ${profile.label || profile.ref}`}
          </button>
        ))}
      </div>
      {result && <CredentialProfileImportResult result={result} />}
    </fieldset>
  );
}

function CredentialProfileImportResult({
  result,
}: {
  result: {
    copied: string[];
    skipped: Array<unknown>;
    provenanceUpdated: boolean;
  };
}) {
  return (
    <p
      className="credential-recovery__outcome"
      role="status"
      aria-label="Credential entry provisioning import result"
    >
      Provisioning import completed: {result.copied.length}{' '}
      {result.copied.length === 1 ? 'item' : 'items'} copied;{' '}
      {result.skipped.length} {result.skipped.length === 1 ? 'item' : 'items'}{' '}
      skipped.{' '}
      {result.provenanceUpdated
        ? 'This credential entry is marked as imported.'
        : 'This credential entry was not marked as imported because nothing was copied.'}
    </p>
  );
}

function CredentialRecoveryPolicy({
  connectionId,
  automatic,
  unsupported,
  pending,
  onChange,
}: {
  connectionId: string;
  automatic: boolean;
  unsupported: boolean;
  pending: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <fieldset>
      <legend className="editor-label">Automatic recovery</legend>
      <Checkbox
        id={`${connectionId}-credential-recovery-automatic`}
        checked={automatic}
        onChange={onChange}
        disabled={unsupported || pending}
      >
        Automatically try an enrolled credential entry after an account-scoped
        capacity or rate-limit failure
      </Checkbox>
      <p className="editor-help">
        Off by default. Station only considers explicitly enrolled credential
        entries after observed account-scoped capacity or rate-limit failures.
        {unsupported
          ? ' This engine does not declare a safe application capability.'
          : ''}
      </p>
    </fieldset>
  );
}

function CredentialRecoveryErrors({ errors }: { errors: unknown[] }) {
  const messages = [
    ...new Set(errors.map(mutationErrorMessage).filter(Boolean)),
  ];
  return messages.length > 0 ? (
    <div className="credential-recovery__errors" aria-live="assertive">
      {messages.map((message) => (
        <p className="editor-error" role="alert" key={message}>
          {message}
        </p>
      ))}
    </div>
  ) : null;
}

function mutationErrorMessage(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}
