/**
 * @vitest-environment jsdom
 *
 * The dock header's More menu PORTALS TO THE BODY, so it is not a descendant of
 * `.chat-dock` (fixed, `--layer-dock` 9200) any more and the
 * `.dock-placement-menu` family's `--layer-popover` (1000) put it UNDER the
 * dock: with an expanded, maximized or side dock the menu opened down into the
 * dock's own band, painted behind it, and its rows hit-tested to the dock.
 * Pressing ⋯ with a chat open showed nothing.
 *
 * Exactly station#3766's shape, and the reason that incident's own guard is a
 * measurement: a z-index is not observable in jsdom (no layout, no paint, no
 * hit-testing), and the assertion that matters is REACHABILITY, not the
 * declared value. `elementsFromPoint` at a row's centre answers the real
 * question — what would a click at these coordinates land on.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import {
  assertNoImportsSurvive,
  chromiumIsInstalled,
  resolveCssImports,
} from '../../../tests/helpers/css-cascade-fixture';
import { ChatDockHeaderMoreMenu } from '../components/chat-dock/ChatDockHeaderMoreMenu';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../');
const INDEX_CSS_PATH = resolve(HERE, '../index.css');

/**
 * The real portal arrangement: the trigger inside a `.chat-dock` header, the
 * backdrop and the menu as siblings of that subtree on `document.body`.
 * Serializing `document.body` after opening the menu is what preserves it —
 * a hand-written fixture would be free to get the document order wrong, which
 * is half of what decides paint order between equal layers.
 *
 * The dock is MAXIMIZED here (`top: 0`), which is the state the defect was
 * confirmed in and the only one where the menu cannot avoid overlapping it.
 */
function bodyMarkupWithOpenMenu(): string {
  const dock = document.createElement('div');
  dock.className = 'chat-dock';
  dock.setAttribute('style', 'top: 0');
  document.body.appendChild(dock);
  const header = document.createElement('div');
  header.className = 'chat-dock__header';
  dock.appendChild(header);

  render(
    <ChatDockHeaderMoreMenu
      actions={[
        { key: 'settings', label: 'Chat settings', onSelect: () => {} },
        { key: 'tasks', label: 'Background tasks', onSelect: () => {} },
      ]}
    />,
    { container: header },
  );

  const trigger = screen.getByLabelText('More dock actions');
  // A trigger 100px down the viewport: the menu opens BELOW it, into the
  // maximized dock's band, which is the arrangement that painted underneath.
  trigger.getBoundingClientRect = () =>
    ({ top: 100, bottom: 128, right: 900 }) as DOMRect;
  fireEvent.click(trigger);

  return document.body.innerHTML;
}

function fixtureHtml(bodyMarkup: string): string {
  const css = resolveCssImports(INDEX_CSS_PATH);
  assertNoImportsSurvive(css);
  return `<!doctype html>
<html>
  <head><style>${css}</style></head>
  <body style="margin:0">${bodyMarkup}</body>
</html>`;
}

const chromiumAvailable = chromiumIsInstalled(REPO_ROOT);

describe.skipIf(!chromiumAvailable)(
  'dock header More menu reachability over the dock (#1536 F)',
  () => {
    let browser: Awaited<ReturnType<typeof chromium.launch>>;

    beforeAll(async () => {
      browser = await chromium.launch();
    });
    afterAll(async () => {
      await browser?.close();
    });
    afterEach(() => {
      cleanup();
      document.body.innerHTML = '';
    });

    async function hitTest() {
      const markup = bodyMarkupWithOpenMenu();
      const page = await browser.newPage({
        viewport: { width: 1200, height: 800 },
      });
      try {
        await page.setContent(fixtureHtml(markup));
        return await page.evaluate(() => {
          const rows = [
            ...document.querySelectorAll('.chat-dock__more-menu [role]'),
          ] as HTMLElement[];
          if (rows.length === 0) throw new Error('no menu rows rendered');
          const describe = (element: Element | null) =>
            element
              ? `${element.tagName.toLowerCase()}.${element.className || '(no class)'}`
              : 'null';
          return {
            dockOverlapsMenu: (() => {
              const dock = document
                .querySelector('.chat-dock')
                ?.getBoundingClientRect();
              const menu = document
                .querySelector('.chat-dock__more-menu')
                ?.getBoundingClientRect();
              if (!dock || !menu) return false;
              return (
                menu.top < dock.bottom &&
                menu.bottom > dock.top &&
                menu.left < dock.right &&
                menu.right > dock.left
              );
            })(),
            rows: rows.map((row) => {
              const rect = row.getBoundingClientRect();
              const x = rect.left + rect.width / 2;
              const y = rect.top + rect.height / 2;
              const stack = document.elementsFromPoint(x, y);
              return {
                label: row.textContent ?? '',
                topmost: describe(stack[0] ?? null),
                hitsRow: stack[0] === row,
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              };
            }),
            backdropBeatsDock: (() => {
              const layer = (selector: string) => {
                const element = document.querySelector(selector);
                if (!element) return Number.NaN;
                return Number(getComputedStyle(element).zIndex);
              };
              return {
                backdrop: layer('.chat-dock__more-backdrop'),
                menu: layer('.chat-dock__more-menu'),
                dock: layer('.chat-dock'),
              };
            })(),
          };
        });
      } finally {
        await page.close();
      }
    }

    test('a click at each row’s centre lands on that row, not on the dock underneath it', async () => {
      const result = await hitTest();

      // The premise: if the menu did not overlap the dock, hit-testing would
      // prove nothing about their layers.
      expect(
        result.dockOverlapsMenu,
        'fixture must place the menu over the maximized dock',
      ).toBe(true);
      expect(result.rows.length).toBe(2);
      for (const row of result.rows) {
        expect(row.width).toBeGreaterThan(0);
        expect(row.height).toBeGreaterThan(0);
        expect(
          row.hitsRow,
          `a click at the centre of "${row.label}" landed on ${row.topmost}`,
        ).toBe(true);
      }
    });

    test('the menu and its backdrop are both above the dock, one step apart', async () => {
      const { backdropBeatsDock } = await hitTest();

      expect(backdropBeatsDock.menu).toBeGreaterThan(backdropBeatsDock.dock);
      expect(backdropBeatsDock.backdrop).toBeGreaterThan(
        backdropBeatsDock.dock,
      );
      // The backdrop must catch outside clicks yet stay under its own menu, or
      // it swallows the menu's rows — which is what the hit test above checks
      // from the other side.
      expect(backdropBeatsDock.backdrop).toBe(backdropBeatsDock.menu - 1);
    });
  },
);

test.skipIf(chromiumAvailable)(
  'dock header More menu layering — Chromium not installed, cannot verify (#1536 F)',
  () => {
    throw new Error(
      'Playwright Chromium is not installed in this worktree, so the More ' +
        'menu’s reachability over the dock could not be measured — this is a ' +
        'missing precondition, not a passing check. Install it with ' +
        '`npm run install:playwright` and re-run.',
    );
  },
);
