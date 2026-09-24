import type {
  DeviceHostCheckResult,
  DeviceHostSummary,
  DeviceSshHostView,
  MobileDeviceCapture,
  MobileDeviceInventory,
  MobileDeviceSession,
  MobileDeviceTarget,
} from '@kontourai/station-contracts/mobile-device';
import {
  addDeviceSshHost,
  captureMobileDevice,
  checkDeviceSshHost,
  closeMobileDeviceSession,
  fetchDeviceSshHosts,
  fetchMobileDeviceHosts,
  fetchMobileDeviceInventory,
  fetchMobileDeviceSessions,
  openMobileDeviceSession,
  powerOffMobileDevice,
  removeDeviceSshHost,
  setDeviceSshHub,
  startDeviceSshHub,
  startMobileDevice,
  updateDeviceSshHost,
} from '../mobile-device';
import {
  type ApiRequestScope,
  type QueryConfig,
  useApiMutation,
  useApiQuery,
} from '../query-core';

/**
 * React Query bindings for the mobile-device inspection client (#1969).
 *
 * On a SUBPATH, never the SDK barrel: `mobile-device.ts` is already
 * subpath-only, and re-exporting either from `index.ts` would pull the
 * client into every barrel consumer's chunk.
 *
 * The key is partitioned by the caller's `ApiRequestScope` — `apiBase` AND
 * `authorityKey` — because that scope "partitions query caches and must agree
 * with the credential resolver". One Station's device list must not be served
 * from another's cache, and re-signing in under a different principal must not
 * either.
 */
/**
 * A device host other than `local` (#1973) partitions every device key, so
 * one host's list is never served for another. `local` keeps the keys it
 * always had.
 */
const hostPart = (hostId?: string | null) =>
  hostId && hostId !== 'local' ? [`host:${hostId}`] : [];

export const mobileDeviceInventoryQueryKey = (
  scope: ApiRequestScope,
  projectSlug?: string | null,
  hostId?: string | null,
) => [
  ...(projectSlug
    ? [
        'mobile-device-inventory',
        scope.apiBase,
        scope.authorityKey,
        projectSlug,
      ]
    : ['mobile-device-inventory', scope.apiBase, scope.authorityKey]),
  ...hostPart(hostId),
];

export function useMobileDeviceInventoryQuery(
  scope: ApiRequestScope,
  config?: QueryConfig<MobileDeviceInventory>,
  /** D12: the Project the device list is read for (shares are per Project). */
  projectSlug?: string | null,
  /** #1973: the device host; `local` when absent. */
  hostId: string = 'local',
) {
  return useApiQuery<MobileDeviceInventory>(
    mobileDeviceInventoryQueryKey(scope, projectSlug, hostId),
    (signal) =>
      fetchMobileDeviceInventory(
        scope.apiBase,
        { ...(signal ? { signal } : {}), requestScope: scope },
        projectSlug,
        hostId,
      ),
    {
      // Explicit refresh only. A poll would be a stream affordance this
      // slice does not have, and each tick is a real request to a device
      // host that has to enumerate simulators to answer it.
      staleTime: 15_000,
      // One retry, not React Query's default three. The default's backoff is
      // 1s + 2s + 4s, so a helper that is simply not running would hold a
      // reader on a skeleton for seven seconds before saying anything — and
      // this surface has an explicit Refresh, so a person can ask again the
      // moment they have been told.
      retry: 1,
      retryDelay: 250,
      ...config,
    },
  );
}

/**
 * One capture, as a mutation.
 *
 * Deliberately WITHOUT `invalidateKeys`: a capture changes no server state
 * (the SDK client marks the POST `readOnly`), and broadcasting a data-change
 * invalidation would make the inventory query refetch itself on every press.
 *
 * Deliberately without `evictSettledVariables` too: the variables are a
 * descriptive `MobileDeviceTarget` — a host id, a platform and a device id —
 * with no credential in them, so the zero-retention escape hatch that exists
 * for write-only secrets would buy nothing here. The TYPE does not bound what
 * is retained on its own, because a caller may hand over a structurally wider
 * row and the cache keeps whatever it was given; the pane therefore builds
 * the three fields explicitly rather than passing its `MobileDeviceSummary`.
 */
