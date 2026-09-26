import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  type Browser,
  type BrowserContext,
  expect as browserExpect,
  chromium,
} from '@playwright/test';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  buildDiagramBundle,
  buildLearningGuide,
  learningClientData,
} from '../build-learning-guide.mjs';

let browser: Browser;
let atlas: Awaited<ReturnType<typeof buildLearningGuide>>;
const assets = new Map<string, { body: string; contentType: string }>();
const contexts: BrowserContext[] = [];

beforeAll(async () => {
  atlas = await buildLearningGuide({ check: true });
  const manifest = learningClientData(atlas);
  assets.set('/diagrams.js', {
    body: await buildDiagramBundle(),
    contentType: 'text/javascript',
  });
  assets.set('/atlas-data.json', {
    body: JSON.stringify(manifest),
    contentType: 'application/json',
  });
  assets.set('/search-index.json', {
    body: JSON.stringify(
      atlas.documents.map(({ path, search }) => ({ path, search })),
    ),
    contentType: 'application/json',
  });
  for (const [index, doc] of atlas.documents.entries())
    assets.set(`/${manifest.documents[index].contentUrl}`, {
      body: JSON.stringify(doc),
      contentType: 'application/json',
    });
  for (const [index, module] of atlas.modules.entries())
    assets.set(`/${manifest.modules[index].contentUrl}`, {
      body: JSON.stringify(module),
      contentType: 'application/json',
    });
  for (const [file, contentType] of [
    ['index.html', 'text/html'],
    ['atlas.js', 'text/javascript'],
    ['atlas.css', 'text/css'],
  ])
    assets.set(`/${file}`, {
      body: await readFile(`docs/learn/${file}`, 'utf8'),
      contentType,
    });
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  try {
    await Promise.all(contexts.map((context) => context.close()));
  } finally {
    await browser?.close();
  }
});

async function pageAt(width: number, suffix = '') {
  const context = await browser.newContext({
    viewport: { width, height: 900 },
  });
  contexts.push(context);
  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const sourcePath =
      url.pathname.startsWith('/sources/') && url.pathname.endsWith('.txt')
        ? decodeURIComponent(url.pathname.slice('/sources/'.length, -4))
        : null;
    if (
      url.origin === 'http://atlas.test' &&
      sourcePath &&
      atlas.sourcePaths.includes(sourcePath)
    ) {
      await route.fulfill({
        status: 200,
        contentType: 'text/plain; charset=utf-8',
        body: await readFile(sourcePath, 'utf8'),
      });
      return;
    }
    const asset =
      url.origin === 'http://atlas.test' &&
      assets.get(url.pathname === '/' ? '/index.html' : url.pathname);
    if (asset) await route.fulfill({ status: 200, ...asset });
    else await route.abort();
  });
  const page = await context.newPage();
  await page.goto(`http://atlas.test/${suffix}`);
  return page;
}

test('a reader follows a concept into its exact module, searches, and returns through history', async () => {
  const page = await pageAt(1440);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await browserExpect(
    page.getByRole('heading', { name: 'How Station fits together.' }),
  ).toBeVisible();
  const initialRequests = await page.evaluate(
    'performance.getEntriesByType("resource").map(entry => new URL(entry.name).pathname)',
  );
  expect(initialRequests).not.toContain('/diagrams.js');
  expect(initialRequests).not.toContain('/search-index.json');
  await page
    .getByRole('link', { name: 'Sessions, engines, and recovery', exact: true })
    .click();
  await page
    .getByRole('article')
    .getByRole('link', { name: 'SessionCommandModule', exact: true })
    .click();
  await browserExpect(page.getByRole('article')).toContainText('indeterminate');
  await browserExpect(page.getByRole('article')).not.toContainText(
    '## StationInstanceReconciler',
  );
  expect(
    await page.getByRole('article').getByRole('heading').allTextContents(),
  ).toEqual(['SessionCommandModule']);
  await browserExpect(page.locator('.review-status')).toBeVisible();
  await browserExpect(page.locator('.review-status')).toContainText(
    'This page has not been verified in full against the code.',
  );
  await page.locator('summary').filter({ hasText: 'Sources & review' }).click();
  await browserExpect(
    page.getByRole('link', { name: 'Source on GitHub' }),
  ).toHaveAttribute(
    'href',
    new RegExp(
      `${atlas.revision}/docs/architecture/module-map.md#sessioncommandmodule$`,
    ),
  );
  const sourceLink = page.getByRole('article').getByRole('link', {
    name: 'src-server/services/orchestration/__tests__/session-command-module.test.ts',
    exact: true,
  });
  await browserExpect(sourceLink).toHaveAttribute(
    'href',
    'sources/src-server/services/orchestration/__tests__/session-command-module.test.ts.txt',
  );
  await sourceLink.click();
  await browserExpect(page.locator('body')).toContainText(
    'createSessionCommandModule',
  );
  await page.goBack();
  await browserExpect(page.getByRole('article')).toContainText('indeterminate');
  await page.getByRole('searchbox').fill('docs/reference/station-docs.md');
  await browserExpect(page.getByRole('status')).toContainText(
    '1 documents match',
  );
  await page
    .getByRole('navigation', { name: 'Search results' })
    .getByRole('link')
    .click();
  await browserExpect(
    page.getByRole('article').getByRole('heading', { level: 1 }),
  ).toHaveText('Station shipped documentation');
  await page.goBack();
  await browserExpect(
    page.getByRole('article').getByRole('heading'),
  ).toHaveText('SessionCommandModule');
  await page.getByRole('searchbox').fill('no-such-concept-84721');
  await browserExpect(page.getByRole('status')).toContainText(
    '0 concepts and 0 documents',
  );
  expect(errors).toEqual([]);
}, 30_000);

