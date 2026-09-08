import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useSyncExternalStore,
} from 'react';
import type { DockMode } from '../types';
import { isShallowEqual } from '../utils/isShallowEqual';
import type { OpenFilePreviewIntent } from '../workspace-panes/openFilePreviewIntent';
import type { NavigationState } from './navigation-store';
import { navigationStore } from './navigation-store';

export { navigationStore } from './navigation-store';

/**
 * Every navigation write this app is allowed to make. The provider memoizes
 * one instance of this object for its whole lifetime, so a consumer that
 * reads only actions has nothing to re-render for — `useNavigationActions`
 * is how it says so.
 */
export type NavigationActions = {
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
};

const NavigationContext = createContext<NavigationActions | null>(null);

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

  // archive#3796: one memoised value per provider — a fresh object literal
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
    ],
  );

  return (
    <NavigationContext.Provider value={value}>
      {children}
    </NavigationContext.Provider>
  );
}

/**
 * The store's own memory of where the user was. Not part of `NavigationState`
 * and not covered by `subscribe`/`notify`, so a selector never sees it — it is
 * re-read on whatever render the whole-snapshot form is already doing.
 */
type NavigationMemory = {
  lastProject: string | null;
  lastProjectLayout: string | null;
  lastDockMaximized: boolean;
};

export type NavigationValue = NavigationState &
  NavigationMemory &
  NavigationActions;

/**
 * Reads navigation. Two forms:
 *
 * - `useNavigation()` returns the whole snapshot plus the store memory plus
 *   every action, and re-renders on every store write.
 * - `useNavigation(selector)` returns only what the selector picks out of
 *   `NavigationState`, and re-renders only when that slice changes.
 *
 * The selector form is the same shape as `useActiveChatSelector`, equality
 * semantics included: the selected value is cached against the snapshot
 * identity, and a recomputed value that compares equal keeps the PREVIOUS
 * reference so `useSyncExternalStore` sees no change. `isEqual` defaults to a
 * one-level shallow compare, which covers a primitive field and a flat object
 * of primitives/stable references; a selector returning a fresh nested object
 * needs its own comparator or it re-renders exactly as often as the
 * whole-snapshot form.
 *
 * Actions are not in the selector's input. A consumer that reads no state at
 * all wants `useNavigationActions`, which does not subscribe.
 */
export function useNavigation(): NavigationValue;
export function useNavigation<T>(
  selector: (state: NavigationState) => T,
  isEqual?: (a: T, b: T) => boolean,
): T;
export function useNavigation<T>(
  selector?: (state: NavigationState) => T,
  isEqual: (a: T, b: T) => boolean = isShallowEqual,
): NavigationValue | T {
  const context = useContext(NavigationContext);
  if (!context) {
    throw new Error('useNavigation must be used within NavigationProvider');
  }

  // Read the latest selector/isEqual through refs rather than as
  // useSyncExternalStore dependencies, so callers can pass inline functions
  // without memoizing them (mirrors React's own selector shim, and
  // `useActiveChatSelector`).
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const isEqualRef = useRef(isEqual);
  isEqualRef.current = isEqual;

  const cacheRef = useRef<{ raw: NavigationState; selected: T } | null>(null);

  const getSnapshot = useCallback((): NavigationState | T => {
    const raw = navigationStore.getSnapshot();
    const select = selectorRef.current;
    if (!select) return raw;
    const cached = cacheRef.current;
    if (cached && cached.raw === raw) {
      return cached.selected;
    }
    const nextSelected = select(raw);
    if (cached && isEqualRef.current(cached.selected, nextSelected)) {
      // Equal by value — keep the old reference so useSyncExternalStore (and
      // any memoized consumer downstream) sees no change.
      cacheRef.current = { raw, selected: cached.selected };
      return cached.selected;
    }
    cacheRef.current = { raw, selected: nextSelected };
    return nextSelected;
  }, []);

  const snapshot = useSyncExternalStore(
    navigationStore.subscribe,
    getSnapshot,
    getSnapshot,
  );

  if (selector) return snapshot as T;

  return {
    ...(snapshot as NavigationState),
    lastProject: navigationStore.lastProject,
    lastProjectLayout: navigationStore.lastProjectLayout,
    lastDockMaximized: navigationStore.lastDockMaximized,
    ...context,
  };
}

/**
 * Navigation actions with no subscription. The provider publishes one
 * memoized actions object for its lifetime (archive#3796), so a consumer of
 * this hook re-renders for its own reasons only — never because some other
 * surface toggled the dock or changed the font size.
 *
 * Use this wherever the destructure is actions only. Reading URL state
 * ambiently (`window.location` in render) counts as reading navigation: that
 * consumer wants `useNavigation(selector)` on the field it is really keyed to.
 */
export function useNavigationActions(): NavigationActions {
  const context = useContext(NavigationContext);
  if (!context) {
    throw new Error(
      'useNavigationActions must be used within NavigationProvider',
    );
  }
  return context;
}

/**
 * Null outside a NavigationProvider instead of throwing. For chrome that must
 * render in bare contexts (layout fallbacks, tests) and only OFFERS navigation
 * when it exists — never for flows that require it.
 */
export function useNavigationOptional() {
  return useContext(NavigationContext);
}
