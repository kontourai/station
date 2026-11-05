import {
  clientVersionInHostOrder,
  compareStationReleaseVersions,
} from '@kontourai/station-shared/release-version-order';
import { useCallback, useEffect, useState } from 'react';
import { useDeviceSettings } from '../../contexts/DeviceSettingsContext';

const LAST_VERSION_KEY = 'station.release-notes.last-version';

export function usePostUpdateChangelog(version: string | null) {
  const { showReleaseNotesAfterUpdate } = useDeviceSettings();
  const [pendingVersion, setPendingVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!version) return;
    const current = clientVersionInHostOrder(version);
    if (!current) return;
    try {
      const previous = window.localStorage.getItem(LAST_VERSION_KEY);
      if (previous === version) return;
      // Record even when disabled, so re-enabling does not replay old upgrades.
      window.localStorage.setItem(LAST_VERSION_KEY, version);
      const prior = previous && clientVersionInHostOrder(previous);
      if (
        showReleaseNotesAfterUpdate &&
        prior &&
        compareStationReleaseVersions(current, prior) === 1
      ) {
        setPendingVersion(version);
      }
    } catch {
      // Without durable presentation memory, skip automatic interruption.
    }
  }, [version, showReleaseNotesAfterUpdate]);
  const dismiss = useCallback(() => setPendingVersion(null), []);
  return { pendingVersion, dismiss };
}
