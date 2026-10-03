// @vitest-environment jsdom

/**
 * #90: the held page-dialog card's action row, measured in a real Chromium
 * against the real cascade (`index.css`, then the chunk sheets that load
 * with the card: the icon button's and the card's own, then the host's —
 * `FloatOverChat.css` for the float, `BrowserPane.css` for the pane), not
 * read out of a stylesheet. "Open in pane" is an icon-only control beside
 * the labelled OK and Cancel: on a coarse pointer it is a 44px target like
 * them, and on a fine pointer it stays visible, hittable, first in the row
 * and centred on it rather than a 30px box left at the top of a taller row.
 *
 * The markup is the real component's, rendered in jsdom with the pointer
 * hook's media query stubbed, and that DOM is what Chromium styles.
 */

import { resolve } from 'node:path';
import type { BrowserPendingDialogView } from '@kontourai/station-contracts/workspace-browser-pane';
import { chromium } from '@playwright/test';
import { cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { resolveCssImports } from '../../../../../tests/helpers/css-cascade-fixture';
import { MIN_TOUCH_TARGET_PX } from '../../../../../tests/helpers/touch-target';
import { BrowserPageDialog } from '../BrowserPageDialog';

function sheet(...paths: string[]) {
  return paths
    .map((path) => resolveCssImports(resolve(import.meta.dirname, path)))
    .join('\n');
}

const CARD_SHEETS = [
  '../../../components/IconButton.css',
  '../BrowserPageDialog.css',
];
const CSS = {
  float: sheet(
    '../../../index.css',
    ...CARD_SHEETS,
    '../../../float-over-chat/FloatOverChat.css',
  ),
  pane: sheet('../../../index.css', ...CARD_SHEETS, '../BrowserPane.css'),
};

const CONFIRM: BrowserPendingDialogView = {
  dialogId: 'd1',
  type: 'confirm',
  message: 'Remove the blue mug?',
  openedAt: '2026-09-22T12:00:05.000Z',
};

function stubPointer(coarse: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(pointer: coarse)' ? coarse : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

/** The card's DOM as the real component renders it for this pointer. */
function cardMarkup(coarse: boolean, compact: boolean): string {
  stubPointer(coarse);
  const { container, unmount } = render(
    <BrowserPageDialog
      compact={compact}
      dialog={CONFIRM}
      pageHost="example.com"
      pending={false}
      error={null}
      onAnswer={() => {}}
      onOpenInPane={() => {}}
    />,
  );
  const markup = container.innerHTML;
  unmount();
  return markup;
}

/** The host's DOM around the card: the float's layer or the pane's. */
const HOSTS = {
  float: (card: string) =>
    '<div class="float-over-chat__browser" style="position:relative;width:360px;height:240px">' +
    `<div class="float-over-chat__dialog-layer float-over-chat__dialog-layer--compact">${card}</div></div>`,
  pane: (card: string, coarse: boolean) =>
    `<div class="browser-pane"${coarse ? ' data-coarse=""' : ''} style="position:relative;width:640px;height:420px">` +
    `<div class="browser-pane__dialog-layer">${card}</div></div>`,
};

let browser: Awaited<ReturnType<typeof chromium.launch>>;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const centreY = (box: { y: number; height: number }) => box.y + box.height / 2;

// A coarse pointer at a phone width AND at a tablet width: below 768px
// `index.css`'s global mobile floor already makes every `.button` 44px, so
// only the tablet case proves the card's own `data-pointer="coarse"` rule.
test.each([
  {
    host: 'float',
    compact: true,
    coarse: true,
    viewport: { width: 390, height: 844 },
  },
  {
    host: 'float',
    compact: true,
    coarse: true,
    viewport: { width: 1024, height: 768 },
  },
  {
    host: 'float',
    compact: true,
    coarse: false,
    viewport: { width: 1280, height: 800 },
  },
  {
    host: 'pane',
    compact: false,
    coarse: true,
    viewport: { width: 390, height: 844 },
  },
  {
    host: 'pane',
    compact: false,
    coarse: true,
    viewport: { width: 1024, height: 768 },
  },
  {
    host: 'pane',
    compact: false,
    coarse: false,
    viewport: { width: 1280, height: 800 },
  },
] as const)(
  'Open in pane is visible, first and centred on the action row in the $host ($coarse coarse pointer, $viewport.width px), and a 44px target on touch',
  async ({ host, compact, coarse, viewport }) => {
    const markup = HOSTS[host](cardMarkup(coarse, compact), coarse);
    const page = await browser.newPage({ viewport });
    try {
      await page.setContent(
        `<!doctype html><html><head><style>${CSS[host]}</style></head><body>${markup}</body></html>`,
      );
      const card = page.getByRole('alertdialog');
      const open = card.getByRole('button', { name: 'Open in pane' });
      const cancel = card.getByRole('button', { name: 'Cancel' });
      const ok = card.getByRole('button', { name: 'OK' });
      // The exact row: a control added later is measured, not skipped.
      expect(
        await card
          .getByRole('button')
          .evaluateAll((buttons) =>
            buttons.map(
              (button) =>
                button.getAttribute('aria-label') ?? button.textContent?.trim(),
            ),
          ),
      ).toEqual(['Open in pane', 'Cancel', 'OK']);

      const cardBox = await card.boundingBox();
      const openBox = await open.boundingBox();
      const cancelBox = await cancel.boundingBox();
      const okBox = await ok.boundingBox();
      if (!cardBox || !openBox || !cancelBox || !okBox)
        throw new Error('every control must render');

      // Visible and hittable at its own centre: nothing lies over it.
      expect(await open.isVisible()).toBe(true);
      expect(
        await open.evaluate(
          (element, [x, y]) =>
            element.contains(document.elementFromPoint(x, y)),
          [openBox.x + openBox.width / 2, centreY(openBox)],
        ),
      ).toBe(true);
      // Inside the card, first in the row, centred on the labelled controls.
      expect(openBox.y).toBeGreaterThanOrEqual(cardBox.y);
      expect(openBox.y + openBox.height).toBeLessThanOrEqual(
        cardBox.y + cardBox.height,
      );
      expect(openBox.x + openBox.width).toBeLessThanOrEqual(cancelBox.x);
      expect(Math.abs(centreY(openBox) - centreY(okBox))).toBeLessThanOrEqual(
        1,
      );
      // A round icon control: never squashed by the row.
      expect(openBox.width).toBeCloseTo(openBox.height, 0);

      const floor = coarse ? MIN_TOUCH_TARGET_PX : 24;
      for (const [name, box] of [
        ['Open in pane', openBox],
        ['Cancel', cancelBox],
        ['OK', okBox],
      ] as const) {
        if (coarse || name === 'Open in pane') {
          expect(box.width, `${name} width`).toBeGreaterThanOrEqual(floor);
          expect(box.height, `${name} height`).toBeGreaterThanOrEqual(floor);
        }
      }
    } finally {
      await page.close();
    }
  },
  120_000,
);
