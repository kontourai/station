import { isIP } from 'node:net';
import {
  type ManagedPolicySummary,
  managedPolicyAllowsRemoteClients,
  managedRemoteClientsDenial,
} from '@kontourai/station-contracts/managed-policy';
import { loadInstalledManagedPolicy } from '@kontourai/station-shared/managed-policy';
import { isLoopbackHost } from './dev-watch.js';

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

/**
 * #4519 round 1: `station start` gives its server child its own host as
 * STATION_HOST, so an inherited STATION_HOST is otherwise dropped without a
 * word. Under the limit one that is not loopback (`localhost`, which the
 * server binds as 127.0.0.1, or a loopback address) is refused with the
 * managed sentence, as the server refuses it.
 */
export function assertManagedInheritedStationHost(
  limit: ManagedPolicySummary | null,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const host = env.STATION_HOST?.trim();
  if (!limit || !host || host.toLowerCase() === 'localhost') return;
  if (isIP(host) !== 0 && isLoopbackHost(host)) return;
  throw new Error(
    `${managedRemoteClientsDenial(limit)} Station listens only on this computer; STATION_HOST=${host.slice(0, 100)} is not supported. Unset STATION_HOST or set it to 127.0.0.1.`,
  );
}
