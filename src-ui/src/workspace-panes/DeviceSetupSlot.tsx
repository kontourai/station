import type { MobileDeviceHostFailure } from '@kontourai/station-contracts/mobile-device';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { mobileDeviceInventoryQueryKey } from '@kontourai/station-sdk/mobile-devices-query';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Empty, SkeletonBlock } from '../components/state';
import { DeviceSetupEntry } from './device/DeviceSetupEntry';
import { useDeviceToolchainStatus } from './device/deviceToolchainApi';
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
  // Setup just finished: the operator enabled the managed helper and it is
  // starting (or already up), but the device list was read before it
  // answered. Say so, and read the list again each second until it does,
  // instead of offering setup again.
  const toolchain = useDeviceToolchainStatus(requestScope);
  const process = toolchain.data?.hubProcess.state;
  const helperComing =
    toolchain.data?.hubEnabled === true &&
    (process === 'starting' || process === 'running');
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!helperComing) return;
    const timer = setInterval(() => {
      void queryClient.invalidateQueries({
        queryKey: mobileDeviceInventoryQueryKey(requestScope),
      });
    }, 1_000);
    return () => clearInterval(timer);
  }, [helperComing, queryClient, requestScope]);
  if (helperComing)
    return (
      <div className="device-pane__setup" data-slot="device-setup">
        <SkeletonBlock count={2} label="Starting the device helper" />
      </div>
    );
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
