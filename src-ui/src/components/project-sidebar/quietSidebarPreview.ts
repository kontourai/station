import { useFeaturePreviewsQuery } from '@kontourai/station-sdk';
import { useEffect } from 'react';

const QUIET_SIDEBAR_PREVIEW_ID = 'quiet-sidebar';

/** This device's last known answer, so the sidebar does not change shape. */
const LAST_KNOWN_KEY = 'station.quietSidebar.lastKnown';

function readLastKnown(): boolean {
  try {
    return window.localStorage.getItem(LAST_KNOWN_KEY) === 'on';
  } catch {
    return false;
  }
}

/**
 * Whether the sidebar draws the quiet sidebar (`quiet-sidebar` preview).
 *
 * While the previews read is pending, or failed with nothing cached, it
 * answers with the last value this device saw, so someone with the preview
 * on does not see the old sidebar first. With no remembered value it is off,
 * the fail-closed default every preview has. This goes with the old sidebar
 * when the quiet one is turned on for everyone.
 */
export function useQuietSidebarPreview(): boolean {
  const { data } = useFeaturePreviewsQuery();
  const known = data?.some(
    (preview) => preview.id === QUIET_SIDEBAR_PREVIEW_ID && preview.enabled,
  );
  useEffect(() => {
    if (known === undefined) return;
    try {
      window.localStorage.setItem(LAST_KNOWN_KEY, known ? 'on' : 'off');
    } catch {
      // Storage refused: the next load waits for the read, as before.
    }
  }, [known]);
  return known ?? readLastKnown();
}
