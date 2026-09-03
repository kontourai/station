/**
 * Direct plugin Pane SDK-context proof (#1371).
 *
 * This is the exact failed #265 journey: Registry preview/install, a real
 * Project-issued occurrence, explicit Add pane selection, and actual renderer
 * output from `minimal-layout`, whose public SDK hooks require the canonical
 * SDKAdapter context graph.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { authenticatedE2EFetch } from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';
import {
  installPluginWithConsent,
  installRegistryPluginWithConsent,
} from './helpers/install-plugin';

const api = resolveE2EApiBase();
const projectSlug = 'plugin-pane-sdk-context';
const plugins = [
  {
    id: 'minimal-layout',
    rendererName: 'minimal-workspace',
    expectedText: 'Minimal plugin starter',
  },
  {
    id: 'builder-delivery-viewer',
    source: resolve('examples/builder-delivery-viewer'),
    rendererName: 'builder-delivery-viewer-main',
    expectedText:
      "Builder artifacts unavailable: Plugin 'builder-delivery-viewer' does not have plugin.server permission",
  },
  {
    id: 'knowledge-docs-starter',
    rendererName: 'knowledge-library',
    expectedText: 'Document library',
  },
] as const;

let workspaceDir = '';
const descriptorNames = new Map<string, string>();

async function installedPluginIds(): Promise<string[]> {
  const response = await authenticatedE2EFetch(`${api}/api/plugins`);
  expect(response.ok).toBe(true);
  const body = (await response.json()) as {
    plugins?: Array<{ name?: string }>;
  };
  return (body.plugins ?? []).flatMap((entry) =>
    typeof entry.name === 'string' ? [entry.name] : [],
  );
}

async function removePlugin(pluginId: string) {
  const response = await authenticatedE2EFetch(
    `${api}/api/registry/plugins/${pluginId}`,
    { method: 'DELETE' },
  );
  if (response.status !== 404) expect(response.ok).toBe(true);
}

async function removeProject() {
  const response = await authenticatedE2EFetch(
    `${api}/api/projects/${projectSlug}`,
    { method: 'DELETE' },
  );
  if (response.status !== 404) expect(response.ok).toBe(true);
}

test.describe('direct plugin Pane SDK context', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  test.beforeAll(async () => {
    const initiallyInstalled = await installedPluginIds();
    for (const { id } of plugins) {
      if (initiallyInstalled.includes(id)) await removePlugin(id);
    }
    await removeProject();

    for (const plugin of plugins) {
      const installed =
        'source' in plugin
          ? await installPluginWithConsent(api, plugin.source)
          : await installRegistryPluginWithConsent(api, plugin.id);
      expect(installed.success).toBe(true);
    }
    expect(await installedPluginIds()).toEqual(
      expect.arrayContaining(plugins.map(({ id }) => id)),
    );

    workspaceDir = mkdtempSync(join(tmpdir(), 'station-pane-sdk-context-'));
    const projectResponse = await authenticatedE2EFetch(`${api}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Plugin Pane SDK Context',
        slug: projectSlug,
        workingDirectory: workspaceDir,
      }),
    });
    expect(projectResponse.status).toBe(201);
    const layoutResponse = await authenticatedE2EFetch(
      `${api}/api/projects/${projectSlug}/layouts/apply`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ layoutId: 'builtin:coding' }),
      },
    );
    expect(layoutResponse.status).toBe(201);

    const catalogResponse = await authenticatedE2EFetch(
      `${api}/api/projects/${projectSlug}/panes`,
    );
    expect(catalogResponse.ok).toBe(true);
    const catalogPayload = (await catalogResponse.json()) as {
      success?: boolean;
      data?: {
        projectId: string;
        projectSlug: string;
        descriptors: Array<{
          id: string;
          name: string;
          renderer: { kind: string; name?: string };
          provenance: { pluginId?: string };
        }>;
        instances: Array<{
          descriptorId: string;
          boundContext?: { projectId?: string };
        }>;
      };
    };
    expect(catalogPayload.success).toBe(true);
    const catalog = catalogPayload.data!;
    expect(catalog.projectSlug).toBe(projectSlug);
    for (const plugin of plugins) {
      const descriptor = catalog.descriptors.find(
        (candidate) =>
          candidate.provenance.pluginId === plugin.id &&
          candidate.renderer.kind === 'plugin-component' &&
          candidate.renderer.name === plugin.rendererName,
      );
      expect(descriptor, `${plugin.id} descriptor`).toBeDefined();
      descriptorNames.set(plugin.id, descriptor!.name);
      expect(
        catalog.instances.find(
          (instance) => instance.descriptorId === descriptor!.id,
        ),
      ).toMatchObject({ boundContext: { projectId: catalog.projectId } });
    }
  });

  test.afterAll(async ({ browserName: _browserName }, testInfo) => {
    const cleanupFailures: string[] = [];
    try {
      await removeProject();
    } catch (error) {
      cleanupFailures.push(`project: ${String(error)}`);
    }
    for (const { id } of plugins) {
      try {
        if ((await installedPluginIds()).includes(id)) {
          await removePlugin(id);
        }
      } catch (error) {
        cleanupFailures.push(`${id}: ${String(error)}`);
      }
    }
    try {
      const remaining = await installedPluginIds();
      for (const { id } of plugins) {
        if (remaining.includes(id))
          cleanupFailures.push(`${id}: still installed`);
      }
    } catch (error) {
      cleanupFailures.push(`inventory: ${String(error)}`);
    } finally {
      if (workspaceDir) rmSync(workspaceDir, { recursive: true, force: true });
    }
    if (cleanupFailures.length) {
      const report = `Cleanup failures: ${cleanupFailures.join('; ')}`;
      if (testInfo.status !== testInfo.expectedStatus) console.error(report);
      else throw new Error(report);
    }
  });

  test('opens the Registry-installed renderer with live Agent, navigation, and toast contexts', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('station:onboarding-setup-dismissed', '1');
    });
    for (const plugin of plugins) {
      const descriptorName = descriptorNames.get(plugin.id)!;
      await page.goto(`/projects/${projectSlug}`);
      await page
        .getByRole('button', { name: '+ Add pane', exact: true })
        .click();
      const dialog = page.getByRole('dialog', { name: 'Add workspace pane' });
      const card = dialog
        .getByRole('listitem')
        .filter({ has: page.getByText(descriptorName, { exact: true }) });
      await card
        .getByRole('button', { name: `Open ${descriptorName}` })
        .click({ timeout: 20_000 });
      await expect(page).toHaveURL(/\/panes\//);
      await expect(
        page.getByText(plugin.expectedText, { exact: true }),
      ).toBeVisible({
        timeout: 20_000,
      });
    }

    await page.goto(`/projects/${projectSlug}`);
    await page.getByRole('button', { name: '+ Add pane', exact: true }).click();
    const minimalName = descriptorNames.get('minimal-layout')!;
    await page
      .getByRole('dialog', { name: 'Add workspace pane' })
      .getByRole('listitem')
      .filter({ has: page.getByText(minimalName, { exact: true }) })
      .getByRole('button', { name: `Open ${minimalName}` })
      .click();
    await page.getByRole('button', { name: 'Open Chat Dock' }).click();
    await expect(
      page.getByText('Chat dock opened', { exact: true }),
    ).toBeVisible();
  });

  test('places the trusted plugin occurrence in WorkspacePaneHost with the same SDK context', async ({
    page,
  }) => {
    await page.goto(`/projects/${projectSlug}/layouts/coding`);
    await page.getByRole('button', { name: /Pane actions for Files/i }).click();
    await page.getByRole('menuitem', { name: 'Open pane catalog' }).click();
    const builder = plugins.find(
      (plugin) => plugin.id === 'builder-delivery-viewer',
    )!;
    const builderName = descriptorNames.get(builder.id)!;
    const picker = page.getByRole('dialog', { name: 'Add workspace pane' });
    await picker
      .getByRole('listitem')
      .filter({ has: page.getByText(builderName, { exact: true }) })
      .getByRole('button', { name: `Open ${builderName}` })
      .click();
    await expect(
      page.getByText(builder.expectedText, { exact: true }),
    ).toBeVisible({
      timeout: 20_000,
    });
    await expect(page).toHaveURL(`/projects/${projectSlug}/layouts/coding`);
  });
});
