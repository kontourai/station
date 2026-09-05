import { useSyncExternalStore } from 'react';
import type { SessionInventoryLaunch } from './SessionInventoryEntryPoint';

type Registration = {
  authorityKey: string;
  chatStoreId: string;
  executionId: string;
};
const registrations = new Map<string, Registration>();
const occurrences = new Map<string, SessionInventoryLaunch>();
const listeners = new Map<string, Set<() => void>>();
const notify = (hostId: string) =>
  listeners.get(hostId)?.forEach((listener) => listener());

export function openSessionInventoryOccurrence(launch: SessionInventoryLaunch) {
  const matches = launch.hostId
    ? [[launch.hostId, registrations.get(launch.hostId)] as const]
    : [...registrations.entries()].filter(
        ([, entry]) =>
          entry.authorityKey === launch.authorityKey &&
          entry.chatStoreId === launch.activeSessionId,
      );
  if (matches.length !== 1) return false;
  const [hostId, registration] = matches[0]!;
  if (
    !registration ||
    registration.authorityKey !== launch.authorityKey ||
    registration.chatStoreId !== launch.activeSessionId ||
    (!launch.requestedScope &&
      registration.executionId !== launch.executionSessionId)
  )
    return false;
  occurrences.set(hostId, { ...launch, hostId });
  notify(hostId);
  return true;
}
export function registerSessionInventoryHost(
  hostId: string,
  registration: Registration | null,
) {
  if (!registration) return () => {};
  registrations.set(hostId, registration);
  // Notify on the REGISTER path too, not only on teardown: since #1536 F the
  // control lives in a different component from the host, and it has to know
  // when this host became pressable. Existing subscribers snapshot
  // `occurrences`, which this does not touch, so they see no change.
  notify(hostId);
  return () => {
    if (registrations.get(hostId) !== registration) return;
    registrations.delete(hostId);
    occurrences.delete(hostId);
    notify(hostId);
  };
}
export function closeSessionInventoryOccurrence(hostId?: string) {
  if (!hostId) {
    for (const id of occurrences.keys()) closeSessionInventoryOccurrence(id);
    return;
  }
  occurrences.delete(hostId);
  notify(hostId);
}
export function readSessionInventoryOccurrence(hostId?: string) {
  return hostId
    ? occurrences.get(hostId)
    : occurrences.size === 1
      ? occurrences.values().next().value
      : undefined;
}
/**
 * Open the host's inventory, or leave it — the one implementation of the
 * inventory control's own verb, so a caller does not have to hold the
 * authority scope to press it.
 *
 * It reads the `authorityKey`/session identity from the REGISTRATION the host
 * wrote rather than from the caller: since #1536 F the control is a row of the
 * dock header's More menu, which is not the component that mounts the host and
 * has no authority scope of its own to capture. A caller with no registration
 * (the host has not mounted, or its scope is incomplete) gets `false`.
 *
 * `focusFullBasis` is `SessionInventoryHost`'s handle, stamped on the trigger
 * element: while a full-height fallback host is up, a second activation focuses
 * it instead of closing the occurrence out from under the user.
 */
export function toggleSessionInventoryOccurrence(input: {
  hostId: string;
  projectId?: string;
  executionRead: string;
  trigger: HTMLElement;
}): boolean {
  const registration = registrations.get(input.hostId);
  if (!registration) return false;
  if (occurrences.has(input.hostId)) {
    const focusFullBasis = (
      input.trigger as HTMLElement & { focusFullBasis?: () => boolean }
    ).focusFullBasis;
    if (focusFullBasis?.()) return true;
    closeSessionInventoryOccurrence(input.hostId);
    return true;
  }
  return openSessionInventoryOccurrence({
    hostId: input.hostId,
    authorityKey: registration.authorityKey,
    activeSessionId: registration.chatStoreId,
    executionSessionId: registration.executionId,
    projectId: input.projectId,
    executionRead: input.executionRead,
    trigger: input.trigger,
  });
}

export function readSessionInventoryHostRegistration(hostId: string) {
  return registrations.get(hostId);
}
export function subscribeSessionInventoryOccurrence(
  hostId: string,
  listener: () => void,
) {
  const group = listeners.get(hostId) ?? new Set<() => void>();
  group.add(listener);
  listeners.set(hostId, group);
  return () => {
    group.delete(listener);
    if (!group.size) listeners.delete(hostId);
  };
}
export function useSessionInventoryOccurrence(hostId: string) {
  return useSyncExternalStore(
    (listener) => subscribeSessionInventoryOccurrence(hostId, listener),
    () => occurrences.get(hostId) ?? null,
    () => null,
  );
}

/**
 * Whether this host is pressable yet.
 *
 * `toggleSessionInventoryOccurrence` refuses without a registration, and since
 * #1536 F the control is a menu row in a component that does NOT mount the host
 * — the host arrives with a lazily loaded chunk, and can fail to arrive at all.
 * A row that silently does nothing until then is the shape this exists to
 * prevent: it is derived from the registration itself, never from a timer or an
 * optimistic assumption that the chunk resolved.
 */
export function useSessionInventoryHostRegistered(hostId: string) {
  return useSyncExternalStore(
    (listener) => subscribeSessionInventoryOccurrence(hostId, listener),
    () => registrations.has(hostId),
    () => false,
  );
}
