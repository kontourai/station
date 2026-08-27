import { useEffect, useRef } from 'react';
import { useNavigation } from '../contexts/NavigationContext';
import { type DockMode, normalizeDockMode } from '../types';

const STORAGE_PREFIX = 'station-dock-mode-override:';

/**
 * Layouts call this to declare a preferred dock mode.
 *
 * Priority: URL param (explicit) > sessionStorage override (⌘⇧M / settings) > layout preferred.
 * Layout preferences apply silently — they do NOT write to the URL.
 * Only explicit user actions (⌘⇧M, settings panel) write to URL + sessionStorage.
 */
export function useDockModePreference(layoutKey: string, preferred: DockMode) {
  const { dockMode, setDockModeQuiet } = useNavigation();
  const prevMode = useRef<DockMode>(dockMode);
  const applied = useRef(false);

  useEffect(() => {
    if (applied.current) return;
    applied.current = true;
    prevMode.current = dockMode;

    // URL param already present → explicit user choice, respect it
    const urlMode = normalizeDockMode(
      new URLSearchParams(window.location.search).get('dockSlotPlacement'),
    );
    if (urlMode) return;

    // SessionStorage override → user previously cycled via ⌘⇧M / settings
    const override = normalizeDockMode(
      sessionStorage.getItem(STORAGE_PREFIX + layoutKey),
    );
    if (override) {
      setDockModeQuiet(override);
      return;
    }

    // Apply layout preference silently (no URL param)
    setDockModeQuiet(preferred);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutKey, preferred, setDockModeQuiet, dockMode]);

  // Restore previous mode on unmount
  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      setDockModeQuiet(prevMode.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setDockModeQuiet]);
}

/** Write a manual override for the current layout (called by ⌘⇧M handler). */
export function setDockModeOverride(layoutKey: string | null, mode: DockMode) {
  if (layoutKey) {
    sessionStorage.setItem(STORAGE_PREFIX + layoutKey, mode);
  }
}
