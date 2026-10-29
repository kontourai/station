import {
  DEFAULT_LAYOUT_PANELS_RECORD,
  type LayoutSessionPanels,
} from '@kontourai/station-contracts/device-settings';
import { useCallback, useMemo } from 'react';
import { useDeviceSettings } from '../contexts/DeviceSettingsContext';
import { deviceSettingsStore } from '../lib/device-settings-store';
import {
  CLOSED_LAYOUT_SESSION_PANELS,
  parseLayoutPanelsRecord,
  readLayoutSessionPanels,
  writeLayoutSessionPanels,
} from '../lib/layout-panels-record';

export function useLayoutSessionPanels(layoutKey: string, sessionKey: string) {
  const stored = useDeviceSettings().layoutPanels;
  const record = useMemo(
    () => parseLayoutPanelsRecord(stored) ?? DEFAULT_LAYOUT_PANELS_RECORD,
    [stored],
  );
  const panels = sessionKey
    ? readLayoutSessionPanels(record, layoutKey, sessionKey)
    : CLOSED_LAYOUT_SESSION_PANELS;
  const update = useCallback(
    (patch: Partial<Omit<LayoutSessionPanels, 'at'>>) => {
      if (!sessionKey) return;
      deviceSettingsStore.update('layoutPanels', (stored) => {
        const current =
          parseLayoutPanelsRecord(stored) ?? DEFAULT_LAYOUT_PANELS_RECORD;
        return writeLayoutSessionPanels(
          current,
          layoutKey,
          sessionKey,
          patch,
          Date.now(),
        );
      });
    },
    [layoutKey, sessionKey],
  );
  return { panels, update };
}
