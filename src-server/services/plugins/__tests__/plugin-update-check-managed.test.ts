/**
 * #4521 review: the plugin update check (the boot-time background check and
 * `GET /api/plugins/check-updates` both run `checkPluginUpdates`) asks every
 * registered plugin registry for its catalog. A registry outside
 * `limits.registries.allowedUrls` must not be contacted at all. `fetch` is a
 * recorder; the registry is the real manifest provider, registered the way
 * Station registers a configured one.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseManagedPolicyDocument,
  summarizeManagedPolicy,
} from '@kontourai/station-contracts/managed-policy';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { JsonManifestRegistryProvider } from '../../../providers/registries/json-manifest-registry.js';
import { registerManifestRegistryProvider } from '../../../providers/registries/register-manifest-registry.js';
import { clearAll } from '../../../providers/registries/registry.js';
import { installManagedCapabilityLimits } from '../../../security/managed-capability-limits.js';
import { checkPluginUpdates } from '../plugin-update-check.js';

const tempDir = trackTempDirs();
const CATALOG = 'https://unlisted-catalog.example/registry.json';
const logger = { debug: vi.fn() };

afterEach(() => {
  installManagedCapabilityLimits(null);
  clearAll();
  vi.unstubAllGlobals();
});

function recorder() {
  const requested: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      requested.push(url);
      return Response.json({
        version: 1,
        plugins: [
          {
            id: 'tracked-plugin',
            displayName: 'Tracked plugin',
            description: 'Installed from the catalog',
            version: '2.0.0',
            source: 'https://github.com/example/tracked-plugin',
          },
        ],
      });
    }),
  );
  return requested;
}

function setup() {
  clearAll();
  const home = tempDir('plugin-update-managed-');
  const pluginsDir = join(home, 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
  registerManifestRegistryProvider(
    new JsonManifestRegistryProvider(CATALOG, home),
    'configured',
  );
  return { home, pluginsDir };
}

test('control: without a policy the update check reads the catalog', async () => {
  const requested = recorder();
  const { pluginsDir } = setup();
  await checkPluginUpdates({ pluginsDir, logger });
  expect(requested).toContain(CATALOG);
});

test('a catalog outside allowedUrls gets zero requests from the update check', async () => {
  const parsed = parseManagedPolicyDocument({
    schemaVersion: 1,
    organization: 'Acme',
    limits: { registries: { allowedUrls: [] } },
  });
  if (!parsed.ok) throw new Error('fixture policy refused');
  installManagedCapabilityLimits({
    summary: summarizeManagedPolicy(parsed.document),
  });
  const requested = recorder();
  const { pluginsDir } = setup();
  expect(await checkPluginUpdates({ pluginsDir, logger })).toEqual({
    updates: [],
  });
  expect(requested).toEqual([]);
});
