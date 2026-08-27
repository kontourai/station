import type { DiscoveredServer } from '../core/types';
import { useConnectionCandidates } from './useConnectionCandidates';

/**
 * @deprecated Register a ConnectionCandidateProvider and use
 * useConnectionCandidates. These options remain for source compatibility but
 * no longer cause a browser subnet or port scan.
 */
export interface UseNetworkDiscoveryOptions {
  port?: number;
  discoveryPath?: string;
  timeout?: number;
  batchSize?: number;
}

/** @deprecated Use UseConnectionCandidatesResult. */
export interface UseNetworkDiscoveryResult {
  scanning: boolean;
  discovered: DiscoveredServer[];
  scan: () => void;
}

/**
 * @deprecated Provider-backed compatibility adapter. It never enumerates a
 * subnet or probes a hard-coded port.
 */
export function useNetworkDiscovery(
  _options: UseNetworkDiscoveryOptions = {},
): UseNetworkDiscoveryResult {
  const { discovering, candidates, refresh } = useConnectionCandidates();
  return {
    scanning: discovering,
    discovered: candidates.map((candidate) => ({
      name: candidate.name,
      url: candidate.url,
      latency: 0,
    })),
    scan: refresh,
  };
}
