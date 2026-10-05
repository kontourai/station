import { telemetry } from '@kontourai/station-sdk';
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'recentAgents';
const MAX_RECENT = 5;
const CONTEXT_AGENT_STORAGE_KEY = 'station.newChat.lastAgentByContext';

export function getRecentAgentSlugs(): string[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
}

export function trackRecentAgent(slug: string): void {
  const recent = getRecentAgentSlugs().filter((s) => s !== slug);
  recent.unshift(slug);
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(recent.slice(0, MAX_RECENT)),
  );
  telemetry.track('agent:selected', { slug });
}

function readContextAgents(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(CONTEXT_AGENT_STORAGE_KEY) || '{}',
    );
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return {};
    const agents: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value) agents[key] = value;
    }
    return agents;
  } catch {
    return {};
  }
}

export function getContextAgent(
  namespace: string | null,
  context: string,
): string | undefined {
  return namespace
    ? readContextAgents()[contextAgentKey(namespace, context)]
    : undefined;
}

export function trackContextAgent(
  namespace: string | null,
  context: string,
  slug: string,
): void {
  if (!namespace) return;
  const agents = readContextAgents();
  agents[contextAgentKey(namespace, context)] = slug;
  try {
    localStorage.setItem(CONTEXT_AGENT_STORAGE_KEY, JSON.stringify(agents));
  } catch {
    /* Choice memory must not block starting work. */
  }
  for (const listener of contextAgentListeners) listener();
}

const contextAgentListeners = new Set<() => void>();

function subscribeContextAgent(listener: () => void): () => void {
  contextAgentListeners.add(listener);
  // Another tab's choice arrives as a `storage` event, not through track.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === CONTEXT_AGENT_STORAGE_KEY)
      listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    contextAgentListeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/**
 * `getContextAgent`, live: re-renders when any surface remembers a choice
 * for this context, so Home's start composer and the dock's draft (both
 * mounted at once) name the same Agent after either one changes it. The
 * snapshot is the slug string, so it is stable between changes.
 */
export function useContextAgent(
  namespace: string | null,
  context: string,
): string | undefined {
  const read = () => getContextAgent(namespace, context);
  return useSyncExternalStore(subscribeContextAgent, read, read);
}

function contextAgentKey(namespace: string, context: string): string {
  return JSON.stringify([namespace, context]);
}
