/**
 * Fieldwork Review plugin browser proof: Station installs the example,
 * grants the isolated server capability, launches project-relative fixture
 * files, and embeds only Fieldwork's protected review application.
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { authenticatedE2EFetch } from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';
import { installPluginWithConsent } from './helpers/install-plugin';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_DIR = join(dirname(__filename), '..');
const PLUGIN_DIR = join(PROJECT_DIR, 'examples', 'fieldwork-review');
const API = resolveE2EApiBase();
const PLUGIN_NAME = 'fieldwork-review';
const PROJECT_SLUG = 'fieldwork-review-e2e';

const TASK = {
  apiVersion: 'fieldwork.kontourai.io/v1alpha1',
  kind: 'FieldworkTask',
  metadata: { name: 'station-fieldwork-browser' },
  spec: {
    traverse: {
      version: '1',
      targetSchema: [
        { path: 'record.status', type: 'string', inferenceType: 'explicit' },
      ],
    },
    projections: [
      {
        fieldPath: 'record.status',
        pattern: 'Status: ([^\\n]+)',
        claim: {
          subjectType: 'record',
          subjectId: 'station-fieldwork-browser',
          facet: 'review',
          claimType: 'field',
          impactLevel: 'medium',
        },
      },
    ],
  },
};

let workspaceDir: string;

async function removeProject() {
  try {
    await authenticatedE2EFetch(`${API}/api/projects/${PROJECT_SLUG}`, {
      method: 'DELETE',
    });
  } catch {}
}

async function removePlugin() {
  try {
    await authenticatedE2EFetch(`${API}/api/plugins/${PLUGIN_NAME}`, {
      method: 'DELETE',
    });
  } catch {}
}

test.describe('Fieldwork Review plugin', () => {
  test.describe.configure({ mode: 'serial' });

  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo.
  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(150_000);
    execSync('npx tsx ../../packages/cli/src/cli.ts plugin build', {
      cwd: PLUGIN_DIR,
      timeout: 120_000,
    });
    await removePlugin();
    await removeProject();

    const installed = await installPluginWithConsent(API, PLUGIN_DIR);
    expect(installed.success).toBe(true);
    expect(installed.plugin.name).toBe(PLUGIN_NAME);
    expect(installed.plugin.hasBundle).toBe(true);

    workspaceDir = mkdtempSync(join(tmpdir(), 'fieldwork-review-e2e-'));
    writeFileSync(join(workspaceDir, 'task.json'), JSON.stringify(TASK));
    writeFileSync(join(workspaceDir, 'source.txt'), 'Status: Active\n');
    const project = await (
      await authenticatedE2EFetch(`${API}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Fieldwork Review E2E',
          slug: PROJECT_SLUG,
          workingDirectory: workspaceDir,
        }),
      })
    ).json();
    expect(project.success).toBe(true);
  });

  test.afterAll(async () => {
    await removeProject();
    await removePlugin();
    if (workspaceDir) rmSync(workspaceDir, { recursive: true, force: true });
  });

  test('grants server access and adds the Fieldwork layout to the project', async ({
    page,
  }) => {
    await page.goto('/plugins');
    await page.getByText('Fieldwork Review', { exact: true }).click();
    await page
      .getByRole('button', { name: /Review Permissions \(1\)/ })
      .click();
    await expect(
      page.getByText('plugin.server', { exact: true }),
    ).toBeVisible();

    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Review trusted access' }).click();
    const approvalPage = await popupPromise;
    // Bounded deliberately. This click is where the 2026-08-23 product baseline
    // hung for 30s per run: the whole approval walk up to here happens on the
    // main page, under whatever overlay a fresh home had open, and an unbounded
    // click turns that into a wall-clock test timeout that names nothing. The
    // bound makes the same failure report as a named action failure instead.
    await approvalPage
      .getByRole('button', { name: 'Approve trusted access' })
      .click({ timeout: 10_000 });
    await expect(
      approvalPage.getByRole('heading', { name: 'Approved' }),
    ).toBeVisible();

    const layout = await (
      await authenticatedE2EFetch(
        `${API}/api/projects/${PROJECT_SLUG}/layouts/from-plugin`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ plugin: PLUGIN_NAME }),
        },
      )
    ).json();
    expect(layout.success).toBe(true);
    expect(layout.data.slug).toBe('fieldwork-review');
  });

  test('launches confined project files and embeds the protected review surface responsively', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/projects/${PROJECT_SLUG}/layouts/fieldwork-review`);
    await expect(page.getByTestId('fieldwork-review')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByLabel('Task file')).toHaveValue('task.json');
    await page.getByLabel('Task file').focus();
    await expect(page.getByLabel('Task file')).toBeFocused();

    await page.getByTestId('fieldwork-launch').click();
    await expect(page.getByText('1 proposal')).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByText('Reviewed output becomes available'),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Open review' }).click();
    const frame = page.getByTestId('fieldwork-review-frame');
    await expect(frame).toBeVisible({ timeout: 20_000 });
    await expect(frame).toHaveAttribute('title', 'Fieldwork review');
    await expect(frame).toHaveAttribute('sandbox', /allow-same-origin/);
    await expect(frame).toHaveAttribute('sandbox', /allow-scripts/);
    await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    const fieldwork = page.frameLocator(
      '[data-testid="fieldwork-review-frame"]',
    );
    await expect(
      fieldwork.getByRole('heading', { name: 'Fieldwork review' }),
    ).toBeVisible({
      timeout: 20_000,
    });
    const candidate = fieldwork.getByRole('button', {
      name: /record\.status .*fieldwork-/u,
    });
    await candidate.scrollIntoViewIfNeeded();
    await expect(candidate).toBeVisible();
    await candidate.click();
    const reviewField = fieldwork.locator('[data-field="record.status"]');
    const useProposed = reviewField.getByTestId('use-proposed');
    await useProposed.scrollIntoViewIfNeeded();
    await expect(useProposed).toBeVisible();
    await useProposed.click();
    await expect(fieldwork.getByLabel('Fieldwork status')).toContainText(
      'Saved',
    );
    await expect(page.getByText('Reviewed output is available.')).toBeVisible({
      timeout: 20_000,
    });

    const mobileFrameBox = await frame.boundingBox();
    expect(mobileFrameBox?.width).toBeGreaterThan(300);
    expect(mobileFrameBox?.height).toBeGreaterThan(300);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(frame).toBeVisible();
    const desktopFrameBox = await frame.boundingBox();
    expect(desktopFrameBox?.width).toBeGreaterThan(500);

    await page.getByRole('button', { name: 'Close review' }).click();
    await expect(page.getByTestId('fieldwork-review-placeholder')).toBeVisible({
      timeout: 15_000,
    });
  });

  test('uninstall disposes an open Fieldwork capability service', async ({
    page,
  }) => {
    await page.goto(`/projects/${PROJECT_SLUG}/layouts/fieldwork-review`);
    await expect(page.getByRole('button', { name: 'Open review' })).toBeVisible(
      {
        timeout: 20_000,
      },
    );
    await page.getByRole('button', { name: 'Open review' }).click();
    const frame = page.getByTestId('fieldwork-review-frame');
    await expect(frame).toBeVisible({ timeout: 20_000 });
    const reviewUrl = await frame.getAttribute('src');
    expect(reviewUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
    expect((await fetch(reviewUrl!)).status).toBe(200);

    const removed = await authenticatedE2EFetch(
      `${API}/api/plugins/${PLUGIN_NAME}`,
      {
        method: 'DELETE',
      },
    );
    expect(removed.status).toBe(200);
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(reviewUrl!)).status;
          } catch {
            return 0;
          }
        },
        { timeout: 10_000 },
      )
      .toBe(0);
  });
});
