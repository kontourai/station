import type { DeviceHubEndpoint } from './device-hub-endpoint.js';

/**
 * Which device host serves a device (#1970, D13).
 *
 * Every device carries a `hostId`: `local` — the Station's own machine,
 * reached through the explicitly configured hub or the supervised one — or
 * an operator-managed SSH device host (#1973), reached through its hub on
 * the host's loopback and an ssh port forward
 * (`hosts/device-host-registry.ts`). A future capability host (device
 * compute on another of the user's Stations) is one more resolver entry.
 * There is no peer transport here.
 *
 * The resolver is the ONLY way to a hub: the runtime composition builds one
 * and hands out what it resolves; nothing else constructs a hub endpoint
 * (pinned by `device-host-resolver.test.ts`).
 */
export const LOCAL_DEVICE_HOST_ID = 'local';

export interface DeviceHostResolver {
  /** The hub endpoint for `hostId`, or null for a host this Station lacks. */
  resolve(target: { hostId: string }): DeviceHubEndpoint | null;
}

/** The SSH device hosts, as the resolver asks them. */
export interface RemoteDeviceHosts {
  /** Whether the id names a stored SSH device host. */
  has(hostId: string): boolean;
  endpoint(hostId: string): DeviceHubEndpoint;
}

/**
 * `local`, then any SSH device host the registry has; null for anything
 * else (a malformed or removed id is never "the local host").
 */
export function createDeviceHostResolver(input: {
  local: DeviceHubEndpoint;
  remote?: RemoteDeviceHosts;
}): DeviceHostResolver {
  return {
    resolve: ({ hostId }) => {
      if (hostId === LOCAL_DEVICE_HOST_ID) return input.local;
      if (!/^ssh-[0-9a-f]{12}$/.test(hostId)) return null;
      return input.remote?.has(hostId) ? input.remote.endpoint(hostId) : null;
    },
  };
}

export function createLocalDeviceHostResolver(
  local: DeviceHubEndpoint,
): DeviceHostResolver {
  return {
    resolve: ({ hostId }) => (hostId === LOCAL_DEVICE_HOST_ID ? local : null),
  };
}
