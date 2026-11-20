import type { JsonManifestRegistryProvider } from './json-manifest-registry.js';
import {
  BUNDLED_MANIFEST_REGISTRY_SOURCE,
  registerAgentRegistryProvider,
  registerIntegrationRegistryProvider,
  registerPluginRegistryProvider,
} from './registry.js';

const manifestRegistrySourceLabels = {
  bundled: BUNDLED_MANIFEST_REGISTRY_SOURCE,
  configured: 'Configured registry',
} as const;

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
): void {
  // The provider owns its origin (#4521): its manifest reader admits the
  // location, so the labels here cannot disagree with what it reads.
  const bundled = provider.origin.bundled === true;
  const origin = bundled ? 'bundled' : 'configured';
  registerAgentRegistryProvider(
    provider.agentRegistry(),
    manifestRegistrySourceLabels[origin],
  );
  registerIntegrationRegistryProvider(provider.integrationRegistry(), {
    bundled,
  });
  registerPluginRegistryProvider(
    provider,
    manifestRegistrySourceLabels[origin],
  );
}
