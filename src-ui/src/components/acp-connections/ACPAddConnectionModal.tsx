import { useEffect, useRef } from 'react';
import type {
  ACPConnectionInfo,
  ACPConnectionRegistryEntry,
} from '../../hooks/useACPConnections';
import { ResponsiveDialogSurface } from '../ResponsiveDialogSurface';
import {
  ACPConnectionCatalogStage,
  ACPConnectionConfirmStage,
  ACPConnectionCustomStage,
  ACPConnectionSetupActions,
  ACPConnectionSetupHeader,
  ACPConnectionSetupStatus,
} from './ACPConnectionSetupStages';
import type { ACPConnectionDraft } from './types';
import { useACPConnectionSetup } from './useACPConnectionSetup';
import { getACPConnectionStatusView } from './utils';

export function ACPAddConnectionModal({
  registryEntries = [],
  connections = [],
  createPending = false,
  installPending = false,
  connectionQueryError,
  connectionQueryFetching = false,
  onAdd,
  onInstallRegistryEntry,
  onRefreshConnections,
  onCancel,
  returnFocusTarget,
  initialProviderId,
  probeStatuses,
  probeStatusesUpdatedAt,
  onFirstContactPendingChange,
  editConnection,
  onUpdate,
  onCheck,
}: {
  registryEntries?: ACPConnectionRegistryEntry[];
  connections?: ACPConnectionInfo[];
  createPending?: boolean;
  installPending?: boolean;
  connectionQueryError?: unknown;
  connectionQueryFetching?: boolean;
  onAdd: (data: ACPConnectionDraft) => unknown;
  onInstallRegistryEntry?: (id: string) => unknown;
  onRefreshConnections?: () => unknown;
  onCancel: () => void;
  returnFocusTarget?: HTMLElement | null;
  initialProviderId?: string | null;
  /** Live probe status; the owner polls it while a first start runs. */
  probeStatuses?: Array<{
    id: string;
    status: string;
    lastError?: { message: string; phase: string };
  }>;
  /** When `probeStatuses` was fetched (epoch ms). */
  probeStatusesUpdatedAt?: number;
  /** Tells the owner when to poll `probeStatuses`. */
  onFirstContactPendingChange?: (pending: boolean) => void;
  /** Edit setup of a saved custom engine; saves through `onUpdate`. */
  editConnection?: ACPConnectionInfo;
  onUpdate?: (id: string, draft: ACPConnectionDraft) => unknown;
  onCheck?: (id: string) => unknown;
}) {
  const nameInputRef = useRef<HTMLInputElement>(null);
  const initialProviderHandled = useRef(false);
  const {
    state,
    dispatch,
    resultConnection,
    awaitingFirstContact,
    submit,
    retryMutation,
    retryCheck,
    retryRefresh,
  } = useACPConnectionSetup({
    registryEntries,
    connections,
    queryError: connectionQueryError,
    queryFetching: connectionQueryFetching,
    onAdd,
    onInstallRegistryEntry,
    onRefreshConnections,
    probeStatuses,
    probeStatusesUpdatedAt,
    editConnection,
    onUpdate,
    onCheck,
  });
  const editing = Boolean(editConnection);
  useEffect(() => {
    onFirstContactPendingChange?.(awaitingFirstContact);
  }, [awaitingFirstContact, onFirstContactPendingChange]);
  useEffect(
    () => () => onFirstContactPendingChange?.(false),
    [onFirstContactPendingChange],
  );
  const availableEntries = registryEntries.filter((entry) => !entry.installed);
  const readiness =
    resultConnection && getACPConnectionStatusView(resultConnection);
  const isCustom = !state.selectedEntry;
  const isPending =
    createPending || installPending || state.stage === 'checking';

  // CI-R8: a provider arriving from a deep link — the hub's "Connect this
  // provider" card, whose own label reads as a status — used to submit
  // straight through, so one click on an informational-looking card wrote a
  // persistent connection and minted an agent with nothing asked and nothing
  // said. It lands on the confirm stage instead; choosing a brand inside this
  // dialog is still an explicit choice and still continues directly.
  // biome-ignore lint/correctness/useExhaustiveDependencies: submit and dispatch are reducer helpers; the guard makes this a one-shot continuation.
  useEffect(() => {
    if (initialProviderHandled.current || !initialProviderId) return;
    if (initialProviderId === 'custom') {
      initialProviderHandled.current = true;
      dispatch({ type: 'custom' });
      return;
    }
    const entry = registryEntries.find(
      (candidate) => candidate.id === initialProviderId,
    );
    if (!entry) return;
    initialProviderHandled.current = true;
    dispatch({ type: 'confirm', entry });
  }, [initialProviderId, registryEntries]);

  return (
    <ResponsiveDialogSurface
      layer="dialog"
      onClose={onCancel}
      ariaLabelledBy="add-provider-title"
      overlayClassName="acp-add-dialog__overlay"
      panelClassName="acp-add-dialog"
      initialFocusRef={nameInputRef}
      initialFocusPolicy="desktop"
      returnFocusTarget={returnFocusTarget}
    >
      <ACPConnectionSetupHeader
        stage={state.stage}
        editing={editing}
        onClose={onCancel}
      />
      <div className="acp-add-dialog__body">
        {state.stage === 'catalog' && (
          <ACPConnectionCatalogStage
            entries={availableEntries}
            onSelect={(entry) => void submit(entry)}
            onCustom={() => dispatch({ type: 'custom' })}
          />
        )}
        {state.stage === 'confirm' && state.selectedEntry && (
          <ACPConnectionConfirmStage entry={state.selectedEntry} />
        )}
        {state.stage === 'custom' && (
          <ACPConnectionCustomStage
            draft={state.draft}
            advancedOpen={state.advancedOpen}
            nameInputRef={nameInputRef}
            idLocked={editing}
            onDraftChange={(field, value) =>
              dispatch({ type: 'draft', field, value })
            }
            onAdvancedChange={(open) => dispatch({ type: 'advanced', open })}
          />
        )}
        <ACPConnectionSetupStatus
          stage={state.stage}
          label={readiness?.statusLabel}
          error={state.error}
          reason={resultConnection?.lastError ?? null}
          connectionId={resultConnection?.id}
          pending={isPending}
          firstContact={awaitingFirstContact}
          attempt={state.attempt}
          engineName={
            resultConnection?.name ??
            state.selectedEntry?.name ??
            editConnection?.name ??
            (state.draft.name || undefined)
          }
        />
      </div>
      <ACPConnectionSetupActions
        stage={state.stage}
        hasRegistryEntries={!editing && registryEntries.length > 0}
        isCustom={isCustom}
        canSubmit={Boolean(state.draft.name && state.draft.command)}
        ready={readiness?.statusLabel === 'Ready'}
        firstContact={awaitingFirstContact}
        canRetryCheck={
          readiness?.statusLabel === 'Setup required' ||
          readiness?.statusLabel === 'Unavailable'
        }
        errorKind={state.errorKind}
        confirmLabel={
          state.selectedEntry
            ? `Connect ${state.selectedEntry.name}`
            : 'Connect'
        }
        onCatalog={() => dispatch({ type: 'catalog' })}
        onCustom={() => dispatch({ type: 'custom' })}
        onConfirm={() => void submit(state.selectedEntry)}
        onSubmit={() => void submit(null)}
        onRetryMutation={() => void retryMutation()}
        onRetryCheck={() => void retryCheck()}
        onRetryRefresh={() => void retryRefresh()}
        onClose={onCancel}
      />
    </ResponsiveDialogSurface>
  );
}
