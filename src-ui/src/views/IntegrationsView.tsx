import {
  type IntegrationViewModel,
  useApplyIntegrationToolsMutation,
  useDeleteIntegrationMutation,
  useIntegrationQuery,
  useIntegrationsQuery,
  useReconnectIntegrationMutation,
  useSaveIntegrationMutation,
  useSetIntegrationEnabledMutation,
  useSetIntegrationRenderPermissionMutation,
} from '@kontourai/station-sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { SettingsGlyph } from '../components/icons/Glyph';
import { LazyBoundary } from '../components/LazyBoundary';
import { SplitPaneLayout } from '../components/SplitPaneLayout';
import { useUrlSelection } from '../hooks/useUrlSelection';
import { DeleteIntegrationModal } from './integrations/DeleteIntegrationModal';
import { IntegrationEditorPanel } from './integrations/IntegrationEditorPanel';
import {
  filterIntegrationItems,
  formForSelectedIntegration,
  formToMcpJson,
  parseMcpJson,
} from './integrations/utils';
import './PluginManagementView.css';
import './IntegrationsView.css';
import './page-layout.css';
import './editor-layout.css';

const loadSecretBindingsSection = () =>
  import('./integrations/SecretBindingsSection').then((module) => ({
    default: module.SecretBindingsSection,
  }));

type IntegrationDef = IntegrationViewModel;

/** Compare only fields this editor submits; probe/list decoration is not a draft. */
function integrationDraftSignature(form: IntegrationDef | null): string {
  if (!form) return '';
  const {
    id,
    kind,
    transport,
    command,
    args,
    endpoint,
    displayName,
    description,
    enabled,
    env,
    secretEnv,
    removeSecretEnvKeys,
    secretEnvKeys,
  } = form;
  return JSON.stringify({
    id,
    kind,
    transport,
    command,
    args,
    endpoint,
    displayName,
    description,
    enabled,
    env,
    secretEnv,
    removeSecretEnvKeys,
    secretEnvKeys,
  });
}

/** The blank form a new tool server starts from. */
function blankIntegration(): IntegrationDef {
  return {
    id: '',
    kind: 'mcp',
    transport: 'stdio',
    command: '',
    args: [],
    env: {},
    displayName: '',
    description: '',
    enabled: false,
  };
}

