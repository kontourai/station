import {
  type AgentId,
  agentId,
} from '@kontourai/station-contracts/agent-identity';
import type { LayoutDefinition } from '@kontourai/station-contracts/layout';

let _apiBase = '';
const apiBaseWaiters = new Set<() => void>();

export interface PluginApiIdentity {
  readonly pluginName: string;
  getHeaders(extraHeaders?: Record<string, string>): Record<string, string>;
}

export function _setApiBase(apiBase: string) {
  _apiBase = apiBase;
  if (apiBase) {
    for (const resolve of apiBaseWaiters) resolve();
    apiBaseWaiters.clear();
  }
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
  const deadline = performance.now() + 500;
  while (!_apiBase) {
    await new Promise<void>((resolve, reject) => {
      const receive = () => {
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(
        () => {
          apiBaseWaiters.delete(receive);
          reject(
            new Error(
              'API base not configured. Ensure SDKProvider is mounted.',
            ),
          );
        },
        Math.max(0, deadline - performance.now()),
      );
      apiBaseWaiters.add(receive);
    });
  }
  return _apiBase;
}

export { apiErrorMessage } from './client/api-error-message';
export { getPluginHeaders } from './client/plugin-headers';
