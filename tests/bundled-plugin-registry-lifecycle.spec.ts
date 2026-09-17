import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AuthenticatedE2ERequest,
  expect,
  test,
} from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';

const API = resolveE2EApiBase();
// Registry display name of the bundled `minimal-layout` package (#265: the
// package id is retained; the friendly name is the Pane's).
const PLUGIN_NAME = 'Minimal Workspace';
// Inventory, CSS, and JavaScript each have an 8s owner deadline.
// A 5s locator assertion can delete the plugin while that valid load is pending.
const PANE_READY_TIMEOUT_MS = 30_000;

async function openBundledPluginInRegistry(
  page: import('@playwright/test').Page,
) {
  await page.goto('/registry');
  const decideLater = page.getByRole('button', {
    name: 'Decide later',
    exact: true,
  });
  if (await decideLater.isVisible().catch(() => false)) {
    await decideLater.click();
  }
  await page.getByRole('tab', { name: 'Plugins', exact: true }).click();
  await page
    .getByRole('button', { name: `View ${PLUGIN_NAME} details` })
    .click();
  return page.getByRole('region', { name: PLUGIN_NAME });
}

/**
 * The Pane-era project journey, mirroring minimal-workspace-example.spec.ts:
 * the "+ Add pane" picker offers the installed contribution and opens its
 * Project-bound occurrence. Returns the committed pane URL so the caller can
 * revisit the same occurrence after the plugin is removed.
 */
