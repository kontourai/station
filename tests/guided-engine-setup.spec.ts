import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentMetadata } from '@kontourai/station-contracts/agent';
import {
  agentId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import { expect } from '@playwright/test';
import { agentConnectionFixture } from './helpers/connection-fixtures';
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
      const engine = agentConnectionFixture({
        id: 'antigravity',
        name: 'Google Antigravity',
        type: 'acp',
        config: { executionClass: 'connected' },
      });
      const json = (data: unknown) => ({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data }),
      });
      await page.route('**/api/connections/agents', (route) =>
        route.fulfill(json(connected ? [engine] : [])),
      );
      await page.route('**/api/connections/agents/catalog', (route) =>
        route.fulfill(json([])),
      );
      await page.route('**/api/connections/antigravity', (route) =>
        route.fulfill(json(engine)),
      );
      const agent: AgentMetadata = {
        slug: agentId('antigravity'),
        name: 'Google Antigravity',
        updatedAt: '2026-11-17T00:00:00.000Z',
        execution: { agentConnectionId: engineConnectionId('antigravity') },
      };
      await page.route('**/api/agents', (route) =>
        route.fulfill(json(connected ? [agent] : [])),
      );
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
      await page.route('**/acp/connections/antigravity/sign-in', (route) =>
        route.fulfill(
          json({
            connectionId: 'antigravity',
            engineName: 'Google Antigravity',
            status: { state: 'unknown', source: 'none', checkable: false },
            methods: [],
            credentials: [],
            allowed: { signIn: true, terminal: true },
          }),
        ),
      );
      const capture = async (stage: string) => {
        const name = `${stage}-${width}-${theme}.png`;
        const path = testInfo.outputPath(name);
        await page.screenshot({
          path: testInfo.outputPath(name),
          fullPage: true,
          animations: 'disabled',
        });
        if (process.env.STATION_GUIDED_SETUP_CAPTURE_DIR) {
          await mkdir(process.env.STATION_GUIDED_SETUP_CAPTURE_DIR, {
            recursive: true,
          });
          await copyFile(
            path,
            join(process.env.STATION_GUIDED_SETUP_CAPTURE_DIR, name),
          );
        }
      };
      await page.goto('/connections/engines');
      await page
        .getByRole('button', { name: 'Add engine', exact: true })
        .click();
      await expect(page).toHaveURL(/\/connections\/engines\/new$/);
      await expect(
        page.getByRole('heading', { name: 'Choose an engine' }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', {
          name: 'Set up Google Antigravity',
          exact: true,
        }),
      ).toBeVisible();
      await page.getByRole('searchbox', { name: 'Find an engine' }).fill('agy');
      await expect(
        page.getByRole('button', {
          name: 'Set up Google Antigravity',
          exact: true,
        }),
      ).toBeVisible();
      await capture('chooser');
      await page
        .getByRole('button', { name: 'Set up Google Antigravity', exact: true })
        .click();
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
      const box = await review.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(box!.y + box!.height).toBeLessThanOrEqual(900);
      await capture('installer-review');
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
        page.getByRole('status').filter({ hasText: /^Ready$/ }),
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
      await capture('station-tools');
      await page.getByRole('button', { name: 'Done', exact: true }).click();
      await expect(page).toHaveURL(/\/connections\/engines\/antigravity$/);
      await expect(
        page.getByRole('heading', { name: 'Google Antigravity', exact: true }),
      ).toBeVisible();
      if (width === 390)
        await page.getByRole('button', { name: 'Back to list' }).click();
      await expect(
        page
          .locator('.split-pane__list')
          .getByText('Google Antigravity', { exact: true }),
      ).toBeVisible();
      await capture('connected-engine');
    });
  }
}
