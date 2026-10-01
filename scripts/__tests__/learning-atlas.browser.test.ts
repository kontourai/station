import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  type Browser,
  type BrowserContext,
  expect as browserExpect,
  chromium,
} from '@playwright/test';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  buildDiagramBundle,
  buildLearningGuide,
  learningClientData,
} from '../build-learning-guide.mjs';
import { resolveDocumentationFreshness } from '../lib/documentation-freshness.mjs';
import { JOB_ENV } from './helpers/freshness-env.js';
import { writeReviewLedger } from './helpers/review-ledger-fixture.js';

let browser: Browser;
let atlas: Awaited<ReturnType<typeof buildLearningGuide>>;
const assets = new Map<
  string,
  { body: string | Buffer; contentType: string }
>();
const contexts: BrowserContext[] = [];
const makeTempDir = trackTempDirs();

type CaptureImage = HTMLImageElement & {
  complete: boolean;
  naturalWidth: number;
  clientWidth: number;
};
type CaptureVideo = HTMLVideoElement & {
  paused: boolean;
  autoplay: boolean;
  controls: boolean;
  currentTime: number;
  duration: number;
  videoWidth: number;
  error: unknown;
  play(): Promise<void>;
  pause(): void;
};

beforeAll(async () => {
  // The real ledger runs in the job's own freshness mode, stated explicitly
  // rather than read from the ambient environment (#2934).
  atlas = await buildLearningGuide({
    check: true,
    freshness: resolveDocumentationFreshness({
      root: process.cwd(),
      env: JOB_ENV,
    }),
  });
  const manifest = learningClientData(atlas);
  for (const capture of atlas.captures)
    assets.set(`/${capture.url}`, {
      body: await readFile(capture.path),
      contentType: capture.kind === 'image' ? 'image/png' : 'video/webm',
    });
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
    const asset =
      url.origin === 'http://atlas.test' &&
      assets.get(url.pathname === '/' ? '/index.html' : url.pathname);
    if (asset) {
      await route.fulfill({ status: 200, ...asset });
      return;
    }
    const sourcePath = Object.keys(atlas.sourceSnapshots).find(
      (file) => `/${atlas.sourceSnapshots[file]}` === url.pathname,
    );
    if (url.origin === 'http://atlas.test' && sourcePath) {
      await route.fulfill({
        status: 200,
        contentType: 'text/plain; charset=utf-8',
        body: await readFile(sourcePath, 'utf8'),
      });
      return;
    }
    await route.abort();
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
    await page
      .getByRole('article')
      .getByRole('heading', { level: 2 })
      .allTextContents(),
  ).toEqual(['SessionCommandModule']);
  await browserExpect(
    page.getByRole('article').getByRole('heading', {
      level: 3,
      name: 'Harness question interaction',
      exact: true,
    }),
  ).toBeVisible();
  await browserExpect(page.getByRole('article')).toContainText(
    'requestUserInput',
  );
  // The panel must render the module map's recorded review state. A merge-queue
  // candidate can legitimately carry a stale record another PR's change caused
  // (freshness is advisory there, #2923), so derive the expected label from
  // that state instead of assuming the record is fresh.
  const moduleMapState = atlas.documents.find(
    (doc) => doc.path === 'docs/architecture/module-map.md',
  )?.reviewRecord?.state;
  const statusByState: Record<string, readonly string[]> = {
    'source-reviewed': [
      'Reviewed against code',
      'live outcomes need their own evidence',
    ],
    'needs-review': ['Review out of date', 'changed after this review'],
  };
  const expectedStatus = statusByState[String(moduleMapState)];
  expect(
    expectedStatus,
    `module map review state ${moduleMapState}`,
  ).toBeDefined();
  await browserExpect(page.locator('.review-status')).toBeVisible();
  for (const text of expectedStatus ?? [])
    await browserExpect(page.locator('.review-status')).toContainText(text);
  await page.locator('summary').filter({ hasText: 'Sources & review' }).click();
  await browserExpect(page.locator('.source-details')).toContainText(
    'Review scope.',
  );
  await browserExpect(
    page.getByRole('link', { name: 'Markdown source', exact: true }),
  ).toHaveAttribute(
    'href',
    atlas.sourceSnapshots['docs/architecture/module-map.md'],
  );
  const sourceLink = page.getByRole('article').getByRole('link', {
    name: 'src-server/services/orchestration/__tests__/session-command-module.test.ts',
    exact: true,
  });
  await browserExpect(sourceLink).toHaveAttribute(
    'href',
    atlas.sourceSnapshots[
      'src-server/services/orchestration/__tests__/session-command-module.test.ts'
    ],
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
    page.getByRole('article').getByRole('heading', { level: 2 }),
  ).toHaveText('SessionCommandModule');
  await page.getByRole('searchbox').fill('no-such-concept-84721');
  await browserExpect(page.getByRole('status')).toContainText(
    '0 concepts and 0 documents',
  );
  await page.goto('http://atlas.test/#doc=docs%2Fstrategy%2Fconstitution.md');
  await browserExpect(page.locator('.review-status')).toContainText(
    'Policy · Purpose checked',
  );
  await browserExpect(page.locator('.review-status')).toContainText(
    'Purpose classification does not verify current behavior.',
  );
  await page.locator('summary').filter({ hasText: 'Sources & review' }).click();
  await browserExpect(page.locator('.source-details')).toContainText(
    'not proof that every current feature meets them',
  );
  await page.goto('http://atlas.test/#doc=docs%2Freference%2Fdeploy-ledger.md');
  await browserExpect(page.locator('.review-status')).toContainText(
    'Generated reference · Generated output checked',
  );
  await browserExpect(page.locator('.review-status')).toContainText(
    'New release claims have not been independently reverified.',
  );
  await browserExpect(page.locator('.review-status')).not.toContainText(
    'Reviewed against code',
  );
  await page.goto('http://atlas.test/#doc=docs%2Fuser%2Fgetting-started.md');
  await page
    .getByRole('article')
    .getByRole('link', { name: 'Starter Work guide', exact: true })
    .click();
  await browserExpect(
    page.getByRole('article').getByRole('heading', { level: 1 }),
  ).toHaveText('How Starter Work connects first steps to real work');
  expect(page.url()).toContain('#doc=docs%2Fguides%2Fstarter-work.md');
  await page.getByRole('link', { name: 'The big picture' }).click();
  await browserExpect(
    page.getByRole('heading', { name: 'How Station fits together.' }),
  ).toBeVisible();
  await page
    .getByRole('link', { name: 'System overview', exact: true })
    .click();
  await page
    .getByRole('link', { name: 'Station Field guide', exact: true })
    .click();
  await browserExpect(
    page.getByRole('heading', { name: 'How Station fits together.' }),
  ).toBeVisible();
  expect(errors).toEqual([]);
}, 30_000);

