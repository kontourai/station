import { EXECUTION_MODE } from '@kontourai/station-contracts/tool';
import { useSyncExternalStore } from 'react';
import type { AgentData } from '../contexts/AgentsContext';

const STORAGE_KEY = 'station.newChat.lastModelByBinding';

/** bindingKey (agent app connection identity) -> last chosen model id */
export type LastChosenModelMap = Record<string, string>;

export function getLastChosenModelMap(): LastChosenModelMap {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const map: LastChosenModelMap = {};
    for (const [key, value] of Object.entries(
      parsed as Record<string, unknown>,
    )) {
      if (typeof value === 'string' && value) {
        map[key] = value;
      }
    }
    return map;
  } catch {
    return {};
  }
}

const listeners = new Set<() => void>();
function notifyLastChosenModel(): void {
  for (const listener of listeners) listener();
}

function readRawLastChosenModel(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

// `useSyncExternalStore` needs a stable snapshot between changes; parse once
// per distinct stored string.
let cachedRaw: string | null | undefined;
let cachedMap: LastChosenModelMap = {};
function lastChosenModelSnapshot(): LastChosenModelMap {
  const raw = readRawLastChosenModel();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedMap = getLastChosenModelMap();
  }
  return cachedMap;
}

function subscribeLastChosenModel(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab's write arrives as a `storage` event, not through track/clear.
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/**
 * The remembered map, live: re-renders when a chat records or forgets a
 * choice, so a surface that stays mounted (Home's start identity) never
 * names a Model the next New Chat would no longer open on.
 */
export function useLastChosenModelMap(): LastChosenModelMap {
  return useSyncExternalStore(
    subscribeLastChosenModel,
    lastChosenModelSnapshot,
    lastChosenModelSnapshot,
  );
}

export function trackLastChosenModel(
  bindingKey: string,
  modelId: string,
): void {
  if (!bindingKey || !modelId) return;
  const map = getLastChosenModelMap();
  map[bindingKey] = modelId;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Storage may be unavailable (quota, private browsing) — this memory
    // is best-effort and must never throw out of a caller's click handler.
  }
  notifyLastChosenModel();
}

/**
 * Forget the remembered choice for one binding — an explicit "use the
 * default" reset means the next New Chat should open on the default again,
 * not on the choice the user just walked away from.
 */
export function clearLastChosenModel(bindingKey: string): void {
  if (!bindingKey) return;
  const map = getLastChosenModelMap();
  if (!(bindingKey in map)) return;
  delete map[bindingKey];
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Best-effort, same as trackLastChosenModel.
  }
  notifyLastChosenModel();
}

/**
 * Identity + gate for this memory. These live here (not in
 * new-chat-modal-utils) so entry-chunk callers like useChatInput can import
 * them without dragging the lazy New Chat modal's module graph into the
 * entry bundle (the app-builds gzip budget caught exactly that).
 */
export function agentBindingId(agent: Pick<AgentData, 'execution'>): string {
  const providerId = agent.execution?.runtimeOptions?.providerId;
  return (
    (typeof providerId === 'string' ? providerId : undefined) ??
    agent.execution?.agentConnectionId ??
    'unbound'
  );
}

/**
 * Identity for "remember the most-recently-chosen model per agent app":
 * per agent app connection, not per project.
 */
export function buildLastChosenModelBindingKey(
  agent: Pick<AgentData, 'slug' | 'execution'>,
): string {
  return buildLastChosenModelBindingKeyFromIdentity(
    agent.slug,
    agentBindingId(agent),
  );
}

/** Same durable binding identity, available at the accepted-turn event seam. */
export function buildLastChosenModelBindingKeyFromIdentity(
  agentSlug: string,
  bindingId: string | undefined,
): string {
  return `${bindingId || 'unbound'}\u001f${agentSlug}`;
}

/**
 * PROVIDER_MANAGED agents are Station agents running against a project's
 * (or the global) default Model connection, which an admin can change at
 * any time. Memory concepts that only make sense for External agents
 * (agent apps) gate on this.
 */
export function isProviderManagedAgent(
  agent: Pick<AgentData, 'execution'> | null | undefined,
): boolean {
  return (
    agent?.execution?.runtimeOptions?.executionMode === EXECUTION_MODE.STATION
  );
}
