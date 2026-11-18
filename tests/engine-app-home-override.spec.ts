import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AccountPreferencesView } from '@kontourai/station-contracts/account-preferences';
import type { AppHomeProfileStatus } from '@kontourai/station-sdk';
import { expect } from '@playwright/test';
import { agentConnectionFixture } from './helpers/connection-fixtures';
import { rejectUnexpectedFixtureRequest, test } from './helpers/fixture-audit';

const profile: AppHomeProfileStatus = {
  profileDir: '/station/app-homes/claude',
  exists: true,
  seededFrom: 'empty',
  authState: 'unauthenticated',
  keychainAuthPossible: false,
  usage: { sizeBytes: 2048, entryCount: 3, truncated: false },
};

for (const width of [390, 1440]) {
  for (const theme of ['light', 'dark'] as const) {
    test(`Engine App home reflects the saved connection at ${width} ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await page.addInitScript((value) => {
        localStorage.setItem('station:onboarding-setup-dismissed', '1');
        localStorage.setItem('theme', value);
        localStorage.setItem(
          'station-device-settings-v1',
          JSON.stringify({ version: 3, values: { theme: value } }),
        );
      }, theme);
      await page.route('**/api/me/preferences', async (route) => {
        if (route.request().method() !== 'GET') {
          return rejectUnexpectedFixtureRequest(route);
        }
        await route.fulfill({
          json: {
            success: true,
            data: {
              schemaVersion: 1,
              values: { theme },
              revision: `engine-app-home-${theme}`,
            } satisfies AccountPreferencesView,
          },
        });
      });
      let configuredHome = true;
      await page.route('**/api/connections/claude', async (route) => {
        if (route.request().method() !== 'GET') {
          return rejectUnexpectedFixtureRequest(route);
        }
        await route.fulfill({
          json: {
            success: true,
            data: agentConnectionFixture({
              id: 'claude',
              name: 'Claude Code',
              config: {
                useAppHome: true,
                ...(configuredHome ? { configHome: '~/.private-claude' } : {}),
              },
            }),
          },
        });
      });
      await page.route(
        '**/api/connections/agent/claude/app-home',
        async (route) => {
          if (route.request().method() !== 'GET') {
            return rejectUnexpectedFixtureRequest(route);
          }
          await route.fulfill({ json: { success: true, data: profile } });
        },
      );

      const openAdvanced = async () => {
        await page.goto('/connections/engines/claude');
        await page.getByText('Advanced', { exact: true }).click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      };
      const capture = async (state: string) => {
        const name = `engine-app-home-${state}-${width}-${theme}.png`;
        await page.screenshot({ path: testInfo.outputPath(name) });
        const directory = process.env.STATION_UI_REVIEW_SCREENSHOT_DIR;
        if (directory) {
          mkdirSync(directory, { recursive: true });
          copyFileSync(testInfo.outputPath(name), resolve(directory, name));
        }
      };
      const appHome = page.getByRole('checkbox', {
        name: 'Run sessions in a Station-managed app home',
      });
      const snapshot = page.getByRole('button', { name: /Import a snapshot/ });
      const clear = page.getByRole('button', { name: 'Clear this app home' });

      await openAdvanced();
      const enabled = page.getByRole('checkbox', {
        name: /Expose this engine in Connections and agent setup/,
      });
      await expect(enabled).toBeChecked();
      await expect(
        page.getByText('Model backend', { exact: true }),
      ).toBeVisible();
      await expect(appHome).toBeDisabled();
      await expect(appHome).not.toBeChecked();
      await expect(page.getByText(/A custom home is configured/)).toBeVisible();
      await expect(page.getByText(/private-claude/)).toHaveCount(0);
      await expect(snapshot).toHaveCount(0);
      await expect(clear).toBeEnabled();
      await expect(page.getByText('Loading accounts')).toHaveCount(0);
      await appHome.scrollIntoViewIfNeeded();
      await capture('configured');
      await clear.click();
      const confirmation = page.getByRole('alertdialog', {
        name: 'Clear app home',
      });
      await expect(confirmation).toBeVisible();
      await confirmation.getByRole('button', { name: 'Cancel' }).click();

      configuredHome = false;
      await openAdvanced();
      await expect(appHome).toBeEnabled();
      await expect(appHome).toBeChecked();
      await expect(snapshot).toBeEnabled();
      await expect(clear).toBeDisabled();
      const include = page.getByRole('checkbox', {
        name: 'Include sign-in credentials',
      });
      await expect(include).not.toBeChecked();
      await include.check();
      await expect(include).toBeChecked();
      await expect(page.getByText('Loading accounts')).toHaveCount(0);
      await appHome.scrollIntoViewIfNeeded();
      await capture('station-managed');
    });
  }
}
