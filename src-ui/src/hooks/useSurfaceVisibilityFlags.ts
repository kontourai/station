import { useFeaturePreviewsQuery } from '@kontourai/station-sdk';
import { useMemo } from 'react';
import { DEVELOPER_TOOLS_FLAG } from '../app-shell/destination-registry';
import { useDeviceSettings } from '../contexts/DeviceSettingsContext';

/**
 * The enabled-flags set that `DestinationRegistry.getSidebar`/`getPalette` filter
 * `previewFlag`-gated destinations against (archive#3313).
 *
 * Two sources compose into one set:
 * - enabled server feature previews (their ids, from /api/feature-previews) —
 *   this is the pass-through `ProjectSidebarNav` used to omit, which made any
 *   `previewFlag`-gated surface unable to ever appear in the sidebar;
 * - the device setting `developerToolsEnabled`, contributed as
 *   `DEVELOPER_TOOLS_FLAG` for the Developer surfaces.
 *
 * Fail-closed by construction: while the previews query is loading or failed,
 * preview-gated surfaces stay hidden (exactly the pre-existing default-flags
 * behavior), and un-gated surfaces are never affected.
 */
export function useSurfaceVisibilityFlags(): ReadonlySet<string> {
  const previews = useFeaturePreviewsQuery();
  const { developerToolsEnabled } = useDeviceSettings();
  const previewsData = previews.data;
  return useMemo(() => {
    const flags = new Set<string>();
    for (const preview of previewsData ?? []) {
      if (preview.enabled) flags.add(preview.id);
    }
    if (developerToolsEnabled) flags.add(DEVELOPER_TOOLS_FLAG);
    return flags;
  }, [previewsData, developerToolsEnabled]);
}
