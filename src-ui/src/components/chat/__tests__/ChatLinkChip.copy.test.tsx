/**
 * @vitest-environment jsdom
 *
 * The host badge a mismatched link carries (`github.com/o/r (evil.test)`)
 * holds two renderings of one fact: the visible `(evil.test)`, hidden from
 * assistive technology, and a screen-reader sentence `, goes to evil.test`.
 * Selecting and copying the link must yield the visible text only — both
 * renderings in the clipboard reads as garbage.
 *
 * jsdom has no selection serialisation that honours CSS, so this launches a
 * real Chromium and reads `getSelection().toString()` over the rendered
 * anchor with the stylesheets a chat message loads: `index.css` (which
 * defines `.sr-only`) and the chip's own sheet.
 *
 * WHAT THIS DOES NOT REPRODUCE: WebKit (the macOS/iOS WebView) and the
 * platform clipboard itself; Chromium's selection string is the proxy.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../../../tests/helpers/css-cascade-fixture';
import { LinkHostBadge } from '../ChatLinkChip';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../');
const STYLESHEETS = [
  resolve(HERE, '../../../index.css'),
  resolve(HERE, '../ChatLinkChip.css'),
];

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'copying a link with a host badge copies what is visible',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;

    beforeAll(async () => {
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });

    test('the screen-reader sentence is not copied alongside the visible host', async () => {
      const css = STYLESHEETS.map((path) => resolveCssImports(path)).join('\n');
      assertNoImportsSurvive(css);
      const markup = renderToStaticMarkup(
        <div className="message">
          <p id="line">
            see{' '}
            <a href="https://evil.test/x">
              github.com/o/r
              <LinkHostBadge host="evil.test" />
            </a>{' '}
            now
          </p>
        </div>,
      );
      const page = await browser.newPage();
      try {
        await page.setContent(
          `<!doctype html><html><head><style>${css}</style></head><body>${markup}</body></html>`,
        );
        const copied = await page.evaluate(() => {
          const range = document.createRange();
          range.selectNodeContents(document.getElementById('line')!);
          const selection = getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
          return selection.toString();
        });
        expect(copied).toBe('see github.com/o/r (evil.test) now');
      } finally {
        await page.close();
      }
    });
  },
);

test.skipIf(chromiumAvailable)(
  'host badge copy — Chromium not installed, cannot verify',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so what a copy ' +
        'of a host-badged link yields could not be measured — this is a ' +
        'missing precondition, not a passing check. Install it with ' +
        '`npm run install:playwright` and re-run.',
    );
  },
);
