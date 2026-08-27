/**
 * useDevicePresentation — the `devicePresentation` projection from
 * `/api/system/status`, bound to the active connection's api base.
 *
 * Same shape as `useSystemStatus`: the SDK owns the derivation and the
 * query, this binds `apiBase` so both read the ONE in-flight status query
 * rather than two.
 *
 * `undefined` means the server has not answered yet (or is too old to serve
 * the projection). Consumers must make no device claim in that state — see
 * the SDK hook's docblock.
 */

import { useConnections } from '@kontourai/station-connect';
import type { DevicePresentation } from '@kontourai/station-contracts/system-status';
import { useDevicePresentation as useSdkDevicePresentation } from '@kontourai/station-sdk';

export function useDevicePresentation(): DevicePresentation | undefined {
  const { apiBase } = useConnections();
  return useSdkDevicePresentation(apiBase);
}