export function useCaptureMobileDeviceMutation(scope: ApiRequestScope) {
  return useApiMutation<MobileDeviceCapture, MobileDeviceTarget>((target) =>
    captureMobileDevice(scope.apiBase, target, { requestScope: scope }),
  );
}

// ---- live device sessions (#1970) -------------------------------------------
//
// Every call takes the Project the pane is in (D12): device shares are per
// Project, so a Project admin's request must name it. It partitions the
// session list's cache too, like the inventory's.

export const mobileDeviceSessionsQueryKey = (
  scope: ApiRequestScope,
  projectSlug?: string | null,
  hostId?: string | null,
) => [
  ...(projectSlug
    ? ['mobile-device-sessions', scope.apiBase, scope.authorityKey, projectSlug]
    : ['mobile-device-sessions', scope.apiBase, scope.authorityKey]),
  ...hostPart(hostId),
];

/** Open sessions (D6: none is hidden). Refreshed after every session change. */
export function useMobileDeviceSessionsQuery(
  scope: ApiRequestScope,
  projectSlug?: string | null,
  config?: QueryConfig<MobileDeviceSession[]>,
  hostId: string = 'local',
) {
  return useApiQuery<MobileDeviceSession[]>(
    mobileDeviceSessionsQueryKey(scope, projectSlug, hostId),
    (signal) =>
      fetchMobileDeviceSessions(
        scope.apiBase,
        { ...(signal ? { signal } : {}), requestScope: scope },
        projectSlug,
        hostId,
      ),
    { staleTime: 5_000, retry: 1, retryDelay: 250, ...config },
  );
}

const sessionKeys = (
  scope: ApiRequestScope,
  projectSlug?: string | null,
  hostId?: string | null,
) => [
  mobileDeviceInventoryQueryKey(scope, projectSlug, hostId),
  mobileDeviceSessionsQueryKey(scope, projectSlug, hostId),
];

/** Boot a stopped device; the list is re-read afterwards. */
export function useStartMobileDeviceMutation(
  scope: ApiRequestScope,
  projectSlug?: string | null,
  hostId: string = 'local',
) {
  return useApiMutation<
    { deviceId: string; state: 'running' | 'starting' },
    MobileDeviceTarget
  >(
    (target) =>
      startMobileDevice(
        scope.apiBase,
        target,
        { requestScope: scope },
        projectSlug,
      ),
    { invalidateKeys: sessionKeys(scope, projectSlug, hostId) },
  );
}

export function useOpenMobileDeviceSessionMutation(
  scope: ApiRequestScope,
  projectSlug?: string | null,
  hostId: string = 'local',
) {
  return useApiMutation<MobileDeviceSession, MobileDeviceTarget>(
    (target) =>
      openMobileDeviceSession(
        scope.apiBase,
        target,
        { requestScope: scope },
        projectSlug,
      ),
    {
      invalidateKeys: [
        mobileDeviceSessionsQueryKey(scope, projectSlug, hostId),
      ],
    },
  );
}

export function useCloseMobileDeviceSessionMutation(
  scope: ApiRequestScope,
  projectSlug?: string | null,
  hostId: string = 'local',
) {
  return useApiMutation<void, string>(
    (sessionId) =>
      closeMobileDeviceSession(
        scope.apiBase,
        sessionId,
        { requestScope: scope },
        projectSlug,
        hostId,
      ),
    {
      invalidateKeys: [
        mobileDeviceSessionsQueryKey(scope, projectSlug, hostId),
      ],
    },
  );
}

export function usePowerOffMobileDeviceMutation(
  scope: ApiRequestScope,
  projectSlug?: string | null,
  hostId: string = 'local',
) {
  return useApiMutation<void, MobileDeviceTarget>(
    (target) =>
      powerOffMobileDevice(
        scope.apiBase,
        target,
        { requestScope: scope },
        projectSlug,
      ),
    { invalidateKeys: sessionKeys(scope, projectSlug, hostId) },
  );
}

// ---- device hosts (#1973) ---------------------------------------------------

