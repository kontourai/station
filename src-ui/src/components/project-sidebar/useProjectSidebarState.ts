import { useEffect, useRef, useState } from 'react';
import {
  useDeviceSettings,
  useDeviceSettingsActions,
} from '../../contexts/DeviceSettingsContext';
import { useIsMobile } from '../../hooks/useIsMobile';

// Re-exported from the shared hook so existing importers of this module's
// `useIsMobile` keep working (the inline copy was unified into the shared hook).
export { useIsMobile };

export function useProjectSidebarState() {
  const isMobile = useIsMobile();
  // Persisted via the device-settings store (archive#settings-revamp slice
  // 2 — previously its own raw `station-sidebar-collapsed` localStorage
  // key). Defaults to expanded so the labels are visible on first run — an
  // unlabeled icon-only rail is hard to navigate.
  const { projectSidebarCollapsed: collapsed } = useDeviceSettings();
  const { setDeviceSetting } = useDeviceSettingsActions();
  const [mobileOpen, setMobileOpen] = useState(false);
  const mobileTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const handler = (event: Event) => {
      const eventTrigger =
        event instanceof CustomEvent &&
        event.detail?.trigger instanceof HTMLElement
          ? event.detail.trigger
          : null;
      const activeTrigger =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      mobileTriggerRef.current = eventTrigger ?? activeTrigger;
      setMobileOpen((prev) => !prev);
    };
    window.addEventListener('toggle-sidebar', handler);
    return () => window.removeEventListener('toggle-sidebar', handler);
  }, []);

  const effectiveCollapsed = isMobile ? !mobileOpen : collapsed;

  const toggleCollapse = () => {
    setDeviceSetting('projectSidebarCollapsed', !collapsed);
  };

  return {
    collapsed,
    effectiveCollapsed,
    isMobile,
    mobileOpen,
    mobileTriggerRef,
    setMobileOpen,
    toggleCollapse,
  };
}
