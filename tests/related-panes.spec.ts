/**
 * Related panes from an installed plugin (docs/design/pane-relationships.md):
 * the `related-reports` example, built and installed through real preview and
 * consent, opens its own report panes beside its list through the SDK's
 * related-pane capability on a real Station. One journey, because what it
 * proves is per device: open, replace, focus, Keep, close, the kept
 * occurrence surviving a reload, a tool landing with the Tools, the
 * plugin's removal leaving its panes unavailable rather than running stale
 * code, and a reinstall of the same version not bringing them back.
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

  test('a real SDK plugin child names its captured Reports opener in the phone Back control', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(reportsRoute);
    await expect(
      reports(page).getByRole('heading', { name: 'Reports' }),
    ).toBeVisible({ timeout: 30_000 });
    await openFromList(page, 'Open Weekly report');
    await expect(
      page.getByRole('article', { name: 'Weekly report' }),
    ).toContainText('Seven days of work, summarised.');
    await page
      .getByRole('button', { name: 'Back to Reports', exact: true })
      .click();
    await expect(
      page.getByRole('article', { name: 'Weekly report' }),
    ).toHaveCount(0);
    await expect(
      reports(page).getByRole('heading', { name: 'Reports' }),
    ).toBeVisible();
  });

  test('opens, replaces, focuses, keeps and closes its own report panes, and a removed plugin’s pane runs no plugin code', async ({
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

    await test.step('open beside the list, with the way back and Keep', async () => {
      await openFromList(page, 'Open Weekly report');
      await expect(status).toHaveText('Weekly report: opened, beside.');
      const weekly = page.getByRole('article', { name: 'Weekly report' });
      await expect(weekly).toBeVisible();
      await expect(weekly).toContainText('Seven days of work, summarised.');
      await expect(
        page.getByRole('button', { name: 'Up to Reports', exact: true }),
      ).toBeVisible();
    });

    await test.step('another report replaces the preview; the same one focuses it', async () => {
      await openFromList(page, 'Open Monthly report');
      await expect(status).toHaveText('Monthly report: replaced, beside.');
      await expect(
        page.getByRole('article', { name: 'Monthly report' }),
      ).toBeVisible();
      await expect(
        page.getByRole('article', { name: 'Weekly report' }),
      ).toHaveCount(0);
      await openFromList(page, 'Open Monthly report');
      await expect(status).toHaveText('Monthly report: focused, beside.');
    });

    await test.step('a kept report stays when the next one opens', async () => {
      await page
        .getByRole('button', { name: 'Keep open', exact: true })
        .click();
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
    });

    await test.step('close what this pane opened', async () => {
      // Four related requests have spent this page's burst. A close that
      // asks no unsaved-changes guard spends nothing, so it still closes.
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
    });

    await test.step('the kept report is the same occurrence after a reload', async () => {
      await page.reload();
      await expect(
        page.getByRole('article', { name: 'Monthly report' }),
      ).toBeVisible({ timeout: 30_000 });
    });

    await test.step('a tool lands with the Tools, not beside the list', async () => {
      // A new page, so a new budget: the burst above is not carried over.
      await reports(page)
        .getByRole('button', { name: 'Open report log', exact: true })
        .click();
      await expect(status).toHaveText('Report log: opened, tool.');
      await expect(
        page.getByRole('region', { name: 'Report log' }),
      ).toBeVisible();
    });

    await test.step('a removed plugin’s pane stays, unavailable, and runs no plugin code', async () => {
      await removePlugin();
      await page.reload();
      await expect(
        page
          .getByText('This plugin pane is unavailable', { exact: true })
          .first(),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page.getByRole('article', { name: 'Monthly report' }),
      ).toHaveCount(0);
      await expect(
        page.getByRole('region', { name: 'Report log' }),
      ).toHaveCount(0);
    });

    await test.step('the same version reinstalled does not bring them back', async () => {
      const reinstalled = await installPluginWithConsent(api, pluginDir);
      expect(reinstalled.success).toBe(true);
      await page.reload();
      // The list is the new installation's own pane, so it renders again;
      // the panes opened under the earlier installation do not.
      await expect(
        reports(page).getByRole('heading', { name: 'Reports' }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        page
          .getByText('This plugin pane is unavailable', { exact: true })
          .first(),
      ).toBeVisible();
      await expect(
        page.getByRole('article', { name: 'Monthly report' }),
      ).toHaveCount(0);
    });
  });
});
