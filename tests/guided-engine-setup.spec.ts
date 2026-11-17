import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import { test } from './helpers/fixture-audit';

// Fixture-backed UI flow. Real installer process ownership and profile writes
// are covered at the server route; this test never downloads vendor software.
for (const width of [390, 1440]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`guided engine setup at ${width} in ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.addInitScript((theme) => {
        localStorage.setItem('theme', theme);
        localStorage.setItem('station:onboarding-setup-dismissed', '1');
      }, theme);
      let detected = false;
      let connected = false;
      let selected = false;
      let installerStarts = 0;
      const connection = {
        id: 'antigravity',
        name: 'Google Antigravity',
        command: 'agy',
        args: ['acp', '--process-per-session'],
        enabled: true,
        status: 'available',
        modes: [],
        sessionId: null,
        mcpServers: [],
        currentModel: null,
        capabilities: { mcpCapabilities: { http: true } },
      };
      const json = (data: unknown) => ({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data }),
      });
      await page.route('**/api/feature-previews', (route) =>
        route.fulfill(json([{ id: 'guided-engine-setup', enabled: true }])),
      );
      await page.route('**/acp/registry', (route) =>
        route.fulfill(
          json([
            {
              ...connection,
              detected,
              installed: connected,
              source: 'core',
              hostInstall: {
                command: 'reviewed-installer',
                docsUrl: 'https://example.test/install',
              },
            },
          ]),
        ),
      );
      await page.route('**/acp/connections', (route) =>
        route.fulfill(json(connected ? [connection] : [])),
      );
      await page.route('**/acp/connections/unregistered', (route) =>
        route.fulfill(json([])),
      );
      await page.route(
        '**/acp/registry/antigravity/install-terminal',
        async (route) => {
          if (route.request().method() !== 'GET') {
            installerStarts++;
            throw new Error('This render test must not run an installer.');
          }
          await route.fulfill(
            json({
              name: 'Google Antigravity',
              command: 'reviewed-installer',
              allowed: true,
              canStop: true,
              terminal: null,
            }),
          );
        },
      );
      await page.route('**/acp/registry/recheck', async (route) => {
        detected = true;
        await route.fulfill(json({ status: 'rechecked' }));
      });
      await page.route('**/acp/registry/antigravity/install', async (route) => {
        connected = true;
        await route.fulfill(json(connection));
      });
      await page.route(
        '**/acp/connections/antigravity/station-tools',
        async (route) => {
          if (route.request().method() === 'POST') selected = true;
          await route.fulfill(
            json({ agentSlug: 'antigravity', supported: true, selected }),
          );
        },
      );
      await page.goto('/connections/engines/new/antigravity');
      await expect(
        page.getByRole('heading', { name: 'Connect Google Antigravity' }),
      ).toBeVisible();
      await page
        .getByRole('button', { name: 'Install Google Antigravity on Station' })
        .click();
      const review = page.getByRole('dialog', {
        name: 'Install Google Antigravity',
      });
      await expect(review.getByText(/reviewed-installer/)).toBeVisible();
      await expect.poll(() => installerStarts).toBe(0);
      await page.screenshot({
        path: testInfo.outputPath(`installer-review-${width}-${theme}.png`),
        fullPage: true,
      });
      if (process.env.STATION_GUIDED_SETUP_CAPTURE_DIR) {
        await mkdir(process.env.STATION_GUIDED_SETUP_CAPTURE_DIR, {
          recursive: true,
        });
        const name = `installer-review-${width}-${theme}.png`;
        await copyFile(
          testInfo.outputPath(name),
          join(process.env.STATION_GUIDED_SETUP_CAPTURE_DIR, name),
        );
      }
      await review.getByRole('button', { name: 'Cancel', exact: true }).click();
      await page
        .getByRole('button', { name: 'Check again for Google Antigravity' })
        .click();
      await page
        .getByRole('button', {
          name: 'Connect Google Antigravity',
          exact: true,
        })
        .click();
      await expect(
        page.getByText('This engine is ready to use.'),
      ).toBeVisible();
      await page
        .getByRole('button', { name: 'Add Station tools', exact: true })
        .click();
      await expect(
        page.getByText('Station tools selected for new chats.'),
      ).toBeVisible();
      await expect(
        page.getByRole('button', {
          name: 'Start a chat with Google Antigravity',
        }),
      ).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth,
          ),
        )
        .toBe(true);
      await page.screenshot({
        path: testInfo.outputPath(`station-tools-${width}-${theme}.png`),
        fullPage: true,
      });
      if (process.env.STATION_GUIDED_SETUP_CAPTURE_DIR) {
        await mkdir(process.env.STATION_GUIDED_SETUP_CAPTURE_DIR, {
          recursive: true,
        });
        const name = `station-tools-${width}-${theme}.png`;
        await copyFile(
          testInfo.outputPath(name),
          join(process.env.STATION_GUIDED_SETUP_CAPTURE_DIR, name),
        );
      }
    });
  }
}
