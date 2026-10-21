import { copyFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import {
  seedE2EFirstRunDecision,
  seedE2EUsageTelemetryDisclosure,
} from '../scripts/run-e2e-suite.mjs';
import { readE2EOperatorCredential } from './helpers/e2e-operator-credential';
import { test } from './helpers/fixture-audit';
import {
  allocateLiveStation,
  createProject,
  createRepository,
  createTaskFromProject,
  type LiveStation,
  startStation,
  stopStation,
} from './helpers/live-station-task';
import { pairBrowser } from './live/helpers/station-instance.mjs';

test.describe
  .serial('Task room reload recovery', () => {
    let live: LiveStation;
    let repositoryRoot = '';
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
    test.beforeAll(async ({}, testInfo) => {
      testInfo.setTimeout(240_000);
      live = await allocateLiveStation(
        'station-task-recovery-',
        'task-recovery',
      );
      repositoryRoot = realpathSync(
        mkdtempSync(join(tmpdir(), 'station-task-recovery-repos-')),
      );
      await startStation(live, true, {
        logFile: testInfo.outputPath('station.log'),
      });
      const credential = readE2EOperatorCredential(live.home);
      await seedE2EFirstRunDecision(live.api, credential);
      await seedE2EUsageTelemetryDisclosure(live.api, credential);
    });
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring before testInfo
    test.afterAll(async ({}, testInfo) => {
      testInfo.setTimeout(180_000);
      if (live) await stopStation(live);
      if (testInfo.status === testInfo.expectedStatus) {
        if (repositoryRoot)
          rmSync(repositoryRoot, { recursive: true, force: true });
        if (live?.home) rmSync(live.home, { recursive: true, force: true });
      }
    });

    test('restores a saved draft only after review across a real page reload', async ({
      page,
    }, testInfo) => {
      await pairBrowser(page, {
        root: process.cwd(),
        instance: live.instance,
        serverPort: live.serverPort,
        uiOrigin: live.ui,
      });
      const repository = join(repositoryRoot, 'draft');
      await createRepository(repository, 'reload-draft');
      await createProject(page, 'reload-draft', repository);
      await createTaskFromProject(
        page,
        live,
        'reload-draft',
        'Reload draft recovery',
        repository,
        'reload-draft',
      );
      const input = page.getByRole('textbox', { name: 'Message the Task' });
      await expect(input).toBeEditable();
      await input.fill('Keep this draft through a reload; do not send it.');
      let writes = 0;
      page.on('request', (request) => {
        if (
          request.method() === 'POST' &&
          /\/room\/messages$|\/delegations$/.test(request.url())
        )
          writes += 1;
      });
      page.once('dialog', (dialog) => dialog.accept());
      await page.reload();
      const saved = page.getByRole('region', { name: 'Saved Task draft' });
      await expect(saved).toBeVisible();
      await expect(
        saved.getByRole('button', { name: 'Restore saved draft' }),
      ).toBeEnabled();
      await expect(
        page.getByRole('region', { name: 'Here now' }).getByRole('listitem'),
      ).toHaveCount(1);
      await expect(input).toBeDisabled();
      expect(writes).toBe(0);
      const visualRoot = mkdtempSync(
        join(process.cwd(), '.kontourai', 'task-recovery-visual-'),
      );
      console.log(`[task-recovery-visual] ${visualRoot}`);
      // Theme attributes are a rendering fixture; no appearance-setting persistence is claimed.
      for (const theme of ['dark', 'light']) {
        await page.evaluate(
          (theme) => document.documentElement.setAttribute('data-theme', theme),
          theme,
        );
        for (const width of [1280, 390]) {
          await page.setViewportSize({ width, height: 900 });
          await saved.scrollIntoViewIfNeeded();
          await expect(saved).toBeInViewport();
          if (width === 390) {
            for (const button of await saved.getByRole('button').all()) {
              const box = await button.boundingBox();
              expect(box).not.toBeNull();
              expect(box!.height).toBeGreaterThanOrEqual(44);
              expect(box!.width).toBeGreaterThanOrEqual(44);
            }
          }
          await page.screenshot({
            path: testInfo.outputPath(`saved-draft-${theme}-${width}.png`),
            fullPage: true,
          });
          copyFileSync(
            testInfo.outputPath(`saved-draft-${theme}-${width}.png`),
            join(visualRoot, `saved-draft-${theme}-${width}.png`),
          );
        }
      }
      await saved.getByRole('button', { name: 'Restore saved draft' }).click();
      await expect(input).toHaveValue(
        'Keep this draft through a reload; do not send it.',
      );
      expect(writes).toBe(0);
      await page
        .getByRole('button', { name: 'Discard draft', exact: true })
        .click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Cancel' })
        .click();
      await expect(input).toHaveValue(
        'Keep this draft through a reload; do not send it.',
      );
      await page
        .getByRole('button', { name: 'Discard draft', exact: true })
        .click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Discard', exact: true })
        .click();
      await expect(input).toHaveValue('');
      await page.reload();
      await expect(input).toBeEditable();
      await expect(saved).toHaveCount(0);
      expect(writes).toBe(0);
    });

    test('a lost committed message acknowledgement retries the same proposal after reload', async ({
      page,
    }) => {
      await pairBrowser(page, {
        root: process.cwd(),
        instance: live.instance,
        serverPort: live.serverPort,
        uiOrigin: live.ui,
      });
      const repository = join(repositoryRoot, 'uncertain');
      await createRepository(repository, 'reload-uncertain');
      await createProject(page, 'reload-uncertain', repository);
      await createTaskFromProject(
        page,
        live,
        'reload-uncertain',
        'Uncertain message recovery',
        repository,
        'reload-uncertain',
      );
      const input = page.getByRole('textbox', { name: 'Message the Task' });
      await expect(input).toBeEditable();
      const bodies: unknown[] = [];
      const pattern = '**/room/messages';
      await page.route(pattern, async (route) => {
        bodies.push(route.request().postDataJSON());
        const response = await route.fetch();
        expect(
          response.ok(),
          `Room message returned ${response.status()}: ${await response.text()}`,
        ).toBe(true);
        if (bodies.length === 1) await route.abort('failed');
        else await route.fulfill({ response });
      });
      try {
        await input.fill(
          'One committed message, even when its acknowledgement is lost.',
        );
        await page.getByRole('button', { name: 'Send to task room' }).click();
        await expect(
          page.getByText(/Message acknowledgement is unavailable/),
        ).toBeVisible();
        page.once('dialog', (dialog) => dialog.accept());
        await page.reload();
        await expect(
          page.getByRole('region', { name: 'Saved Task draft' }),
        ).toBeVisible();
        expect(bodies).toHaveLength(1);
        await page.getByRole('button', { name: 'Restore saved draft' }).click();
        await expect(input).toBeDisabled();
        await page
          .getByRole('button', { name: 'Retry same room message' })
          .click();
        await expect(input).toHaveValue('');
        expect(bodies).toHaveLength(2);
        expect(bodies[1]).toEqual(bodies[0]);
        await expect(
          page
            .getByRole('region', { name: 'Task room conversation' })
            .getByText(
              'One committed message, even when its acknowledgement is lost.',
              { exact: true },
            ),
        ).toHaveCount(1);
      } finally {
        if (!page.isClosed()) await page.unroute(pattern);
      }
    });
  });
