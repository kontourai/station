import { execFile } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { expect, type Page, type TestInfo } from '@playwright/test';
import {
  seedE2EFirstRunDecision,
  seedE2EUsageTelemetryDisclosure,
} from '../scripts/run-e2e-suite.mjs';
import { contrastRatio } from './helpers/color-contrast';
import { readE2EOperatorCredential } from './helpers/e2e-operator-credential';
import { test } from './helpers/fixture-audit';
import {
  allocateLiveStation,
  apiJson,
  createProject,
  createRepository,
  createTaskFromProject,
  type LiveStation,
  prepareLiveStationBuild,
  startStation,
  stopStation,
} from './helpers/live-station-task';
import { pairBrowser } from './live/helpers/station-instance.mjs';

const execute = promisify(execFile);
const plan =
  '# Review integration\n\nKeep the review loop easy to use.\n\n## Verify\n\nCheck both themes and narrow screens.';

async function writePlan(page: Page, desired: string) {
  await page.getByRole('tab', { name: 'Plan', exact: true }).click();
  const editor = page.getByRole('region', { name: 'Task room editor' });
  await editor.getByRole('button', { name: 'Edit brief', exact: true }).click();
  const input = editor.getByRole('textbox', {
    name: 'Task brief',
    exact: true,
  });
  await expect(input).toBeEditable();
  await input.fill(desired);
  await editor.getByRole('button', { name: 'View brief', exact: true }).click();
  await expect(
    editor.getByRole('status').filter({ hasText: /^Saved$/ }),
  ).toHaveText('Saved', {
    timeout: 30_000,
  });
  await page.getByRole('tab', { name: 'Review', exact: true }).click();
}

async function shots(page: Page, testInfo: TestInfo, prefix: string) {
  const directory = process.env.STATION_REVIEW_SHOTS_DIR;
  if (directory) mkdirSync(directory, { recursive: true });
  for (const theme of ['dark', 'light']) {
    const reviewUrl = page.url();
    await page.goto(new URL('/appearance', reviewUrl).href);
    const mode = page.getByRole('radiogroup', { name: 'Mode', exact: true });
    const label = theme === 'dark' ? 'Dark' : 'Light';
    if (
      !(await mode.getByRole('radio', { name: label, exact: true }).isChecked())
    ) {
      const [saved] = await Promise.all([
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/me/preferences' &&
            response.request().method() === 'PATCH' &&
            response.request().postDataJSON()?.theme === theme,
        ),
        mode.getByText(label, { exact: true }).click(),
      ]);
      expect(saved.ok()).toBe(true);
      expect(await saved.json()).toMatchObject({
        success: true,
        data: { values: { theme } },
      });
    }
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const [reviewResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          /\/api\/tasks\/[^/]+\/review$/.test(
            new URL(response.url()).pathname,
          ) && response.request().method() === 'GET',
      ),
      page.goto(reviewUrl),
    ]);
    expect(reviewResponse.ok()).toBe(true);
    await reviewResponse.finished();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(
      page.getByRole('article', { name: /^Thread \d+$/ }).first(),
    ).toBeVisible();
    for (const expand of await page
      .getByRole('button', { name: /^Expand thread \d+$/ })
      .all())
      await expand.click();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(
        page.getByRole('tabpanel', { name: 'Review', exact: true }),
      ).toBeVisible();
      await expect(
        page
          .locator(
            '.task-review .review-document__markdown, .task-review .review-image__stage',
          )
          .first(),
      ).toBeVisible();
      await expect(
        page.locator('.task-review .review-thread__body').first(),
      ).toBeVisible();
      if (width === 390) {
        const rail = await page.locator('.task-review__comments').boundingBox();
        const review = await page.locator('.task-review').boundingBox();
        expect(
          Math.abs(rail!.y + rail!.height - review!.y - review!.height),
        ).toBeLessThan(2);
        if (prefix === 'screens') {
          const viewport = page.getByRole('region', {
            name: 'Screen viewport',
            exact: true,
          });
          await expect(viewport).toBeVisible();
          await expect(
            page.getByText('Scroll to explore the Screen.', { exact: true }),
          ).toBeVisible();
          const screen = await viewport.boundingBox();
          const content = await page
            .locator('.task-review__content')
            .boundingBox();
          expect(screen!.y + screen!.height).toBeLessThan(
            content!.y + content!.height,
          );
        }
      }
      for (const starter of await page
        .locator('.review-avatar__starter .task-room-avatar')
        .all())
        expect(
          Number.parseFloat(
            await starter.evaluate(
              (element) => getComputedStyle(element).fontSize,
            ),
          ),
        ).toBeGreaterThanOrEqual(12);
      const probes = [
        ['Review tab', page.getByRole('tab', { name: 'Review', exact: true })],
        ['Share', page.getByRole('button', { name: 'Share', exact: true })],
        ['Brief', page.getByRole('button', { name: 'Brief', exact: true })],
        ...(await page
          .locator('.review-evidence .review-chip, .review-image .review-chip')
          .all()
          .then((chips) =>
            chips.map((chip) => ['Commit chip', chip] as const),
          )),
      ] as const;
      const contrast = [];
      for (const [label, locator] of probes) {
        const opacity = await locator.evaluate(
          (element) => getComputedStyle(element).opacity,
        );
        const disabled = await locator.isDisabled();
        const ratio = await contrastRatio(locator);
        contrast.push({ label, ratio, opacity, disabled });
        if (label !== 'Share' || !disabled) {
          expect(opacity, `${theme} ${label} opacity`).toBe('1');
          expect(ratio, `${theme} ${label} contrast`).toBeGreaterThanOrEqual(
            4.5,
          );
        }
      }
      writeFileSync(
        testInfo.outputPath(`${prefix}-${theme}-${width}-contrast.json`),
        JSON.stringify(contrast, null, 2),
      );
      const name = `${prefix}-${theme}-${width}.png`;
      await page.screenshot({
        path: testInfo.outputPath(name),
        fullPage: true,
      });
      if (directory)
        copyFileSync(testInfo.outputPath(name), join(directory, name));
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}

