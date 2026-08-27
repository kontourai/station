/**
 * Survey Review Workbench plugin — end-to-end proof for the S2 "vertical as
 * a plugin" slice: install the example plugin, add its layout to a project,
 * complete a real review action in Survey's workbench, verify the session
 * round-trips through Station's per-project persistence across a reload, and
 * project the review into a Surface trust bundle written to the project
 * workspace.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { authenticatedE2EFetch } from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';
import { installPluginWithConsent } from './helpers/install-plugin';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_DIR = join(dirname(__filename), '..');
const PLUGIN_DIR = join(PROJECT_DIR, 'examples', 'survey-review-workbench');
const API = resolveE2EApiBase();

const PLUGIN_NAME = 'survey-review-workbench';
const PROJECT_SLUG = 'srw-e2e';

let workspaceDir: string;

async function deleteProject(): Promise<void> {
  try {
    await authenticatedE2EFetch(`${API}/api/projects/${PROJECT_SLUG}`, {
      method: 'DELETE',
    });
  } catch {}
}

async function deletePlugin(): Promise<void> {
  try {
    await authenticatedE2EFetch(`${API}/api/plugins/${PLUGIN_NAME}`, {
      method: 'DELETE',
    });
  } catch {}
}

test.describe('Survey Review Workbench plugin', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    // Build the plugin bundle (installs plugin-local deps, incl.
    // @kontourai/survey) the same way plugin-system.spec.ts builds demo-layout.
    execSync('npx tsx ../../packages/cli/src/cli.ts plugin build', {
      cwd: PLUGIN_DIR,
      timeout: 120_000,
    });

    await deletePlugin();
    await deleteProject();

    const install = await installPluginWithConsent(API, PLUGIN_DIR);
    expect(install.success).toBe(true);
    expect(install.plugin.name).toBe(PLUGIN_NAME);
    expect(install.plugin.hasBundle).toBe(true);

    workspaceDir = mkdtempSync(join(tmpdir(), 'srw-e2e-workspace-'));
    const project = await (
      await authenticatedE2EFetch(`${API}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Survey Review E2E',
          slug: PROJECT_SLUG,
          workingDirectory: workspaceDir,
        }),
      })
    ).json();
    expect(project.success).toBe(true);
  });

  test.afterAll(async () => {
    await deleteProject();
    await deletePlugin();
    if (workspaceDir) rmSync(workspaceDir, { recursive: true, force: true });
  });

  test('approves trusted server access through the isolated host flow', async ({
    page,
  }) => {
    await page.goto('/plugins');
    await page.getByText('Survey Review Workbench', { exact: true }).click();
    await page
      .getByRole('button', { name: /Review Permissions \(1\)/ })
      .click();

    await expect(page.getByText('Trusted', { exact: true })).toBeVisible();
    await expect(
      page.getByText('plugin.server', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(/separate, host-owned review page/),
    ).toBeVisible();

    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('button', { name: 'Review trusted access' }).click();
    const approvalPage = await popupPromise;
    await expect(
      approvalPage.getByRole('heading', {
        name: 'Trust Survey Review Workbench?',
      }),
    ).toBeVisible();
    await expect(
      approvalPage.getByText('plugin.server', { exact: true }),
    ).toBeVisible();
    await approvalPage
      .getByRole('button', { name: 'Approve trusted access' })
      .click();
    await expect(
      approvalPage.getByRole('heading', { name: 'Approved' }),
    ).toBeVisible();

    await expect(
      page.getByRole('button', { name: 'Review trusted access' }),
    ).toBeHidden({ timeout: 15_000 });

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
    expect(layout.data.slug).toBe('survey-review');
  });

  test('layout renders the workbench and a review action persists across reload', async ({
    page,
  }) => {
    await page.goto(`/projects/${PROJECT_SLUG}/layouts/survey-review`);

    // Plugin layout chrome is up.
    const loadExample = page.getByTestId('srw-load-example');
    await expect(loadExample).toBeVisible({ timeout: 20_000 });

    // Seed a session from Survey's published example data.
    await loadExample.click();
    await expect(page.getByTestId('srw-notice')).toContainText(
      'Survey example data',
      { timeout: 15_000 },
    );

    // Survey's workbench is mounted (its own DOM, not a screenshot of it).
    const workbench = page.getByTestId('srw-mount');
    await expect(
      workbench.locator('section[aria-label="Survey review workbench"]'),
    ).toBeVisible({ timeout: 15_000 });
    await expect(workbench.getByText('Review queue')).toBeVisible();

    // A real review action: accept the proposed candidate.
    await workbench
      .getByRole('button', { name: 'Accept proposed' })
      .first()
      .click();

    // The event store persists through the plugin server route.
    await expect(page.getByTestId('srw-persistence-status')).toHaveText(
      'saved',
      { timeout: 15_000 },
    );

    // Server-side state agrees: one session with at least one event.
    const sessions = await (
      await authenticatedE2EFetch(
        `${API}/api/plugins/${PLUGIN_NAME}/projects/${PROJECT_SLUG}/review-sessions`,
      )
    ).json();
    expect(sessions.success).toBe(true);
    expect(sessions.sessions).toHaveLength(1);
    expect(sessions.sessions[0].eventCount).toBeGreaterThan(0);
    const sessionName: string = sessions.sessions[0].name;

    // Reload: the session survives and the decision is replayed.
    await page.reload();
    await expect(page.getByTestId('srw-session-select')).toHaveValue(
      sessionName,
      { timeout: 20_000 },
    );
    const reloadedWorkbench = page.getByTestId('srw-mount');
    await expect(
      reloadedWorkbench.locator('button[data-decision="accept-proposed"]'),
    ).toHaveClass(/is-active/, { timeout: 15_000 });
  });

  test('projecting writes a Surface trust bundle into the project workspace', async ({
    page,
  }) => {
    await page.goto(`/projects/${PROJECT_SLUG}/layouts/survey-review`);
    await expect(page.getByTestId('srw-session-select')).not.toHaveValue('', {
      timeout: 20_000,
    });

    await page.getByTestId('srw-project-bundle').click();
    await expect(page.getByTestId('srw-notice')).toContainText(
      'Trust bundle written',
      { timeout: 15_000 },
    );

    const bundlePath = (
      await page.getByTestId('srw-bundle-path').textContent()
    )?.trim();
    expect(bundlePath).toBeTruthy();
    expect(bundlePath).toContain(join('.station', 'trust-bundles'));
    expect(existsSync(bundlePath as string)).toBe(true);

    const bundle = JSON.parse(readFileSync(bundlePath as string, 'utf-8'));
    expect(bundle.schemaVersion).toBeDefined();
    expect(Array.isArray(bundle.claims)).toBe(true);
    expect(bundle.claims.length).toBeGreaterThan(0);
    expect(Array.isArray(bundle.evidence)).toBe(true);
  });
});
