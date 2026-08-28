import type { AgentConnectionView } from '@kontourai/station-contracts/tool';
import {
  ConnectionModelSelectionError,
  useConnectionsQuery,
  useDeleteModelConnectionMutation,
  useModelConnectionsQuery,
  useSaveModelConnectionMutation,
  useSystemStatusQuery,
  useTestModelConnectionMutation,
} from '@kontourai/station-sdk';
import { useEffect, useRef, useState } from 'react';
import { DetailHeader } from '../components/DetailHeader';
import { ConfirmModal } from '../components/modals/ConfirmModal';
import { SplitPaneLayout } from '../components/SplitPaneLayout';
import { CONNECTIONS_MODELS_PANE_ID } from '../components/split-pane-metrics';
import { Empty } from '../components/state';
import {
  useACPConnectionRegistry,
  useACPConnections,
} from '../hooks/useACPConnections';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import type { NavigationView } from '../types';
import { connectionEngineId } from '../utils/execution';
import { ProviderConnectionForm } from './provider-settings/ProviderConnectionForm';
import { ProviderStackOverview } from './provider-settings/ProviderStackOverview';
import { ProviderTypePicker } from './provider-settings/ProviderTypePicker';
import { resolveProviderPresentation } from './provider-settings/providerCatalog';
import type { ProviderConnection } from './provider-settings/types';
import {
  capabilitiesForType,
  type DirtyFieldPath,
  defaultConfig,
  describeProvider,
  filterModelProviders,
  finalizeConnectionConfig,
  isConnectionConfigValid,
  mergeServerIntoEdit,
  readFormPath,
  WHOLE_CONFIG_DIRTY,
} from './provider-settings/utils';

interface Props {
  selectedProviderId?: string;
  onNavigate: (view: NavigationView) => void;
}

