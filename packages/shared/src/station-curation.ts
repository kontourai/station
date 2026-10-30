import type { ToolDef } from '@kontourai/station-contracts/tool';
import stationCuratedCatalog from './curated/station-mcp-subregistry.json' with {
  type: 'json',
};

export { stationCuratedCatalog };

/** Classification is derived only from Station's bundled endpoint catalog. */
export function stationCuratedContentTrust(
  def: Pick<ToolDef, 'endpoint'>,
): 'trusted' | 'untrusted' | undefined {
  if (!def.endpoint) return undefined;
  let endpoint: string;
  try {
    endpoint = new URL(def.endpoint).href;
  } catch {
    return undefined;
  }
  for (const entry of stationCuratedCatalog.servers) {
    const curation = entry._meta['ai.kontour.station/curation'];
    if (new URL(curation.remote).href === endpoint)
      return 'contentTrust' in curation && curation.contentTrust === 'untrusted'
        ? 'untrusted'
        : 'trusted';
  }
  return undefined;
}
