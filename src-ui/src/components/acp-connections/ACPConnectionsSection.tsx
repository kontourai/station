import {
  useCreateACPConnectionMutation,
  useDeleteACPConnectionMutation,
  useInstallACPConnectionRegistryEntryMutation,
  useReconnectACPConnectionMutation,
  useUpdateACPConnectionMutation,
} from '@kontourai/station-sdk';
import { restoreReturnFocus } from '@kontourai/station-shared/return-focus';
import { useRef, useState } from 'react';
import {
  useACPConnectionRegistry,
  useACPConnections,
} from '../../hooks/useACPConnections';
import type { AgentSummary } from '../../types';
import { Button } from '../Button';
import { usePageFrameActionsSlot } from '../page-frame';
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
  // Review fix round 2 (#592 slice 2, M2): a captured DOM node cannot cross
  // this boundary — `connections-engine-new`'s surface identity is per-provider
  // (`route-identity.ts`'s `routeSurfaceIdentity` never folds it into
  // `connections-engines`), so `AppViewContent`'s `key={surfaceKey}` entrance
  // wrapper remounts everything from `ConnectionsSectionFrame` down on EVERY
  // arrival here — the `SplitPaneReturnFocusProvider` a prior round captured
  // the catalogue's "Add engine" button into does not survive either, and
  // `PageFrame`'s `.page__actions` cell is independently torn down and
  // recreated by its own `key={routeIdentity}` the moment the cell's route
  // identity changes (`PageFrame.tsx`, pinned by
  // `PageFrame.test.tsx`'s "replaces the action cell itself" case) — so the
  // captured button is off-document by the time this component exists to
  // read it. There is no target from the OLD route to carry forward.
  //
  // The fix resolves the target on THIS route, AT CLOSE TIME, not by
  // carrying a node: `PageFrame` itself (`FramedPage`) is not remounted by
  // the same boundary — only its `.page__actions` child cell is, and
  // `FramedPage` keeps that cell's current DOM node live in
  // `PageFrameContext` regardless. Since `ConnectionsSectionFrame` always
  // renders exactly one primary-action `Button` into that cell
  // (`PageFrameActions`' documented contract), the current route's OWN "Add
  // engine" button — not the one that was clicked, which never exists in
  // this tree — is the one real, always-connected, on-this-route substitute.
  //
  // NOT threaded through `ACPAddConnectionModal`'s `returnFocusTarget` prop:
  // `.page__actions`'s cell swap does not settle in the render that mounts
  // this component — it settles over several renders (proven live: a render
  // reads the OLD, about-to-be-orphaned button before its removal even
  // commits; the very next reads the freshly emptied cell; only a LATER
  // render sees the real new button attached), and that settling can land in
  // the SAME commit as the close action itself. A value fed into
  // `returnFocusTarget` is captured once, reactively, by an effect keyed to
  // that prop — exactly the "carry a node across a boundary" failure mode
  // this fix exists to remove, just moved from a route boundary to a render
  // boundary. Reading `usePageFrameActionsSlot()`'s result imperatively,
  // inside `onCancel`, is what "at close time" means: by the moment a real
  // user can click Cancel, the cell has already settled (at least one
  // browser paint separates "dialog opened" from "user clicked inside it"),
  // so the read is never stale in practice. No chain, nothing consumed once,
  // so `SplitPaneLayout`'s own one-shot read of `SplitPaneReturnFocusProvider`
  // (its mobile detail sheet, unrelated to this component) can never race it.
  const currentActionsNode = usePageFrameActionsSlot();
  const currentActionsNodeRef = useRef<HTMLElement | null>(null);
  currentActionsNodeRef.current = currentActionsNode;
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
          onCancel={() => {
            setShowAddModal(false);
            // Read now, at the moment of closing — not passed as
            // `returnFocusTarget` (see the comment above `currentActionsNodeRef`).
            const button =
              currentActionsNodeRef.current?.querySelector('button') ?? null;
            if (button) restoreReturnFocus([button]);
          }}
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