async function openMinimalWorkspacePane(
  page: import('@playwright/test').Page,
  slug: string,
): Promise<string> {
  await page.goto(`/projects/${slug}`);
  await page.getByRole('button', { name: '+ Add pane', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Add workspace pane' })
    .getByRole('listitem')
    .filter({ has: page.getByText(PLUGIN_NAME, { exact: true }) })
    .getByRole('button', { name: `Open ${PLUGIN_NAME}`, exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: PLUGIN_NAME, exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Minimal plugin starter')).toBeVisible({
    timeout: PANE_READY_TIMEOUT_MS,
  });
  const paneUrl = page.url();
  expect(new URL(paneUrl).pathname).toMatch(
    new RegExp(`^/projects/${slug}/panes/`),
  );
  return paneUrl;
}

async function assertNoHorizontalOverflow(
  page: import('@playwright/test').Page,
) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
}

/**
 * Best-effort cleanup DELETE that validates the response: 2xx (deleted) and
 * 404 (already absent) are acceptable; anything else is unexpected and
 * returned as a description so callers report it instead of silently
 * swallowing it. Bounded to a single attempt with an explicit 30s timeout so
 * baseline and teardown stay deterministic.
 */
async function safeCleanupDelete(
  request: AuthenticatedE2ERequest,
  url: string,
  label: string,
): Promise<string | null> {
  try {
    const response = await request.delete(url, { timeout: 30_000 });
    const status = response.status();
    if ((status >= 200 && status < 300) || status === 404) return null;
    return `DELETE ${label} returned unexpected status ${status}`;
  } catch (error) {
    return `DELETE ${label} failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

test.describe('Bundled plugin registry lifecycle', () => {
  // Body worst case: two 60s install waits (install + reinstall) plus one
  // 60s removal response = 180s. Baseline DELETE (30s) runs before the body;
  // final cleanup runs two 30s DELETEs concurrently (Promise.all) = 30s
  // ceiling. Two pane readiness waits add 60s: 180 + 30 + 30 + 60 = 300s.
  // The 360s outer budget leaves 60s for ordinary UI interactions and cleanup.
  test.describe.configure({ timeout: 360_000 });

  test('request-only authentication reaches operator routes without changing the ordinary request context', async ({
    authenticatedRequest,
    playwright,
  }) => {
    const operatorResponse = await authenticatedRequest.get(
      `${API}/api/pairing/requests`,
    );
    expect(operatorResponse.ok()).toBe(true);

    const ordinaryRequest = await playwright.request.newContext();
    try {
      const unauthenticatedResponse = await ordinaryRequest.get(
        `${API}/api/pairing/requests`,
      );
      expect(unauthenticatedResponse.status()).toBe(401);
    } finally {
      await ordinaryRequest.dispose();
    }
  });

  test('installs, uses, removes, and reinstalls the bundled minimal workspace', async ({
    page,
    authenticatedRequest,
  }, testInfo) => {
    const slug = `bundled-workspace-${Date.now()}`;
    const workspace = mkdtempSync(join(tmpdir(), 'station-bundled-workspace-'));

    // Baseline cleanup: ensure no leftover install from a prior run. 404 is
    // expected when nothing is leftover; any other failure is surfaced
    // (broken environment) rather than swallowed.
    const baselineFailure = await safeCleanupDelete(
      authenticatedRequest,
      `${API}/api/registry/plugins/minimal-layout`,
      'minimal-layout (baseline)',
    );
    if (baselineFailure) throw new Error(baselineFailure);

    let testError: unknown;
    try {
      await page.addInitScript(() =>
        localStorage.setItem('station:onboarding-setup-dismissed', '1'),
      );
      const detail = await openBundledPluginInRegistry(page);
      await detail
        .getByRole('button', { name: 'Install', exact: true })
        .click();
      await page
        .getByRole('dialog', { name: 'Install Preview' })
        .getByRole('button', { name: 'Confirm Install', exact: true })
        .click();
      await expect(page.getByText(`Installed ${PLUGIN_NAME}`)).toBeVisible({
        timeout: 60_000,
      });

      // A reload must project the persisted registry alias as installed, not
      // merely preserve optimistic client mutation state.
      await page.reload();
      await page.getByRole('tab', { name: 'Plugins', exact: true }).click();
      await expect(
        page.getByRole('article').filter({ hasText: PLUGIN_NAME }).first(),
      ).toContainText('Installed');

      await page.goto('/plugins');
      await expect(
        page.getByText(PLUGIN_NAME, { exact: true }).first(),
      ).toBeVisible();

      const project = await authenticatedRequest.post(`${API}/api/projects`, {
        data: {
          name: 'Bundled Workspace Proof',
          slug,
          workingDirectory: workspace,
        },
      });
      expect(project.ok()).toBe(true);

      const paneUrl = await openMinimalWorkspacePane(page, slug);

      await page.setViewportSize({ width: 390, height: 844 });
      await assertNoHorizontalOverflow(page);
      await page
        .getByRole('button', { name: 'Open Chat Dock', exact: true })
        .focus();
      await expect(
        page.getByRole('button', { name: 'Open Chat Dock', exact: true }),
      ).toBeFocused();
      await testInfo.attach('bundled-workspace-390x844', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });
      await page.setViewportSize({ width: 1280, height: 900 });

      const removeDetail = await openBundledPluginInRegistry(page);
      // The uninstall DELETE can take ~24s under fixture-budget load; await the
      // exact response (bounded) before asserting the success toast, rather
      // than racing a short locator timeout against a slow mutation.
      const pluginRemoval = page.waitForResponse(
        (response) =>
          response.request().method() === 'DELETE' &&
          new URL(response.url()).pathname ===
            '/api/registry/plugins/minimal-layout',
        { timeout: 60_000 },
      );
      await removeDetail
        .getByRole('button', { name: 'Remove Plugin', exact: true })
        .click();
      const removed = await pluginRemoval;
      expect(removed.ok()).toBe(true);
      await expect(page.getByText(`Removed ${PLUGIN_NAME}`)).toBeVisible();

      // The occurrence the plugin backed is withdrawn, not left rendering a
      // stale component: the same pane route now reports the host's reason.
      await page.goto(paneUrl);
      await expect(
        page.getByText('Workspace pane not found', { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Open Chat Dock', exact: true }),
      ).toHaveCount(0);

      const reinstallDetail = await openBundledPluginInRegistry(page);
      await reinstallDetail
        .getByRole('button', { name: 'Install', exact: true })
        .click();
      await page
        .getByRole('dialog', { name: 'Install Preview' })
        .getByRole('button', { name: 'Confirm Install', exact: true })
        .click();
      await expect(page.getByText(`Installed ${PLUGIN_NAME}`)).toBeVisible({
        timeout: 60_000,
      });

      // Reinstall is proven through the same picker journey rather than the
      // earlier pane URL: the contribution is offered again and opens.
      await openMinimalWorkspacePane(page, slug);
      await assertNoHorizontalOverflow(page);
    } catch (error) {
      testError = error;
    }
    // Cleanup runs after the body's try/catch (not in `finally`): the catch
    // above never throws out, so this is guaranteed to run, and it avoids the
    // throw-in-finally control-flow hazard. Validate each response (allow an
    // intentional 404) and report unexpected failures instead of swallowing.
    const cleanupFailures = (
      await Promise.all(
        (
          [
            [`${API}/api/projects/${slug}`, `project ${slug}`],
            [`${API}/api/registry/plugins/minimal-layout`, 'minimal-layout'],
          ] as [string, string][]
        ).map(([cleanupUrl, cleanupLabel]) =>
          safeCleanupDelete(authenticatedRequest, cleanupUrl, cleanupLabel),
        ),
      )
    ).filter((failure): failure is string => failure !== null);
    rmSync(workspace, { recursive: true, force: true });
    if (cleanupFailures.length > 0) {
      const report = `Cleanup failures: ${cleanupFailures.join('; ')}`;
      if (testError) {
        // Don't mask the original test failure; surface cleanup alongside it.
        console.error(report);
        throw testError;
      }
      throw new Error(report);
    }
    if (testError) throw testError;
  });
});
