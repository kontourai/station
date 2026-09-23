/**
 * #2323 S4: local plugin source status, on its own SDK subpath
 * (`@kontourai/station-sdk/plugin-local-sources-query`) so only the lazy
 * Plugins view pays for it, not the app entry.
 */
import type { PluginLocalSourceStatus } from '@kontourai/station-contracts/plugin';
import { _getApiBase } from '../api';
import { type QueryConfig, useApiQuery } from '../query-core';

/**
 * #2323 S4: for each Project folder that is an installed local-folder
 * plugin's source, whether the folder still holds the installed code.
 * Operator-only on the server; any other viewer gets 404, read here as "no
 * sources to offer", never as "unchanged".
 */
async function fetchPluginLocalSources(): Promise<PluginLocalSourceStatus[]> {
  const apiBase = await _getApiBase();
  const response = await authenticatedFetch(`${apiBase}/api/plugin-sources`);
  if (response.status === 404) return [];
  const result = (await response.json()) as {
    sources?: PluginLocalSourceStatus[];
    error?: string;
  };
  if (!response.ok || !Array.isArray(result.sources)) {
    throw new Error(
      apiErrorMessage(result, 'Plugin source status is unavailable'),
    );
  }
  return result.sources;
}

export function usePluginLocalSourcesQuery(
  config?: QueryConfig<PluginLocalSourceStatus[]>,
) {
  return useApiQuery(['plugin-sources'], fetchPluginLocalSources, config);
}
