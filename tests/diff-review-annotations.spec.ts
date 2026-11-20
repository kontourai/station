import { copyFile } from 'node:fs/promises';
import type { GitStatusResult } from '@kontourai/station-sdk';
import { expect, type Page, type TestInfo } from '@playwright/test';
import { selectCodingPane } from './helpers/coding-stack';
import { rejectUnexpectedFixtureRequest, test } from './helpers/fixture-audit';
import {
  installMockOrchestrationSse,
  seedOrchestrationRoutes,
} from './helpers/orchestration';

/**
 * Diff review annotations — verifies the DiffPanel ↔ diff-comments wiring in a
 * real browser: the panel renders a parsed diff, fetches the project's comments,
 * and renders a seeded comment inline via @pierre/diffs' annotation slot.
 * All endpoints are routed deterministically so the test is repo-independent.
 */

const LONG_LINE = `const b = "${'words in this comment anchor '.repeat(10)}";`;
const SAMPLE_PATCH = `diff --git a/foo.ts b/foo.ts
--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const b = 2;
+${LONG_LINE}
 const c = 4;
`;

const COMMENT_AT = new Date(Date.now() - 2 * 60_000).toISOString();
const SEEDED_COMMENT = {
  id: 'seed-1',
  projectId: 'dev',
  filePath: 'foo.ts',
  side: 'additions' as const,
  lineNumber: 2,
  body: 'Needs a null guard here',
  createdAt: COMMENT_AT,
  updatedAt: COMMENT_AT,
};

async function captureDiff(page: Page, testInfo: TestInfo, name: string) {
  const destination = testInfo.outputPath(`${name}.png`);
  await page.screenshot({
    path: testInfo.outputPath(`${name}.png`),
    animations: 'disabled',
  });
  const review = process.env.STATION_UI_REVIEW_SCREENSHOT_DIR;
  if (review) await copyFile(destination, `${review}/${name}.png`);
}

async function seedRoutes(page: Page) {
  await page.route('**/api/coding/repos**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          workspace: '/repo',
          workspaceIsRepo: true,
          repos: [
            { root: '/repo', name: 'repo', relativePath: '.', branch: 'main' },
          ],
        },
      }),
    }),
  );
  await page.route('**/api/coding/git/status**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: {
          isRepo: true,
          branch: 'main',
          changes: [' M foo.ts'],
          staged: 0,
          unstaged: 1,
          untracked: 0,
          lastCommit: null,
          ahead: 0,
          behind: 0,
          remote: 'present',
          repoRoot: '/repo',
        } satisfies GitStatusResult,
      }),
    }),
  );
  await page.route('**/api/coding/git/branches**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data: [{ name: 'main', sha: 'aaaaaaa', current: true }],
      }),
    }),
  );
  await page.route('**/api/coding/git/log**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [] }),
    }),
  );
  await page.route('**/api/coding/files**', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: {
            success: true,
            data: [{ name: 'foo.ts', path: 'foo.ts', type: 'file' }],
          },
        })
      : rejectUnexpectedFixtureRequest(route),
  );
  await page.route('**/api/projects/dev/file-preview', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          json: {
            success: true,
            data: {
              path: 'foo.ts',
              status: 'ready',
              renderKind: 'text',
              content: `${LONG_LINE}\n`,
            },
          },
        })
      : rejectUnexpectedFixtureRequest(route),
  );
  await page.route('**/api/projects/dev/file-preview/changes', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          json: {
            success: true,
            data: { state: 'changed', base: 'HEAD', patch: SAMPLE_PATCH },
          },
        })
      : rejectUnexpectedFixtureRequest(route),
  );
  // The diff the panel renders (real endpoint is /api/coding/git/diff).
  await page.route('**/api/coding/git/diff**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: SAMPLE_PATCH }),
    }),
  );
  // One pre-existing review comment anchored to the changed line.
  await page.route('**/api/projects/*/diff-comments**', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data: [SEEDED_COMMENT] }),
    }),
  );
  for (const pattern of [
    '**/api/projects/*/readiness**',
    '**/api/projects/*/flow/definitions**',
    '**/api/projects/*/trust-bundles**',
    '**/api/fs/browse**',
  ]) {
    await page.route(pattern, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      }),
    );
  }
}

