/**
 * What the full-access refusal may say about this Station and the device
 * that asked, read from the pairing service's own records (a display name,
 * never a credential), whichever route refuses it.
 */

import { STATION_GROUP_CEILINGS } from '@kontourai/station-contracts/station-groups';
import { operatorCliCommand } from '@kontourai/station-shared/ports';
import type { FullAccessRefusalIdentitySource } from '../../security/full-access-refusal.js';
import { principalForDeviceBinding } from '../../services/access/device-binding-principal.js';
import type { EnvironmentSecurityService } from '../../services/ssh/environment-security-service.js';

export function createFullAccessRefusalIdentity(
  security: Pick<EnvironmentSecurityService, 'devicePairing' | 'groupOf'>,
  channel: () => string | undefined,
): FullAccessRefusalIdentitySource {
  const deviceById = (deviceId: string) =>
    security.devicePairing
      .listDevices()
      .find((device) => device.id === deviceId);
  return {
    environmentId: () => security.devicePairing.environmentId(),
    deviceName: (deviceId) => deviceById(deviceId)?.name,
    hostCli: () => operatorCliCommand(channel()),
    // #3557: whether the person this device is tied to sits in a group that
    // does not allow full access (then granting the device cannot help).
    groupLimit: (deviceId) => {
      const device = deviceById(deviceId);
      if (!device?.principalBinding || device.kind === 'delegation')
        return undefined;
      const group = security.groupOf(
        principalForDeviceBinding(device.principalBinding).id,
      );
      if (STATION_GROUP_CEILINGS[group].includes('approval:full-access'))
        return undefined;
      return {
        hasGrant: device.scope.split(' ').includes('approval:full-access'),
      };
    },
  };
}
