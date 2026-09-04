import { STATION_PLUGIN_HEADER } from '@kontourai/station-contracts/http';

/** Explicit header attribution only; no ambient identity or permission grant. */
export function getPluginHeaders(
  extraHeaders?: Record<string, string>,
  pluginName = '',
): Record<string, string> {
  return { ...extraHeaders, [STATION_PLUGIN_HEADER]: pluginName };
}
