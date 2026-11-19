import type { LayoutDefinition } from '@kontourai/station-contracts/layout';
import type { PaneRelatedPanesHost } from '@kontourai/station-contracts/workspace-pane-host-contract';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
} from 'react';
import type { PluginApiIdentity } from './api-core';
import type {
  SDKAgentsContext,
  SDKAuthContext,
  SDKConfigContext,
  SDKHostContext,
  SDKModelsContext,
  SDKNavigationContext,
  SDKShortcutsContext,
  SDKToastContext,
  SDKToolApprovalHandler,
} from './host-contexts';

/**
 * SDK Context - Provides access to all core app contexts and hooks
 *
 * The core app injects its contexts here, making them available to plugins
 * through the SDK hooks.
 */

export interface SDKContextValue {
  apiBase: string;
  /** Exact request identity owned by this SDKProvider boundary. */
  pluginApiIdentity?: PluginApiIdentity;
  /**
   * The related-pane capability of the pane occurrence this provider wraps,
   * when its host offers one (`useRelatedPanes`).
   */
  relatedPanes?: PaneRelatedPanesHost;

  // Core contexts (injected by core app)
  contexts: {
    agents?: SDKAgentsContext;
    layouts?: any;
    conversations?: any;
    activeChats?: any;
    models?: SDKModelsContext;
    config?: SDKConfigContext;
    navigation?: SDKNavigationContext;
    toast?: SDKToastContext;
    stats?: any;
    auth?: SDKAuthContext;
    host?: SDKHostContext;
    shortcuts?: SDKShortcutsContext;
    /** @deprecated Read by `useKeyboardShortcuts`; use the `shortcuts` slot. */
    keyboardShortcuts?: any;
    workflows?: any;
  };

  // Custom hooks (injected by core app)
  hooks: {
    slashCommandHandler?: () => any;
    slashCommands?: () => any;
    toolApproval?: () => SDKToolApprovalHandler;
    /** @deprecated Read by `useKeyboardShortcut`; use `contexts.shortcuts`. */
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
  layout: _layout,
  project: _project,
  activeLayout: _activeLayout,
  children,
}: LayoutProviderProps) {
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

export function LayoutNavigationProvider({
  children,
  activeTabId,
  layoutSlug,
}: LayoutNavigationProviderProps) {
  const previousKey = useRef<string | null>(null);
  const pendingRestore = useRef<(() => void) | null>(null);
  const cancelRestore = useCallback(() => {
    pendingRestore.current?.();
    pendingRestore.current = null;
  }, []);

  const activeKey =
    activeTabId && layoutSlug
      ? `layout-${layoutSlug}-tab-${activeTabId}`
      : null;
  // Plugins can initialize state from the URL when their first render runs.
  if (activeKey && typeof window !== 'undefined' && !window.location.hash) {
    const retained = sessionStorage.getItem(activeKey);
    if (retained) window.location.hash = retained;
  }

  useLayoutEffect(() => {
    if (!activeKey) return cancelRestore;
    if (previousKey.current && previousKey.current !== activeKey) {
      window.location.hash = sessionStorage.getItem(activeKey) ?? '';
    }
    previousKey.current = activeKey;
    return cancelRestore;
  }, [activeKey, cancelRestore]);

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
      const key = `layout-${layoutSlug}-tab-${tabId}`;
      sessionStorage.setItem(key, state);
      if (tabId !== activeTabId) return;

      cancelRestore();
      window.location.hash = state;
      if (!state) return;

      let timeout: ReturnType<typeof setTimeout> | undefined;
      const frame = requestAnimationFrame(() => {
        timeout = setTimeout(() => {
          pendingRestore.current = null;
          if (!window.location.hash && sessionStorage.getItem(key) === state) {
            window.location.hash = state;
          }
        }, 0);
      });
      pendingRestore.current = () => {
        cancelAnimationFrame(frame);
        clearTimeout(timeout);
      };
    },
    [activeTabId, layoutSlug, cancelRestore],
  );

  const clearTabState = useCallback(
    (tabId: string) => {
      const key = `layout-${layoutSlug}-tab-${tabId}`;
      sessionStorage.removeItem(key);
      if (tabId === activeTabId) {
        cancelRestore();
        window.location.hash = '';
      }
    },
    [activeTabId, layoutSlug, cancelRestore],
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
