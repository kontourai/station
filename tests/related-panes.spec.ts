/**
 * Related panes from an installed plugin (docs/design/pane-relationships.md):
 * the `related-reports` example, built and installed through real preview and
 * consent, opens its own report panes beside its list through the SDK's
 * related-pane capability on a real Station. The journey covers open,
 * replace, focus, Keep, close, a tool landing with the Tools, the occurrence
 * surviving a reload, and the plugin's removal leaving its pane unavailable
 * rather than running stale code.
 *
 * The frame tier's transport is covered where its boundary is
 * (`framePaneHost.test.tsx`, the SDK client test and the bootstrap relay
 * test); this journey runs the direct tier end to end.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { authenticatedE2EFetch } from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';
import {
  buildExamplePlugin,
  installPluginWithConsent,
} from './helpers/install-plugin';
import { expectRegionTabs } from './helpers/region-placement';

const api = resolveE2EApiBase();
const pluginId = 'related-reports';
const pluginDir = resolve('examples/related-reports');
const projectSlug = 'related-panes-journey';
const reportsDescriptor = 'pane:plugin%3Arelated-reports:reports';

let workspaceDir = '';
let reportsRoute = '';

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

function reports(page: Page) {
  return page.getByRole('region', { name: 'Related reports' });
}

async function openFromList(page: Page, label: string) {
  await reports(page).getByRole('button', { name: label, exact: true }).click();
}

test.describe('related panes from an installed plugin', () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  test.beforeAll(async () => {
    test.setTimeout(240_000);
    await removePlugin();
    await removeProject();
    buildExamplePlugin(pluginDir);
    const installed = await installPluginWithConsent(api, pluginDir);
    expect(installed.success).toBe(true);

    workspaceDir = mkdtempSync(join(tmpdir(), 'station-related-panes-'));
    const created = await authenticatedE2EFetch(`${api}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Related Panes Journey',
        slug: projectSlug,
        workingDirectory: workspaceDir,
      }),
    });
    expect(created.status).toBe(201);

    const catalogResponse = await authenticatedE2EFetch(
      `${api}/api/projects/${projectSlug}/panes`,
    );
    expect(catalogResponse.ok).toBe(true);
    const catalog = (
      (await catalogResponse.json()) as {
        data: {
          instances: Array<{ instanceId: string; descriptorId: string }>;
        };
      }
    ).data;
    const occurrence = catalog.instances.find(
      (instance) => instance.descriptorId === reportsDescriptor,
    );
    expect(occurrence, 'the Project issues a Reports occurrence').toBeDefined();
    reportsRoute = `/projects/${projectSlug}/panes/${encodeURIComponent(reportsDescriptor)}/${encodeURIComponent(occurrence!.instanceId)}`;
  });

  test.afterAll(async () => {
    try {
      await removeProject();
      await removePlugin();
    } finally {
      if (workspaceDir) rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  test('opens, replaces, focuses, keeps and closes its own report panes beside the list', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(() => {
      localStorage.setItem('station:onboarding-setup-dismissed', '1');
    });
    await page.goto(reportsRoute);
    await expect(
      reports(page).getByRole('heading', { name: 'Reports' }),
    ).toBeVisible({ timeout: 30_000 });
    const status = reports(page).getByRole('status');

    // Open: beside the list, with the way back to it and the preview's Keep.
    await openFromList(page, 'Open Weekly report');
    await expect(status).toHaveText('Weekly report: opened, beside.');
    const weekly = page.getByRole('article', { name: 'Weekly report' });
    await expect(weekly).toBeVisible();
    await expect(weekly).toContainText('Seven days of work, summarised.');
    await expect(
      page.getByRole('button', { name: 'Up to Reports', exact: true }),
    ).toBeVisible();

    // Another report replaces the one preview; the same report focuses it.
    await openFromList(page, 'Open Monthly report');
    await expect(status).toHaveText('Monthly report: replaced, beside.');
    await expect(
      page.getByRole('article', { name: 'Monthly report' }),
    ).toBeVisible();
    await expect(weekly).toHaveCount(0);
    await openFromList(page, 'Open Monthly report');
    await expect(status).toHaveText('Monthly report: focused, beside.');

    // Keep it: the next report opens beside it instead of replacing it.
    await page.getByRole('button', { name: 'Keep open', exact: true }).click();
    await expect(
      page.getByRole('button', { name: 'Keep open', exact: true }),
    ).toHaveCount(0);
    await openFromList(page, 'Open Weekly report');
    await expect(status).toHaveText('Weekly report: opened, beside.');
    await expectRegionTabs(
      page,
      ['Monthly report', 'Weekly report'],
      'Weekly report',
    );

    // Close what this pane opened.
    await reports(page)
      .getByRole('button', { name: 'Close report', exact: true })
      .click();
    await expect(status).toHaveText('Report closed.');
    await expect(
      page.getByRole('article', { name: 'Weekly report' }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('article', { name: 'Monthly report' }),
    ).toBeVisible();

    // A tool lands with the Tools, not beside the list.
    await reports(page)
      .getByRole('button', { name: 'Open report log', exact: true })
      .click();
    await expect(status).toHaveText('Report log: opened, tool.');
    await expect(
      page.getByRole('region', { name: 'Report log' }),
    ).toBeVisible();

    // The kept report is the same occurrence after a reload.
    await page.reload();
    await expect(
      page.getByRole('article', { name: 'Monthly report' }),
    ).toBeVisible({ timeout: 30_000 });
  });

  test('a removed plugin’s related pane stays, unavailable, and runs no plugin code', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(() => {
      localStorage.setItem('station:onboarding-setup-dismissed', '1');
    });
    await page.goto(reportsRoute);
    await expect(
      page.getByRole('article', { name: 'Monthly report' }),
    ).toBeVisible({ timeout: 30_000 });
    await removePlugin();
    // The Project is still the dock's; its catalog no longer offers the
    // plugin, so the kept occurrence renders its placeholder.
    await page.reload();
    await expect(
      page.getByText('This plugin pane is unavailable', { exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByRole('article', { name: 'Monthly report' }),
    ).toHaveCount(0);
  });
});
