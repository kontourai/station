/**
 * Direct plugin Pane SDK-context proof (#1371).
 *
 * Real preview/consent/install, a Project-issued occurrence, explicit Add pane
 * selection, and genuine public SDK hooks in direct and placed hosts. The
 * test-only plugin deliberately does not migrate first-party examples or claim
 * global-action/default-Agent semantics (https://github.com/kontourai/station/issues/1372).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { authenticatedE2EFetch } from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';
import { installPluginWithConsent } from './helpers/install-plugin';

const api = resolveE2EApiBase();
const projectSlug = 'plugin-pane-sdk-context';
const plugins = [
  {
    id: 'pane-sdk-context-proof',
    source: resolve('tests/fixtures/plugin-pane-sdk-context'),
    rendererName: 'pane-sdk-context-proof',
    expectedText: 'Installed Pane SDK proof',
  },
] as const;

let workspaceDir = '';
const descriptorNames = new Map<string, string>();
const occurrenceIds = new Map<string, string>();
let catalogProjectId = '';
let appliedLayoutId = '';

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
    // Playwright gives beforeAll its own timeout; describe.configure only
    // sets the test-body budget. The real preview/consent/install journey
    // must settle before cleanup or any renderer assertion can begin.
    test.setTimeout(180_000);
    const initiallyInstalled = await installedPluginIds();
    for (const { id } of plugins) {
      if (initiallyInstalled.includes(id)) await removePlugin(id);
    }
    await removeProject();

    for (const plugin of plugins) {
      await test.step(`Preview and install ${plugin.id}`, async () => {
        const installed = await installPluginWithConsent(api, plugin.source);
        expect(installed.success).toBe(true);
      });
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
    const applied = (await layoutResponse.json()) as { data: { id: string } };
    appliedLayoutId = applied.data.id;
    expect(appliedLayoutId).toBeTruthy();

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
          instanceId: string;
          descriptorId: string;
          boundContext?: { projectId?: string };
        }>;
      };
    };
    expect(catalogPayload.success).toBe(true);
    const catalog = catalogPayload.data!;
    catalogProjectId = catalog.projectId;
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
      occurrenceIds.set(
        plugin.id,
        catalog.instances.find(
          (instance) => instance.descriptorId === descriptor!.id,
        )!.instanceId,
      );
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

  test('opens the installed renderer with live Agent, navigation, and toast contexts', async ({
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
      const proof = page.getByRole('region', {
        name: 'Installed Pane SDK proof',
      });
      await expect(
        proof.getByText(`Plugin: ${plugin.id}`, { exact: true }),
      ).toBeVisible();
      await expect(
        proof.getByText(`Project: ${projectSlug}`, { exact: true }),
      ).toBeVisible();
      await expect(
        proof.getByText(`Occurrence: ${occurrenceIds.get(plugin.id)}`, {
          exact: true,
        }),
      ).toBeVisible();
      await expect(proof.getByText(/^Discovered Agents: \d+$/)).toBeVisible();
    }

    await page.goto(`/projects/${projectSlug}`);
    await page.getByRole('button', { name: '+ Add pane', exact: true }).click();
    const descriptorName = descriptorNames.get('pane-sdk-context-proof')!;
    await page
      .getByRole('dialog', { name: 'Add workspace pane' })
      .getByRole('listitem')
      .filter({ has: page.getByText(descriptorName, { exact: true }) })
      .getByRole('button', { name: `Open ${descriptorName}` })
      .click();
    await page.getByRole('button', { name: 'Open Chat Dock' }).click();
    await expect(
      page.getByText('Pane proof chat dock opened', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Chat dock: open', { exact: true }),
    ).toBeVisible();
  });

  test('places the trusted plugin occurrence in WorkspacePaneHost with the same SDK context', async ({
    page,
    baseURL,
  }) => {
    const expectedHost = new URL(
      `/projects/${projectSlug}/layouts/coding`,
      baseURL,
    );
    await page.goto(expectedHost.href);
    // Coding is the initial catalog-issued tab; Files is the intended placement
    // origin, not an implicit fallback after invalid context records are lost.
    await expect(
      page.getByRole('tab', { name: 'Coding', exact: true }),
    ).toBeVisible({ timeout: 20_000 });
    await page
      .getByRole('tab', { name: 'Files', exact: true })
      .click({ timeout: 20_000 });
    await page
      .getByRole('button', { name: /Pane actions for Files/i })
      .click({ timeout: 20_000 });
    await page.getByRole('menuitem', { name: 'Open pane catalog' }).click();
    const plugin = plugins[0];
    const descriptorName = descriptorNames.get(plugin.id)!;
    const picker = page.getByRole('dialog', { name: 'Add workspace pane' });
    await picker
      .getByRole('listitem')
      .filter({ has: page.getByText(descriptorName, { exact: true }) })
      .getByRole('button', { name: `Open ${descriptorName}` })
      .click();
    await expect(
      page.getByText(plugin.expectedText, { exact: true }),
    ).toBeVisible({
      timeout: 20_000,
    });
    const proof = page.getByRole('region', {
      name: 'Installed Pane SDK proof',
    });
    await expect(
      proof.getByText(`Plugin: ${plugin.id}`, { exact: true }),
    ).toBeVisible();
    await expect(
      proof.getByText(`Project: ${projectSlug}`, { exact: true }),
    ).toBeVisible();
    await expect(
      proof.getByText(`Occurrence: ${occurrenceIds.get(plugin.id)}`, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(proof.getByText(/^Discovered Agents: \d+$/)).toBeVisible();
    await expect(page).toHaveURL(
      (url) =>
        url.origin === expectedHost.origin &&
        url.pathname === `/projects/${projectSlug}/layouts/coding` &&
        url.searchParams.get('pane') === occurrenceIds.get(plugin.id) &&
        url.searchParams.get('paneScope') ===
          JSON.stringify(['project', catalogProjectId, appliedLayoutId]),
    );
  });
});