export const mobileDeviceHostsQueryKey = (
  scope: ApiRequestScope,
  projectSlug?: string | null,
) =>
  projectSlug
    ? ['mobile-device-hosts', scope.apiBase, scope.authorityKey, projectSlug]
    : ['mobile-device-hosts', scope.apiBase, scope.authorityKey];

/** The Device pane's host picker: `local`, then each SSH device host. */
export function useMobileDeviceHostsQuery(
  scope: ApiRequestScope,
  projectSlug?: string | null,
  config?: QueryConfig<DeviceHostSummary[]>,
) {
  return useApiQuery<DeviceHostSummary[]>(
    mobileDeviceHostsQueryKey(scope, projectSlug),
    (signal) =>
      fetchMobileDeviceHosts(
        scope.apiBase,
        { ...(signal ? { signal } : {}), requestScope: scope },
        projectSlug,
      ),
    { staleTime: 30_000, retry: 1, retryDelay: 250, ...config },
  );
}

export const deviceSshHostsQueryKey = (scope: ApiRequestScope) => [
  'device-ssh-hosts',
  scope.apiBase,
  scope.authorityKey,
];

/** The operator's SSH device hosts (Settings → Device hosts). */
export function useDeviceSshHostsQuery(
  scope: ApiRequestScope,
  config?: QueryConfig<DeviceSshHostView[]>,
) {
  return useApiQuery<DeviceSshHostView[]>(
    deviceSshHostsQueryKey(scope),
    (signal) =>
      fetchDeviceSshHosts(scope.apiBase, {
        ...(signal ? { signal } : {}),
        requestScope: scope,
      }),
    { staleTime: 5_000, retry: false, ...config },
  );
}

const hostKeys = (scope: ApiRequestScope) => [
  deviceSshHostsQueryKey(scope),
  ['mobile-device-hosts', scope.apiBase, scope.authorityKey],
];

export function useAddDeviceSshHostMutation(scope: ApiRequestScope) {
  return useApiMutation<
    DeviceSshHostView,
    { label: string; sshTarget: string }
  >(
    (input) => addDeviceSshHost(scope.apiBase, input, { requestScope: scope }),
    { invalidateKeys: hostKeys(scope) },
  );
}

export function useUpdateDeviceSshHostMutation(scope: ApiRequestScope) {
  return useApiMutation<
    DeviceSshHostView,
    { hostId: string; label?: string; sshTarget?: string }
  >(
    ({ hostId, ...input }) =>
      updateDeviceSshHost(scope.apiBase, hostId, input, {
        requestScope: scope,
      }),
    { invalidateKeys: hostKeys(scope) },
  );
}

export function useRemoveDeviceSshHostMutation(scope: ApiRequestScope) {
  return useApiMutation<void, string>(
    (hostId) =>
      removeDeviceSshHost(scope.apiBase, hostId, { requestScope: scope }),
    { invalidateKeys: hostKeys(scope) },
  );
}

/** "Test connection" changes nothing on the server: no invalidation. */
export function useCheckDeviceSshHostMutation(scope: ApiRequestScope) {
  return useApiMutation<DeviceHostCheckResult, string>((hostId) =>
    checkDeviceSshHost(scope.apiBase, hostId, { requestScope: scope }),
  );
}

export function useSetDeviceSshHubMutation(scope: ApiRequestScope) {
  return useApiMutation<
    DeviceSshHostView,
    | { hostId: string; enabled: true; consent: true }
    | { hostId: string; enabled: false }
  >(
    (variables) =>
      setDeviceSshHub(
        scope.apiBase,
        variables.hostId,
        variables.enabled
          ? { enabled: true, consent: variables.consent }
          : { enabled: false },
        { requestScope: scope },
      ),
    { invalidateKeys: hostKeys(scope) },
  );
}

export function useStartDeviceSshHubMutation(scope: ApiRequestScope) {
  return useApiMutation<DeviceSshHostView, string>(
    (hostId) =>
      startDeviceSshHub(scope.apiBase, hostId, { requestScope: scope }),
    { invalidateKeys: hostKeys(scope) },
  );
}
