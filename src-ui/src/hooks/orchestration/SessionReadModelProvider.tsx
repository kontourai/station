import { OrchestrationSessionsContext } from '@kontourai/station-sdk';
import { useQueryClient } from '@tanstack/react-query';
import {
  type ReactNode,
  useEffect,
  useMemo,
  useSyncExternalStore,
} from 'react';
import {
  useApiBase,
  useHostRequestAuthorityScope,
} from '../../contexts/ApiBaseContext';
import { registerOrchestrationStreamQueryClient } from './ensureOrchestrationEventStream';
import {
  getStreamConnectionState,
  subscribeStreamConnectionState,
} from './streamConnectionState';

export function SessionReadModelProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { apiBase } = useApiBase();
  const scope = useHostRequestAuthorityScope();
  const queryClient = useQueryClient();
  useEffect(
    () =>
      registerOrchestrationStreamQueryClient(
        apiBase,
        queryClient,
        scope?.authorityKey,
      ),
    [apiBase, queryClient, scope?.authorityKey],
  );
  const state = useSyncExternalStore(subscribeStreamConnectionState, () =>
    getStreamConnectionState(apiBase),
  );
  const value = useMemo(
    () => ({ scope, streamLive: state.phase === 'caught-up' }),
    [scope, state.phase],
  );
  return (
    <OrchestrationSessionsContext.Provider value={value}>
      {children}
    </OrchestrationSessionsContext.Provider>
  );
}
