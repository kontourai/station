import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';
import { installPluginWithConsent } from './helpers/install-plugin';

const API = resolveE2EApiBase();
const ENTERPRISE_SOURCE = join(
  import.meta.dirname,
  '..',
  'examples',
  'enterprise-layout',
);
const PROJECT_SLUG = 'enterprise-dependency-lifecycle';
let workingDirectory = '';

test.describe
  .serial('Enterprise dependency lifecycle', () => {
    test.describe.configure({ timeout: 90_000 });

    test.beforeAll(async ({ authenticatedRequest }) => {
      workingDirectory = mkdtempSync(
        join(tmpdir(), 'station-enterprise-pane-'),
      );
      await authenticatedRequest.delete(`${API}/api/projects/${PROJECT_SLUG}`);
      await authenticatedRequest.delete(`${API}/api/plugins/enterprise-layout`);
      await authenticatedRequest.delete(`${API}/api/plugins/shared-providers`);
    });

    test.afterAll(async ({ authenticatedRequest }) => {
      await authenticatedRequest.delete(`${API}/api/projects/${PROJECT_SLUG}`);
      await authenticatedRequest.delete(`${API}/api/plugins/enterprise-layout`);
      await authenticatedRequest.delete(`${API}/api/plugins/shared-providers`);
      if (workingDirectory) {
        rmSync(workingDirectory, { recursive: true, force: true });
      }
    });

    test('clean install issues a Project Dashboard occurrence and removes owned dependency state', async ({
      page,
      authenticatedRequest,
    }) => {
      const installed = await installPluginWithConsent(API, ENTERPRISE_SOURCE);
      expect(installed).toMatchObject({
        success: true,
        plugin: { name: 'enterprise-layout' },
        dependencies: [{ id: 'shared-providers', status: 'installed' }],
      });

      const installedList = await authenticatedRequest.get(
        `${API}/api/plugins`,
      );
      expect(installedList.status()).toBe(200);
      const plugins = (await installedList.json()).plugins as Array<{
        name: string;
        hasSettings: boolean;
        providers?: Array<{ type: string; module: string }>;
        permissions?: {
          granted: string[];
          missing: Array<{ permission: string }>;
        };
      }>;
      expect(plugins.map((plugin) => plugin.name)).toEqual(
        expect.arrayContaining(['enterprise-layout', 'shared-providers']),
      );
      expect(
        plugins.find((plugin) => plugin.name === 'shared-providers'),
      ).toMatchObject({
        hasSettings: true,
        providers: expect.arrayContaining([
          { type: 'auth', module: './providers/oauth-auth.js' },
        ]),
        permissions: {
          granted: expect.not.arrayContaining(['providers.register']),
          missing: expect.arrayContaining([
            expect.objectContaining({ permission: 'providers.register' }),
          ]),
        },
      });
      const dependencySettings = await authenticatedRequest.get(
        `${API}/api/plugins/shared-providers/settings`,
      );
      expect(dependencySettings.status()).toBe(200);
      expect((await dependencySettings.json()).schema).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: 'authDomain', type: 'text' }),
        ]),
      );

      const created = await authenticatedRequest.post(`${API}/api/projects`, {
        data: {
          name: 'Enterprise dependency lifecycle',
          slug: PROJECT_SLUG,
          workingDirectory,
        },
      });
      expect(created.status()).toBe(201);

      await page.goto(`/projects/${PROJECT_SLUG}`);
      await page.getByRole('button', { name: /Add pane/i }).click();
      const picker = page.getByRole('dialog', { name: 'Add workspace pane' });
      await expect(picker).toBeVisible({ timeout: 20_000 });
      await picker.getByRole('button', { name: /Open Dashboard/i }).click();

      const catalogResponse = await authenticatedRequest.get(
        `${API}/api/projects/${PROJECT_SLUG}/panes`,
      );
      expect(catalogResponse.status()).toBe(200);
      const catalog = (await catalogResponse.json()).data as {
        descriptors: Array<{ id: string; name: string }>;
        instances: Array<{ instanceId: string; descriptorId: string }>;
      };
      const dashboard = catalog.descriptors.find(
        (descriptor) => descriptor.name === 'Dashboard',
      );
      expect(dashboard).toBeTruthy();
      expect(catalog.instances).toContainEqual(
        expect.objectContaining({
          instanceId: expect.any(String),
          descriptorId: dashboard?.id,
        }),
      );

      const rendered = page.getByRole('heading', { name: 'Quick Actions' });
      // This is the product journey, not a host-error diagnostic. Until the
      // canonical Pane composition supports it (#1371), this proof is pending;
      // a visible failure must never count as a rendered Enterprise Dashboard.
      await expect(rendered).toBeVisible({ timeout: 20_000 });

      const removed = await authenticatedRequest.delete(
        `${API}/api/plugins/enterprise-layout`,
      );
      expect(removed.status()).toBe(200);
      const afterRemoval = await authenticatedRequest.get(`${API}/api/plugins`);
      expect(afterRemoval.status()).toBe(200);
      const remainingNames = (
        (await afterRemoval.json()).plugins as Array<{ name: string }>
      ).map((plugin) => plugin.name);
      for (const name of ['enterprise-layout', 'shared-providers']) {
        // Negating arrayContaining([parent, dependency]) also passes when one
        // survives. Verify each before afterAll's defensive fixture cleanup.
        expect(remainingNames).not.toContain(name);
        const settings = await authenticatedRequest.get(
          `${API}/api/plugins/${name}/settings`,
        );
        expect(settings.status()).toBe(404);
        const providers = await authenticatedRequest.get(
          `${API}/api/plugins/${name}/providers`,
        );
        expect(providers.status()).toBe(404);
      }
      // This source install creates no registry alias, and the dependency's
      // providers.register permission stays pending above. Active-provider and
      // alias retirement are separately exercised by the registry-backed
      // install/remove integration test, not inferred from manifest absence.
    });
  });
