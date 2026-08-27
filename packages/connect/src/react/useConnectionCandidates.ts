import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type ConnectionCandidateProviderResult,
  connectionCandidateProviderCount,
  discoverConnectionCandidates,
} from '../core/connectionCandidates';
import type { ConnectionCandidate } from '../core/types';

export interface UseConnectionCandidatesResult {
  discovering: boolean;
  candidates: ConnectionCandidate[];
  providers: ConnectionCandidateProviderResult[];
  providerCount: number;
  refresh: () => void;
}

export function useConnectionCandidates(): UseConnectionCandidatesResult {
  const [discovering, setDiscovering] = useState(false);
  const [candidates, setCandidates] = useState<ConnectionCandidate[]>([]);
  const [providers, setProviders] = useState<
    ConnectionCandidateProviderResult[]
  >([]);
  const generationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const providerCount = connectionCandidateProviderCount();

  const refresh = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const generation = ++generationRef.current;
    setDiscovering(true);
    void discoverConnectionCandidates({ signal: controller.signal }).then(
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
  }, []);

  useEffect(
    () => () => {
      generationRef.current += 1;
      abortRef.current?.abort();
    },
    [],
  );

  return { discovering, candidates, providers, providerCount, refresh };
}
