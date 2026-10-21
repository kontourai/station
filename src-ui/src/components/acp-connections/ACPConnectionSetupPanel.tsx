import { type ReactNode, useEffect, useRef } from 'react';
import type {
  ACPConnectionInfo,
  ACPConnectionRegistryEntry,
} from '../../hooks/useACPConnections';
import { useACPConnectionRegistry } from '../../hooks/useACPConnections';
import { registryEntryDiscovery } from '../engine-install/registryEntryDiscovery';
import {
  ACPConnectionConfirmStage,
  ACPConnectionCustomStage,
  ACPConnectionSetupActions,
  ACPConnectionSetupHeader,
  ACPConnectionSetupStatus,
} from './ACPConnectionSetupStages';
import type { ACPConnectionDraft } from './types';
import { useACPConnectionSetup } from './useACPConnectionSetup';
import { getACPConnectionStatusView } from './utils';
import './ACPConnections.css';

export interface ACPConnectionSetupPanelProps {
  /** A catalogue choice: the flow starts on its confirm step. */
  entry?: ACPConnectionRegistryEntry | null;
  connections?: ACPConnectionInfo[];
  createPending?: boolean;
  installPending?: boolean;
  connectionQueryError?: unknown;
  connectionQueryFetching?: boolean;
  onAdd: (data: ACPConnectionDraft) => unknown;
  onInstallRegistryEntry?: (id: string) => unknown;
  onRefreshConnections?: () => unknown;
  /** Leaves the setup (Done, Cancel, Close). */
  onDone: () => void;
  /** Back to the catalogue the flow was opened from. */
  onBack?: () => void;
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
  /** With `editConnection`: start by re-checking it (Retry check). */
  recheck?: boolean;
  /** With `editConnection`: whether its setup may be edited (custom only). */
  editable?: boolean;
  onUpdate?: (id: string, draft: ACPConnectionDraft) => unknown;
  onCheck?: (id: string) => unknown;
  /** Ready: start a chat with the connected engine. */
  onStartChat?: (connection: ACPConnectionInfo) => void;
  startChatPending?: boolean;
  /** Mount point beside a result that is not Ready (see the status). */
  renderSetupRequired?: (connection: ACPConnectionInfo) => ReactNode;
}

/**
 * One engine's setup, in place: a catalogue choice's confirm step or the
 * custom form, then Checking and the readiness result. It renders inside the
 * Engines page's detail pane, so the catalogue it came from stays the one
 * context; there is no second catalogue here.
 */
export function ACPConnectionSetupPanel({
  entry,
  connections = [],
  createPending = false,
  installPending = false,
  connectionQueryError,
  connectionQueryFetching = false,
  onAdd,
  onInstallRegistryEntry,
  onRefreshConnections,
  onDone,
  onBack,
  probeStatuses,
  probeStatusesUpdatedAt,
  onFirstContactPendingChange,
  editConnection,
  recheck = false,
  editable = true,
  onUpdate,
  onCheck,
  onStartChat,
  startChatPending = false,
  renderSetupRequired,
}: ACPConnectionSetupPanelProps) {
  const nameInputRef = useRef<HTMLInputElement>(null);
  // The choice that opened this setup is gone from the page, so focus moves
  // to the setup itself rather than dropping to the document.
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    sectionRef.current?.focus({ preventScroll: true });
  }, []);
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
    entry,
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
  // Retry check opens the setup already checking; once per mount.
  const recheckStarted = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a one-shot start; retryCheck changes every render.
  useEffect(() => {
    if (!recheck || !editConnection || recheckStarted.current) return;
    recheckStarted.current = true;
    void retryCheck();
  }, [recheck, editConnection]);
  // The confirm step follows the live lookup, so Check again in its install
  // hint offers Connect as soon as Station finds the engine.
  const { data: registryEntries } = useACPConnectionRegistry();
  const liveEntry = state.selectedEntry
    ? (registryEntries?.find((item) => item.id === state.selectedEntry?.id) ??
      state.selectedEntry)
    : null;
  const installed =
    !liveEntry || registryEntryDiscovery(liveEntry) !== 'not-installed';
  const readiness =
    resultConnection && getACPConnectionStatusView(resultConnection);
  const isCustom = !state.selectedEntry && editable;
  const isPending =
    createPending || installPending || state.stage === 'checking';
  const engineName =
    resultConnection?.name ??
    state.selectedEntry?.name ??
    editConnection?.name ??
    (state.draft.name || 'this engine');

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      className="engine-setup editor-layout"
      aria-label="Engine setup"
    >
      <ACPConnectionSetupHeader
        stage={state.stage}
        editing={editing}
        engineName={state.selectedEntry?.name}
      />
      <div className="agent-editor__section">
        {state.stage === 'confirm' && liveEntry && (
          <ACPConnectionConfirmStage entry={liveEntry} installed={installed} />
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
          pending={isPending}
          firstContact={awaitingFirstContact}
          attempt={state.attempt}
          engineName={engineName}
          setupRequiredSlot={
            resultConnection && renderSetupRequired?.(resultConnection)
          }
        />
        <ACPConnectionSetupActions
          stage={state.stage}
          isCustom={isCustom}
          canSubmit={Boolean(state.draft.name && state.draft.command)}
          canConfirm={installed}
          ready={readiness?.statusLabel === 'Ready'}
          firstContact={awaitingFirstContact}
          canRetryCheck={
            readiness?.statusLabel === 'Setup required' ||
            readiness?.statusLabel === 'Unavailable'
          }
          errorKind={state.errorKind}
          confirmLabel={`Connect ${state.selectedEntry?.name ?? engineName}`}
          engineName={engineName}
          onBack={onBack}
          onConfirm={() => void submit(state.selectedEntry)}
          onSubmit={() => void submit(null)}
          onRetryMutation={() => void retryMutation()}
          onRetryCheck={() => void retryCheck()}
          onRetryRefresh={() => void retryRefresh()}
          onEditSetup={() => dispatch({ type: 'custom' })}
          onDone={onDone}
          onStartChat={
            onStartChat && resultConnection
              ? () => onStartChat(resultConnection)
              : undefined
          }
          startChatPending={startChatPending}
        />
      </div>
    </section>
  );
}
