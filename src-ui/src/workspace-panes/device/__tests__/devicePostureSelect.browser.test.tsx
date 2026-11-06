// @vitest-environment jsdom

/**
 * The compact stand picker in the full-screen bar, in a real Chromium against
 * the real cascade. jsdom renders `DevicePostureControl` (compact, as the
 * phone-width bar asks for it) and Chromium styles that markup with
 * `index.css`, `chat.css` (the coarse-pointer floor), the live view's bar and
 * the fold sheet.
 *
 * Checked, in both themes: the select is dressed as the shell's compact
 * picker (theme surface and text, not the UA's white box), it draws the
 * shared caret inside its own box, its target is 44px, and it is named Stand.
 */

import { resolve } from 'node:path';
import type { LiveSurfaceFold } from '@kontourai/station-contracts/live-surface';
import { chromium } from '@playwright/test';
import { cleanup, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { resolveCssImports } from '../../../../../tests/helpers/css-cascade-fixture';
import { MIN_TOUCH_TARGET_PX } from '../../../../../tests/helpers/touch-target';
import { DevicePostureControl } from '../DeviceFoldControls';

const css = [
  '../../../index.css',
  '../../../components/chat/chat.css',
  '../../../live-surface/LiveSurfaceCanvas.css',
  '../DeviceFold.css',
]
  .map((path) => resolveCssImports(resolve(import.meta.dirname, path)))
  .join('\n');

const BOOK: LiveSurfaceFold = {
  activeDisplay: 'inner',
  hingeAngle: 90,
  posture: 'book',
  postures: ['closed', 'open', 'book', 'laptop', 'tent'],
  angleControl: true,
  tableMode: false,
};

let browser: Awaited<ReturnType<typeof chromium.launch>>;

beforeAll(async () => {
  browser = await chromium.launch();
});

afterAll(async () => {
  await browser?.close();
});

afterEach(cleanup);

function compactPickerMarkup(): string {
  const { container } = render(
    <DevicePostureControl
      compact
      fold={BOOK}
      inputReady
      onPreviewAngle={() => undefined}
      previewAngle={null}
      sendInput={() => undefined}
    />,
  );
  // The accessible name is the select's own, not inferred from layout.
  const select = screen.getByRole('combobox', {
    name: 'Stand',
  }) as HTMLSelectElement;
  expect(select.value).toBe('book');
  // A select's value is a property; carry it into the serialized markup.
  select.selectedOptions[0]?.setAttribute('selected', '');
  return container.innerHTML;
}

for (const theme of ['dark', 'light'] as const) {
  test(`the full-screen bar's stand picker is the shell's compact picker (${theme})`, async () => {
    const markup = compactPickerMarkup();
    const page = await browser.newPage({
      viewport: { width: 390, height: 300 },
      hasTouch: true,
    });
    try {
      await page.setContent(
        `<!doctype html><html data-theme="${theme}"><head><style>${css}</style></head>` +
          `<body style="margin:0"><div style="position:relative;width:390px;height:300px;background:#000">` +
          `<div class="live-surface__immersive-bar"><div class="live-surface-controls">${markup}</div></div>` +
          `</div></body></html>`,
      );
      const evidence = process.env.STATION_UI_EVIDENCE_DIR;
      if (evidence)
        await page.screenshot({
          path: `${evidence}/device-stand-picker-390-${theme}.png`,
        });
      const facts = await page.evaluate(() => {
        const select = document.querySelector('select')!;
        const caret = document.querySelector(
          '.device-fold-controls__stand-picker > svg',
        );
        const style = getComputedStyle(select);
        // The theme's own surface and text, resolved through the same
        // custom properties the shared picker reads.
        const probe = document.createElement('div');
        probe.style.background = 'var(--bg-secondary)';
        probe.style.color = 'var(--text-primary)';
        document.body.append(probe);
        const tokens = getComputedStyle(probe);
        const select_ = select.getBoundingClientRect();
        const caret_ = caret?.getBoundingClientRect();
        return {
          height: select_.height,
          appearance: style.appearance,
          background: style.backgroundColor,
          color: style.color,
          tokenBackground: tokens.backgroundColor,
          tokenColor: tokens.color,
          caretInside:
            !!caret_ &&
            caret_.width > 0 &&
            caret_.left >= select_.left &&
            caret_.right <= select_.right &&
            caret_.top >= select_.top &&
            caret_.bottom <= select_.bottom,
        };
      });
      expect(facts.appearance).toBe('none');
      expect(facts.background).toBe(facts.tokenBackground);
      expect(facts.color).toBe(facts.tokenColor);
      // The reported defect: a white UA box in the dark bar.
      if (theme === 'dark')
        expect(facts.background).not.toBe('rgb(255, 255, 255)');
      expect(facts.caretInside).toBe(true);
      expect(facts.height).toBeGreaterThanOrEqual(MIN_TOUCH_TARGET_PX);
    } finally {
      await page.close();
    }
  });
}
