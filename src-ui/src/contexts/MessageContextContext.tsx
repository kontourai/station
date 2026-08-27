/**
 * MessageContextContext — app-level context for message context providers.
 *
 * Subscribes to contextRegistry via useSyncExternalStore. Exposes:
 *   providers[]        — all registered context providers
 *   toggleProvider(id) — enable/disable a provider
 *   getComposedContext() — compose all enabled providers into one string
 */

import type { MessageContextProvider } from '@kontourai/station-sdk';
import { contextRegistry } from '@kontourai/station-sdk';
import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
} from 'react';

interface MessageContextContextValue {
  providers: MessageContextProvider[];
  toggleProvider: (id: string) => void;
  getComposedContext: () => string | null;
}

const MessageContextCtx = createContext<MessageContextContextValue | null>(
  null,
);

function getSnapshot() {
  return contextRegistry.getAll();
}

export function MessageContextContext({
  children,
}: {
  children: React.ReactNode;
}) {
  const providers = useSyncExternalStore(
    contextRegistry.subscribe,
    getSnapshot,
    getSnapshot,
  );

  const toggleProvider = useCallback((id: string) => {
    contextRegistry.toggle(id);
  }, []);

  const getComposedContext = useCallback(
    () => contextRegistry.getComposedContext(),
    [],
  );

  const value = useMemo(
    () => ({ providers, toggleProvider, getComposedContext }),
    [providers, toggleProvider, getComposedContext],
  );

  return (
    <MessageContextCtx.Provider value={value}>
      {children}
    </MessageContextCtx.Provider>
  );
}

export function useMessageContextContext(): MessageContextContextValue {
  const ctx = useContext(MessageContextCtx);
  if (!ctx)
    throw new Error(
      'useMessageContextContext must be used within MessageContextContext',
    );
  return ctx;
}
