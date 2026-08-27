import {
  type AgentId,
  agentId,
} from '@kontourai/station-contracts/agent-identity';
import { STATION_PLUGIN_HEADER } from '@kontourai/station-contracts/http';
import type { LayoutDefinition } from '@kontourai/station-contracts/layout';

let _apiBase = '';
let _currentLayout: LayoutDefinition | undefined;

export function _setApiBase(apiBase: string) {
  _apiBase = apiBase;
}

export function _setLayoutContext(layout: LayoutDefinition | undefined) {
  _currentLayout = layout;
}

export function _resolveAgent(agentSlug: string): AgentId {
  return agentId(agentSlug);
}

export function _getPluginName(): string {
  return _currentLayout?.slug || '';
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

export function getPluginHeaders(
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  return {
    [STATION_PLUGIN_HEADER]: _getPluginName(),
    ...extraHeaders,
  };
}

export { apiErrorMessage } from './client/api-error-message';
