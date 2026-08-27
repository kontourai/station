import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react';
import type { DockMode } from '../types';
import type { OpenFilePreviewIntent } from '../workspace-panes/openFilePreviewIntent';
import { navigationStore } from './navigation-store';

export { navigationStore } from './navigation-store';

const NavigationContext = createContext<{
  navigate: (pathname: string, params?: Record<string, string | null>) => void;
  updateParams: (params: Record<string, string | null>) => void;
  setAgent: (slug: string | null) => void;
  setLayoutTab: (layoutSlug: string, tabId: string | null) => void;
  setProject: (slug: string) => void;
  setLayout: (
    projectSlug: string,
    layoutSlug: string,
    options?: { openFilePreviewIntent?: OpenFilePreviewIntent },
  ) => void;
  setConversation: (id: string | null) => void;
  setActiveChat: (id: string | null) => void;
  setDockState: (open: boolean, maximized?: boolean) => void;
  collapseMaximizedDock: () => void;
  setDockMode: (mode: DockMode) => void;
  setDockModeQuiet: (mode: DockMode) => void;
} | null>(null);

export function NavigationProvider({ children }: { children: ReactNode }) {
  const navigate = useCallback(
    (pathname: string, params?: Record<string, string | null>) => {
      navigationStore.navigate(pathname, params);
    },
    [],
  );

  const updateParams = useCallback((params: Record<string, string | null>) => {
    navigationStore.updateParams(params);
  }, []);

  const setAgent = useCallback((slug: string | null) => {
    navigationStore.setAgent(slug);
  }, []);

  const setLayoutTab = useCallback(
    (layoutSlug: string, tabId: string | null) => {
      navigationStore.setLayoutTab(layoutSlug, tabId);
    },
    [],
  );

  const setProject = useCallback((slug: string) => {
    navigationStore.setProject(slug);
  }, []);

  const setLayout = useCallback(
    (
      projectSlug: string,
      layoutSlug: string,
      options?: { openFilePreviewIntent?: OpenFilePreviewIntent },
    ) => {
      navigationStore.setLayout(projectSlug, layoutSlug, options);
    },
    [],
  );

  const setConversation = useCallback((id: string | null) => {
    navigationStore.setConversation(id);
  }, []);

  const setActiveChat = useCallback((id: string | null) => {
    navigationStore.setActiveChat(id);
  }, []);

  const setDockState = useCallback((open: boolean, maximized?: boolean) => {
    navigationStore.setDockState(open, maximized);
  }, []);

  const collapseMaximizedDock = useCallback(() => {
    navigationStore.collapseMaximizedDock();
  }, []);

  const setDockMode = useCallback((mode: DockMode) => {
    navigationStore.setDockMode(mode);
  }, []);

  const setDockModeQuiet = useCallback((mode: DockMode) => {
    navigationStore.setDockModeQuiet(mode);
  }, []);

  // station#3796: one memoised value per provider — a fresh object literal
  // here republishes the context to every consumer on any render of this
  // provider, whatever the render was actually about.
  const value = useMemo(
    () => ({
      navigate,
      updateParams,
      setAgent,
      setLayoutTab,
      setProject,
      setLayout,
      setConversation,
      setActiveChat,
      setDockState,
      collapseMaximizedDock,
      setDockMode,
      setDockModeQuiet,
    }),
    [
      navigate,
      updateParams,
      setAgent,
      setLayoutTab,
      setProject,
      setLayout,
      setConversation,
      setActiveChat,
      setDockState,
      collapseMaximizedDock,
      setDockMode,
      setDockModeQuiet,
    ],
  );

  return (
    <NavigationContext.Provider value={value}>
      {children}
    </NavigationContext.Provider>
  );
}

export function useNavigation() {
  const context = useContext(NavigationContext);
  if (!context) {
    throw new Error('useNavigation must be used within NavigationProvider');
  }

  const state = useSyncExternalStore(
    navigationStore.subscribe,
    navigationStore.getSnapshot,
  );

  return {
    ...state,
    lastProject: navigationStore.lastProject,
    lastProjectLayout: navigationStore.lastProjectLayout,
    lastDockMaximized: navigationStore.lastDockMaximized,
    ...context,
  };
}

/**
 * Null outside a NavigationProvider instead of throwing. For chrome that must
 * render in bare contexts (layout fallbacks, tests) and only OFFERS navigation
 * when it exists — never for flows that require it.
 */
export function useNavigationOptional() {
  return useContext(NavigationContext);
}
