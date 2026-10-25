import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, type Page, type TestInfo } from '@playwright/test';
import {
  seedE2EFirstRunDecision,
  seedE2EUsageTelemetryDisclosure,
} from '../scripts/run-e2e-suite.mjs';
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

async function shots(page: Page, info: TestInfo, prefix: string) {
  const directory =
    process.env.STATION_REVIEW_SHOTS_DIR ?? info.outputPath('shots');
  mkdirSync(directory, { recursive: true });
  for (const theme of ['dark', 'light']) {
    // Rendering fixture only: this does not claim appearance-setting persistence.
    await page.evaluate(
      (theme) => document.documentElement.setAttribute('data-theme', theme),
      theme,
    );
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(
        page.getByRole('tabpanel', { name: 'Review', exact: true }),
      ).toBeVisible();
      await page.screenshot({
        path: join(directory, `${prefix}-${theme}-${width}.png`),
        fullPage: true,
      });
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
      await startStation(live, true, {
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

    test('comments, relocates, sends to the lead, displays verified commit evidence, resolves and reopens', async ({
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

      const engineId = useClaude ? 'claude' : 'review-journey';
      if (!useClaude) {
        expect(
          await apiJson(page, '/acp/connections', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              id: engineId,
              name: 'Review journey fixture',
              command: process.execPath,
              args: [
                join(process.cwd(), 'tests/helpers/task-review-engine.mjs'),
              ],
              cwd: repo,
              provideToolServers: ['station-control'],
            }),
          }),
        ).toMatchObject({ success: true });
      }
      expect(
        await apiJson(page, '/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            slug: 'review-lead',
            name: 'Review lead',
            prompt:
              'Wait for review comments. Reply to sent threads with task_thread_reply and existing HEAD commit evidence. Never resolve a thread or mark the Task done; the person tests those controls. Do not modify files.',
            execution: { agentConnectionId: engineId },
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
        page.getByText('Sent to the lead agent.', { exact: true }),
      ).toBeVisible();
      await expect(
        card.getByRole('button', { name: new RegExp(commit.slice(0, 7)) }),
      ).toBeVisible({ timeout: 120_000 });
      await expect(card).toContainText('Replied');
      await expect(card).not.toContainText('claimed');
      await card.hover();
      await card
        .getByRole('button', { name: 'Resolve thread 1', exact: true })
        .click();
      await page.getByRole('button', { name: /^Resolved 1$/ }).click();
      await expect(
        card.getByRole('button', { name: 'Reopen thread 1', exact: true }),
      ).toBeVisible();
      await card
        .getByRole('button', { name: 'Reopen thread 1', exact: true })
        .click();
      await page.getByRole('button', { name: /^Open 1$/ }).click();
      await expect(
        card.getByRole('button', { name: 'Resolve thread 1', exact: true }),
      ).toBeVisible();
      await shots(page, info, 'review');
      info.annotations.push({
        type: 'agent-evidence',
        description: useClaude
          ? 'Real signed-in Claude Code, actual session-bound task_thread_reply.'
          : 'ACP fixture calls the registered MCP tool and real internal route; no provider claim.',
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
      await page.goto(
        `${live.ui}/tasks/${taskId}?taskView=review&reviewKind=capture`,
      );
      await page
        .getByRole('button', { name: 'Capture from Browser', exact: true })
        .click();
      await expect(
        page.getByRole('combobox', { name: 'Browser session' }),
      ).toBeVisible();
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
      const target = page.getByRole('button', { name: 'Place region pin' });
      await target.focus();
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
      await shots(page, info, 'screens');
    });
  });
