import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  type ConnectionCandidateProviderResult,
  connectionCandidateProviderCount,
  connectionCandidateProviderRevision,
  discoverConnectionCandidates,
  subscribeConnectionCandidateProviders,
} from '../core/connectionCandidates';
import type { ConnectionCandidate } from '../core/types';

export interface UseConnectionCandidatesResult {
  discovering: boolean;
  candidates: ConnectionCandidate[];
  providers: ConnectionCandidateProviderResult[];
  providerCount: number;
  refresh: () => void;
  cancel: () => void;
}

export function useConnectionCandidates(): UseConnectionCandidatesResult {
  const [discovering, setDiscovering] = useState(false);
  const [candidates, setCandidates] = useState<ConnectionCandidate[]>([]);
  const [providers, setProviders] = useState<
    ConnectionCandidateProviderResult[]
  >([]);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const providerRevision = useSyncExternalStore(
    subscribeConnectionCandidateProviders,
    connectionCandidateProviderRevision,
    connectionCandidateProviderRevision,
  );
  const providerCount = connectionCandidateProviderCount();
  const cancel = useCallback(() => {
    generationRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setDiscovering(false);
  }, []);

  const refresh = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const generation = ++generationRef.current;
    setCandidates([]);
    setProviders([]);
    setDiscovering(true);
    void discoverConnectionCandidates({
      signal: controller.signal,
      providerRevision,
    }).then(
      (result) => {
        if (generation !== generationRef.current) return;
        setCandidates(result.candidates);
        setProviders(result.providers);
        setDiscovering(false);
      },
      () => {
        if (generation !== generationRef.current) return;
        setCandidates([]);
        setProviders([]);
        setDiscovering(false);
      },
    );
  }, [providerRevision]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      abortRef.current?.abort();
    },
    [],
  );

  return { discovering, candidates, providers, providerCount, refresh, cancel };
}
