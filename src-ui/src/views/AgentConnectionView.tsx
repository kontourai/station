import {
  type EngineConnectionId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import type { AgentConnectionView as AgentConnectionViewData } from '@kontourai/station-contracts/tool';
import {
  useAgentConnectionCatalogQuery,
  useAgentConnectionQuery,
  useDeleteAgentConnectionMutation,
  useEngineConnectionsQuery,
  useReconnectACPConnectionMutation,
  useSaveAgentConnectionMutation,
  useSmokeAgentConnectionMutation,
  useTestAgentConnectionMutation,
} from '@kontourai/station-sdk';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { ACPConnectionDetailsField } from '../components/acp-connections/ACPConnectionDetailsField';
import { ConnectionIcon } from '../components/acp-connections/ConnectionIcon';
import { Button } from '../components/Button';
import { ConnectionReadinessNotice } from '../components/connections/ConnectionReadinessNotice';
import { PublicRegistryUpdateNotice } from '../components/engine-install/PublicRegistry';
import { registryEntryDiscovery } from '../components/engine-install/registryEntryDiscovery';
import { EngineSignInPanel } from '../components/engine-sign-in/EngineSignInPanel';
import { BrandIcon } from '../components/icons/BrandIcon';
import { connectionVerdictTone } from '../components/kontour/station-tones';
import {
  ManagedEngineNotice,
  managedEngineFact,
  managedEnvironmentLocked,
} from '../components/ManagedEngineNotice';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import {
  ResourceDetail,
  type ResourceDetailTab,
} from '../components/resource-hub/ResourceDetail';
import { resourceRow } from '../components/resource-hub/resource-row';
import { useResourceEditor } from '../components/resource-hub/useResourceEditor';
import type { SplitPaneItem } from '../components/SplitPaneLayout';
import { SplitPaneLayout } from '../components/SplitPaneLayout';
import { CONNECTIONS_ENGINES_PANE_ID } from '../components/split-pane-metrics';
import { Empty } from '../components/state';
import {
  type ACPConnectionInfo,
  type ACPConnectionRegistryEntry,
  useACPConnectionRegistry,
  useACPConnections,
  useUnregisteredACPConnections,
} from '../hooks/useACPConnections';
import { useDevicePresentation } from '../hooks/useDevicePresentation';
import { useManagedEngineStateFor } from '../hooks/useManagedEngines';
import type { AgentSummary, NavigationView } from '../types';
import { agentsUsingEngine } from '../utils/engineDependents';
import {
  connectionEngineId,
  runtimeCatalogSourceSentence,
} from '../utils/execution';
import { describeStationFailure } from '../utils/stationFailure';
import { CredentialProfileAccess } from './CredentialProfileLoginProfiles';
import {
  type ConnectionHealth,
  deriveConnectionHealth,
  engineHealthInput,
} from './connections-hub/connection-health';
import type { EngineDetailTab } from './connections-hub/connection-sections';
import { EngineAccountOverview } from './EngineAccountOverview';
import { EngineAddFlow, type NotConnectedEngine } from './EngineAddFlow';
import { EngineProxySettings } from './EngineProxySettings';
import { EngineModelsTab } from './engine-detail/EngineModelsTab';
import { EngineOverviewTab } from './engine-detail/EngineOverviewTab';
import {
  AppHomeProfileField,
  ClaudeSkillsMaterializationField,
} from './engine-detail/EngineSettingsFields';
import { EngineSettingsTab } from './engine-detail/EngineSettingsTab';
import { EngineUsageTab } from './engine-detail/EngineUsageTab';
import { ambientRouteNote } from './engine-detail/engine-facts';
import { NotConnectedEngineDetail } from './NotConnectedEngineDetail';
import { blockingPrerequisite } from './provider-settings/providerCatalog';
import './PluginManagementView.css';
import './page-layout.css';
import './editor-layout.css';

interface AgentConnectionViewProps {
  selectedRuntimeId?: EngineConnectionId | string;
  /** The detail's route tab; absent opens Overview. */
  selectedTab?: EngineDetailTab;
  /**
   * With the add route: the catalogue entry to open on its confirm step
   * (`/connections/engines/new/<id>`; `custom` opens the custom form).
   */
  addChoiceId?: string;
  /** Agents, for an engine's dependents. */
  agents?: AgentSummary[];
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

/** Prefix for a detected engine's list row; it is not a saved connection. */
const FOUND_ROW_PREFIX = 'found:';

const FOUND_STATUS = {
  label: 'Found, not connected',
  tone: connectionVerdictTone('setup'),
} as const;

const SETTINGS_KEPT_MOUNTED = ['settings'] as const;

/** Claude Code and Codex hold sign-in accounts; other engines do not. */
function hasAccounts(
  connection: AgentConnectionViewData,
): connection is AgentConnectionViewData & { type: 'claude' | 'codex' } {
  return connection.type === 'claude' || connection.type === 'codex';
}

function engineTabs(
  connection: AgentConnectionViewData,
): Array<ResourceDetailTab<EngineDetailTab>> {
  return [
    { key: 'overview', label: 'Overview' },
    { key: 'usage', label: 'Usage' },
    { key: 'models', label: 'Models' },
    ...(hasAccounts(connection)
      ? [{ key: 'accounts' as const, label: 'Accounts' }]
      : []),
    { key: 'settings', label: 'Settings' },
  ];
}

function cloneConnection(
  connection: AgentConnectionViewData,
): AgentConnectionViewData {
  return {
    ...connection,
    capabilities: [...connection.capabilities],
    config: { ...connection.config },
    prerequisites: [...connection.prerequisites],
  };
}

export function AgentConnectionView({
  selectedRuntimeId,
  selectedTab,
  addChoiceId,
  agents = [],
  onNavigate,
}: AgentConnectionViewProps) {
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  /**
   * The section frame owns this section's single add action (design P3), and
   * it navigates to `/connections/engines/new` rather than reaching into this
   * component's state. `new` is not a connection id: it selects nothing, and
   * opens the add flow in the detail pane.
   */
  const isAddRoute = selectedRuntimeId === 'new';
  // A repair started on a not-connected engine keeps its page until Done,
  // even once the engine connects and leaves the not-connected list.
  const [repair, setRepair] = useState<{
    engine: NotConnectedEngine;
    mode: 'recheck' | 'edit';
  } | null>(null);

  const {
    data: runtimes = [],
    isLoading,
    error: runtimesError,
    refetch: refetchRuntimes,
  } = useEngineConnectionsQuery() as {
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
  // reflects a configured connection.
  const { data: acpRegistryEntries = [] } = useACPConnectionRegistry() as {
    data?: ACPConnectionRegistryEntry[];
  };
  const availableCommandEntries = useMemo(
    () => acpRegistryEntries.filter((entry) => !entry.installed),
    [acpRegistryEntries],
  );
  // Saved connections whose engine never registered (a failed first add).
  // Listed for repair here and in Add; never counted as engines Station has
  // (station#1548). Only a connection no catalogue entry names is custom.
  const { data: unregistered = [], isPending: unregisteredPending } =
    useUnregisteredACPConnections() as {
      data?: ACPConnectionInfo[];
      isPending: boolean;
    };
  const notConnected = useMemo<NotConnectedEngine[]>(
    () =>
      unregistered.map((connection) => ({
        connection,
        custom: !acpRegistryEntries.some((entry) => entry.id === connection.id),
      })),
    [unregistered, acpRegistryEntries],
  );

  const selectedEngineConnectionId =
    selectedRuntimeId && !isAddRoute
      ? engineConnectionId(selectedRuntimeId)
      : undefined;
  // A saved engine that never connected has no runtime record to read (its
  // read is a 404): it is shown from the not-connected list instead.
  const selectedNeverConnected = notConnected.some(
    (engine) => engine.connection.id === selectedEngineConnectionId,
  );
  const { data: runtime } = useAgentConnectionQuery(
    selectedEngineConnectionId,
    {
      enabled:
        !!selectedEngineConnectionId &&
        !unregisteredPending &&
        !selectedNeverConnected,
    },
  );

  // One editable copy of the selected engine. The route tab is not part of
  // the route identity, so switching tabs keeps this mounted and its edits.
  const editor = useResourceEditor<AgentConnectionViewData>({
    source: (runtime as AgentConnectionViewData | undefined) ?? null,
    identity: (connection) => connection.id,
    clone: cloneConnection,
    isSaving: () => saveMutation.isPending,
  });
  const form = editor.draft;
  // A message about one engine is not about the next one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the engine id is the intentional reset signal.
  useEffect(() => {
    setError(null);
  }, [selectedEngineConnectionId]);

  const saveMutation = useSaveAgentConnectionMutation({
    onSuccess: (saved: AgentConnectionViewData) => {
      editor.saved(saved);
      setError(null);
      onNavigate({
        type: 'connections-engine-edit',
        id: saved.id,
        ...(selectedTab ? { tab: selectedTab } : {}),
      });
    },
    onError: (mutationError: Error) => {
      setError(describeStationFailure(mutationError).body);
    },
  });

  const resetMutation = useDeleteAgentConnectionMutation({
    onSuccess: () => {
      setError(null);
    },
    onError: (mutationError: Error) => {
      setError(describeStationFailure(mutationError).body);
    },
  });

  const testMutation = useSmokeAgentConnectionMutation();
  const refreshMutation = useTestAgentConnectionMutation();

  // The handshake retry the refusal sentence names (enriched-agents.ts). The
  // bridge's live connection set is the same projection the reconnect route
  // 404s against, so it is also the gate: a non-ACP engine gets no button
  // that could only ever answer "Connection not found".
  const { data: acpBridgeConnections = [] } = useACPConnections();
  const reconnectMutation = useReconnectACPConnectionMutation({
    onSuccess: () => {
      setError(null);
      // The engine's readiness travels through the engine-connections
      // projection, not the ACP status query the mutation invalidates.
      void refetchRuntimes();
    },
    onError: (mutationError: Error) => {
      setError(describeStationFailure(mutationError).body);
      // A failed check changed the engine's readiness too; re-read it so the
      // status beside this message does not keep saying Ready.
      void refetchRuntimes();
    },
  });
  const selectedAcpConnection = form
    ? (acpBridgeConnections.find((entry) => entry.id === form.id) ?? null)
    : null;
  const selectedAcpConnectionId = selectedAcpConnection?.id ?? null;
  // #4520: what the machine's managed policy says about each engine row.
  const managedStateFor = useManagedEngineStateFor();
  const selectedManagedState = form ? managedStateFor(form) : null;

  // #1054 stopped excluding Station here: the Station engine is a row this
  // view legitimately shows, and its test asserts so. This branch renames the
  // binding and must not reinstate the filter that rename predates.
  const externalEngines = runtimes;
  const availableEngines = useMemo(() => {
    const addedIds = new Set(
      externalEngines.filter(isAddedEngine).map(({ id }) => id),
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
  }, [catalog, externalEngines]);
  const addedEngines = useMemo(
    () => externalEngines.filter(isAddedEngine),
    [externalEngines],
  );
  /**
   * Engines Station found on this computer that nobody has added, by the
   * server's setup placement (detected, not added). Add may label one
   * differently when a prerequisite blocks it. Listing one configures
   * nothing; its Connect opens that entry's Add result in place.
   */
  const foundEngines = useMemo(
    () =>
      // Without the engine list, an added engine would read as found.
      runtimesError
        ? []
        : [
            ...availableEngines
              // The server's own placement: detected here, not added.
              .filter(
                (connection) =>
                  connection.setup?.state === 'available' &&
                  connection.setup.detected === true,
              )
              .map((connection) => ({
                id: connection.id,
                name: connection.name,
                icon: (
                  <BrandIcon
                    name={connection.name}
                    id={connection.id}
                    engineId={connectionEngineId(connection)}
                    size={22}
                  />
                ),
              })),
            ...availableCommandEntries
              // Public registry listings stay in Add's own group: being on
              // PATH does not make a third-party listing one of Station's.
              .filter(
                (entry) =>
                  entry.source !== 'registry' &&
                  registryEntryDiscovery(entry) === 'detected-unconfigured',
              )
              .map((entry) => ({
                id: entry.id,
                name: entry.name,
                icon: (
                  <ConnectionIcon
                    icon={entry.icon}
                    name={entry.name}
                    id={entry.id}
                    size={22}
                  />
                ),
              })),
          ],
    [availableEngines, availableCommandEntries, runtimesError],
  );
  const connectFound = useCallback(
    (providerId: string) =>
      onNavigate({ type: 'connections-engine-new', providerId }),
    [onNavigate],
  );
  const items = useMemo<SplitPaneItem[]>(() => {
    const query = search.toLowerCase();
    const matches = (name: string, type = '') =>
      !search ||
      name.toLowerCase().includes(query) ||
      type.toLowerCase().includes(query);
    return [
      ...addedEngines
        .filter((connection) => matches(connection.name, connection.type))
        .map((connection) => {
          const managed = managedStateFor(connection);
          return resourceRow({
            id: connection.id,
            name:
              connection.config.modelRoute &&
              typeof connection.config.modelRoute === 'object' &&
              'label' in connection.config.modelRoute
                ? `${connection.name} · via ${String(connection.config.modelRoute.label)}`
                : connection.name,
            // The rail and the resolver read this same verdict.
            status: deriveConnectionHealth(engineHealthInput(connection), {
              policyDisallowed: managed?.disallowed === true,
            }),
            // The row is already named; the facts say what is true of it.
            facts: [
              managedEngineFact(managed),
              runtimeCatalogSourceSentence(
                connection.runtimeCatalog?.source ?? 'none',
              ),
            ],
            icon: (
              <BrandIcon
                name={connection.name}
                id={connection.id}
                engineId={connectionEngineId(connection)}
                size={22}
              />
            ),
          });
        }),
      // A failed first add is listed beside the engines, never as one: its
      // row says so, and its page offers only the repairs.
      ...notConnected
        .filter(({ connection }) => matches(connection.name))
        .map(({ connection }) => ({
          id: connection.id,
          name: connection.name,
          subtitle: 'Not connected yet',
          icon: (
            <ConnectionIcon
              icon={connection.icon}
              name={connection.name}
              id={connection.id}
              size={22}
            />
          ),
        })),
      ...foundEngines
        .filter((engine) => matches(engine.name))
        .map((engine) => ({
          ...resourceRow({
            id: `${FOUND_ROW_PREFIX}${engine.id}`,
            name: engine.name,
            icon: engine.icon,
            status: FOUND_STATUS,
          }),
          trailing: (
            <Button
              aria-label={`Connect ${engine.name}`}
              onClick={() => connectFound(engine.id)}
            >
              Connect
            </Button>
          ),
        })),
    ];
  }, [
    addedEngines,
    notConnected,
    foundEngines,
    search,
    managedStateFor,
    connectFound,
  ]);
  const selectedNotConnected =
    repair && repair.engine.connection.id === selectedRuntimeId
      ? repair.engine
      : notConnected.find(
          ({ connection }) => connection.id === selectedRuntimeId,
        );

  function setDraftField<K extends keyof AgentConnectionViewData>(
    key: K,
    value: AgentConnectionViewData[K],
  ) {
    editor.update((current) => ({ ...current, [key]: value }));
  }

  function setConfigField(key: string, value: unknown) {
    editor.update((current) => ({
      ...current,
      config: { ...current.config, [key]: value },
    }));
  }

  // The row's verdict, read again for the selected engine: the header, its
  // one fix and the readiness instructions cannot say Ready where the row
  // (and dispatch) say otherwise.
  const health = form
    ? deriveConnectionHealth(engineHealthInput(form), {
        policyDisallowed: selectedManagedState?.disallowed === true,
      })
    : null;
  const [confirmResetOpen, setConfirmResetOpen] = useState(false);
  const devicePresentation = useDevicePresentation();
  const blocker = form ? blockingPrerequisite(form.prerequisites) : undefined;
  const tabs = form ? engineTabs(form) : [];
  // A tab this engine does not have (Accounts on a command engine) opens
  // Overview rather than an empty panel.
  const activeTab: EngineDetailTab =
    selectedTab && tabs.some((tab) => tab.key === selectedTab)
      ? selectedTab
      : 'overview';

  function selectTab(tab: EngineDetailTab) {
    if (!form || tab === activeTab) return;
    // Same engine, same editor: the navigation store lets a route tab of
    // one record through its unsaved guard (`isSameRecordTabTraversal`).
    onNavigate({
      type: 'connections-engine-edit',
      id: form.id,
      ...(tab === 'overview' ? {} : { tab }),
    });
  }

  const save = () => {
    if (form) saveMutation.mutate({ connection: form, isNew: false });
  };
  const check = () => {
    if (form)
      testMutation.mutate({ id: engineConnectionId(form.id), confirmed: true });
  };

  /**
   * At most one fix in the header, and only one this page can perform. A
   * policy refusal has none; a command engine's failed handshake is retried;
   * Claude Code and Codex sign in on Accounts; a turned-off engine turns on.
   * Install and setup instructions are on Overview instead.
   */
  function fixAction(
    current: AgentConnectionViewData,
    verdict: ConnectionHealth,
  ) {
    if (verdict.verdict === 'ready' || selectedManagedState?.disallowed)
      return undefined;
    if (verdict.action?.id === 'enable')
      return (
        <Button
          variant="primary"
          disabled={saveMutation.isPending}
          onClick={() =>
            saveMutation.mutate({
              connection: { ...current, enabled: true },
              isNew: false,
            })
          }
        >
          Enable
        </Button>
      );
    // Waiting for the reset (or switching accounts) is the fix; a check
    // would only spend a turn the provider refuses.
    if (verdict.label === 'Usage limit reached') return undefined;
    if (selectedAcpConnectionId)
      return (
        <Button
          disabled={reconnectMutation.isPending}
          onClick={() => reconnectMutation.mutate(selectedAcpConnectionId)}
        >
          {reconnectMutation.isPending ? 'Checking…' : 'Retry check'}
        </Button>
      );
    if (verdict.action?.id === 'sign-in' && hasAccounts(current))
      return (
        <Button variant="primary" onClick={() => selectTab('accounts')}>
          Sign in
        </Button>
      );
    if (verdict.action?.id === 'check-connection')
      return (
        <Button
          disabled={testMutation.isPending || editor.dirty}
          onClick={check}
        >
          {testMutation.isPending ? 'Checking…' : 'Check connection'}
        </Button>
      );
    return undefined;
  }

  /**
   * What the header's fix and Check connection reported, and what a check
   * costs: on every tab, beside the action, once. Settings states the cost
   * beside its own Check connection.
   */
  function fixNotice(
    current: AgentConnectionViewData,
    verdict: ConnectionHealth,
  ): ReactNode {
    const checkInHeader = verdict.action?.id === 'check-connection';
    const testedHere =
      testMutation.variables?.id === engineConnectionId(current.id);
    const result =
      testMutation.data &&
      testedHere &&
      testMutation.data.smoke.testedAt ===
        current.readinessEvidence?.smoke.testedAt
        ? testMutation.data.smoke.status === 'passed'
          ? 'Connected — your engine answered successfully.'
          : 'Couldn’t connect. Check the connection settings, then try again.'
        : null;
    const parts = [
      checkInHeader && activeTab !== 'settings' && (
        <p key="cost" className="editor-help">
          Check connection sends one short message (uses a little model
          allowance).
        </p>
      ),
      result && (
        <p key="result" className="editor-help" role="status">
          {result}
        </p>
      ),
      testMutation.error && testedHere && (
        <p key="check-error" className="editor-error">
          {describeStationFailure(testMutation.error).body}
        </p>
      ),
      error && (
        <p key="error" className="editor-error">
          {error}
        </p>
      ),
    ].filter(Boolean);
    return parts.length ? parts : undefined;
  }

  function renderTab(
    tab: EngineDetailTab,
    current: AgentConnectionViewData,
  ): ReactNode {
    const savedCopy =
      (runtime as AgentConnectionViewData | undefined) ?? current;
    switch (tab) {
      case 'usage':
        return <EngineUsageTab connection={savedCopy} />;
      case 'models':
        return (
          <EngineModelsTab
            connection={current}
            defaultModel={String(current.config.defaultModel || '')}
            onDefaultModelChange={(id) => setConfigField('defaultModel', id)}
            refreshDisabled={editor.dirty}
            refreshing={refreshMutation.isPending}
            onRefresh={() => refreshMutation.mutate(current.id)}
          />
        );
      case 'accounts':
        return hasAccounts(current) ? (
          current.config.proxyConnectionId ? (
            <Empty
              variant="compact"
              label="Accounts are not used while routed through a proxy"
              description="Runs use the saved proxy's key instead."
            />
          ) : (
            <EngineAccountOverview
              connectionId={current.id}
              engine={current.type}
            />
          )
        ) : null;
      case 'settings':
        return renderSettings(current);
      default:
        return (
          <EngineOverviewTab
            connection={savedCopy}
            defaultModel={String(savedCopy.config.defaultModel || '')}
            managedFact={managedEngineFact(selectedManagedState)}
            dependents={agentsUsingEngine(agents, current.id)}
            onOpenAgent={(slug) => onNavigate({ type: 'agent-edit', slug })}
            notices={
              <>
                <ManagedEngineNotice state={selectedManagedState} />
                <PublicRegistryUpdateNotice
                  entry={acpRegistryEntries.find(
                    (entry) => entry.installed && entry.id === current.id,
                  )}
                />
                {selectedAcpConnectionId && (
                  <EngineSignInPanel
                    connectionId={selectedAcpConnectionId}
                    onSignedIn={() =>
                      reconnectMutation.mutate(selectedAcpConnectionId)
                    }
                  />
                )}
                {/* #4520: a policy-disallowed engine is explained by the
                    managed notice; its instructions would be a fix the
                    policy refuses. */}
                {health?.verdict !== 'ready' &&
                  !selectedManagedState?.disallowed &&
                  blocker && (
                    <ConnectionReadinessNotice
                      readiness={health?.label ?? ''}
                      detail={health?.reason ?? ''}
                      kind="agent"
                      prerequisites={current.prerequisites}
                      devicePresentation={devicePresentation}
                      verdictShown
                    />
                  )}
              </>
            }
          />
        );
    }
  }

  function renderSettings(current: AgentConnectionViewData) {
    const engineLabel =
      engineDisplayLabel(connectionEngineId(current) ?? current.type) ??
      current.name;
    const observation = current.routeObservation;
    return (
      <>
        <EngineSettingsTab
          draft={current}
          dirty={editor.dirty}
          onNameChange={(name) => setDraftField('name', name)}
          onEnabledChange={(enabled) => setDraftField('enabled', enabled)}
          routing={
            hasAccounts(current) ? (
              <EngineProxySettings
                managedLocked={managedEnvironmentLocked(selectedManagedState)}
                connection={current}
                onChange={(config) => setDraftField('config', config)}
                onManageModels={() =>
                  onNavigate({ type: 'connections-models' })
                }
                {...(ambientRouteNote(observation)
                  ? { ambientNote: ambientRouteNote(observation) }
                  : {})}
              />
            ) : undefined
          }
          skills={
            current.type === 'claude' ? (
              <ClaudeSkillsMaterializationField
                selectedSkillIds={
                  Array.isArray(current.config.provideSkills)
                    ? current.config.provideSkills.filter(
                        (id): id is string => typeof id === 'string',
                      )
                    : []
                }
                onChange={(ids) => setConfigField('provideSkills', ids)}
              />
            ) : undefined
          }
          appHome={
            hasAccounts(current) ? (
              <CredentialProfileAccess connectionId={current.id} managementOnly>
                <AppHomeProfileField
                  connectionId={current.id}
                  engineLabel={engineLabel}
                  useAppHome={current.config.useAppHome === true}
                  onToggle={(value) => setConfigField('useAppHome', value)}
                />
              </CredentialProfileAccess>
            ) : undefined
          }
          connectionDetails={
            selectedAcpConnection ? (
              <ACPConnectionDetailsField
                connection={selectedAcpConnection}
                agents={agents}
              />
            ) : undefined
          }
          saving={saveMutation.isPending}
          checking={testMutation.isPending}
          onCheck={check}
          resetting={resetMutation.isPending}
          onReset={() => setConfirmResetOpen(true)}
        />
        {/*
         * "Reset to defaults" is a DELETE. It removes the settings override
         * and calls `agentRegistry.unregister`, which drops the engine out of
         * the list entirely, so it confirms and says so.
         */}
        <ConfirmModal
          isOpen={confirmResetOpen}
          title="Reset this engine"
          message={`Removes ${current.name}'s saved settings and disconnects it. This cannot be undone.`}
          confirmLabel="Reset"
          cancelLabel="Cancel"
          variant="danger"
          onCancel={() => setConfirmResetOpen(false)}
          onConfirm={() => {
            setConfirmResetOpen(false);
            resetMutation.mutate(engineConnectionId(current.id));
          }}
        />
      </>
    );
  }

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
                onNavigate({
                  type: 'connections-engines',
                } as NavigationView),
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
        if (id === selectedRuntimeId) return;
        if (id.startsWith(FOUND_ROW_PREFIX)) {
          connectFound(id.slice(FOUND_ROW_PREFIX.length));
          return;
        }
        setRepair(null);
        // A route change: the editor's registered guard asks, once.
        onNavigate({ type: 'connections-engine-edit', id });
      }}
      onDeselect={() => {
        setRepair(null);
        onNavigate({ type: 'connections-engines' } as NavigationView);
      }}
      onSearch={setSearch}
      searchValue={search}
      listFilteredEmptyNoun="engines"
      collectionEmpty={
        addedEngines.length === 0 &&
        notConnected.length === 0 &&
        foundEngines.length === 0
      }
      /* empty-state action: the section frame's "Add engine" is adjacent. Copy
         stays action-shaped (matching the sibling providers list) rather than
         a bespoke "No engines yet" — the state-primitives ratchet exists to
         stop every view minting its own "No X" restatement of its noun. */
      listEmptyTitle="Add an engine to get started"
      listEmptyDescription="Engines Station finds on this computer appear here too."
      emptyDescription="Select an engine to review its status and setup."
      emptyContent={
        isAddRoute ? (
          <EngineAddFlow
            initialChoiceId={addChoiceId}
            notConnected={notConnected}
            connections={availableEngines}
            commandEntries={availableCommandEntries}
            onDone={() =>
              onNavigate({ type: 'connections-engines' } as NavigationView)
            }
            onOpenEngine={(id) =>
              onNavigate({ type: 'connections-engine-edit', id })
            }
          />
        ) : undefined
      }
      unselectedDetailOpen={isAddRoute}
      searchPlaceholder="Search engines..."
    >
      {form && health && repair?.engine.connection.id !== selectedRuntimeId ? (
        <div className="editor-layout">
          <ResourceDetail
            // Another engine is another page: no field state carries over.
            key={form.id}
            id={`engine-${form.id}`}
            title={form.name}
            icon={
              <BrandIcon
                name={form.name}
                id={form.id}
                engineId={connectionEngineId(form)}
                size={28}
              />
            }
            status={health}
            fix={fixAction(form, health)}
            fixNotice={fixNotice(form, health)}
            {...(editor.dirty
              ? {
                  unsaved: {
                    saving: saveMutation.isPending,
                    onSave: save,
                    onDiscard: editor.reset,
                  },
                }
              : {})}
            tabs={tabs}
            activeTab={activeTab}
            onSelectTab={selectTab}
            tabsLabel={`${form.name} sections`}
            renderPanel={(tab) => renderTab(tab, form)}
            // Settings holds field state outside the editor (a half-typed
            // credential entry, an import's include-credentials choice).
            keepMounted={SETTINGS_KEPT_MOUNTED}
          />
        </div>
      ) : selectedNotConnected ? (
        <NotConnectedEngineDetail
          key={selectedNotConnected.connection.id}
          engine={selectedNotConnected}
          repairing={
            repair?.engine.connection.id === selectedNotConnected.connection.id
              ? repair.mode
              : null
          }
          onRepairingChange={(mode) =>
            setRepair(mode ? { engine: selectedNotConnected, mode } : null)
          }
          onRemoved={() =>
            onNavigate({ type: 'connections-engines' } as NavigationView)
          }
        />
      ) : (
        <Empty
          variant="prominent"
          label="Select an engine to review its status and setup."
        />
      )}
      <editor.DiscardModal />
    </SplitPaneLayout>
  );
}
