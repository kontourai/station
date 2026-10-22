import { OrchestrationSessionsContext } from '@kontourai/station-sdk';
import { type ReactNode, useMemo, useSyncExternalStore } from 'react';
import {
  useApiBase,
  useHostRequestAuthorityScope,
} from '../../contexts/ApiBaseContext';
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
