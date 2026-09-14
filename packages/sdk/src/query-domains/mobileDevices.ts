import type {
  MobileDeviceCapture,
  MobileDeviceInventory,
  MobileDeviceTarget,
} from '@kontourai/station-contracts/mobile-device';
import {
  captureMobileDevice,
  fetchMobileDeviceInventory,
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
export const mobileDeviceInventoryQueryKey = (scope: ApiRequestScope) => [
  'mobile-device-inventory',
  scope.apiBase,
  scope.authorityKey,
];

export function useMobileDeviceInventoryQuery(
  scope: ApiRequestScope,
  config?: QueryConfig<MobileDeviceInventory>,
) {
  return useApiQuery<MobileDeviceInventory>(
    mobileDeviceInventoryQueryKey(scope),
    (signal) =>
      fetchMobileDeviceInventory(scope.apiBase, {
        ...(signal ? { signal } : {}),
        requestScope: scope,
      }),
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
 * for write-only secrets would buy nothing here.
 */
export function useCaptureMobileDeviceMutation(scope: ApiRequestScope) {
  return useApiMutation<MobileDeviceCapture, MobileDeviceTarget>((target) =>
    captureMobileDevice(scope.apiBase, target, { requestScope: scope }),
  );
}
