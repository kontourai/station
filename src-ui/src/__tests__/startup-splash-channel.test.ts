import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';

/**
 * The splash in `index.html` paints before any app module runs, so the
 * channel the native host reports cannot reach it. A nightly, beta or dev
 * install must still open on its own mark, not the stable one: this loads the
 * real `index.html`, `startup-theme.js` and `startup-screen.css` in Chromium,
 * with the app entry stubbed so nothing after first paint can intervene, and
 * reads which image the splash logo actually shows.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const UI = resolve(REPO_ROOT, 'src-ui');
const ORIGIN = 'http://station.test';
const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)('first-paint splash mark', () => {
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  let css: string;

  beforeAll(async () => {
    browser = await chromium.launch();
    css = resolveCssImports(resolve(UI, 'src/components/startup-screen.css'));
    assertNoImportsSurvive(css);
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function splash(remembered: string | null) {
    const page = await browser.newPage();
    const requested: string[] = [];
    try {
      await page.route(`${ORIGIN}/**`, (route) => {
        const path = new URL(route.request().url()).pathname;
        requested.push(path);
        if (path === '/')
          return route.fulfill({
            contentType: 'text/html',
            body: readFileSync(resolve(UI, 'index.html'), 'utf8'),
          });
        if (path === '/src/components/startup-screen.css')
          return route.fulfill({ contentType: 'text/css', body: css });
        if (path === '/startup-theme.js' || path.startsWith('/favicon'))
          return route.fulfill({
            body: readFileSync(resolve(UI, 'public', path.slice(1))),
          });
        // The app entry: never run it, so the logo stays what first paint drew.
        return route.fulfill({ contentType: 'text/javascript', body: '' });
      });
      if (remembered !== null)
        await page.addInitScript(
          (mark) => localStorage.setItem('station-startup-mark', mark),
          remembered,
        );
      await page.goto(`${ORIGIN}/`);
      await page.waitForFunction(
        () =>
          (document.querySelector('.station-startup__logo') as HTMLImageElement)
            .complete,
      );
      const content = await page.$eval(
        '.station-startup__logo',
        (logo) => getComputedStyle(logo).content,
      );
      const mark = await page.evaluate(
        () => document.documentElement.dataset.startupMark ?? null,
      );
      return { content, requested, mark };
    } finally {
      await page.close();
    }
  }

  test.each(['nightly', 'beta', 'dev'])(
    'a %s install opens on its own mark',
    async (channel) => {
      const { content, requested } = await splash(channel);
      expect(content).toBe(`url("${ORIGIN}/favicon-${channel}.png")`);
      expect(requested).toContain(`/favicon-${channel}.png`);
    },
  );

  test('stable, a first launch, or an unknown value keeps the stable mark', async () => {
    for (const remembered of ['stable', null, 'violet']) {
      const { content, requested, mark } = await splash(remembered);
      expect(mark).toBeNull();
      expect(content).toBe('normal');
      expect(requested).toContain('/favicon.png');
      expect(requested.filter((path) => path.startsWith('/favicon-'))).toEqual(
        [],
      );
    }
  });
});
