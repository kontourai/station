import { useCallback } from 'react';
import { useDeviceSettings } from '../contexts/DeviceSettingsContext';
import { useRegionModelOptional } from '../contexts/RegionModelContext';
import { DOCK_REGION_IDS } from '../regions/region-model';

const TERMINAL_SURFACE = 'coding:terminal';

/**
 * Whether a shown dock region holds this Project's Terminal, and the move
 * back. The Terminal is one surface (`coding:terminal` is one per region
 * set), so the Coding layout's lower panel yields to it rather than drawing a
 * second view of the same shells at another width; taking it back leaves the
 * dock region the way a placement leaves the region it moves out of.
 *
 * The dock binds its coding panes to `chatDockProjectSlug`, else the route's
 * Project (`useDockProject`), and on this route that is `projectSlug`.
 */
export function useDockedCodingTerminal(projectSlug: string): {
  docked: boolean;
  undock: () => void;
} {
  const model = useRegionModelOptional();
  const { chatDockProjectSlug } = useDeviceSettings();
  const docked =
    model !== null &&
    (chatDockProjectSlug ?? projectSlug) === projectSlug &&
    DOCK_REGION_IDS.some(
      (id) =>
        model.regions[id].visible &&
        model.regions[id].panes.includes(TERMINAL_SURFACE),
    );
  const undock = useCallback(() => {
    if (!model) return;
    for (const id of DOCK_REGION_IDS) {
      if (!model.readRegions()[id].panes.includes(TERMINAL_SURFACE)) continue;
      model.removePane(id, TERMINAL_SURFACE);
      if (model.readRegions()[id].panes.length === 0)
        model.setRegion(id, { visible: false });
    }
  }, [model]);
  return { docked, undock };
}