export function ProviderSettingsView({
  selectedProviderId,
  onNavigate,
}: Props) {
  const [form, setForm] = useState<Omit<ProviderConnection, 'id'> | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [search, setSearch] = useState('');
  const [testResult, setTestResult] = useState<{
    healthy: boolean;
    reason?: string;
  } | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  const {
    data: providers = [],
    isLoading,
    isFetching: isFetchingProviders,
    error: providersError,
    refetch: refetchProviders,
  } = useModelConnectionsQuery();
  const { data: connections = [] } = useConnectionsQuery();
  const { data: acpConnections = [] } = useACPConnections();
  const { data: acpRegistry = [] } = useACPConnectionRegistry();
  const { data: systemStatus } = useSystemStatusQuery();
  const modelProviders = providers as ProviderConnection[];
  const hasOllamaProvider = modelProviders.some(
    (provider) => provider.type === 'ollama',
  );
  const hasBedrockProvider = modelProviders.some(
    (provider) => provider.type === 'bedrock',
  );

  // Which provider the form currently holds, and which of its fields the user
  // has edited since it was seeded. Refs, not state: they steer the sync effect
  // and must not themselves retrigger it.
  const seededProviderId = useRef<string | null>(null);
  /** The id a draft will be created under; only meaningful while `new`. */
  const draftConnectionId = useRef<string | null>(null);
  /** The selection this component last rendered, to tell arrival from a refetch. */
  const renderedProviderId = useRef<string | undefined>(undefined);
  /** Set by a successful create; consumed by the route-move effect below. */
  const [createdConnectionId, setCreatedConnectionId] = useState<string | null>(
    null,
  );
  const dirtyFields = useRef<Set<DirtyFieldPath>>(new Set());
  // What was actually sent, by dirty path. The payload is snapshotted when Save
  // is pressed, so anything edited while the request is in flight was never
  // sent. Clearing dirt by path alone cannot tell "dirty at submit" from
  // "edited again since" for the same field, so the submitted VALUE is kept and
  // compared — a field only stops being dirty if it still holds what the server
  // was given.
  const submittedValues = useRef<Map<DirtyFieldPath, unknown>>(new Map());
  const creatingSubmission = useRef(false);
  // onSuccess fires after the round trip, so it must read the form as it is
  // then, not as it was when the handler closed over it.
  const formRef = useRef<Omit<ProviderConnection, 'id'> | null>(null);
  const isCreatingSelection = selectedProviderId === 'new';
  const configuredACPIds = new Set(acpConnections.map((entry) => entry.id));
  const agentChoices = connections.filter(
    (connection): connection is AgentConnectionView =>
      connection.kind === 'agent' &&
      connection.type !== 'acp' &&
      connectionEngineId(connection) !== 'station' &&
      (connection as Partial<AgentConnectionView>).setup?.state === 'available',
  );
  const commandChoices = acpRegistry.filter(
    (entry) => !entry.installed && !configuredACPIds.has(entry.id),
  );

  formRef.current = form;

  const dirty = dirtyFields.current.size > 0;
  const { guard, DiscardModal } = useUnsavedGuard(dirty);

  // A created connection's route move waits for the form to be clean, so the
  // unsaved-changes guard cannot swallow it (see `saveMutation.onSuccess`).
  useEffect(() => {
    if (!createdConnectionId || dirty) return;
    setCreatedConnectionId(null);
    onNavigate({ type: 'connections-provider-edit', id: createdConnectionId });
  }, [createdConnectionId, dirty, onNavigate]);

  function guardedNavigate(view: NavigationView) {
    guard(() => onNavigate(view));
  }

  function markDirty(...paths: DirtyFieldPath[]) {
    for (const path of paths) dirtyFields.current.add(path);
  }

  // Keep the form in sync with server state without discarding in-progress
  // edits.
  //
  // The modelProviders dependency is load-bearing: the query can resolve after
  // the selection is already set, so without it the form never seeds on a cold
  // load. But React Query returns a new array identity on every refetch, and a
  // refetch follows every Test Connection (a background one can also land
  // shortly after page load). Re-seeding wholesale therefore reset config to
  // the server copy — which still had no defaultModel, because the user had not
  // saved yet — and Save then persisted the pre-edit config (archive#794).
  //
  // Selection change: seed fresh and drop the dirty set. Same selection with
  // new data: merge, so untouched fields still track the server and edited
  // fields survive.
  useEffect(() => {
    const arrivedAtSelection =
      renderedProviderId.current !== selectedProviderId;
    renderedProviderId.current = selectedProviderId;
    // `new` is a DRAFT, not a server record: it has nothing to sync from, and
    // the draft the type picker just composed must survive every refetch that
    // lands while the user fills the form in. Reset only on arrival — this
    // effect also runs on each `modelProviders` identity change.
    if (isCreatingSelection) {
      // Arriving with a draft already composed is the quick-setup path: the
      // picker (or a detected-provider shortcut) built the draft and then
      // moved the URL to `new`, which is where a draft belongs.
      if (arrivedAtSelection && draftConnectionId.current === null) {
        setForm(null);
        setIsNew(false);
        seededProviderId.current = null;
        dirtyFields.current.clear();
      }
      return;
    }
    // Left the draft route: whatever it was composing is no longer in play.
    draftConnectionId.current = null;
    if (!selectedProviderId) {
      setForm(null);
      setIsNew(false);
      seededProviderId.current = null;
      dirtyFields.current.clear();
      return;
    }
    const conn = modelProviders.find((p) => p.id === selectedProviderId);
    // If not found, form was already set by handleAddWithType — don't clear it
    if (!conn) return;

    const isNewSelection = seededProviderId.current !== selectedProviderId;
    if (isNewSelection) dirtyFields.current.clear();
    seededProviderId.current = selectedProviderId;

    const fromServer: Omit<ProviderConnection, 'id'> = {
      kind: 'model',
      type: conn.type,
      name: conn.name,
      config: { ...conn.config },
      enabled: conn.enabled,
      capabilities: [...conn.capabilities],
      status: conn.status,
      prerequisites: [...conn.prerequisites],
      lastCheckedAt: conn.lastCheckedAt ?? null,
      // never a form field — the server's derivation, carried so the
      // summary rail can render what was observed instead of what was saved.
      ...(conn.readinessEvidence
        ? { readinessEvidence: conn.readinessEvidence }
        : {}),
    };

    setForm((current) =>
      isNewSelection || !current
        ? fromServer
        : mergeServerIntoEdit(fromServer, current, dirtyFields.current),
    );
    setIsNew(false);
  }, [isCreatingSelection, modelProviders, selectedProviderId]);

  // A provider refetch follows a connection test. Clear transient feedback
  // only when the user changes selection, not when fresh provider data lands.
  // biome-ignore lint/correctness/useExhaustiveDependencies: selectedProviderId is the intentional reset signal.
  useEffect(() => {
    setTestResult(null);
    setTestError(null);
    setError(null);
  }, [selectedProviderId]);

  const testMutation = useTestModelConnectionMutation({
    onSuccess: (data) => {
      setTestResult(data);
      setTestError(null);
    },
    onError: (err: Error) => {
      setTestResult(null);
      setTestError(err.message);
    },
  });

  const saveMutation = useSaveModelConnectionMutation({
    onSuccess: (saved) => {
      const shouldCheck = creatingSubmission.current;
      creatingSubmission.current = false;
      setIsNew(false);
      setError(null);
      // A field stops needing protection only if it still holds exactly what
      // was submitted. Anything changed during the round trip stays dirty.
      for (const [path, sent] of submittedValues.current) {
        if (Object.is(readFormPath(formRef.current, path), sent)) {
          dirtyFields.current.delete(path);
        }
      }
      submittedValues.current.clear();
      // Do NOT navigate from here. `useUnsavedGuard` registers a navigation
      // guard while the form is dirty, and this callback runs BEFORE the
      // render that recomputes dirtiness — so the guard captured this
      // navigation as "pending", then dropped it when dirty went false on the
      // next render, and the URL silently stayed on `new` while the pane
      // showed the saved connection. The effect below moves the route once
      // the form is genuinely clean.
      setCreatedConnectionId(saved.id);
      if (shouldCheck) testMutation.mutate(saved.id);
    },
    onError: (err: Error) => {
      creatingSubmission.current = false;
      if (err instanceof ConnectionModelSelectionError) {
        // These options came from the failed save, not from the providers
        // query — a refetch would otherwise drop the list the user needs in
        // order to resolve the error.
        markDirty('config.modelOptions');
        setForm((current) =>
          current
            ? {
                ...current,
                config: {
                  ...current.config,
                  modelOptions: err.modelOptions,
                },
              }
            : current,
        );
      }
      setError(err.message);
    },
  });

  const deleteMutation = useDeleteModelConnectionMutation({
    onSuccess: () => {
      setShowDeleteModal(false);
      setForm(null);
      setIsNew(false);
      onNavigate({ type: 'connections-providers' });
    },
    onError: (err: Error) => {
      setShowDeleteModal(false);
      setError(err.message);
    },
  });

  function handleSelect(id: string) {
    // SplitPaneLayout fires onSelect for the already-selected row too; a
    // same-row click is not navigation and must not trip the unsaved guard
    // ( 2 finding).
    if (id === selectedProviderId) return;
    guardedNavigate({ type: 'connections-provider-edit', id });
  }

  function handleAddWithType(
    type: string,
    name: string,
    presetConfig?: Record<string, string>,
  ) {
    const id = crypto.randomUUID();
    // Claim the seed slot now. Without this the row's first appearance (which
    // only happens after the create POST's refetch lands) counts as a new
    // selection and takes the hard overwrite branch, dropping anything typed
    // between pressing Create and that refetch.
    seededProviderId.current = id;
    draftConnectionId.current = id;
    dirtyFields.current.clear();
    setIsNew(true);
    setForm({
      kind: 'model',
      type,
      name,
      config: { ...defaultConfig(type), ...presetConfig },
      enabled: true,
      capabilities: capabilitiesForType(type),
      status: 'missing_prerequisites',
      prerequisites: [],
      lastCheckedAt: null,
    });
    setError(null);
    // To `new`, never to the id being composed. The route's identity includes
    // the connection id and the app shell remounts a route subtree when that
    // identity changes — so navigating to the not-yet-created id threw the
    // draft away and left the user on a blank pane with no Create button.
    // `new` is a stable identity for as long as the draft exists;
    // `saveMutation.onSuccess` moves to the persisted id once the server can
    // answer for it.
    onNavigate({ type: 'connections-provider-edit', id: 'new' });
  }

  function setField<K extends keyof Omit<ProviderConnection, 'id'>>(
    key: K,
    value: Omit<ProviderConnection, 'id'>[K],
  ) {
    markDirty(key as string);
    setForm((f) => (f ? { ...f, [key]: value } : f));
  }

  function setConfigField(key: string, value: unknown) {
    // A baseUrl edit deliberately clears the model selection: that reset is
    // itself an edit, so mark those fields dirty too or a refetch would put
    // the stale model back.
    markDirty(
      `config.${key}`,
      ...(key === 'baseUrl'
        ? ['config.defaultModel', 'config.modelOptions']
        : []),
    );
    setForm((f) =>
      f
        ? {
            ...f,
            config: {
              ...f.config,
              [key]: value,
              ...(key === 'baseUrl'
                ? { defaultModel: '', modelOptions: undefined }
                : {}),
            },
          }
        : f,
    );
  }

  function handleTypeChange(type: string) {
    // Changing type replaces the whole config with that type's defaults.
    markDirty('type', 'capabilities', WHOLE_CONFIG_DIRTY);
    setForm((f) =>
      f
        ? {
            ...f,
            type,
            config: defaultConfig(type),
            capabilities: capabilitiesForType(type),
          }
        : f,
    );
  }

  function handleSave() {
    if (!form || !selectedProviderId) return;
    const connectionId =
      isNew && draftConnectionId.current
        ? draftConnectionId.current
        : selectedProviderId;
    creatingSubmission.current = isNew;
    submittedValues.current = new Map(
      [...dirtyFields.current].map((path) => [path, readFormPath(form, path)]),
    );
    const { modelOptions: _modelOptions, ...rest } = form.config;
    const persistedConfig = finalizeConnectionConfig(form.type, rest);
    saveMutation.mutate({
      connection: {
        id: connectionId,
        ...form,
        config: persistedConfig,
      },
      isNew,
    });
  }

  const llmEmbeddingProviders = filterModelProviders(modelProviders, '');
  const filtered = filterModelProviders(modelProviders, search);

  // 6-: the list rail used to carry no readiness at all — a green dot
  // meaning `enabled` — while the hub card for the same connection asserted
  // "Ready". One derivation now feeds both.
  const items = filtered.map((p) => {
    const described = describeProvider(p);
    const presentation = resolveProviderPresentation({
      id: p.id,
      kind: 'model',
      type: p.type,
      name: p.name,
      enabled: p.enabled,
      status: p.status,
      prerequisites: p.prerequisites,
      ...(p.readinessEvidence
        ? { readinessEvidence: p.readinessEvidence }
        : {}),
      setup: null,
      href: '',
    });
    return {
      id: p.id,
      name: described.name,
      subtitle: `${presentation.readiness} · ${described.subtitle}`,
      icon: (
        <span
          style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background:
              presentation.tone === 'ready'
                ? 'var(--success-text, #22c55e)'
                : presentation.tone === 'error'
                  ? 'var(--error-text)'
                  : presentation.tone === 'warn'
                    ? 'var(--warning-text)'
                    : 'var(--text-muted)',
            display: 'inline-block',
            flexShrink: 0,
          }}
        />
      ),
    };
  });

  const detectedActions = [
    systemStatus?.providers?.detected.ollama && !hasOllamaProvider
      ? {
          type: 'ollama',
          name: 'Local Ollama',
          label: 'Add detected Ollama',
          detail: 'A local Ollama server is reachable right now.',
        }
      : null,
    systemStatus?.providers?.detected.bedrock && !hasBedrockProvider
      ? {
          type: 'bedrock',
          name: 'Amazon Bedrock',
          label: 'Add detected Bedrock',
          detail: 'AWS credentials are available for Bedrock.',
        }
      : null,
  ].filter(Boolean) as Array<{
    type: string;
    name: string;
    label: string;
    detail: string;
  }>;

  return (
    <SplitPaneLayout
      paneId={CONNECTIONS_MODELS_PANE_ID}
      label={
        selectedProviderId && !isCreatingSelection
          ? 'Connections / Providers / Edit'
          : 'Connections / Providers'
      }
      // FLAGGED FOR CLEANUP (archive#4463): `breadcrumbLinks`
      // is looked up per SEGMENT (`seg.toLowerCase` against one word from
      // the split trail), so this compound key ('connections / providers')
      // can never match any single segment and this handler is dead. Harmless
      // today — this view's live route always renders inside
      // `ConnectionsSectionFrame`'s `PageHeaderScope`, which suppresses this
      // component's own header/breadcrumb entirely — but worth fixing (or
      // removing) the next time this file is touched.
      breadcrumbLinks={
        selectedProviderId && !isCreatingSelection
          ? {
              'connections / providers': () =>
                guardedNavigate({ type: 'connections-providers' }),
            }
          : undefined
      }
      title="Providers"
      subtitle="Connect model services for chats and agents"
      items={items}
      loading={isLoading}
      error={providersError}
      onRetry={() => void refetchProviders()}
      selectedId={selectedProviderId ?? null}
      onSelect={handleSelect}
      onDeselect={() => {
        guard(() => {
          setForm(null);
          onNavigate({ type: 'connections-providers' });
        });
      }}
      onSearch={setSearch}
      searchValue={search}
      listFilteredEmptyNoun="model connections"
      collectionEmpty={llmEmbeddingProviders.length === 0}
      searchPlaceholder="Search model connections…"
      // archive#4463: the list's own genuinely-empty
      // title, for when there are no connections at all (no filter involved
      // `searchValue` above routes a filtered-to-nothing search to
      // FilteredEmpty instead of this). No listEmptyDescription: the detail
      // panel's overview (quickstart actions + provider stack) is the one
      // owner of "what to do about it" (the pattern below), so the list
      // states only the fact, not the fix.
      //
      // No emptyTitle/emptyDescription: `emptyContent` below is always
      // supplied, so SplitPaneLayout never reaches its own default Empty —
      // these two props would be dead text.
      listEmptyTitle="No model connections yet"
      emptyContent={
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {/*
            M2 (delta review round 3): this panel's own "nothing to select"
            label duplicated whichever fact the list pane had already
            stated — "No model connections yet" (listEmptyTitle, when
            llmEmbeddingProviders is empty) or "Nothing in model
            connections matches…" (FilteredEmpty, when a search leaves
            `items` empty). Rendering it only when there IS something to
            select — connections exist AND the current filtered view isn't
            itself empty — leaves the list pane as the one owner of both
            of those facts; this panel keeps only the quickstart actions
            and the (always-useful, per-capability) provider stack below,
            neither of which restates either fact. `items` is already a
            subset of `llmEmbeddingProviders`, so the second check is
            structurally redundant today — named explicitly so the two
            states being suppressed stay legible rather than implied by
            set inclusion a future reader has to re-derive.
*/}
          {llmEmbeddingProviders.length > 0 && items.length > 0 && (
            <Empty
              variant="compact"
              label="Select a model connection"
              description="Choose a model connection to review its status and setup."
            />
          )}
          {detectedActions.length > 0 && (
            <div
              style={{
                padding: '16px',
                borderRadius: '10px',
                border: '1px solid var(--border-primary)',
                background: 'var(--bg-secondary)',
              }}
            >
              <div
                style={{
                  fontSize: '11px',
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: 'var(--text-muted)',
                  marginBottom: '8px',
                }}
              >
                Detected providers
              </div>
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                }}
              >
                {detectedActions.map((action) => (
                  <button
                    type="button"
                    key={action.type}
                    className="provider-overview__quickstart-btn"
                    onClick={() => handleAddWithType(action.type, action.name)}
                    disabled={saveMutation.isPending}
                    title={
                      saveMutation.isPending
                        ? 'A connection save is already in progress'
                        : undefined
                    }
                  >
                    <div>
                      <div className="provider-overview__quickstart-name">
                        {action.label}
                      </div>
                      <div className="provider-overview__quickstart-meta">
                        {action.detail}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}

          <ProviderStackOverview
            providers={llmEmbeddingProviders}
            onSelect={handleSelect}
            onAdd={handleAddWithType}
          />
        </div>
      }
    >
      {isCreatingSelection && !form ? (
        <ProviderTypePicker
          onAdd={handleAddWithType}
          onCancel={() => guardedNavigate({ type: 'connections-providers' })}
          agentChoices={agentChoices}
          commandChoices={commandChoices}
          onChooseAgent={(connection) =>
            guardedNavigate({
              type: 'connections-runtime-edit',
              id: connection.id,
            })
          }
          onChooseCommand={(entry) =>
            guardedNavigate({
              type: 'connections-acp-new',
              providerId: entry === 'custom' ? 'custom' : entry.id,
            })
          }
        />
      ) : form ? (
        <div
          style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
        >
          <DetailHeader
            title={isNew ? `Connect ${form.name}` : form.name || form.type}
          >
            {!isNew && selectedProviderId && (
              <button
                type="button"
                className="editor-btn editor-btn--danger"
                onClick={() => setShowDeleteModal(true)}
                disabled={deleteMutation.isPending}
              >
                Delete
              </button>
            )}
            <button
              type="button"
              className="editor-btn editor-btn--primary"
              onClick={handleSave}
              disabled={
                saveMutation.isPending ||
                !form.name ||
                !isConnectionConfigValid(form.type, form.config)
              }
            >
              {saveMutation.isPending ? 'Saving…' : isNew ? 'Create' : 'Save'}
            </button>
          </DetailHeader>

          {error && (
            <div
              style={{
                margin: '12px 24px',
                padding: '10px 14px',
                background: 'var(--error-bg)',
                border: '1px solid var(--error-border)',
                borderRadius: '6px',
                color: 'var(--error-text)',
                fontSize: '13px',
              }}
            >
              {error}
            </div>
          )}

          <ProviderConnectionForm
            form={form}
            isNew={isNew}
            selectedProviderId={selectedProviderId}
            testResult={testResult}
            testError={testError}
            isTesting={testMutation.isPending}
            onSetField={setField}
            onSetConfigField={setConfigField}
            onTypeChange={handleTypeChange}
            onTestConnection={(id) => testMutation.mutate(id)}
            isLoadingModels={isFetchingProviders}
            // the catalogue load is the same live request the
            // connections listing performs; refetching it re-asks the
            // provider rather than reading a cached answer.
            onLoadModels={() => {
              void refetchProviders();
            }}
          />
        </div>
      ) : null}
      {/*
        RT-17: provider delete was a single unconfirmed click that removed the
        connection and its saved API key from disk immediately, while agent
        delete has always confirmed. Same shared modal, same danger variant.
*/}
      <ConfirmModal
        isOpen={showDeleteModal && !!selectedProviderId && !isNew}
        title="Delete provider"
        message={`Are you sure you want to delete "${form?.name || selectedProviderId}"? Its saved credentials are removed from this computer. This cannot be undone.`}
        confirmLabel="Delete"
        variant="danger"
        role="alertdialog"
        pending={deleteMutation.isPending}
        onConfirm={() => {
          if (selectedProviderId) deleteMutation.mutate(selectedProviderId);
        }}
        onCancel={() => setShowDeleteModal(false)}
      />
      <DiscardModal />
    </SplitPaneLayout>
  );
}
