import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { readRegistryPluginAvailability } from '../../../routes/plugins/plugin-install-shared.js';
import { JsonManifestRegistryProvider } from '../json-manifest-registry.js';
import { registerManifestRegistryProvider } from '../register-manifest-registry.js';
import {
  clearAll,
  getAgentRegistryProvider,
  getIntegrationRegistryProvider,
  getPluginRegistryProviders,
} from '../registry.js';

describe('registerManifestRegistryProvider', () => {
  afterEach(() => clearAll());

  test.each([
    ['bundled', 'Bundled examples'],
    ['configured', 'Configured registry'],
  ] as const)(
    'exposes a %s manifest through every registry surface with the truthful plugin source',
    async (origin, source) => {
      const provider = new JsonManifestRegistryProvider(
        join(process.cwd(), 'examples', 'registry', 'manifest.json'),
        process.cwd(),
      );

      registerManifestRegistryProvider(provider, origin);

      expect(getAgentRegistryProvider()).toBe(provider);
      expect(
        await getIntegrationRegistryProvider().listAvailable(),
      ).not.toBeNull();
      expect(getPluginRegistryProviders()).toEqual([
        expect.objectContaining({ provider, source }),
      ]);

      await expect(
        readRegistryPluginAvailability(process.cwd()),
      ).resolves.toContainEqual(
        expect.objectContaining({ id: 'minimal-layout', source }),
      );
    },
  );
});
