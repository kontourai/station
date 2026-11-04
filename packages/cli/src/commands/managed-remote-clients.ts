import {
  type ManagedPolicySummary,
  managedPolicyAllowsRemoteClients,
  managedRemoteClientsDenial,
} from '@kontourai/station-contracts/managed-policy';
import { loadInstalledManagedPolicy } from '@kontourai/station-shared/managed-policy';

/**
 * #4519: the installed policy's summary when its `limits.clients` leaves out
 * `remote`, else `null`. An installed policy that cannot be loaded throws its
 * `STATION_MANAGED_POLICY_INVALID` error: a caller that opens remote access
 * must not treat an unreadable policy as permission.
 */
export function installedRemoteClientsLimit(
  load: typeof loadInstalledManagedPolicy = loadInstalledManagedPolicy,
): ManagedPolicySummary | null {
  const loaded = load();
  return loaded && !managedPolicyAllowsRemoteClients(loaded.summary)
    ? loaded.summary
    : null;
}

/** Throws the managed refusal when the installed policy allows no remote clients. */
export function assertInstalledPolicyAllowsRemoteClients(
  action: string,
  load?: typeof loadInstalledManagedPolicy,
): void {
  const limit = installedRemoteClientsLimit(load);
  if (limit)
    throw new Error(
      `${managedRemoteClientsDenial(limit)} Station cannot ${action}.`,
    );
}
