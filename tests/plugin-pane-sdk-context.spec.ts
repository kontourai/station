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
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { authenticatedE2EFetch } from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';
import { installRegistryPluginWithConsent } from './helpers/install-plugin';

const api = resolveE2EApiBase();
const pluginId = 'minimal-layout';
const projectSlug = 'plugin-pane-sdk-context';
const rendererName = 'minimal-workspace';

let workspaceDir = '';
let descriptorName = '';

async function installedRegistryPluginIds(): Promise<string[]> {
  const response = await authenticatedE2EFetch(
    `${api}/api/registry/plugins/installed`,
  );
  expect(response.ok).toBe(true);
  const body = (await response.json()) as {
    success?: boolean;
    data?: Array<{ id?: string }>;
  };
  expect(body.success).toBe(true);
  return (body.data ?? []).flatMap((entry) =>
    typeof entry.id === 'string' ? [entry.id] : [],
  );
}

async function removePlugin() {
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
  test.describe.configure({ mode: 'serial', timeout: 60_000 });

  test.beforeAll(async () => {
    if ((await installedRegistryPluginIds()).includes(pluginId)) {
      await removePlugin();
    }
    await removeProject();

    const installed = await installRegistryPluginWithConsent(api, pluginId);
    expect(installed.success).toBe(true);
    expect(await installedRegistryPluginIds()).toContain(pluginId);

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

    const catalogResponse = await authenticatedE2EFetch(
      `${api}/api/projects/${projectSlug}/panes`,
    );
    expect(catalogResponse.ok).toBe(true);
    const catalogPayload = (await catalogResponse.json()) as {
      success?: boolean;
      data?: {
        projectId: string;
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
    const descriptor = catalog.descriptors.find(
      (candidate) =>
        candidate.provenance.pluginId === pluginId &&
        candidate.renderer.kind === 'plugin-component' &&
        candidate.renderer.name === rendererName,
    );
    expect(descriptor).toBeDefined();
    descriptorName = descriptor!.name;
    expect(
      catalog.instances.find(
        (instance) => instance.descriptorId === descriptor!.id,
      ),
    ).toMatchObject({ boundContext: { projectId: catalog.projectId } });
  });

  test.afterAll(async () => {
    await removeProject();
    if ((await installedRegistryPluginIds()).includes(pluginId)) {
      await removePlugin();
    }
    expect(await installedRegistryPluginIds()).not.toContain(pluginId);
    if (workspaceDir) rmSync(workspaceDir, { recursive: true, force: true });
  });

  test('opens the Registry-installed renderer with live Agent, navigation, and toast contexts', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      localStorage.setItem('station:onboarding-setup-dismissed', '1');
    });
    await page.goto(`/projects/${projectSlug}`);
    await page.getByRole('button', { name: '+ Add pane', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add workspace pane' });
    const card = dialog
      .getByRole('listitem')
      .filter({ has: page.getByText(descriptorName, { exact: true }) });
    await card
      .getByRole('button', { name: `Open ${descriptorName}` })
      .click({ timeout: 20_000 });

    await expect(page).toHaveURL(/\/panes\//);
    await expect(
      page.getByText('Minimal plugin starter', { exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByRole('heading', { name: 'Discovered agents' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Open Chat Dock' }).click();
    await expect(
      page.getByText('Chat dock opened', { exact: true }),
    ).toBeVisible();
  });
});
