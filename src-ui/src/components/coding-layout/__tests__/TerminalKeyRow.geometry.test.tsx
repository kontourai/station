/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TerminalView } from '@kontourai/station-sdk/terminal-view';
import { chromium } from '@playwright/test';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../../../tests/helpers/css-cascade-fixture';

/**
 * The phone terminal's key row, rendered by the real `TerminalView` with the
 * app's cascade. At 390 it was 412px wide: Ctrl sat 18px past the edge with
 * nothing to say the row scrolled (visual review of 4249bb5f5d).
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../');
const TERMINAL_CSS = resolve(
  REPO_ROOT,
  'packages/sdk/src/terminal-view/TerminalView.css',
);

function page(css: string, overflow?: string) {
  const markup = renderToStaticMarkup(
    <TerminalView session={null} fontSize={14} touchKeys />,
  );
  // The overflow state is the component's to set once it is mounted; static
  // markup carries it as written.
  const body = overflow
    ? markup.replace(
        'class="station-terminal__keys"',
        `class="station-terminal__keys" data-overflow="${overflow}"`,
      )
    : markup;
  return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>${css} html,body{height:100%;margin:0} body{display:flex;flex-direction:column}</style>
</head><body>${body}</body></html>`;
}

describe.skipIf(!chromiumIsInstalled(REPO_ROOT))(
  'The terminal key row on a phone (real cascade)',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;
    let css: string;
    beforeAll(async () => {
      browser = await chromium.launch();
      css = `${resolveCssImports(resolve(HERE, '../../../index.css'))}\n${readFileSync(TERMINAL_CSS, 'utf8')}`;
      assertNoImportsSurvive(css);
    });
    afterAll(async () => {
      await browser?.close();
    });

    const measure = async (width: number, overflow?: string) => {
      const tab = await browser.newPage({ viewport: { width, height: 844 } });
      try {
        await tab.setContent(page(css, overflow));
        return await tab.evaluate(() => {
          const row = document.querySelector<HTMLElement>(
            '.station-terminal__keys',
          )!;
          return {
            scrollWidth: row.scrollWidth,
            clientWidth: row.clientWidth,
            mask: getComputedStyle(row).maskImage,
            keys: [...row.querySelectorAll('button')].map((button) => {
              const r = button.getBoundingClientRect();
              return {
                name: button.getAttribute('aria-label'),
                left: r.left,
                right: r.right,
                width: r.width,
                height: r.height,
              };
            }),
          };
        });
      } finally {
        await tab.close();
      }
    };

    test('all eight keys fit a 390px phone at 44px or more', async () => {
      const g = await measure(390);
      expect(g.keys).toHaveLength(8);
      expect(g.scrollWidth).toBeLessThanOrEqual(g.clientWidth);
      for (const key of g.keys) {
        expect(key.width, key.name ?? '').toBeGreaterThanOrEqual(44);
        expect(key.height, key.name ?? '').toBeGreaterThanOrEqual(44);
        expect(key.left, key.name ?? '').toBeGreaterThanOrEqual(0);
        expect(key.right, key.name ?? '').toBeLessThanOrEqual(390);
      }
      expect(g.mask).toBe('none');
    });

    test('a narrower phone keeps 44px keys and fades the edge with more keys', async () => {
      const narrow = await measure(320);
      expect(narrow.scrollWidth).toBeGreaterThan(narrow.clientWidth);
      for (const key of narrow.keys)
        expect(key.width, key.name ?? '').toBeGreaterThanOrEqual(44);
      for (const edge of ['end', 'start', 'both']) {
        const faded = await measure(320, edge);
        expect(faded.mask, edge).toContain('linear-gradient');
      }
    });
  },
);
