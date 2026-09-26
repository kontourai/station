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
} from '../build-learning-guide.mjs';

let browser: Browser;
let atlas: Awaited<ReturnType<typeof buildLearningGuide>>;
const assets = new Map<string, { body: string; contentType: string }>();
const contexts: BrowserContext[] = [];

beforeAll(async () => {
  atlas = await buildLearningGuide({ check: true });
  assets.set('/diagrams.js', {
    body: await buildDiagramBundle(),
    contentType: 'text/javascript',
  });
  assets.set('/atlas-data.json', {
    body: JSON.stringify(atlas),
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
  await browserExpect(
    page.getByRole('link', { name: 'Source on GitHub' }),
  ).toHaveAttribute(
    'href',
    new RegExp(
      `${atlas.revision}/docs/architecture/module-map.md#sessioncommandmodule$`,
    ),
  );
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
  expect(
    await page.evaluate(
      'document.documentElement.scrollWidth <= window.innerWidth',
    ),
  ).toBe(true);
  await page.getByRole('link', { name: 'Skip to reading' }).focus();
  await page.keyboard.press('Enter');
  await browserExpect(page.locator('#content')).toBeFocused();
  await browserExpect(page.getByRole('article')).toContainText('indeterminate');
  await page.goto(
    'http://atlas.test/#doc=docs%2Farchitecture.md&section=data-flow-chat-request',
  );
  await browserExpect(
    page.getByRole('heading', { name: 'Data Flow: Chat Request', exact: true }),
  ).toBeVisible();
  const diagram = page.locator('#data-flow-chat-request + figure');
  await browserExpect(diagram.locator('svg')).toBeVisible();
  await diagram.getByRole('button', { name: 'Fit width', exact: true }).click();
  await browserExpect(diagram.locator('svg')).toHaveCSS('width', '350px');
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
