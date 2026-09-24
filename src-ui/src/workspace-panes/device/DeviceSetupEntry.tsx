import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { mobileDeviceInventoryQueryKey } from '@kontourai/station-sdk/mobile-devices-query';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { LazyBoundary } from '../../components/LazyBoundary';

// The wizard and its styles load only when someone opens it.
const loadWizard = () => import('./DeviceSetupWizard');

/**
 * "Set up devices" (#1970): opens the setup wizard. Closing it re-reads the
 * device list, so a hub the wizard just started is picked up at once.
 */
export function DeviceSetupEntry({
  requestScope,
}: {
  requestScope: ApiRequestScope;
}) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}>
        Set up devices
      </Button>
      {open ? (
        <LazyBoundary
          load={loadWizard}
          pending={null}
          componentProps={{
            requestScope,
            onClose: () => {
              setOpen(false);
              void queryClient.invalidateQueries({
                queryKey: mobileDeviceInventoryQueryKey(requestScope),
              });
            },
          }}
        />
      ) : null}
    </>
  );
}
