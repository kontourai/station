/** Actual first-party portable example: install, explicit Project Pane, local dock, withdrawal. */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { authenticatedE2EFetch } from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';
import { installPluginWithConsent } from './helpers/install-plugin';

const api = resolveE2EApiBase();
const slug = 'minimal-workspace-example';
const plugin = 'minimal-layout';

test('portable minimal example opens its Project Pane and existing dock without sending, then withdraws on uninstall', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const workspace = mkdtempSync(join(tmpdir(), 'station-minimal-example-'));
  let installed = false;
  let created = false;
  try {
    expect(
      (await installPluginWithConsent(api, resolve('examples/minimal-layout')))
        .success,
    ).toBe(true);
    installed = true;
    const response = await authenticatedE2EFetch(`${api}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Minimal Example Project',
        slug,
        workingDirectory: workspace,
      }),
    });
    expect(response.status, await response.text()).toBe(201);
    created = true;
    const catalogResponse = await authenticatedE2EFetch(
      `${api}/api/projects/${slug}/panes`,
    );
    expect(catalogResponse.ok).toBe(true);
    const { data: catalog } = await catalogResponse.json();
    const descriptor = catalog.descriptors.find(
      (entry: { provenance: { pluginId?: string } }) =>
        entry.provenance.pluginId === plugin,
    );
    expect(descriptor).toMatchObject({
      name: 'Minimal Workspace',
      renderer: { kind: 'plugin-component', name: 'minimal-workspace' },
    });
    expect(
      catalog.instances.find(
        (entry: { descriptorId: string }) =>
          entry.descriptorId === descriptor.id,
      ),
    ).toMatchObject({ boundContext: { projectId: catalog.projectId } });

    await page.addInitScript(() =>
      localStorage.setItem('station:onboarding-setup-dismissed', '1'),
    );
    await page.goto(`/projects/${slug}`);
    await page.getByRole('button', { name: '+ Add pane', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Add workspace pane' })
      .getByRole('listitem')
      .filter({ has: page.getByText('Minimal Workspace', { exact: true }) })
      .getByRole('button', { name: 'Open Minimal Workspace', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Minimal Workspace', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.minimal-shell li').first()).toBeVisible();
    const paneUrl = page.url();
    expect(new URL(paneUrl).pathname).toMatch(
      new RegExp(`^/projects/${slug}/panes/`),
    );
    const evidenceRoot = resolve(
      '.kontourai/minimal-workspace-browser',
      basename(process.env.STATION_E2E_OUTPUT_DIR ?? 'manual'),
    );
    mkdirSync(evidenceRoot, { recursive: true });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(
        page.getByRole('button', { name: 'Open Chat Dock', exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath(`minimal-workspace-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      });
      copyFileSync(
        testInfo.outputPath(`minimal-workspace-${width}.png`),
        join(evidenceRoot, `minimal-workspace-${width}.png`),
      );
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    const mutations: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (
        request.method() === 'POST' &&
        /\/(?:api\/)?(?:agents\/|orchestration\/|chat\/|conversations)/.test(
          path,
        )
      )
        mutations.push(path);
    });
    await page
      .getByRole('button', { name: 'Open Chat Dock', exact: true })
      .click();
    await expect(
      page.getByText('Chat dock opened', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Chat dock', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('No active session', { exact: true }),
    ).toBeVisible();
    const openedDockUrl = new URL(paneUrl);
    openedDockUrl.searchParams.set('dock', 'open');
    await expect(page).toHaveURL(openedDockUrl.href);
    expect(mutations).toEqual([]);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({
        path: testInfo.outputPath(`minimal-workspace-dock-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      });
      copyFileSync(
        testInfo.outputPath(`minimal-workspace-dock-${width}.png`),
        join(evidenceRoot, `minimal-workspace-dock-${width}.png`),
      );
    }
    const removed = await authenticatedE2EFetch(
      `${api}/api/registry/plugins/${plugin}`,
      { method: 'DELETE' },
    );
    expect(removed.ok).toBe(true);
    installed = false;
    // The existing client must withdraw the renderer through the real removal event.
    await expect(
      page.getByRole('button', { name: 'Open Chat Dock', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText('Workspace pane not found', { exact: true }),
    ).toBeVisible();
    await page.goto(paneUrl);
    await expect(
      page.getByText('Workspace pane not found', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Open Chat Dock', exact: true }),
    ).toHaveCount(0);
    expect(mutations).toEqual([]);
  } finally {
    if (created)
      expect(
        (
          await authenticatedE2EFetch(`${api}/api/projects/${slug}`, {
            method: 'DELETE',
          })
        ).ok,
      ).toBe(true);
    if (installed)
      expect(
        (
          await authenticatedE2EFetch(`${api}/api/registry/plugins/${plugin}`, {
            method: 'DELETE',
          })
        ).ok,
      ).toBe(true);
    rmSync(workspace, { recursive: true, force: true });
  }
});
