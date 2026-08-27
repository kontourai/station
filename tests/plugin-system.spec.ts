/**
 * Plugin system integration tests using the demo-layout example.
 * No dependency on external plugins — uses the built-in demo layout.
 */

import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { authenticatedE2EFetch } from './helpers/authenticated-request';
import { resolveE2EApiBase } from './helpers/e2e-target';
import { installPluginWithConsent } from './helpers/install-plugin';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_DIR = join(dirname(__filename), '..');
const DEMO_DIR = join(PROJECT_DIR, 'examples', 'demo-layout');
const API = resolveE2EApiBase();

test.describe('Plugin System', () => {
  test.describe.configure({ timeout: 60_000 });

  // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
  test.beforeAll(async ({}, testInfo) => {
    testInfo.setTimeout(90_000);
    // Build the demo layout bundle using centralized build. The command is
    // `plugin build` — the bare `build` form prints usage and (since the S2
    // CLI fix) exits non-zero; before that fix it exited 0 and this step was
    // a silent no-op.
    execSync('npx tsx ../../packages/cli/src/cli.ts plugin build', {
      cwd: DEMO_DIR,
      timeout: 60000,
    });
    // Ensure it's not installed
    try {
      await authenticatedE2EFetch(`${API}/api/plugins/demo-layout`, {
        method: 'DELETE',
      });
    } catch {}
  });

  test.afterAll(async () => {
    try {
      await authenticatedE2EFetch(`${API}/api/plugins/demo-layout`, {
        method: 'DELETE',
      });
    } catch {}
  });

  test('demo layout loads in browser after install', async ({ page }) => {
    // Ensure plugin is installed
    await installPluginWithConsent(API, DEMO_DIR);

    // Navigate — PluginRegistry fetches /api/plugins on init and loads bundles
    await page.goto('/');
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            return !!(window as any).__station_ai_plugins?.['demo-layout'];
          }),
        { timeout: 10_000 },
      )
      .toBe(true);

    // Check if demo layout components registered
    const hasPlugin = await page.evaluate(() => {
      return !!(window as any).__station_ai_plugins?.['demo-layout'];
    });
    expect(hasPlugin).toBe(true);
  });
});
