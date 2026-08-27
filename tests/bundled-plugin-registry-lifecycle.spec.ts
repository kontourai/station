import {
  type AuthenticatedE2ERequest,
  expect,
  test,
} from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';

const API = resolveE2EApiBase();

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
  await page.getByRole('button', { name: 'Plugins', exact: true }).click();
  await page
    .getByRole('button', { name: 'View Minimal Layout details' })
    .click();
  return page.getByRole('region', { name: 'Minimal Layout' });
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
  // ceiling. Total bounded: 180 + 30 + 30 = 240s. 300s gives 60s headroom so
  // the enclosing timeout never interrupts primary-error-preserving cleanup.
  test.describe.configure({ timeout: 300_000 });

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

  test('installs, uses, removes, and reinstalls the bundled minimal layout', async ({
    page,
    authenticatedRequest,
  }, testInfo) => {
    const slug = `bundled-layout-${Date.now()}`;

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
      const detail = await openBundledPluginInRegistry(page);
      await detail
        .getByRole('button', { name: 'Install', exact: true })
        .click();
      await expect(page.getByText('Installed Minimal Layout')).toBeVisible({
        timeout: 60_000,
      });

      // A reload must project the persisted registry alias as installed, not
      // merely preserve optimistic client mutation state.
      await page.reload();
      await page.getByRole('button', { name: 'Plugins', exact: true }).click();
      await expect(
        page.getByRole('article').filter({ hasText: 'Minimal Layout' }).first(),
      ).toContainText('Installed');

      await page.goto('/plugins');
      await expect(
        page.getByText('Minimal Layout', { exact: true }),
      ).toBeVisible();

      const project = await authenticatedRequest.post(`${API}/api/projects`, {
        data: { name: 'Bundled Layout Proof', slug },
      });
      expect(project.ok()).toBe(true);

      await page.goto(`/projects/${slug}`);
      await page.getByRole('button', { name: '+ Add', exact: true }).click();
      const picker = page.getByRole('dialog', { name: 'Add Layout' });
      const minimalLayout = picker
        .getByRole('button', { name: /Minimal.*Plugin: minimal-layout/ })
        .first();
      await expect(minimalLayout).toBeVisible();
      await minimalLayout.click();
      const minimalSidebarTab = page.getByRole('button', {
        name: 'Minimal',
        exact: true,
      });
      await expect(minimalSidebarTab).toBeVisible();
      await minimalSidebarTab.click();
      await expect(page.getByText('Minimal plugin starter')).toBeVisible();

      await page.setViewportSize({ width: 390, height: 844 });
      await assertNoHorizontalOverflow(page);
      await page.getByRole('button', { name: 'Open Chat Dock' }).focus();
      await expect(
        page.getByRole('button', { name: 'Open Chat Dock' }),
      ).toBeFocused();
      await testInfo.attach('bundled-layout-390x844', {
        body: await page.screenshot(),
        contentType: 'image/png',
      });

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
      await expect(page.getByText('Removed Minimal Layout')).toBeVisible();

      await page.goto(`/projects/${slug}/layouts/minimal`);
      await expect(page.getByText('Unsupported layout tab')).toBeVisible();
      await expect(page.getByText(/not installed or registered/)).toBeVisible();

      const reinstallDetail = await openBundledPluginInRegistry(page);
      await reinstallDetail
        .getByRole('button', { name: 'Install', exact: true })
        .click();
      await expect(page.getByText('Installed Minimal Layout')).toBeVisible({
        timeout: 60_000,
      });

      await page.goto(`/projects/${slug}/layouts/minimal`);
      await expect(page.getByText('Minimal plugin starter')).toBeVisible();
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
