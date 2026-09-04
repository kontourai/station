import {
  type AgentId,
  agentId,
} from '@kontourai/station-contracts/agent-identity';
import type { LayoutDefinition } from '@kontourai/station-contracts/layout';

let _apiBase = '';

export interface PluginApiIdentity {
  readonly pluginName: string;
  getHeaders(extraHeaders?: Record<string, string>): Record<string, string>;
}

export function _setApiBase(apiBase: string) {
  _apiBase = apiBase;
}

export function _setLayoutContext(
  _layout: LayoutDefinition | undefined,
  _options: { owner?: object; pluginName?: string } = {},
) {
  // Compatibility-only no-op. A module global cannot identify simultaneous
  // Pane owners; SDKProvider now supplies a boundary-local PluginApiIdentity.
  return () => {};
}

export function _resolveAgent(agentSlug: string): AgentId {
  return agentId(agentSlug);
}

export function _getPluginName(): string {
  // Legacy imperative callers remain deliberately unqualified rather than
  // borrowing whichever plugin Pane happened to render most recently.
  return '';
}

export async function _getApiBase(): Promise<string> {
  let attempts = 0;
  while (!_apiBase && attempts < 50) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    attempts++;
  }

  if (!_apiBase) {
    throw new Error('API base not configured. Ensure SDKProvider is mounted.');
  }
  return _apiBase;
}

export { apiErrorMessage } from './client/api-error-message';
export { getPluginHeaders } from './client/plugin-headers';
