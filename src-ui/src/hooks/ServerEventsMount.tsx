import { useEffect } from 'react';
import {
  useApiBase,
  useHostRequestAuthorityScope,
} from '../contexts/ApiBaseContext';
import { useClientBootstrapReadiness } from '../contexts/AuthorityPersistenceContext';
import { ensureOrchestrationEventStream } from './orchestration/ensureOrchestrationEventStream';

export function useServerEventsTransport() {
  const { apiBase } = useApiBase();
  const authorityKey = useHostRequestAuthorityScope()?.authorityKey;
  const bootstrap = useClientBootstrapReadiness();
  useEffect(() => {
    if (bootstrap.status !== 'settled') return;
    return ensureOrchestrationEventStream(
      apiBase,
      undefined,
      authorityKey,
      true,
      bootstrap.sharedRealtime,
    );
  }, [apiBase, authorityKey, bootstrap.status, bootstrap.sharedRealtime]);
}

export function ServerEventsMount() {
  useServerEventsTransport();
  return null;
}
