import { join } from 'node:path';
import { expect, test } from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';
import {
  installPluginWithConsent,
  previewPluginForInstall,
} from './helpers/install-plugin';

const API = resolveE2EApiBase();
const PARENT = 'dependency-parent-fixture';
const PROVIDER = 'dependency-provider-fixture';
const SOURCE = join(
  import.meta.dirname,
  'fixtures',
  'plugin-dependency-lifecycle',
  'parent',
);

// A test-only API lifecycle fixture, not the Enterprise product journey. The
// actual Enterprise example retains all legacy layout declarations pending its
// separately owned semantics-preserving migration and browser qualification.
test.describe
  .serial('Plugin dependency lifecycle fixture', () => {
    test.describe.configure({ timeout: 90_000 });

    test.beforeAll(async ({ authenticatedRequest }) => {
      await authenticatedRequest.delete(`${API}/api/plugins/${PARENT}`);
      await authenticatedRequest.delete(`${API}/api/plugins/${PROVIDER}`);
    });

    test.afterAll(async ({ authenticatedRequest }) => {
      await authenticatedRequest.delete(`${API}/api/plugins/${PARENT}`);
      await authenticatedRequest.delete(`${API}/api/plugins/${PROVIDER}`);
    });

    test('preview-bound install projects pending provider permission and removes each owned plugin', async ({
      authenticatedRequest,
    }) => {
      const preview = await previewPluginForInstall(API, SOURCE);
      expect(preview.dependencies).toContainEqual(
        expect.objectContaining({
          id: PROVIDER,
          consent: expect.objectContaining({
            contentDigest: expect.any(String),
            permissions: expect.arrayContaining(['providers.register']),
          }),
        }),
      );
      const installed = await installPluginWithConsent(API, SOURCE);
      expect(installed).toMatchObject({
        success: true,
        plugin: { name: PARENT },
        dependencies: [{ id: PROVIDER, status: 'installed' }],
      });

      const collection = await authenticatedRequest.get(`${API}/api/plugins`);
      expect(collection.status()).toBe(200);
      const plugins = (await collection.json()).plugins as Array<{
        name: string;
        hasSettings: boolean;
        permissions?: {
          granted: string[];
          missing: Array<{ permission: string }>;
        };
      }>;
      for (const name of [PARENT, PROVIDER]) {
        expect(plugins.map((plugin) => plugin.name)).toContain(name);
      }
      expect(plugins.find((plugin) => plugin.name === PROVIDER)).toMatchObject({
        hasSettings: true,
        permissions: {
          granted: expect.not.arrayContaining(['providers.register']),
          missing: expect.arrayContaining([
            expect.objectContaining({ permission: 'providers.register' }),
          ]),
        },
      });
      // This asserts declared permission/settings projection only. The throwing
      // fixture factory is not an invocation receipt: a loader could catch it.
      const settings = await authenticatedRequest.get(
        `${API}/api/plugins/${PROVIDER}/settings`,
      );
      expect(settings.status()).toBe(200);
      expect((await settings.json()).schema).toContainEqual(
        expect.objectContaining({ key: 'fixtureLabel', type: 'text' }),
      );

      const removed = await authenticatedRequest.delete(
        `${API}/api/plugins/${PARENT}`,
      );
      expect(removed.status()).toBe(200);
      const afterRemoval = await authenticatedRequest.get(`${API}/api/plugins`);
      expect(afterRemoval.status()).toBe(200);
      const remainingNames = (
        (await afterRemoval.json()).plugins as Array<{ name: string }>
      ).map((plugin) => plugin.name);
      for (const name of [PARENT, PROVIDER]) {
        // Each must be absent before afterAll's defensive fixture cleanup.
        expect(remainingNames).not.toContain(name);
        for (const declaration of ['settings', 'providers']) {
          const response = await authenticatedRequest.get(
            `${API}/api/plugins/${name}/${declaration}`,
          );
          expect(response.status()).toBe(404);
        }
      }
      // A source install creates no registry alias; declaration 404 is not an
      // active-provider or external-effect drain receipt. Registry-backed local
      // lifecycle integration tests separately exercise aliases and providers.
    });
  });
