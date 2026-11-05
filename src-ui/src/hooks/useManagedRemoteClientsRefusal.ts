import {
  type ManagedPolicySummary,
  managedPolicyAllowsRemoteClients,
  managedRemoteClientsDenial,
} from '@kontourai/station-contracts/managed-policy-status';
import { useManagedPolicyStatusQuery } from '@kontourai/station-sdk';
import { useApiBase } from '../contexts/ApiBaseContext';

/**
 * #4519: the connected Station's policy summary when it allows no remote
 * clients, else `undefined` (also while the status loads, or when it cannot
 * be read). The server refuses pairing and remote access whatever this
 * says; surfaces use it to disable those controls and explain why.
 */
export function useManagedRemoteClientsLimit():
  | ManagedPolicySummary
  | undefined {
  const { apiBase } = useApiBase();
  const status = useManagedPolicyStatusQuery(apiBase);
  const summary =
    status.data?.state === 'loaded' ? status.data.summary : undefined;
  return summary && !managedPolicyAllowsRemoteClients(summary)
    ? summary
    : undefined;
}

/** The same limit as one plain sentence, for a tooltip or label. */
export function useManagedRemoteClientsRefusal(): string | undefined {
  const summary = useManagedRemoteClientsLimit();
  return summary ? managedRemoteClientsDenial(summary) : undefined;
}