async function timelineShots(page: Page, testInfo: TestInfo, empty = false) {
  const directory = process.env.STATION_REVIEW_SHOTS_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive: true });
  const taskUrl = page.url();
  for (const theme of empty ? ['dark'] : ['dark', 'light']) {
    await page.goto(new URL('/appearance', taskUrl).href);
    const mode = page.getByRole('radiogroup', { name: 'Mode', exact: true });
    const label = theme === 'dark' ? 'Dark' : 'Light';
    if (
      !(await mode.getByRole('radio', { name: label, exact: true }).isChecked())
    ) {
      const [saved] = await Promise.all([
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/me/preferences' &&
            response.request().method() === 'PATCH' &&
            response.request().postDataJSON()?.theme === theme,
        ),
        mode.getByText(label, { exact: true }).click(),
      ]);
      expect(saved.ok()).toBe(true);
    }
    await page.goto(taskUrl);
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    const timeline = page.getByRole('region', {
      name: 'Timeline',
      exact: true,
    });
    if (empty) await expect(timeline.getByText('No Screens yet')).toBeVisible();
    else
      await expect(timeline.locator('.task-timeline__capture')).toHaveCount(2);
    for (const width of empty ? [390] : [390, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(timeline).toBeVisible();
      if (!empty) await expect(timeline.locator('img')).toHaveCount(2);
      const name = empty
        ? 'timeline-empty.png'
        : `timeline-${theme}-${width}.png`;
      await page.screenshot({
        path: testInfo.outputPath(name),
        fullPage: true,
      });
      copyFileSync(testInfo.outputPath(name), join(directory, name));
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}

test.describe
  .serial('Task review on an isolated Station', () => {
    let live: LiveStation;
    let root: string;
    let taskId: string;
    let commit: string;
    let app: Server | undefined;
    const useClaude = process.env.STATION_REVIEW_USE_CLAUDE === '1';

    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring
    test.beforeAll(async ({}, info) => {
      info.setTimeout(360_000);
      root = mkdtempSync(join(tmpdir(), 'station-review-journey-'));
      live = await allocateLiveStation(
        'station-review-home-',
        'review-journey',
      );
      await prepareLiveStationBuild(live);
      // Control only the raw OS identity; the real provider, route and UI resolve its display name.
      const identityFixture = join(root, 'review-identity.mjs');
      writeFileSync(
        identityFixture,
        `import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
const original = os.userInfo;
os.userInfo = (...args) => ({ ...original(...args), username: 'reviewer' });
syncBuiltinESMExports();
`,
      );
      await startStation(live, true, {
        environment: {
          ...process.env,
          NODE_OPTIONS: [
            process.env.NODE_OPTIONS,
            `--import=${pathToFileURL(identityFixture).href}`,
          ]
            .filter(Boolean)
            .join(' '),
        },
        logFile: info.outputPath('station.log'),
      });
      const credential = readE2EOperatorCredential(live.home);
      await seedE2EFirstRunDecision(live.api, credential);
      await seedE2EUsageTelemetryDisclosure(live.api, credential);
      writeFileSync(
        info.outputPath('instance.json'),
        JSON.stringify(live, null, 2),
      );
    });
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires fixture destructuring
    test.afterAll(async ({}, info) => {
      info.setTimeout(180_000);
      if (app) {
        app.closeAllConnections();
        await new Promise<void>((resolve) => app!.close(() => resolve()));
      }
      if (live) await stopStation(live);
      if (info.status === info.expectedStatus) {
        if (root) rmSync(root, { recursive: true, force: true });
        if (live) rmSync(live.home, { recursive: true, force: true });
      }
    });

    test('comments, relocates, resolves and reopens without provider credentials', async ({
      page,
    }, info) => {
      info.setTimeout(240_000);
      await pairBrowser(page, {
        root: process.cwd(),
        instance: live.instance,
        serverPort: live.serverPort,
        uiOrigin: live.ui,
      });
      expect(
        await apiJson(page, '/api/feature-previews/task-review', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: true }),
        }),
      ).toMatchObject({ success: true });
      const repo = join(root, 'project');
      await createRepository(repo, 'review-demo');
      commit = (
        await execute('git', ['rev-parse', 'HEAD'], {
          cwd: repo,
          windowsHide: true,
          timeout: 5000,
          maxBuffer: 4096,
        })
      ).stdout.trim();
      await createProject(page, 'review-demo', repo);
      taskId = await createTaskFromProject(
        page,
        live,
        'review-demo',
        'Refine Task review',
        repo,
        'review-demo',
      );
      await page.reload();
      await timelineShots(page, info, true);
      await page.getByRole('tab', { name: 'Review', exact: true }).click();
      await expect(
        page.getByRole('tabpanel', { name: 'Review', exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole('region', { name: 'Task review', exact: true }),
      ).toBeVisible();
      await writePlan(page, plan);
      const content = page.getByRole('article', {
        name: 'Plan content',
        exact: true,
      });
      // A normal paragraph click selects its source block; C opens the composer.
      await content
        .getByText('Keep the review loop easy to use.', { exact: true })
        .click();
      await content.press('c');
      const composer = page.getByRole('dialog', { name: 'New review comment' });
      await composer
        .getByRole('textbox', { name: 'New comment' })
        .fill(
          `Please reply using task_thread_reply with the existing commit ${commit} as evidence. Leave the thread and Task unresolved for the person. No file changes or shell commands are needed.`,
        );
      await composer
        .getByRole('button', { name: 'Comment', exact: true })
        .click();
      const card = page.getByRole('article', { name: 'Thread 1', exact: true });
      await expect(card).toContainText('Please reply using task_thread_reply');
      await writePlan(page, '# Changed approach\n\nUse the public contract.');
      await page.getByRole('button', { name: /^Outdated 1$/ }).click();
      await expect(card).toContainText('Outdated');
      await expect(card).toContainText('Keep the review loop easy to use.');
      await writePlan(
        page,
        '# Moved approach\n\nA new introduction.\n\nKeep the review loop easy to use.\n\nCheck both themes and narrow screens.',
      );
      await page.getByRole('button', { name: /^Open 1$/ }).click();
      await expect(card.getByText('Outdated', { exact: true })).toHaveCount(0);

      await expect(
        card.locator('.review-thread__header strong').first(),
      ).toHaveText('Reviewer');
      await expect(card.locator('.review-thread__state')).toHaveText('Open');
      info.annotations.push({
        type: 'qualification',
        description: useClaude
          ? 'Live text-reply qualification runs in the next test.'
          : 'NOT_QUALIFIED: text reply requires STATION_REVIEW_USE_CLAUDE=1 and signed-in Claude; the live-only test is explicitly skipped.',
      });
      await card.hover();
      await card
        .getByRole('button', { name: 'Resolve thread 1', exact: true })
        .click();
      await page.getByRole('button', { name: /^Resolved 1$/ }).click();
      await expect(
        page.getByRole('button', { name: /^Resolved 1$/ }),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(
        card.getByRole('button', { name: 'Reopen thread 1', exact: true }),
      ).toBeVisible();
      await card
        .getByRole('button', { name: 'Reopen thread 1', exact: true })
        .click();
      await expect(card).toHaveCount(0);
      await expect(
        page.getByRole('button', { name: /^Resolved$/ }),
      ).toHaveAttribute('aria-pressed', 'true');
      await page.getByRole('button', { name: /^Open 1$/ }).click();
      await expect(
        page.getByRole('button', { name: /^Open 1$/ }),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(
        card.getByRole('button', { name: 'Resolve thread 1', exact: true }),
      ).toBeVisible();
      const resolvedFilter = page.getByRole('button', {
        name: 'Resolved',
        exact: true,
      });
      await resolvedFilter.hover();
      await expect(resolvedFilter).toHaveAttribute('aria-pressed', 'false');
      await expect(resolvedFilter).toHaveCSS(
        'background-color',
        'rgba(0, 0, 0, 0)',
      );
      await expect(resolvedFilter).toHaveCSS('border-top-style', 'none');
      const [sendResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname ===
              `/api/tasks/${taskId}/review/send`,
        ),
        page.getByRole('button', { name: 'Send 1', exact: true }).click(),
      ]);
      expect(sendResponse.status()).toBe(409);
      expect(await sendResponse.json()).toMatchObject({
        success: false,
        code: 'no-live-agent',
      });
      await expect(page.getByRole('alert')).toContainText(
        'Start the lead agent before sending.',
      );
      await expect(card.locator('.review-thread__state')).toHaveText('Open');
      await shots(page, info, 'review');
    });

    test('live Claude replies through its bound tool with verified commit evidence', async ({
      page,
    }, info) => {
      test.skip(
        !useClaude,
        'NOT_QUALIFIED: live text reply requires STATION_REVIEW_USE_CLAUDE=1 and signed-in Claude. ACP delegated-custody fallback is unavailable (403).',
      );
      info.setTimeout(240_000);
      await pairBrowser(page, {
        root: process.cwd(),
        instance: live.instance,
        serverPort: live.serverPort,
        uiOrigin: live.ui,
      });
      await page.goto(`${live.ui}/tasks/${taskId}?taskView=review`);
      await page
        .getByRole('button', { name: 'Expand thread 1', exact: true })
        .click();
      const card = page.getByRole('article', { name: 'Thread 1', exact: true });
      expect(
        await apiJson(page, '/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slug: 'review-lead',
            name: 'Review lead',
            prompt:
              'Wait for review comments. Reply to sent threads with task_thread_reply and existing HEAD commit evidence. Never resolve a thread or mark the Task done; the person tests those controls. Do not modify files.',
            execution: { agentConnectionId: 'claude' },
            tools: { mcpServers: ['station-control'] },
          }),
        }),
      ).toMatchObject({ success: true });
      await expect
        .poll(
          async () =>
            (
              await apiJson<{ data: Array<{ slug: string }> }>(
                page,
                '/api/agents',
              )
            ).data.some((agent) => agent.slug === 'review-lead'),
          { timeout: 30_000 },
        )
        .toBe(true);
      expect(
        await apiJson(page, `/api/tasks/${taskId}/dispatch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            agentId: 'review-lead',
            sourceSurface: 'review-journey',
          }),
        }),
      ).toMatchObject({ success: true });
      await page.getByRole('button', { name: 'Send 1', exact: true }).click();
      await expect(
        card.getByRole('button', { name: new RegExp(commit.slice(0, 7)) }),
      ).toBeVisible({ timeout: 120_000 });
      await expect(card).toContainText('Replied');
      await expect(
        card.getByText('Claude Code', { exact: true }),
      ).toBeVisible();
      await expect(card.getByText('CC', { exact: true })).toBeVisible();
      await expect(card.locator('.review-avatar__starter')).toBeVisible();
      await expect(card).not.toContainText('human:local:operator');
      await expect(card).not.toContainText('Lead agent');
      await expect(
        page.getByText('Sent to the lead agent.', { exact: true }),
      ).toHaveCount(0);
      await expect(
        page.locator('.review-document__header .review-chip'),
      ).toHaveCount(0);
      await expect(
        card.getByRole('button', { name: new RegExp(commit.slice(0, 7)) }),
      ).not.toContainText('claimed');
      await expect(
        card.locator('.review-thread__header strong').first(),
      ).toHaveText('Reviewer');
      await shots(page, info, 'review');
      info.annotations.push({
        type: 'agent-evidence',
        description:
          'Real signed-in Claude Code, actual session-bound task_thread_reply. Commit existence is verified; no new repair or gate execution is claimed.',
      });
    });

    test('captures a real Browser session and posts a keyboard region pin', async ({
      page,
    }, info) => {
      info.setTimeout(150_000);
      await pairBrowser(page, {
        root: process.cwd(),
        instance: live.instance,
        serverPort: live.serverPort,
        uiOrigin: live.ui,
      });
      const acquisition = await apiJson<{ data: { state: string } }>(
        page,
        '/api/browser/acquisition',
      );
      test.skip(
        !['found-system', 'downloaded'].includes(acquisition.data.state),
        `NOT_VERIFIED: real Chromium unavailable (${acquisition.data.state})`,
      );
      app = createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/html' });
        response.end(
          '<!doctype html><html><title>Review capture</title><body><h1>Task review</h1><p>Capture this real Chromium viewport and pin the heading.</p></body></html>',
        );
      });
      await new Promise<void>((resolve) =>
        app!.listen(0, '127.0.0.1', resolve),
      );
      const address = app.address();
      if (!address || typeof address === 'string')
        throw new Error('Capture fixture did not listen');
      expect(
        await apiJson(page, '/api/browser/sessions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectSlug: 'review-demo',
            url: `http://127.0.0.1:${address.port}/`,
            viewport: { width: 1000, height: 700, deviceScaleFactor: 1 },
          }),
        }),
      ).toMatchObject({ success: true });
      await page.setViewportSize({ width: 390, height: 1000 });
      await page.goto(
        `${live.ui}/tasks/${taskId}?taskView=review&reviewKind=capture`,
      );
      await page.getByRole('button', { name: 'Capture', exact: true }).click();
      await expect(
        page.getByRole('combobox', { name: 'Browser session' }),
      ).toBeVisible();
      await expect(
        page
          .getByRole('combobox', { name: 'Browser session' })
          .getByRole('option'),
      ).toHaveText(`127.0.0.1:${address.port}`);
      await page
        .getByRole('button', { name: 'Capture Screen', exact: true })
        .click();
      const image = page
        .getByRole('region', { name: 'Screen review' })
        .getByRole('img');
      await expect(image).toBeVisible();
      await expect
        .poll(() =>
          image.evaluate((image) => (image as HTMLImageElement).naturalWidth),
        )
        .toBeGreaterThan(0);
      await expect(
        page.getByRole('button', { name: 'Capture', exact: true }),
      ).toBeFocused();
      const target = page.getByRole('button', { name: 'Place region pin' });
      await expect(page.locator('.review-image__hint')).toBeHidden();
      await target.focus();
      await expect(page.locator('.review-image__hint')).toBeVisible();
      await target.press('ArrowRight');
      await target.press('Enter');
      const composer = page.getByRole('dialog', { name: 'New review comment' });
      await composer
        .getByRole('textbox', { name: 'New comment' })
        .fill('Keep this heading aligned.');
      await composer
        .getByRole('button', { name: 'Comment', exact: true })
        .click();
      await expect(
        page.getByRole('article', { name: 'Thread 2', exact: true }),
      ).toContainText('Keep this heading aligned.');
      await target.press('j');
      await expect(
        page.getByRole('article', { name: 'Thread 2', exact: true }),
      ).toBeFocused();
      await expect(page.locator('.review-image__hint')).toBeHidden();
      const marker = page.locator('.review-image__marker');
      const region = page.locator('.review-image__region').first();
      const markerBox = await marker.boundingBox();
      const regionBox = await region.boundingBox();
      expect(markerBox).not.toBeNull();
      expect(regionBox).not.toBeNull();
      expect(
        Math.abs(markerBox!.x + markerBox!.width / 2 - regionBox!.x),
      ).toBeLessThan(2);
      expect(
        Math.abs(markerBox!.y + markerBox!.height - regionBox!.y),
      ).toBeLessThan(2);
      await target.hover();
      await expect(target).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      await shots(page, info, 'screens');
      if (process.env.STATION_REVIEW_SHOTS_DIR) {
        await page
          .getByRole('button', { name: 'Capture', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Capture Screen', exact: true })
          .click();
        await timelineShots(page, info);
      }
    });
  });
