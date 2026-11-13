import {
  clientVersionInHostOrder,
  compareStationReleaseVersions,
} from '@kontourai/station-shared/release-version-order';
import { useCallback, useEffect, useState } from 'react';
import { useDeviceSettings } from '../../contexts/DeviceSettingsContext';

const LAST_VERSION_KEY = 'station.release-notes.last-version';

export function usePostUpdateChangelog(
  version: string | null,
  serverKey?: string,
) {
  const { showReleaseNotesAfterUpdate } = useDeviceSettings();
  const storageKey = serverKey
    ? `${LAST_VERSION_KEY}.server:${serverKey}`
    : LAST_VERSION_KEY;
  const [pending, setPending] = useState<{
    key: string;
    version: string;
  } | null>(null);
  useEffect(() => {
    if (!version) return;
    const current = clientVersionInHostOrder(version);
    if (!current) return;
    try {
      const previous = window.localStorage.getItem(storageKey);
      if (previous === version) return;
      // Record even when disabled, so re-enabling does not replay old upgrades.
      window.localStorage.setItem(storageKey, version);
      const prior = previous && clientVersionInHostOrder(previous);
      if (
        showReleaseNotesAfterUpdate &&
        prior &&
        compareStationReleaseVersions(current, prior) === 1
      ) {
        setPending({ key: storageKey, version });
      }
    } catch {
      // Without durable presentation memory, skip automatic interruption.
    }
  }, [version, storageKey, showReleaseNotesAfterUpdate]);
  const dismiss = useCallback(() => setPending(null), []);
  return {
    pendingVersion:
      version && pending?.key === storageKey && pending.version === version
        ? pending.version
        : null,
    dismiss,
  };
}
