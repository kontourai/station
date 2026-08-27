import type {
  SessionInventoryGroupId,
  SessionInventoryScope,
} from '@kontourai/station-contracts/session-inventory';
import { useSyncExternalStore } from 'react';

export type SessionInventorySelection = {
  scope: SessionInventoryScope;
  groupId: SessionInventoryGroupId;
  itemKey?: string;
};
export type SessionInventorySelectionKey = {
  apiBase: string;
  authorityKey: string;
  sessionId: string;
};

const values = new Map<string, SessionInventorySelection>();
/**
 * Exact scopes are a separate, in-memory occurrence history. They are never
 * derived from a session's latest turn or Task: a caller must commit one.
 */
const knownScopes = new Map<string, readonly SessionInventoryScope[]>();
const listeners = new Map<string, Set<() => void>>();
const keyOf = ({
  apiBase,
  authorityKey,
  sessionId,
}: SessionInventorySelectionKey) =>
  JSON.stringify([apiBase, authorityKey, sessionId]);

function notify(key: string) {
  listeners.get(key)?.forEach((listener) => listener());
}

export function readSessionInventorySelection(
  key: SessionInventorySelectionKey,
) {
  return values.get(keyOf(key));
}

export function commitSessionInventorySelection(
  key: SessionInventorySelectionKey,
  selection: SessionInventorySelection,
) {
  const encoded = keyOf(key);
  values.set(encoded, selection);
  const known = knownScopes.get(encoded) ?? [];
  if (
    !known.some(
      (scope) => JSON.stringify(scope) === JSON.stringify(selection.scope),
    )
  )
    knownScopes.set(encoded, [...known, selection.scope]);
  notify(encoded);
}

export function readSessionInventoryKnownScopes(
  key: SessionInventorySelectionKey,
) {
  return knownScopes.get(keyOf(key)) ?? [];
}

export function clearSessionInventorySelection(
  key: SessionInventorySelectionKey,
) {
  const encoded = keyOf(key);
  values.delete(encoded);
  notify(encoded);
}

/** Old authority epochs never retain a Session selection. */
export function clearSessionInventorySelectionsForAuthority(
  apiBase: string,
  authorityKey: string,
) {
  const prefix = JSON.stringify([apiBase, authorityKey]).slice(0, -1);
  const affected = new Set([...values.keys(), ...knownScopes.keys()]);
  for (const key of affected) {
    if (key.startsWith(prefix)) {
      values.delete(key);
      knownScopes.delete(key);
    }
  }
  for (const key of listeners.keys()) {
    if (key.startsWith(prefix)) notify(key);
  }
}

export function useSessionInventorySelection(
  key: SessionInventorySelectionKey | null,
  fallback: SessionInventorySelection,
) {
  const encoded = key ? keyOf(key) : '';
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
    () => (key ? (values.get(encoded) ?? fallback) : fallback),
    () => fallback,
  );
}
