import { telemetry } from '@kontourai/station-sdk';

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
}

function contextAgentKey(namespace: string, context: string): string {
  return JSON.stringify([namespace, context]);
}
