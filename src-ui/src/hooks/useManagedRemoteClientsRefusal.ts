import {
  managedPolicyAllowsRemoteClients,
  managedRemoteClientsDenial,
} from '@kontourai/station-contracts/managed-policy';
import { useManagedPolicyStatusQuery } from '@kontourai/station-sdk';
import { useApiBase } from '../contexts/ApiBaseContext';

/**
 * #4519: the managed sentence when the connected Station's policy allows no
 * remote clients, else `undefined` (also while the status loads, or when it
 * cannot be read). The server refuses pairing and remote access whatever
 * this says; surfaces use it to disable those controls and explain why.
 */
export function useManagedRemoteClientsRefusal(): string | undefined {
  const { apiBase } = useApiBase();
  const status = useManagedPolicyStatusQuery(apiBase);
  const summary =
    status.data?.state === 'loaded' ? status.data.summary : undefined;
  return summary && !managedPolicyAllowsRemoteClients(summary)
    ? managedRemoteClientsDenial(summary)
    : undefined;
}
