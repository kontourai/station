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
const REQUEST_EVENT = 'station-session-inventory-request';

type SessionInventoryRequest = {
  launch: SessionInventoryLaunch;
  candidates: (() => void)[];
};

export function openSessionInventoryOccurrence(launch: SessionInventoryLaunch) {
  const matches = launch.hostId
    ? [[launch.hostId, registrations.get(launch.hostId)] as const]
    : [...registrations.entries()].filter(
        ([, entry]) =>
          entry.authorityKey === launch.authorityKey &&
          entry.chatStoreId === launch.activeSessionId,
      );
  if (matches.length === 1) {
    const [hostId, registration] = matches[0]!;
    if (registration && registration.authorityKey === launch.authorityKey) {
      occurrences.set(hostId, { ...launch, hostId });
      notify(hostId);
      return true;
    }
  }
  if (typeof window === 'undefined') return false;
  const detail: SessionInventoryRequest = { launch, candidates: [] };
  window.dispatchEvent(new CustomEvent(REQUEST_EVENT, { detail }));
  if (detail.candidates.length !== 1) return false;
  detail.candidates[0]!();
  return true;
}
export function registerSessionInventoryHost(
  hostId: string,
  registration: Registration | null,
) {
  if (!registration) return () => {};
  registrations.set(hostId, registration);
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
