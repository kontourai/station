import { telemetry } from '@kontourai/station-sdk';

const STORAGE_KEY = 'recentAgents';
const MAX_RECENT = 5;

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