/* ── Integrations View ── */
export function IntegrationsView({
  basePath = '/connections/tools',
}: {
  basePath?: string;
}) {
  const {
    data: integrations = [],
    isLoading,
    error: integrationsError,
    refetch: refetchIntegrations,
  } = useIntegrationsQuery();
  const [search, setSearch] = useState('');
  const [message, setMessage] = useState<{
    type: 'success' | 'warning' | 'error';
    text: string;
  } | null>(null);
  const { selectedId, select, deselect } = useUrlSelection(basePath);
  const [editForm, setEditForm] = useState<IntegrationDef | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [isLocked, setIsLocked] = useState(true);
  const [viewMode, setViewMode] = useState<'form' | 'raw'>('form');
  const [rawJson, setRawJson] = useState('');
  const [rawError, setRawError] = useState<string | null>(null);
  const [pendingDisabledTools, setPendingDisabledTools] = useState<string[]>(
    [],
  );
  const queryClient = useQueryClient();
  const removeSettledSecretMutation = (
    variables: IntegrationDef & { isNew: boolean },
  ) => {
    queueMicrotask(() => {
      const cache = queryClient.getMutationCache();
      for (const mutation of cache.getAll()) {
        if (mutation.state.variables === variables) cache.remove(mutation);
      }
    });
  };

  // Load full detail when selected
  const { data: detailData } = useIntegrationQuery(selectedId ?? undefined, {
    enabled: !!selectedId && selectedId !== 'new',
  });

  useEffect(() => {
    if (detailData) {
      const summary = integrations.find((item) => item.id === detailData.id);
      setEditForm({ ...summary, ...detailData, tools: summary?.tools });
      setPendingDisabledTools(detailData.disabledTools ?? []);
    }
  }, [detailData, integrations]);

  const saveMutation = useSaveIntegrationMutation({
    onSuccess: (_, variables) => {
      setEditForm((current) =>
        current
          ? {
              ...current,
              secretEnv: undefined,
              removeSecretEnvKeys: undefined,
            }
          : current,
      );
      setMessage({ type: 'success', text: 'Saved' });
      if (variables.isNew) select(variables.id);
      saveMutation.reset();
      removeSettledSecretMutation(variables);
    },
    onError: (error, variables) => {
      setEditForm((current) =>
        current
          ? {
              ...current,
              secretEnv: undefined,
              removeSecretEnvKeys: undefined,
            }
          : current,
      );
      setMessage({ type: 'error', text: error.message });
      saveMutation.reset();
      removeSettledSecretMutation(variables);
    },
  });

  const deleteMutation = useDeleteIntegrationMutation({
    onSuccess: () => {
      deselect();
      setEditForm(null);
    },
    onError: (error) => setMessage({ type: 'error', text: error.message }),
  });

  const reconnectMutation = useReconnectIntegrationMutation({
    onSuccess: () => {
      setMessage({ type: 'success', text: 'Reconnecting…' });
    },
    onError: (error) => setMessage({ type: 'error', text: error.message }),
  });

  const renderPermMutation = useSetIntegrationRenderPermissionMutation({
    onSuccess: () =>
      setMessage({ type: 'success', text: 'Render permission updated' }),
    onError: (error) => setMessage({ type: 'error', text: error.message }),
  });
  const enabledMutation = useSetIntegrationEnabledMutation({
    onSuccess: (result) => {
      setEditForm((current) => (current ? { ...current, ...result } : current));
      setMessage(
        result.restartRequired
          ? {
              type: 'warning',
              text: 'Saved. Not yet live — restart required.',
            }
          : { type: 'success', text: 'Lifecycle updated' },
      );
    },
    onError: (error) => setMessage({ type: 'error', text: error.message }),
  });
  const toolsMutation = useApplyIntegrationToolsMutation({
    onSuccess: (result) => {
      setEditForm((current) => (current ? { ...current, ...result } : current));
      setMessage(
        result.restartRequired
          ? {
              type: 'warning',
              text: 'Saved. Not yet live — restart required.',
            }
          : { type: 'success', text: 'Tool changes applied' },
      );
    },
    onError: (error) => setMessage({ type: 'error', text: error.message }),
  });

  // Render permission is a global per-server setting; read it from the list
  // query (the detail endpoint returns only the ToolDef). Default allowed.
  const selectedRenderAllowed =
    integrations.find((integration) => integration.id === selectedId)
      ?.renderAllowed ?? true;

  /**
   * `/connections/tools/new` is the section frame's add action, so the blank
   * form has to exist for a route the user reached directly — not only for
   * the in-page click that used to seed it. Without this the add action
   * selected `new` and rendered nothing.
   */
  useEffect(() => {
    if (selectedId === 'new' && !editForm) {
      setEditForm(blankIntegration());
      setViewMode('form');
      setRawJson('');
      setRawError(null);
    }
  }, [selectedId, editForm]);

  const switchToRaw = () => {
    if (editForm) setRawJson(formToMcpJson(editForm));
    setRawError(null);
    setViewMode('raw');
  };

  const switchToForm = () => {
    if (rawJson.trim()) {
      const { form, error } = parseMcpJson(rawJson, editForm);
      setRawError(error);
      if (form) setEditForm(form);
      else return;
    }
    setViewMode('form');
  };

  const items = useMemo(
    () => filterIntegrationItems(integrations, search),
    [integrations, search],
  );

  const isNew = selectedId === 'new';
  const renderedEditForm = formForSelectedIntegration(selectedId, editForm);
  const locked = !!(renderedEditForm?.plugin && isLocked && !isNew);
  const hasUnsavedIntegrationDraft =
    isNew ||
    (viewMode === 'raw'
      ? rawJson !== formToMcpJson(renderedEditForm ?? blankIntegration())
      : integrationDraftSignature(renderedEditForm) !==
        integrationDraftSignature(detailData ?? null));

  return (
    <>
      <LazyBoundary
        load={loadSecretBindingsSection}
        componentProps={{}}
        pending={null}
      />
      <SplitPaneLayout
        label="connections / tools"
        title="Tool Servers"
        subtitle="MCP server connections"
        items={items}
        loading={isLoading}
        error={integrationsError}
        onRetry={() => void refetchIntegrations()}
        selectedId={selectedId}
        onSelect={(id) => {
          // Secret inputs must disappear in the same event as selection changes;
          // waiting for the next detail query or a mutation callback retains
          // plaintext from the previously selected server in rendered state.
          setEditForm(null);
          select(id);
          setMessage(null);
          setIsLocked(true);
        }}
        onDeselect={() => {
          deselect();
          setEditForm(null);
          saveMutation.reset();
        }}
        onSearch={setSearch}
        searchValue={search}
        listFilteredEmptyNoun="tool servers"
        collectionEmpty={integrations.length === 0}
        searchPlaceholder="Search tool servers..."
        /* The Connections section frame owns this section's single add action
           (design P3: exactly one add entry per section). This view used to
           add two more beside it — a `+ Add Tool Server` list button and a
           Browse Registry header action — which is the CI-R9 shape: several
           differently-styled ways to add the same thing on one screen. The
           Registry keeps its own sidebar entry. */
        listEmptyTitle="No tool servers yet"
        listEmptyDescription="Add an MCP server connection or install one from the registry."
        emptyIcon={<SettingsGlyph />}
        emptyTitle="No tool server selected"
        emptyDescription="Select a tool server to edit, or add a new one"
      >
        {renderedEditForm && (
          <IntegrationEditorPanel
            key={selectedId}
            editForm={renderedEditForm}
            isNew={isNew}
            locked={locked}
            message={message}
            viewMode={viewMode}
            rawJson={rawJson}
            rawError={rawError}
            secretBindingRequireSave={hasUnsavedIntegrationDraft}
            savePending={saveMutation.isPending}
            reconnectPending={reconnectMutation.isPending}
            lifecyclePending={enabledMutation.isPending}
            toolsApplyPending={toolsMutation.isPending}
            pendingDisabledTools={pendingDisabledTools}
            onToggleEnabled={() =>
              enabledMutation.mutate({
                id: renderedEditForm.id,
                enabled: renderedEditForm.enabled === false,
              })
            }
            onToggleTool={(name) =>
              setPendingDisabledTools((current) =>
                current.includes(name)
                  ? current.filter((value) => value !== name)
                  : [...current, name],
              )
            }
            onApplyTools={() =>
              toolsMutation.mutate({
                id: renderedEditForm.id,
                disabledTools: pendingDisabledTools,
              })
            }
            renderAllowed={selectedRenderAllowed}
            renderPermPending={renderPermMutation.isPending}
            onToggleRender={(allow) =>
              renderPermMutation.mutate({
                serverId: renderedEditForm.id,
                allowRender: allow,
              })
            }
            onReconnect={() => reconnectMutation.mutate(renderedEditForm.id)}
            onDelete={() => setDeleteConfirm(true)}
            onSave={() =>
              saveMutation.mutate({
                ...renderedEditForm,
                isNew: selectedId === 'new',
              })
            }
            onSwitchToForm={switchToForm}
            onSwitchToRaw={switchToRaw}
            onRawJsonChange={(value) => {
              setRawJson(value);
              setRawError(null);
            }}
            onUpdate={(updater) =>
              setEditForm((form) => (form ? updater(form) : form))
            }
            onUnlock={() => setIsLocked(false)}
          />
        )}
      </SplitPaneLayout>

      {deleteConfirm && (
        <DeleteIntegrationModal
          integrationName={editForm?.displayName || selectedId || 'tool server'}
          onCancel={() => setDeleteConfirm(false)}
          onConfirm={() => {
            setDeleteConfirm(false);
            if (selectedId) deleteMutation.mutate(selectedId);
          }}
        />
      )}
    </>
  );
}
