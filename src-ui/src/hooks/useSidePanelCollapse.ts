import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_PREFIX = 'station-side-panel-collapsed:';

function storageKey(projectSlug: string, layoutSlug: string): string {
  return `${STORAGE_PREFIX}${projectSlug}:${layoutSlug}`;
}

function readStored(key: string): boolean | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    return raw === 'true';
  } catch {
    return null;
  }
}

/**
 * Collapse state for the coding layout side panel, persisted per
 * project+layout in localStorage (key `station-side-panel-collapsed:<project>:<layout>`).
 *
 * Default behaviour (only while the user has never toggled this panel):
 *   - collapsed when the project has NONE of the inspector tools configured,
 *     so non-Kontour projects are not nagged with an empty rail;
 *   - expanded when at least one tool is configured.
 *
 * Once the user explicitly toggles, their choice is sticky and the
 * configured-count default no longer overrides it. The `defaultCollapsed`
 * input can resolve asynchronously (it depends on config-detection queries),
 * so the hook re-applies the default until the first explicit toggle.
 */
export function useSidePanelCollapse(
  projectSlug: string,
  layoutSlug: string,
  defaultCollapsed: boolean,
) {
  const key = storageKey(projectSlug, layoutSlug);

  // Whether the user has an explicit, stored preference for this panel.
  const hasExplicit = useRef(readStored(key) !== null);

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    const stored = readStored(key);
    return stored !== null ? stored : defaultCollapsed;
  });

  // Re-apply the computed default until the user makes an explicit choice.
  // This lets the default flip once async config-detection resolves
  // (e.g. a project turns out to have a configured tool after the queries
  // settle), without clobbering a user toggle.
  useEffect(() => {
    if (hasExplicit.current) return;
    setCollapsed(defaultCollapsed);
  }, [defaultCollapsed]);

  const setExplicit = useCallback(
    (next: boolean) => {
      hasExplicit.current = true;
      setCollapsed(next);
      try {
        localStorage.setItem(key, String(next));
      } catch {
        /* ignore quota / private-mode failures */
      }
    },
    [key],
  );

  const toggle = useCallback(() => {
    setExplicit(!collapsed);
  }, [collapsed, setExplicit]);

  return { collapsed, setCollapsed: setExplicit, toggle } as const;
}
