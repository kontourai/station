import {
  useCreateACPConnectionMutation,
  useDeleteACPConnectionMutation,
  useInstallACPConnectionRegistryEntryMutation,
  useReconnectACPConnectionMutation,
  useUpdateACPConnectionMutation,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import {
  useACPConnectionRegistry,
  useACPConnections,
} from '../../hooks/useACPConnections';
import type { AgentSummary } from '../../types';
import { Button } from '../Button';
import { useSplitPaneExternalReturnFocus } from '../split-pane-return-focus-context';
import { describeReadFailure, Empty, ErrorState, SkeletonList } from '../state';
import { ACPAddConnectionModal } from './ACPAddConnectionModal';
import { ACPConnectionCard } from './ACPConnectionCard';
import { ACPConnectionDetailModal } from './ACPConnectionDetailModal';
import type { ACPConnectionDraft } from './types';

interface ACPConnectionsSectionProps {
  acpAgents: AgentSummary[];
  initialProviderId?: string | null;
}

export function ACPConnectionsSection({
  acpAgents,
  initialProviderId,
}: ACPConnectionsSectionProps) {
  const {
    data: connections = [],
    error: connectionQueryError,
    isError: connectionQueryIsError = false,
    isFetching: connectionQueryFetching = false,
    // SHELL-09 class: the empty state below rendered from `connections.length
    // === 0`, which is also true for the whole initial read — so a populated
    // instance briefly asserted "Add a provider to get started". `isPending`
    // is the initial-read signal; `isFetching` (already read above, for the
    // refresh affordance) is true for background refetches too and would blank
    // a populated list.
    isPending: connectionQueryPending = false,
    refetch: refetchConnections,
  } = useACPConnections();
  const { data: registryEntries = [] } = useACPConnectionRegistry();
  const createConnectionMutation = useCreateACPConnectionMutation();
  const installRegistryEntryMutation =
    useInstallACPConnectionRegistryEntryMutation();
  const updateConnectionMutation = useUpdateACPConnectionMutation();
  // Separate mutation instance from `updateConnectionMutation` (used for the
  // card grid's enabled toggle) so `isPending` reflects only an in-flight
  // `provideToolServers` update — sharing one instance would make the modal
  // report "pending" while an unrelated connection's enabled toggle is
  // mid-flight, or vice versa.
  const updateToolServersMutation = useUpdateACPConnectionMutation();
  const deleteConnectionMutation = useDeleteACPConnectionMutation();
  const reconnectConnectionMutation = useReconnectACPConnectionMutation();
  // #592 slice 2: this section no longer owns an add trigger of its own —
  // the merged Add-engine catalogue on the Engines tab
  // (`AgentConnectionView`'s `EngineAddCatalog`, reached from the frame's one
  // "Add engine" action) is the sole entry point. Arriving here with a
  // provider already named (`/connections/engines/new/<id>`) is therefore
  // the only way this modal opens.
  const [showAddModal, setShowAddModal] = useState(Boolean(initialProviderId));
  const splitPaneReturnFocus = useSplitPaneExternalReturnFocus();
  // Review fix (#592 slice 2, M2): the catalogue row that used to sit in
  // this component and own its own `returnTriggerRef` no longer exists —
  // choosing an ACP engine is a route change into a fresh mount of this
  // component, so nothing local survives to focus back to.
  // `ConnectionsSectionFrame` already captures its one "Add engine" button
  // into `SplitPaneReturnFocusProvider` before navigating here
  // (`ConnectionsSectionFrame.tsx`'s `add` handler), and that provider is
  // not remounted by this route change (it wraps the whole Engines section,
  // both the catalogue's route and this one). Taken once, on mount, so a
  // later re-render of this same instance cannot re-read an already-consumed
  // chain. `chain[0]` — the captured trigger itself — is what
  // `ACPAddConnectionModal` re-derives its own ancestor chain from; an empty
  // chain (no capture happened, e.g. a direct deep link) falls through to
  // `ResponsiveDialogSurface`'s own `document.activeElement` fallback.
  const [returnFocusChain] = useState<HTMLElement[]>(
    () => splitPaneReturnFocus?.takeExternalReturnFocus() ?? [],
  );
  const [selectedConnId, setSelectedConnId] = useState<string | null>(null);
  // Derived (not a snapshot) so the detail modal reflects the connection's
  // latest `provideToolServers` selection immediately after a mutation.
  const selectedConn =
    connections.find((connection) => connection.id === selectedConnId) ?? null;

  const toggleEnabled = async (id: string, enabled: boolean) => {
    await updateConnectionMutation.mutateAsync({
      id,
      updates: { enabled },
    });
  };

  const updateToolServers = async (
    id: string,
    provideToolServers: string[],
  ) => {
    await updateToolServersMutation.mutateAsync({
      id,
      updates: { provideToolServers },
    });
  };

  const removeConnection = async (id: string) => {
    await deleteConnectionMutation.mutateAsync(id);
  };

  const addConnection = async (data: ACPConnectionDraft) => {
    return createConnectionMutation.mutateAsync(data);
  };

  const installRegistryEntry = async (id: string) => {
    return installRegistryEntryMutation.mutateAsync(id);
  };

  // Registry entries are suggestions only. Once installed, the connection
  // query is the single configured-engine projection used by this page.
  const availableRegistryEntries = registryEntries.filter(
    (entry) => !entry.installed,
  );

  return (
    <>
      {showAddModal && (
        <ACPAddConnectionModal
          registryEntries={availableRegistryEntries}
          connections={connections}
          createPending={createConnectionMutation.isPending}
          installPending={installRegistryEntryMutation.isPending}
          connectionQueryError={
            connectionQueryIsError ? connectionQueryError : undefined
          }
          connectionQueryFetching={connectionQueryFetching}
          onAdd={addConnection}
          onInstallRegistryEntry={installRegistryEntry}
          onRefreshConnections={refetchConnections}
          onCancel={() => setShowAddModal(false)}
          returnFocusTarget={returnFocusChain[0] ?? null}
          initialProviderId={initialProviderId}
        />
      )}

      <div className="acp-connections-section__grid">
        {connections.map((conn) => (
          <ACPConnectionCard
            key={conn.id}
            conn={conn}
            agents={acpAgents.filter((a) => a.slug.startsWith(`${conn.id}-`))}
            onClick={() => setSelectedConnId(conn.id)}
            onToggle={(enabled) => toggleEnabled(conn.id, enabled)}
            onRemove={() => removeConnection(conn.id)}
            onReconnect={async () => {
              await reconnectConnectionMutation.mutateAsync(conn.id);
            }}
          />
        ))}
      </div>

      {connectionQueryPending && (
        <SkeletonList count={2} label="Loading engines" />
      )}
      {/*
        Review H1: the failure was read, but only inside the Add-provider
        modal — the page itself fell through to the empty state below and told
        a user whose provider list Station could not read that they had none
        and should add one. The failure belongs on the surface that made the
        claim, ahead of the empty branch.
      */}
      {!connectionQueryPending && connectionQueryIsError && (
        <ErrorState
          variant="compact"
          title="Unable to load engines"
          description={describeReadFailure(connectionQueryError)}
          action={
            <Button size="sm" onClick={() => void refetchConnections()}>
              Retry
            </Button>
          }
        />
      )}
      {!connectionQueryPending &&
        !connectionQueryIsError &&
        connections.length === 0 && (
          /* empty-state action: the frame's one "Add engine" action is
             adjacent (this section owns no add action of its own — #592
             slice 2) */
          <Empty
            variant="compact"
            label="Add an engine to get started"
            description="Choose a detected engine or connect a custom one."
          />
        )}

      {selectedConn && (
        <ACPConnectionDetailModal
          conn={selectedConn}
          agents={acpAgents.filter((a) =>
            a.slug.startsWith(`${selectedConn.id}-`),
          )}
          onClose={() => setSelectedConnId(null)}
          {...(selectedConn.source !== 'plugin'
            ? {
                onUpdateToolServers: (ids: string[]) =>
                  updateToolServers(selectedConn.id, ids),
                isUpdatingToolServers: updateToolServersMutation.isPending,
              }
            : {})}
        />
      )}
    </>
  );
}
