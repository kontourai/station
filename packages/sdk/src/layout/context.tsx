import { createContext, type ReactNode, useContext, useState } from 'react';

interface LayoutContextConfig<T> {
  layoutSlug: string;
  projectSlug?: string;
  initialState: T;
  persist?: boolean; // Auto-save to sessionStorage
}

export function createLayoutContext<T extends Record<string, any>>(
  config: LayoutContextConfig<T>,
) {
  const { layoutSlug, projectSlug, initialState, persist = true } = config;
  // Include projectSlug in storage key for proper scoping
  const storageKey = projectSlug
    ? `layout:${projectSlug}:${layoutSlug}:context`
    : `layout:${layoutSlug}:context`;

  type ContextValue = {
    state: T;
    setState: (updates: Partial<T>) => void;
    resetState: () => void;
  };

  const Context = createContext<ContextValue | null>(null);

  function Provider({ children }: { children: ReactNode }) {
    const [state, setStateInternal] = useState<T>(() => {
      if (!persist) return initialState;

      try {
        const stored = sessionStorage.getItem(storageKey);
        return stored
          ? { ...initialState, ...JSON.parse(stored) }
          : initialState;
      } catch {
        return initialState;
      }
    });

    const setState = (updates: Partial<T>) => {
      setStateInternal((prev) => {
        const next = { ...prev, ...updates };
        if (persist) {
          try {
            sessionStorage.setItem(storageKey, JSON.stringify(next));
          } catch (err) {
            console.warn(
              `Failed to persist layout context for ${layoutSlug}:`,
              err,
            );
          }
        }
        return next;
      });
    };

    const resetState = () => {
      setStateInternal(initialState);
      if (persist) {
        sessionStorage.removeItem(storageKey);
      }
    };

    return (
      <Context.Provider value={{ state, setState, resetState }}>
        {children}
      </Context.Provider>
    );
  }

  function useLayoutContext() {
    const context = useContext(Context);
    if (!context) {
      throw new Error(
        `useLayoutContext must be used within ${layoutSlug} layout Provider`,
      );
    }
    return context;
  }

  return { Provider, useLayoutContext };
}
