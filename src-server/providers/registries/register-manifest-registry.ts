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
 */
export function registerManifestRegistryProvider(
  provider: JsonManifestRegistryProvider,
  origin: ManifestRegistrySourceOrigin,
): void {
  registerAgentRegistryProvider(provider);
  registerIntegrationRegistryProvider(provider.integrationRegistry());
  registerPluginRegistryProvider(
    provider,
    manifestRegistrySourceLabels[origin],
  );
}
