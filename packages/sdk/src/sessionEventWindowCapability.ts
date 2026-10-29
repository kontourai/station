import { hasCapability } from './capability.js';
import {
  fetchPublicStationCapabilities,
  invalidatePublicStationCapabilities,
  resetPublicStationCapabilities,
} from './publicStationCapabilities.js';

/** `true` is capable, `false` is answered-not-capable, and `undefined` is undetermined. */
export type SessionEventWindowCapability = boolean | undefined;

const recoveryAttempts = new Map<string, number>();
const MAX_AUTOMATIC_CAPABILITY_RECOVERIES = 3;
export const SESSION_EVENT_WINDOW_CAPABILITY_RETRY_MS = 30_000;
export const SESSION_EVENT_WINDOW_UNSUPPORTED_RETRY_MS = 60_000;

function recoveryKey(apiBase: string, sessionId: string): string {
  return `${apiBase}\u0000${sessionId}`;
}

/**
 * Reserves one bounded automatic re-probe for a host/session pair. The budget
 * outlives a component mount, while a confirmed capable response resets it.
 */
export function claimSessionEventWindowCapabilityRecovery(
  apiBase: string,
  sessionId: string,
): boolean {
  const key = recoveryKey(apiBase, sessionId);
  const attempts = recoveryAttempts.get(key) ?? 0;
  if (attempts >= MAX_AUTOMATIC_CAPABILITY_RECOVERIES) return false;
  recoveryAttempts.set(key, attempts + 1);
  return true;
}

export function resetSessionEventWindowCapabilityRecovery(
  apiBase: string,
  sessionId: string,
): void {
  recoveryAttempts.delete(recoveryKey(apiBase, sessionId));
}
/** Negotiates support before a client requests a bounded event-window page. */
export function fetchSessionEventWindowCapability(
  apiBase: string,
): Promise<SessionEventWindowCapability> {
  return fetchPublicStationCapabilities(apiBase).then((handshake) =>
    handshake ? hasCapability(handshake, 'sessionEventWindow') : undefined,
  );
}

export function resetSessionEventWindowCapabilityCache(): void {
  resetPublicStationCapabilities();
  recoveryAttempts.clear();
}

/** Invalidate only this host; recovery budgets remain session-scoped. */
export function invalidateSessionEventWindowCapabilityCache(
  apiBase: string,
): void {
  invalidatePublicStationCapabilities(apiBase);
}
