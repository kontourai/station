import type { JsonManifestRegistryProvider } from './json-manifest-registry.js';
import {
  registerAgentRegistryProvider,
  registerIntegrationRegistryProvider,
  registerPluginRegistryProvider,
} from './registry.js';

const manifestRegistrySourceLabels = {
  bundled: 'Bundled examples',
  configured: 'Configured registry',
} as const;

type ManifestRegistrySourceOrigin = keyof typeof manifestRegistrySourceLabels;

/**
 * A JSON manifest is one catalog exposed through three public registry
 * surfaces. Keep registration atomic so a fresh install cannot show agents
 * and integrations while silently omitting plugins.
 *
 * Each surface gets the VIEW of the catalog it names, never the whole
 * manifest: the agent surface received the provider itself, whose
 * `listAvailable` returned `manifest.plugins`, so a catalog of layout plugins
 * browsed under "Agents" (#1536 D2) exactly as manifest `tools` once browsed
 * under Plugins.
 */
export function registerManifestRegistryProvider(
  provider: JsonManifestRegistryProvider,
  origin: ManifestRegistrySourceOrigin,
): void {
  registerAgentRegistryProvider(provider.agentRegistry());
  registerIntegrationRegistryProvider(provider.integrationRegistry());
  registerPluginRegistryProvider(
    provider,
    manifestRegistrySourceLabels[origin],
  );
}
