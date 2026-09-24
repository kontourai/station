import type { MobileDeviceHostFailure } from '@kontourai/station-contracts/mobile-device';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { Empty } from '../components/state';
import { DeviceSetupEntry } from './device/DeviceSetupEntry';
import { DEVICE_HOST_FAILURE_COPY } from './deviceOutcome';

/**
 * Where the Device pane asks for setup when no device hub is running
 * (#1970): the toolchain lane's "Set up devices" wizard (consent install,
 * supervised hub, agent access) opens from here. A setup state, not a
 * failure, so there is no retry — closing the wizard re-reads the device
 * list instead.
 */
export function DeviceSetupSlot({
  failure,
  requestScope,
}: {
  failure: Extract<MobileDeviceHostFailure, 'not-configured'>;
  requestScope: ApiRequestScope;
}) {
  const copy = DEVICE_HOST_FAILURE_COPY[failure];
  return (
    <div className="device-pane__setup" data-slot="device-setup">
      <Empty
        variant="prominent"
        label={copy.title}
        description={copy.description}
        action={<DeviceSetupEntry requestScope={requestScope} />}
      />
    </div>
  );
}
