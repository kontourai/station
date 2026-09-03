import type { LayoutDefinition } from '@kontourai/station-contracts/layout';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react';
import { _setLayoutContext } from './api';

/**
 * SDK Context - Provides access to all core app contexts and hooks
 *
 * The core app injects its contexts here, making them available to plugins
 * through the SDK hooks.
 */

export interface SDKContextValue {
  apiBase: string;

  // Core contexts (injected by core app)
  contexts: {
    agents?: any;
    layouts?: any;
    conversations?: any;
    activeChats?: any;
    models?: any;
    config?: any;
    navigation?: any;
    toast?: any;
    stats?: any;
    auth?: any;
    keyboardShortcuts?: any;
    workflows?: any;
  };

  // Custom hooks (injected by core app)
  hooks: {
    slashCommandHandler?: () => any;
    slashCommands?: () => any;
    toolApproval?: () => any;
    keyboardShortcut?: (
      key: string,
      callback: () => void,
      deps?: any[],
    ) => void;
  };
}

export const SDKContext = createContext<SDKContextValue | null>(null);

interface SDKProviderProps {
  value: SDKContextValue;
  children: ReactNode;
}

/**
 * SDKProvider - Wraps plugins with SDK context
 *
 * The core app uses this to inject contexts into plugins.
 */
export function SDKProvider({ value, children }: SDKProviderProps) {
  return <SDKContext.Provider value={value}>{children}</SDKContext.Provider>;
}

/**
 * LayoutProvider - Convenience wrapper for layout plugins
 *
 * Provides common layout props and SDK context.
 */
interface LayoutProviderProps {
  sdk: SDKContextValue;
  layout?: LayoutDefinition;
  project?: { slug: string; name: string; [key: string]: any };
  activeLayout?: { slug: string; type: string; [key: string]: any };
  children: ReactNode;
}

export function LayoutProvider({
  sdk,
  layout,
  project: _project,
  activeLayout: _activeLayout,
  children,
}: LayoutProviderProps) {
  const [layoutContextOwner] = useState(() => ({}));
  // Set layout context for API agent resolution
  useEffect(() => {
    return _setLayoutContext(layout, { owner: layoutContextOwner });
  }, [layout, layoutContextOwner]);

  return <SDKProvider value={sdk}>{children}</SDKProvider>;
}

// Layout Navigation Context
interface LayoutNavigationContextType {
  getTabState: (tabId: string) => string;
  setTabState: (tabId: string, state: string) => void;
  clearTabState: (tabId: string) => void;
}

const LayoutNavigationContext =
  createContext<LayoutNavigationContextType | null>(null);

interface LayoutNavigationProviderProps {
  children: ReactNode;
  activeTabId?: string;
  layoutSlug?: string;
}

// Global hash restoration mechanism
let lastSetHash: string | null = null;
// `ReturnType<typeof setTimeout>`, not `NodeJS.Timeout`: the SDK is a browser
// package whose consumers have no reason to install `@types/node`, and an
// ambient namespace they cannot resolve makes their `tsc` fail on our source.
const hashRestoreTimeout: ReturnType<typeof setTimeout> | null = null;

const restoreHashIfCleared = () => {
  const currentHash = window.location.hash.slice(1);
  if (lastSetHash && currentHash !== lastSetHash) {
    window.location.hash = lastSetHash;
  }
};

export function LayoutNavigationProvider({
  children,
  activeTabId,
  layoutSlug,
}: LayoutNavigationProviderProps) {
  const [_instanceId] = useState(() => Math.random().toString(36).substr(2, 9));

  // IMMEDIATE hash restoration - before any state initialization
  if (activeTabId && layoutSlug) {
    const key = `layout-${layoutSlug}-tab-${activeTabId}`;
    const stored = sessionStorage.getItem(key);
    const currentHash = window.location.hash.slice(1);

    if (stored && !currentHash) {
      window.location.hash = stored;
    }
  }

  const [previousActiveTab, setPreviousActiveTab] = useState<
    string | undefined
  >(undefined);
  const [isInitialized, setIsInitialized] = useState(false);

  // Log mount/unmount
  useEffect(() => {
    return () => {};
  }, []);

  // Restore hash from sessionStorage on mount
  useEffect(() => {
    if (activeTabId && layoutSlug) {
      const key = `layout-${layoutSlug}-tab-${activeTabId}`;
      const stored = sessionStorage.getItem(key);
      const currentHash = window.location.hash.slice(1);
      if (stored && !currentHash) {
        window.location.hash = stored;
      }
    }
  }, [activeTabId, layoutSlug]); // Empty deps - only run on mount

  // Debug: Track all hash changes
  useEffect(() => {
    const handleHashChange = () => {};

    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  // Handle tab switching - restore hash for the active tab
  useEffect(() => {
    // Skip on first mount - let existing hash remain
    if (!isInitialized) {
      setPreviousActiveTab(activeTabId);
      setIsInitialized(true);
      return;
    }

    if (previousActiveTab !== activeTabId && activeTabId) {
      // Always restore the active tab's hash when switching tabs
      const key = `layout-${layoutSlug}-tab-${activeTabId}`;
      const stored = sessionStorage.getItem(key);
      if (stored) {
        window.location.hash = stored;
      } else {
        window.location.hash = '';
      }
      setPreviousActiveTab(activeTabId);
    }
  }, [activeTabId, previousActiveTab, layoutSlug, isInitialized]);

  const getTabState = useCallback(
    (tabId: string): string => {
      // Always use sessionStorage as source of truth
      const key = `layout-${layoutSlug}-tab-${tabId}`;
      const stored = sessionStorage.getItem(key);
      return stored || '';
    },
    [layoutSlug],
  );

  const setTabState = useCallback(
    (tabId: string, state: string) => {
      // Always save to sessionStorage first
      const key = `layout-${layoutSlug}-tab-${tabId}`;
      sessionStorage.setItem(key, state);

      if (tabId === activeTabId) {
        // Active tab also updates URL hash
        window.location.hash = state;

        // Global restoration mechanism - use requestAnimationFrame for after render
        lastSetHash = state;
        if (hashRestoreTimeout) clearTimeout(hashRestoreTimeout);
        requestAnimationFrame(() => {
          setTimeout(restoreHashIfCleared, 0);
        });
      }
    },
    [activeTabId, layoutSlug],
  );

  const clearTabState = useCallback(
    (tabId: string) => {
      if (tabId === activeTabId) {
        window.location.hash = '';
      } else {
        const key = `layout-${layoutSlug}-tab-${tabId}`;
        sessionStorage.removeItem(key);
      }
    },
    [activeTabId, layoutSlug],
  );

  return (
    <LayoutNavigationContext.Provider
      value={{ getTabState, setTabState, clearTabState }}
    >
      {children}
    </LayoutNavigationContext.Provider>
  );
}

export function useLayoutNavigation() {
  const context = useContext(LayoutNavigationContext);
  if (!context) {
    // Context validation
    throw new Error(
      'useLayoutNavigation must be used within LayoutNavigationProvider',
    );
  }
  return context;
}
