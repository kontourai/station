import { useFeaturePreviewsQuery } from '@kontourai/station-sdk';
import { useEffect } from 'react';

const QUIET_SIDEBAR_PREVIEW_ID = 'quiet-sidebar';

/**
 * This device's last known answer for one Station, keyed by the Station's
 * durable namespace, so one Station's answer is never shown for another.
 */
function lastKnownKey(namespace: string | null): string | null {
  return namespace ? `station.quietSidebar.lastKnown:${namespace}` : null;
}

function readLastKnown(key: string | null): boolean {
  if (!key) return false;
  try {
    return window.localStorage.getItem(key) === 'on';
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
 * the fail-closed default every preview has, and so is a Station whose
 * durable namespace is not verified yet. This goes with the old sidebar
 * when the quiet one is turned on for everyone.
 */
export function useQuietSidebarPreview(namespace: string | null): boolean {
  const key = lastKnownKey(namespace);
  const { data } = useFeaturePreviewsQuery();
  const known = data?.some(
    (preview) => preview.id === QUIET_SIDEBAR_PREVIEW_ID && preview.enabled,
  );
  useEffect(() => {
    if (known === undefined || !key) return;
    try {
      window.localStorage.setItem(key, known ? 'on' : 'off');
    } catch {
      // Storage refused: the next load waits for the read, as before.
    }
  }, [known, key]);
  return known ?? readLastKnown(key);
}
