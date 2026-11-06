// @vitest-environment jsdom

/**
 * A browser that cannot start says why, and its "How to fix" guide link is a
 * full 44px touch target on its own row: measured in a real Chromium against
 * the real cascade (`index.css`, then `BrowserPane.css`), at a phone and a
 * desktop width, in both themes. The markup is the real component's.
 */

import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { cleanup, render } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { resolveCssImports } from '../../../../../tests/helpers/css-cascade-fixture';
import { MIN_TOUCH_TARGET_PX } from '../../../../../tests/helpers/touch-target';
import { BrowserOpenFailureNotice } from '../BrowserPane';
import { BrowserApiError } from '../browserPaneApi';

const css = ['../../../index.css', '../BrowserPane.css']
  .map((path) => resolveCssImports(resolve(import.meta.dirname, path)))
  .join('\n');

let browser: Awaited<ReturnType<typeof chromium.launch>>;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

afterEach(() => cleanup());

test.each([
  { theme: 'dark', viewport: { width: 390, height: 844 } },
  { theme: 'light', viewport: { width: 390, height: 844 } },
  { theme: 'dark', viewport: { width: 412, height: 915 } },
  { theme: 'light', viewport: { width: 1440, height: 900 } },
] as const)(
  'the "How to fix" link is a 44px target on its own row ($theme, $viewport.width px)',
  async ({ theme, viewport }) => {
    const { container } = render(
      <BrowserOpenFailureNotice
        error={new BrowserApiError(503, 'browser-sandbox-unavailable')}
      />,
    );
    const page = await browser.newPage({ viewport });
    try {
      await page.setContent(
        `<!doctype html><html data-theme="${theme}"><head><style>${css}</style></head><body style="margin:0">` +
          `<div class="browser-pane" style="padding:12px;width:${viewport.width - 24}px">${container.innerHTML}</div></body></html>`,
      );
      const link = page.getByRole('link', { name: 'How to fix' });
      const box = await link.boundingBox();
      if (!box) throw new Error('link not rendered');
      expect(box.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      expect(box.width).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
      // Its own row: entirely below the reason's text.
      const reasonBottom = await page.evaluate(() => {
        const notice = document.querySelector('.browser-pane__notice')!;
        const range = document.createRange();
        range.setStart(notice.firstChild!, 0);
        range.setEnd(
          notice.firstChild!,
          notice.firstChild!.textContent!.length,
        );
        const rects = [...range.getClientRects()];
        return Math.max(...rects.map((rect) => rect.bottom));
      });
      expect(box.y).toBeGreaterThanOrEqual(reasonBottom - 1);
      const evidence = process.env.STATION_UI_EVIDENCE_DIR;
      if (evidence)
        await page.locator('.browser-pane').screenshot({
          path: `${evidence}/browser-how-to-fix-${theme}-${viewport.width}.png`,
        });
    } finally {
      await page.close();
    }
  },
  120_000,
);