async function expectPhoneDiffFits(page: Page) {
  for (const name of [
    'Collapse all files',
    'Expand all files',
    'Split view',
    'Wrap lines',
  ]) {
    const control = page.getByRole('button', { name, exact: true });
    await expect(control).toBeVisible();
    await expect
      .poll(() =>
        control.evaluate((node) => {
          const bounds = node.getBoundingClientRect();
          const hit = document.elementFromPoint(
            bounds.left + bounds.width / 2,
            bounds.top + bounds.height / 2,
          );
          return (
            bounds.left >= 0 &&
            bounds.right <= window.innerWidth &&
            !!hit &&
            node.contains(hit)
          );
        }),
      )
      .toBe(true);
  }
  const wrap = page.getByRole('button', {
    name: 'Wrap lines',
    exact: true,
  });
  if ((await wrap.getAttribute('aria-pressed')) === 'false') await wrap.click();
  await expect(wrap).toHaveAttribute('aria-pressed', 'true');
  await expect
    .poll(() =>
      page
        .locator('diffs-container')
        .first()
        .evaluate((host) => {
          const line = [
            ...(host.shadowRoot?.querySelectorAll('[data-line]') ?? []),
          ].find((node) =>
            node.textContent?.includes('words in this comment anchor'),
          );
          if (!line) return false;
          const range = document.createRange();
          range.selectNodeContents(line);
          const fragments = [...range.getClientRects()].filter(
            (rect) => rect.width > 0,
          );
          return (
            new Set(fragments.map((rect) => Math.round(rect.top))).size > 1 &&
            fragments.every(
              (rect) => rect.right <= host.getBoundingClientRect().right + 1,
            )
          );
        }),
    )
    .toBe(true);
}

test.describe('Diff review annotations', () => {
  test.beforeEach(async ({ page }) => {
    await installMockOrchestrationSse(page);
    await seedOrchestrationRoutes(page);
    await seedRoutes(page);
  });

  for (const width of [390, 1440]) {
    for (const theme of ['light', 'dark'] as const) {
      test(`renders the diff and a seeded comment inline at ${width}px in ${theme}`, async ({
        page,
      }, testInfo) => {
        await page.setViewportSize({
          width,
          height: width === 390 ? 844 : 900,
        });
        await page.emulateMedia({ colorScheme: theme });
        // DiffPanel queries the project's comments as soon as the coding layout loads.
        const commentsRequest = page.waitForRequest((req) =>
          /\/api\/projects\/[^/]+\/diff-comments/.test(req.url()),
        );

        await page.goto('/projects/dev/layouts/code');
        await page.evaluate((value) => {
          document.documentElement.setAttribute('data-theme', value);
        }, theme);
        await selectCodingPane(page, 'Diff');

        // The pane head names the pane; the toolbar is counts and icon tools.
        await expect(page.getByText('Git Diff')).toHaveCount(0);
        await expect(
          page.getByRole('button', { name: 'Wrap lines' }),
        ).toBeVisible();
        await expect(
          page.getByRole('textbox', { name: 'Commit message', exact: true }),
        ).toHaveAttribute('placeholder', 'Commit message (1)');

        // The wiring fired: DiffPanel fetched the project's comments.
        await commentsRequest;

        // The parsed diff rendered: @pierre/diffs mounts its <diffs-container>
        // custom element (the line text itself is split across Shiki token spans,
        // so assert on the container rather than a full-line string).
        await expect(page.locator('diffs-container').first()).toBeVisible({
          timeout: 15000,
        });

        if (width === 390) await expectPhoneDiffFits(page);

        // The seeded comment renders inline via the annotation slot.
        await expect(page.getByText('Needs a null guard here')).toBeVisible({
          timeout: 15000,
        });
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await page.evaluate(() => document.fonts.ready);
        const annotation = page
          .getByText('Needs a null guard here')
          .locator('..');
        await expect(annotation.locator('time')).toHaveAttribute(
          'datetime',
          SEEDED_COMMENT.createdAt,
        );
        await expect(annotation.locator('time')).toHaveText(/^now$|^\d+[mhd]$/);
        await captureDiff(page, testInfo, `coding-diff-${width}-${theme}`);

        await selectCodingPane(page, 'Files');
        await page.getByText('foo.ts', { exact: true }).click();
        const source = page.getByRole('region', { name: 'foo.ts source' });
        await expect(source).toBeVisible();
        await page.getByRole('button', { name: 'More file actions' }).click();
        const sourceWrap = page.getByRole('menuitemcheckbox', {
          name: 'Wrap lines',
        });
        if ((await sourceWrap.getAttribute('aria-checked')) === 'false')
          await sourceWrap.click();
        else await page.keyboard.press('Escape');
        await expect
          .poll(() =>
            source.locator('[data-line="1"]').evaluate((line) => {
              const gutter = line.querySelector('a')!;
              const content = line.querySelector('span')!;
              const range = document.createRange();
              range.selectNodeContents(content);
              const fragments = [...range.getClientRects()];
              return (
                new Set(fragments.map(({ top }) => Math.round(top))).size > 1 &&
                fragments.every(
                  ({ left }) => left >= gutter.getBoundingClientRect().right,
                )
              );
            }),
          )
          .toBe(true);
        await captureDiff(page, testInfo, `file-source-${width}-${theme}`);

        await page.getByRole('button', { name: /^Changes vs HEAD/ }).click();
        const changes = page.getByRole('region', {
          name: 'foo.ts changes against HEAD',
        });
        await expect(changes).toBeVisible();
        await expect(changes.locator('diffs-container')).toBeVisible();
        if (width === 390) await expectPhoneDiffFits(page);
        await captureDiff(page, testInfo, `file-changes-${width}-${theme}`);
      });
    }
  }
});