test('narrow reading, keyboard disclosure, and section links preserve visible content', async () => {
  const page = await pageAt(390);
  await browserExpect(
    page.getByRole('heading', { name: 'How Station fits together.' }),
  ).toBeInViewport();
  await browserExpect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({
    path: resolve('.kontourai/docs-learning/evidence/home-narrow.png'),
  });
  await page.getByRole('button', { name: 'Explore', exact: false }).click();
  await browserExpect(
    page.getByRole('dialog', { name: 'Explore Station' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await browserExpect(page.getByRole('dialog')).toHaveCount(0);
  await browserExpect(
    page.getByRole('button', { name: 'Explore', exact: false }),
  ).toBeFocused();
  await page.getByRole('button', { name: 'Explore', exact: false }).click();
  const summary = page
    .locator('summary')
    .filter({ hasText: 'Sessions, engines, and recovery' });
  await summary.focus();
  await page.keyboard.press('Enter');
  await browserExpect(
    page
      .getByRole('navigation', { name: 'Concept branches' })
      .getByRole('link', { name: 'SessionCommandModule', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Concept branches' })
    .getByRole('link', { name: 'SessionCommandModule', exact: true })
    .click();
  await browserExpect(page.getByRole('dialog')).toHaveCount(0);
  expect(
    await page.evaluate(
      'document.documentElement.scrollWidth <= window.innerWidth',
    ),
  ).toBe(true);
  await page.getByRole('link', { name: 'Skip to reading' }).focus();
  await page.keyboard.press('Enter');
  await browserExpect(page.locator('#content')).toBeFocused();
  await browserExpect(page.getByRole('article')).toContainText('indeterminate');
  await page.reload();
  await browserExpect(
    page.getByRole('article').getByRole('heading'),
  ).toHaveText('SessionCommandModule');
  await page.goto(
    'http://atlas.test/#doc=docs%2Farchitecture.md&section=data-flow-chat-request',
  );
  await browserExpect(
    page.getByRole('heading', { name: 'Data Flow: Chat Request', exact: true }),
  ).toBeVisible();
  const diagram = page.locator('#data-flow-chat-request + figure');
  await browserExpect(diagram.locator('svg')).toBeVisible();
  await diagram.getByRole('button', { name: 'Fit width', exact: true }).click();
  const canvasBounds = await diagram.locator('.diagram-canvas').boundingBox();
  const drawingBounds = await diagram.locator('svg').boundingBox();
  expect(canvasBounds).not.toBeNull();
  expect(drawingBounds).not.toBeNull();
  expect(drawingBounds!.width).toBeCloseTo(canvasBounds!.width, 0);
  await diagram
    .getByRole('button', { name: 'Actual size', exact: true })
    .click();
  expect(
    await page.evaluate(
      'document.documentElement.scrollWidth <= window.innerWidth',
    ),
  ).toBe(true);
  const screenshotDir = resolve('.kontourai/docs-learning/evidence');
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: resolve(screenshotDir, 'reader-narrow.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://atlas.test/');
  await browserExpect(
    page.getByRole('heading', { name: 'How Station fits together' }),
  ).toBeVisible();
  await page.screenshot({ path: resolve(screenshotDir, 'reader-wide.png') });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await browserExpect(
    page.getByRole('heading', { name: 'How Station fits together.' }),
  ).toBeVisible();
  await page.screenshot({ path: resolve(screenshotDir, 'reader-dark.png') });
}, 30_000);

test('renders every Mermaid diagram in the tracked documentation', async () => {
  const page = await pageAt(1440);
  const documents = atlas.documents.filter((doc) =>
    doc.html.includes('language-mermaid'),
  );
  expect(documents.length).toBeGreaterThan(0);
  for (const doc of documents) {
    await page.goto(`http://atlas.test/#doc=${encodeURIComponent(doc.path)}`);
    const count = (doc.html.match(/class="language-mermaid"/g) ?? []).length;
    await browserExpect(page.locator('.diagram'), doc.path).toHaveCount(count, {
      timeout: 15_000,
    });
    expect(await page.getByRole('alert').allTextContents(), doc.path).toEqual(
      [],
    );
    await browserExpect(page.locator('.diagram svg'), doc.path).toHaveCount(
      count,
      { timeout: 15_000 },
    );
    await browserExpect(page.getByRole('alert'), doc.path).toHaveCount(0);
  }
}, 60_000);

test('refuses a document body from a different generated snapshot', async () => {
  const page = await pageAt(1440);
  await browserExpect(
    page.getByRole('heading', { name: 'How Station fits together.' }),
  ).toBeVisible();
  await page.route('**/modules/sessioncommandmodule.json', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'sessioncommandmodule',
        digest: 'outdated',
        html: '<h1>Wrong snapshot content</h1>',
        headings: [],
      }),
    }),
  );
  await page.goto('http://atlas.test/#module=sessioncommandmodule');
  await browserExpect(page.getByRole('alert')).toContainText(
    'document was rebuilt',
  );
  await browserExpect(page.getByRole('article')).not.toContainText(
    'Wrong snapshot content',
  );
});
