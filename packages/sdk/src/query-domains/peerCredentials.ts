import { useQuery } from '@tanstack/react-query';
import { _getApiBase } from '../api';
import { apiErrorMessage } from '../api-core';
import { authenticatedFetch } from '../client/http';
import type { QueryConfig } from '../query-core';
/**
 * Outbound peer-credential summary (station#1123 slice 2,
 * `src-server/services/peers/peer-credential-store.ts`'s
 * `PeerCredentialSummary`) — never carries the raw credential.
 */
export interface PeerCredentialSummary {
  environmentId: string;
  /** Bare origin (`https://host:port`) the peer is reached at directly. */
  apiBase: string;
  /** Space-delimited PairingScope string the peer granted us. */
  scope: string;
  label: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * station#settings-revamp slice 5 (docs/design/settings-architecture.md §3
 * S5): a read-only UI home for the CLI-provisioned outbound peer-credential
 * store (`GET /api/environments/peers`). That route is `access:manage`-gated
 * for a REMOTE caller (`pairing-route-scopes.ts`), so a browser reaching this
 * Station over the network without an operator-tier credential gets a 403 —
 * callers must treat that as "hide the section", never a hard error (see
 * `KnownEnvironmentsSection.tsx`).
 */
export function fetchPeerCredentials(): Promise<PeerCredentialSummary[]> {
  return (async () => {
    const apiBase = await _getApiBase();
    const response = await authenticatedFetch(
      `${apiBase}/api/environments/peers`,
    );
    const result = (await response.json()) as ApiEnvelope<
      PeerCredentialSummary[]
    >;
    if (!response.ok || !result.success || result.data === undefined) {
      throw new Error(
        apiErrorMessage(result, 'Peer credentials request failed'),
      );
    }
    return result.data;
  })();
}

export const peerCredentialQueries = {
  list: () => ({
    queryKey: ['peer-credentials'] as const,
    queryFn: fetchPeerCredentials,
    staleTime: 30_000,
    retry: false,
  }),
};

export function usePeerCredentialsQuery(
  config?: QueryConfig<PeerCredentialSummary[]>,
) {
  return useQuery({ ...peerCredentialQueries.list(), ...config });
}
