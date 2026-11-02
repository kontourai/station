import { copyFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { AccountPreferencesView } from '@kontourai/station-contracts/account-preferences';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import type { CoordinatorDesignationRead } from '@kontourai/station-contracts/coordinator';
import type { OrchestrationSessionSummary } from '@kontourai/station-contracts/orchestration';
import { expect } from '@playwright/test';
import { seedMobileTaskSwitcher } from './helpers/chat-shell-fixture';
import { rejectUnexpectedFixtureRequest, test } from './helpers/fixture-audit';
import {
  installMockOrchestrationConversationEventWindow,
  installMockOrchestrationEventWindow,
  installMockOrchestrationSse,
  seedActiveChats,
} from './helpers/orchestration';

const session: OrchestrationSessionSummary = {
  threadId: 'owned-parent',
  conversationId: 'owned-parent',
  provider: 'codex',
  projectSlug: 'default',
  assignedAgentSlug: agentId('station'),
  displayTitle: 'Owned parent',
  status: 'closed',
  lifecycleState: 'running',
  hasActiveTurn: false,
  controlMode: 'station-owned',
  answerability: { answerable: true },
  isLoaded: false,
  isPersisted: true,
  eventCount: 2,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
  ownedWork: {
    state: 'unknown',
    ownLifecycleState: 'canceled',
    runningChildCount: 1,
    pendingStopCount: 1,
    pendingStops: [{ custody: 'unknown', reason: 'dead-owner', count: 1 }],
  },
};

for (const width of [390, 1440])
  for (const theme of ['light', 'dark'] as const) {
    test(`owned custody inbox and detail ${width} ${theme}`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: 'reduce' });
      await seedMobileTaskSwitcher(page);
      await seedActiveChats(page, []);
      await installMockOrchestrationSse(page);
      await installMockOrchestrationEventWindow(page, 'codex', {
        'owned-parent': [
          {
            method: 'session.started',
            threadId: 'owned-parent',
            sessionId: 'owned-parent',
            provider: 'codex',
            createdAt: session.createdAt,
          },
          {
            method: 'session.cancellation-requested',
            threadId: 'owned-parent',
            sessionId: 'owned-parent',
            provider: 'codex',
            action: 'stop',
            createdAt: session.updatedAt,
          },
        ],
      });
      await installMockOrchestrationConversationEventWindow(page, (id) =>
        id === 'owned-parent' ? ['owned-parent'] : [],
      );
      await page.route('**/api/orchestration/coordinator', (route) =>
        route.fulfill({
          json: {
            success: true,
            data: { designation: null } satisfies CoordinatorDesignationRead,
          },
        }),
      );
      await page.route('**/api/me/preferences', (route) =>
        route.fulfill({
          json: {
            success: true,
            data: {
              schemaVersion: 1,
              values: { theme },
              revision: `custody-${theme}`,
            } satisfies AccountPreferencesView,
          },
        }),
      );
      await page.addInitScript((value) => {
        localStorage.setItem('theme', value);
        const settings = JSON.parse(
          localStorage.getItem('station-device-settings-v1') ??
            '{"version":3,"values":{}}',
        );
        settings.values.theme = value;
        localStorage.setItem(
          'station-device-settings-v1',
          JSON.stringify(settings),
        );
        localStorage.setItem('station:onboarding-setup-dismissed', '1');
      }, theme);
      let removed = false;
      const commands: unknown[] = [];
      await page.route('**/api/orchestration/sessions/read-model', (route) =>
        route.fulfill({
          json: { success: true, data: removed ? [] : [session] },
        }),
      );
      await page.route('**/api/orchestration/sessions/owned-parent', (route) =>
        route.fulfill({
          json: { success: true, data: { session, events: [] } },
        }),
      );
      await page.route('**/api/orchestration/commands/receipts**', (route) =>
        route.fulfill({ json: { success: true, data: [] } }),
      );
      await page.route(
        '**/api/orchestration/sessions/owned-parent/checkpoints**',
        (route) => route.fulfill({ json: { success: true, data: [] } }),
      );
      await page.route('**/api/orchestration/commands', async (route) => {
        if (route.request().method() !== 'POST')
          return rejectUnexpectedFixtureRequest(route);
        const command = route.request().postDataJSON();
        expect(command).toEqual({
          type: 'releaseUnknownOwnedWork',
          threadId: 'owned-parent',
          confirmation: 'child-process-may-still-be-running',
        });
        commands.push(command);
        removed = true;
        return route.fulfill({ json: { success: true } });
      });
      const capture = async (name: string) => {
        await page.screenshot({
          path: testInfo.outputPath(name),
          animations: 'disabled',
        });
        if (process.env.STATION_UI_REVIEW_SCREENSHOT_DIR) {
          mkdirSync(process.env.STATION_UI_REVIEW_SCREENSHOT_DIR, {
            recursive: true,
          });
          copyFileSync(
            testInfo.outputPath(name),
            resolve(process.env.STATION_UI_REVIEW_SCREENSHOT_DIR, name),
          );
        }
      };
      await page.goto('/?dock=open');
      const inbox =
        width === 390
          ? page.getByRole('region', { name: 'Inbox', exact: true })
          : page.locator('.chat-dock-inbox');
      const row = inbox
        .getByTestId('inbox-row')
        .filter({ hasText: 'Owned parent' });
      await expect(row).toBeVisible();
      await expect(row).toContainText('Unknown');
      await expect(row).toContainText(
        'The Station process that owned the child has exited.',
      );
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await page.evaluate(() => document.fonts.ready);
      await capture(`inbox-${width}-${theme}.png`);
      await page.goto('/?surface=activity&session=owned-parent');
      const detail = page.getByTestId('session-detail');
      await expect(detail).toBeVisible();
      const cleanup = detail.getByRole('region', {
        name: 'Owned child cleanup',
      });
      await expect(cleanup).toContainText(
        'The Station process that owned the child has exited.',
      );
      await cleanup
        .getByRole('button', { name: 'Release and remove', exact: true })
        .scrollIntoViewIfNeeded();
      await capture(`session-detail-${width}-${theme}.png`);
      await cleanup
        .getByRole('button', { name: 'Release and remove', exact: true })
        .click();
      const confirmation = page.getByRole('alertdialog');
      await expect(confirmation).toContainText(
        'Child processes may still be running and will no longer be tracked',
      );
      expect(commands).toEqual([]);
      await capture(`confirmation-${width}-${theme}.png`);
      await confirmation.getByRole('button', { name: 'Keep tracking' }).click();
      expect(commands).toEqual([]);
      await cleanup
        .getByRole('button', { name: 'Release and remove', exact: true })
        .click();
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Release and remove', exact: true })
        .click();
      await expect.poll(() => commands.length).toBe(1);
      await expect(detail).toHaveCount(0);
    });
  }
