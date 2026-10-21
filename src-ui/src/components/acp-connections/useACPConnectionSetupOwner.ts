import {
  splitACPArgs,
  useCheckACPConnectionMutation,
  useCreateACPConnectionMutation,
  useInstallACPConnectionRegistryEntryMutation,
  useUpdateACPConnectionMutation,
} from '@kontourai/station-sdk';
import { useState } from 'react';
import {
  useACPConnectionProbeStatuses,
  useACPConnections,
} from '../../hooks/useACPConnections';
import type { ACPConnectionSetupPanelProps } from './ACPConnectionSetupPanel';
import type { ACPConnectionDraft } from './types';

/**
 * The reads and writes one engine setup needs: the connection list the result
 * is read from, the polled probe status while a first start runs, and the
 * add, install, edit and re-check mutations. One owner per mounted setup, so
 * its pending flags describe that setup only.
 */
export function useACPConnectionSetupOwner(): Pick<
  ACPConnectionSetupPanelProps,
  | 'connections'
  | 'createPending'
  | 'installPending'
  | 'connectionQueryError'
  | 'connectionQueryFetching'
  | 'onAdd'
  | 'onInstallRegistryEntry'
  | 'onRefreshConnections'
  | 'onUpdate'
  | 'onCheck'
  | 'probeStatuses'
  | 'probeStatusesUpdatedAt'
  | 'onFirstContactPendingChange'
> {
  const {
    data: connections = [],
    error,
    isError = false,
    isFetching = false,
    refetch,
  } = useACPConnections();
  const [firstContactPending, setFirstContactPending] = useState(false);
  const { data: probeStatuses, dataUpdatedAt: probeStatusesUpdatedAt } =
    useACPConnectionProbeStatuses(firstContactPending);
  const create = useCreateACPConnectionMutation();
  const install = useInstallACPConnectionRegistryEntryMutation();
  const update = useUpdateACPConnectionMutation();
  const check = useCheckACPConnectionMutation();
  return {
    connections,
    createPending: create.isPending,
    installPending: install.isPending,
    connectionQueryError: isError ? error : undefined,
    connectionQueryFetching: isFetching,
    onAdd: (draft: ACPConnectionDraft) => create.mutateAsync(draft),
    onInstallRegistryEntry: (id: string) => install.mutateAsync(id),
    onRefreshConnections: refetch,
    // Edit setup saves through PUT, which re-probes and registers on success.
    onUpdate: (id: string, draft: ACPConnectionDraft) =>
      update.mutateAsync({
        id,
        updates: {
          name: draft.name,
          command: draft.command,
          args: splitACPArgs(draft.args),
          // Sent even when empty: the server reads an empty folder as none
          // and an empty icon as the default, so an edit can clear them.
          icon: draft.icon,
          cwd: draft.cwd,
        },
      }),
    onCheck: (id: string) => check.mutateAsync(id),
    probeStatuses,
    probeStatusesUpdatedAt,
    onFirstContactPendingChange: setFirstContactPending,
  };
}
