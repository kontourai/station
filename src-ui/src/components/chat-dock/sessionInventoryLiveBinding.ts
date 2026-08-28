import { useSyncExternalStore } from 'react';

type Binding = { hostId: string; chatStoreId: string };
const values = new Map<string, Binding>();
const listeners = new Map<string, Set<() => void>>();
const key = (apiBase: string, authorityKey: string, sessionId: string) =>
  JSON.stringify([apiBase, authorityKey, sessionId]);
export function registerSessionInventoryLiveBinding(
  apiBase: string,
  authorityKey: string,
  sessionId: string,
  binding: Binding,
) {
  const encoded = key(apiBase, authorityKey, sessionId);
  values.set(encoded, binding);
  listeners.get(encoded)?.forEach((listener) => listener());
  return () => {
    if (values.get(encoded) !== binding) return;
    values.delete(encoded);
    listeners.get(encoded)?.forEach((listener) => listener());
  };
}
export function releaseSessionInventoryLiveBinding(
  apiBase: string,
  authorityKey: string,
  sessionId: string,
  binding: Binding,
) {
  const encoded = key(apiBase, authorityKey, sessionId);
  if (values.get(encoded) !== binding) return;
  values.delete(encoded);
  listeners.get(encoded)?.forEach((listener) => listener());
}
export function useSessionInventoryLiveBinding(
  scope:
    | { apiBase: string; authorityKey: string; isCurrent?: () => boolean }
    | undefined,
  sessionId: string,
) {
  const encoded = scope
    ? key(scope.apiBase, scope.authorityKey, sessionId)
    : '';
  return useSyncExternalStore(
    (listener) => {
      if (!encoded) return () => {};
      const group = listeners.get(encoded) ?? new Set<() => void>();
      group.add(listener);
      listeners.set(encoded, group);
      return () => {
        group.delete(listener);
        if (!group.size) listeners.delete(encoded);
      };
    },
    () => (scope?.isCurrent?.() ? values.get(encoded) : undefined),
    () => undefined,
  );
}
