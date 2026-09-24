import type { MobileDeviceSummary } from '@kontourai/station-contracts/mobile-device';
import type { ApiRequestScope } from '@kontourai/station-sdk/client';
import { useMobileDeviceInventoryQuery } from '@kontourai/station-sdk/mobile-devices-query';
import { useId, useState } from 'react';
import { Button } from '../../components/Button';
import { SkeletonBlock } from '../../components/state';
import {
  useDeviceShareAction,
  useDeviceShares,
  useRunningAvds,
} from './deviceToolchainApi';

const EMULATOR_SERIAL = /^emulator-[0-9]+$/;

/**
 * Which Projects each device is shared with (D12), for the operator.
 * Admins and owners of a Project can view and drive only the devices shared
 * with it; everything else stays the operator's.
 */
export function DeviceShares({
  requestScope,
  hostId = 'local',
}: {
  requestScope: ApiRequestScope;
  /** Which device host's devices (#1973); shares are per host. */
  hostId?: string;
}) {
  const inventory = useMobileDeviceInventoryQuery(
    requestScope,
    undefined,
    null,
    hostId,
  );
  const shares = useDeviceShares(requestScope, true);
  const serials = (inventory.data?.devices ?? [])
    .filter(
      (device) =>
        device.platform === 'android' && EMULATOR_SERIAL.test(device.deviceId),
    )
    .map((device) => device.deviceId);
  const avds = useRunningAvds(requestScope, serials, hostId);
  if (
    inventory.isPending ||
    shares.isPending ||
    (serials.length > 0 && avds.isPending)
  )
    return <SkeletonBlock count={2} label="Reading devices and shares" />;
  if (inventory.isError || shares.isError || !inventory.data || !shares.data)
    return <p role="alert">The devices or their shares could not be read.</p>;
  const devices = inventory.data.devices;
  if (devices.length === 0)
    return (
      <p className="device-setup__muted">
        Once the device hub lists simulators or emulators, you can share each
        one with a Project here.
      </p>
    );
  return (
    <ul className="device-setup__platforms" aria-label="Device sharing">
      {devices.map((device) => (
        <DeviceShareRow
          key={`${device.platform}:${device.deviceId}`}
          device={device}
          shareKey={
            device.platform === 'android' &&
            EMULATOR_SERIAL.test(device.deviceId)
              ? (avds.data?.[device.deviceId] ?? undefined)
              : device.deviceId
          }
          entries={shares.data}
          hostId={hostId}
          requestScope={requestScope}
        />
      ))}
    </ul>
  );
}

function DeviceShareRow({
  device,
  shareKey,
  entries,
  hostId,
  requestScope,
}: {
  device: MobileDeviceSummary;
  hostId: string;
  /** The id shares use: the UDID, or the AVD running on an emulator serial. */
  shareKey: string | undefined;
  entries: ReturnType<typeof useDeviceShares>['data'] & object;
  requestScope: ApiRequestScope;
}) {
  const action = useDeviceShareAction(requestScope);
  const [choosing, setChoosing] = useState(false);
  const selectId = useId();
  const sharedWith = entries.filter((entry) =>
    entry.shares.some(
      (share) =>
        (share.hostId ?? 'local') === hostId &&
        share.platform === device.platform &&
        share.deviceId === shareKey,
    ),
  );
  const available = entries.filter((entry) => !sharedWith.includes(entry));
  const [project, setProject] = useState('');
  return (
    <li className="device-setup__platform">
      <strong>{device.name}</strong>
      <span className="device-setup__muted">
        {sharedWith.length === 0
          ? 'Not shared with any Project.'
          : `Shared with ${sharedWith.map((entry) => entry.projectSlug).join(', ')}.`}
      </span>
      <div className="device-setup__status">
        {sharedWith.map((entry) => (
          <Button
            key={entry.projectId}
            size="sm"
            pending={action.isPending}
            onClick={() =>
              action.mutate({
                kind: 'unshare',
                hostId,
                projectSlug: entry.projectSlug,
                platform: device.platform,
                deviceId: shareKey ?? device.deviceId,
              })
            }
          >
            Stop sharing with {entry.projectSlug}
          </Button>
        ))}
        {choosing ? (
          <>
            <label htmlFor={selectId}>Project</label>
            <select
              id={selectId}
              value={project}
              onChange={(event) => setProject(event.target.value)}
            >
              <option value="">Choose a Project</option>
              {available.map((entry) => (
                <option key={entry.projectId} value={entry.projectSlug}>
                  {entry.projectSlug}
                </option>
              ))}
            </select>
            <Button
              size="sm"
              variant="primary"
              disabled={project === ''}
              pending={action.isPending}
              onClick={() => {
                action.mutate({
                  kind: 'share',
                  hostId,
                  projectSlug: project,
                  platform: device.platform,
                  deviceId: device.deviceId,
                  label: device.name,
                });
                setChoosing(false);
                setProject('');
              }}
            >
              Share
            </Button>
          </>
        ) : available.length > 0 ? (
          <Button size="sm" onClick={() => setChoosing(true)}>
            Share with Project…
          </Button>
        ) : null}
      </div>
      {action.isError ? (
        <p role="alert">That sharing change did not go through.</p>
      ) : null}
    </li>
  );
}