test.each([390, 1440])(
  'application captures decode and play without autoplay at width %i',
  async (width) => {
    const page = await pageAt(width, '#doc=docs%2Flearn%2Fwalkthroughs.md');
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const images = page.locator('article .learning-capture img');
    await browserExpect(images).toHaveCount(6);
    for (const image of await images.all()) {
      await image.scrollIntoViewIfNeeded();
      await browserExpect
        .poll(() =>
          image.evaluate(
            (element: CaptureImage) =>
              element.complete && element.naturalWidth > 0,
          ),
        )
        .toBe(true);
      expect(
        await image.evaluate(
          (element: CaptureImage) =>
            element.clientWidth <= element.naturalWidth,
        ),
      ).toBe(true);
    }
    const videos = page.locator('article video');
    await browserExpect(videos).toHaveCount(2);
    for (const video of await videos.all()) {
      await video.scrollIntoViewIfNeeded();
      expect(
        await video.evaluate((element: CaptureVideo) => ({
          paused: element.paused,
          autoplay: element.autoplay,
          controls: element.controls,
        })),
      ).toEqual({ paused: true, autoplay: false, controls: true });
      await video.evaluate((element: CaptureVideo) => element.play());
      await browserExpect
        .poll(() =>
          video.evaluate((element: CaptureVideo) => element.currentTime),
        )
        .toBeGreaterThan(0);
      expect(
        await video.evaluate(
          (element: CaptureVideo) =>
            element.duration > 10 &&
            element.videoWidth > 0 &&
            element.error === null,
        ),
      ).toBe(true);
      await video.evaluate((element: CaptureVideo) => element.pause());
    }
    expect(
      await page.evaluate(
        'document.documentElement.scrollWidth <= window.innerWidth',
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
  },
  30_000,
);

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
    page.getByRole('article').getByRole('heading', { level: 2 }),
  ).toHaveText('SessionCommandModule');
  await page.goto(
    'http://atlas.test/#doc=docs%2Farchitecture.md&section=data-flow-chat-request',
  );
  await browserExpect(
    page.getByRole('heading', { name: 'Data Flow: Chat Request', exact: true }),
  ).toBeVisible();
  const diagram = page.locator('#data-flow-chat-request + figure');
  await browserExpect(diagram.locator('svg')).toBeVisible();
  await browserExpect(
    diagram.getByRole('button', { name: 'Fit width', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await diagram.getByRole('button', { name: 'Fit width', exact: true }).click();
  const canvasBounds = await diagram.locator('.diagram-canvas').boundingBox();
  const drawingBounds = await diagram.locator('svg').boundingBox();
  expect(canvasBounds).not.toBeNull();
  expect(drawingBounds).not.toBeNull();
  expect(drawingBounds!.width).toBeCloseTo(canvasBounds!.width - 34, 0);
  await diagram
    .getByRole('button', { name: 'Actual size', exact: true })
    .click();
  await browserExpect(
    diagram.getByRole('button', { name: 'Actual size', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
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

test('an open reader keeps immutable evidence and rejects lazy content after a source-only rebuild', async () => {
  const root = makeTempDir('station-atlas-snapshot-');
  const output = join(root, '.kontourai/docs-learning');
  const hash = (bytes: string | Buffer) =>
    createHash('sha256').update(bytes).digest('hex');
  const code = Buffer.from('export const evidence = "original café";\r\n');
  const nativeSources = {
    'native/Bridge.kt': Buffer.from('class StationBridge\n'),
    'native/Bridge.swift': Buffer.from('struct StationBridge {}\n'),
    Dockerfile: Buffer.from('FROM node:24\n'),
  };
  const guide =
    '# Snapshot guide\n\n[Supporting code](owner.ts)\n\n[Native bridge](native/Bridge.kt)\n\n[Container build](Dockerfile)\n\n`native/Bridge.swift`\n\n[Binary icon](icon.png)\n\n[Historical bridge](https://github.com/kontourai/station/blob/older/native/Bridge.kt)\n';
  const moduleMap = '# Modules\n\n## Snapshot module\n\n`owner.ts`\n';
  const records = [
    ['README.md', guide],
    ['docs/architecture/module-map.md', moduleMap],
  ].map(([path, markdown]) => ({
    path,
    kind: 'current',
    state: 'source-reviewed',
    documentDigest: hash(markdown),
    summary: 'The fixture code was reviewed.',
    limits: 'Fixture evidence only.',
    sources: [{ path: 'owner.ts', digest: hash(code) }],
    checks: ['Source inspected.'],
  }));
  const inputs = {
    'README.md': guide,
    'docs/architecture/module-map.md': moduleMap,
    'owner.ts': code,
    ...nativeSources,
    'icon.png': Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
    'docs/learn/atlas.json': JSON.stringify({
      version: 1,
      groups: [
        {
          id: 'snapshot',
          title: 'Snapshot',
          summary: 'Snapshot fixture',
          docs: ['README.md'],
          modules: ['Snapshot module'],
          questions: ['Which bytes?'],
        },
      ],
    }),
  };
  let context: BrowserContext | undefined;
  try {
    for (const [file, bytes] of Object.entries(inputs)) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), bytes);
    }
    writeReviewLedger(root, records);
    for (const file of ['index.html', 'atlas.js', 'atlas.css'])
      await copyFile(`docs/learn/${file}`, join(root, 'docs/learn', file));
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: root, windowsHide: true });
    git(['init', '-q']);
    git(['add', '.']);
    git([
      '-c',
      'user.name=Snapshot Fixture',
      '-c',
      'user.email=snapshot@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'test: capture snapshot fixture',
    ]);
    const original = await buildLearningGuide({ root });
    const originalUrl = original.sourceSnapshots['owner.ts'];
    expect(originalUrl).toBe(`sources/${hash(code)}/owner.ts.txt`);
    expect(await readFile(join(output, originalUrl))).toEqual(code);
    for (const [file, bytes] of Object.entries(nativeSources)) {
      const sourceUrl = `sources/${hash(bytes)}/${file}.txt`;
      expect(original.sourceSnapshots[file]).toBe(sourceUrl);
      expect(await readFile(join(output, sourceUrl))).toEqual(bytes);
    }
    expect(original.sourceSnapshots['icon.png']).toBeUndefined();

    context = await browser.newContext();
    await context.route('http://snapshot.test/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      const file =
        pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
      const contentType = file.endsWith('.json')
        ? 'application/json'
        : file.endsWith('.js')
          ? 'text/javascript'
          : file.endsWith('.css')
            ? 'text/css'
            : file.endsWith('.html')
              ? 'text/html'
              : 'text/plain; charset=utf-8';
      await route.fulfill({
        body: await readFile(join(output, file)),
        contentType,
      });
    });
    const cached = await context.newPage();
    await cached.goto('http://snapshot.test/#doc=README.md');
    await browserExpect(cached.locator('.review-status')).toContainText(
      'Reviewed against code',
    );
    await browserExpect(
      cached.getByRole('link', { name: 'Binary icon' }),
    ).toHaveAttribute(
      'href',
      `https://github.com/kontourai/station/blob/${original.revision}/icon.png`,
    );
    await browserExpect(
      cached.getByRole('link', { name: 'Historical bridge' }),
    ).toHaveAttribute(
      'href',
      'https://github.com/kontourai/station/blob/older/native/Bridge.kt',
    );
    await cached.getByRole('link', { name: 'Native bridge' }).click();
    await browserExpect(cached.locator('body')).toHaveText(
      'class StationBridge\n',
    );
    await cached.goBack();
    await cached.getByRole('link', { name: 'Container build' }).click();
    await browserExpect(cached.locator('body')).toHaveText('FROM node:24\n');
    await cached.goBack();
    const lazy = await context.newPage();
    await lazy.goto('http://snapshot.test/');
    await browserExpect(
      lazy.getByRole('heading', { name: 'How Station fits together.' }),
    ).toBeVisible();

    const changedCode = Buffer.from(
      'export const evidence = "changed code";\r\n',
    );
    await writeFile(join(root, 'owner.ts'), changedCode);
    const rebuilt = await buildLearningGuide({ root });
    expect(rebuilt.documents[0].digest).toBe(original.documents[0].digest);
    expect(rebuilt.documents[0].snapshotDigest).not.toBe(
      original.documents[0].snapshotDigest,
    );
    expect(rebuilt.modules[0].digest).toBe(original.modules[0].digest);
    expect(rebuilt.modules[0].snapshotDigest).not.toBe(
      original.modules[0].snapshotDigest,
    );
    expect(await readFile(join(output, originalUrl))).toEqual(code);
    const changedUrl = rebuilt.sourceSnapshots['owner.ts'];
    expect(changedUrl).toBe(`sources/${hash(changedCode)}/owner.ts.txt`);
    expect(await readFile(join(output, changedUrl))).toEqual(changedCode);

    await cached.goto('http://snapshot.test/#branch=snapshot');
    await cached
      .getByRole('article')
      .getByRole('link', { name: 'Snapshot guide' })
      .click();
    await browserExpect(cached.locator('.review-status')).toContainText(
      'Reviewed against code',
    );
    await cached
      .locator('summary')
      .filter({ hasText: 'Sources & review' })
      .click();
    const evidence = cached
      .locator('#reading-status')
      .getByRole('link', { name: 'owner.ts', exact: true });
    await browserExpect(evidence).toHaveAttribute('href', originalUrl);
    await evidence.click();
    await browserExpect(cached.locator('body')).toContainText('original café');
    await browserExpect(cached.locator('body')).not.toContainText(
      'changed code',
    );

    await lazy.goto('http://snapshot.test/#doc=README.md');
    await browserExpect(lazy.getByRole('alert')).toContainText(
      'document was rebuilt',
    );
    await browserExpect(lazy.locator('.review-status')).toHaveCount(0);
    await lazy.goto('http://snapshot.test/#module=snapshot-module');
    await browserExpect(lazy.getByRole('alert')).toContainText(
      'document was rebuilt',
    );
    await lazy.reload();
    await browserExpect(lazy.locator('.review-status')).toContainText(
      'Review out of date',
    );
    await browserExpect(
      lazy.getByRole('article').getByRole('link', { name: 'owner.ts' }),
    ).toHaveAttribute('href', changedUrl);

    records[0].limits = 'A changed review limit without a Markdown change.';
    records[1].limits =
      'A changed module owner review without a Markdown change.';
    writeReviewLedger(root, records);
    const reviewed = await buildLearningGuide({ root });
    expect(reviewed.documents[0].digest).toBe(rebuilt.documents[0].digest);
    expect(reviewed.documents[0].snapshotDigest).not.toBe(
      rebuilt.documents[0].snapshotDigest,
    );
    expect(reviewed.modules[0].digest).toBe(rebuilt.modules[0].digest);
    expect(reviewed.modules[0].snapshotDigest).not.toBe(
      rebuilt.modules[0].snapshotDigest,
    );
    expect(await readFile(join(output, originalUrl))).toEqual(code);
    const manifestBeforeFailure = await readFile(
      join(output, 'atlas-data.json'),
    );
    const truncated = changedCode.subarray(0, 8);
    await writeFile(join(output, changedUrl), truncated);
    await expect(buildLearningGuide({ root })).rejects.toThrow(
      'Immutable source snapshot mismatch',
    );
    expect(await readFile(join(output, changedUrl))).toEqual(truncated);
    expect(await readFile(join(output, 'atlas-data.json'))).toEqual(
      manifestBeforeFailure,
    );
  } finally {
    await context?.close();
  }
}, 60_000);
